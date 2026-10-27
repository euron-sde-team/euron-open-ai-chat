# Testing

Four layers of tests, and the gates that run them:

| Layer | Runs | Needs | Command |
| --- | --- | --- | --- |
| Unit | Pure functions, adapters against canned streams, web components and the turn runner, the API client | Node and pnpm | `make test` (`pnpm test`) |
| Integration | The real API in-process (supertest) against Postgres and Redis, with the provider stubs in-process | Postgres and Redis (compose starts them) | `make test-integration` |
| Matrix | The integration suite under every storage and mail backend: 6 runs | The full local stack (`make up`) | `make test-matrix` |
| End-to-end | Playwright against the running stack | `make up` and `make demo` | `make e2e` |

No layer calls a real model, search or moderation provider: they all run against
[`apps/stubs`](../../apps/stubs/server.mjs), the same adapter code as production with a
different base URL.

## Unit tests

Vitest in every package (`pnpm test` runs them all through Turborepo):

| Package | Tests | Covers |
| --- | --- | --- |
| `apps/api` | [`test/unit`](../../apps/api/test/unit) | `llm-adapters` (OpenAI-compatible, Anthropic and Gemini stream parsing: text, reasoning, fragmented tool calls, usage, finish reasons), `http` (the SSE reader across chunk boundaries, failure classification, key masking), `chat-context` (token budget, vision on the last two user messages, document share, summary on the right branch only), `chat-helpers` (titles, argument parsing, error codes), `net-guard` (every private, link-local, CGNAT and IPv4-in-IPv6 range), `file-rules` (allowlist, extension match, magic bytes), `chunking`, `display-name`, `username`, `hardening`, `logger-redaction` (secrets and conversation fields) |
| `apps/web` | [`test`](../../apps/web/test) | The turn runner applying events to the cache, markdown rendering, the CSP builder, session and refresh, errors, the auth forms, the admin pages and charts |
| `packages/api-client` | [`test`](../../packages/api-client/test) | Single-flight refresh, pagination, uploads with progress, `followTurn` (SSE parsing, reconnecting after a drop with `after`, the XHR transport) |
| `packages/ui` | [`test`](../../packages/ui/test) | Components |
| `apps/stubs` | [`test`](../../apps/stubs/test/stubs.test.mjs) | The stand-ins' wire formats |

A rule worth arguing about lives in `apps/api/src/domain/` (pure, no I/O) and gets a unit
test there first.

## Integration tests

```bash
make test-integration
```

This makes sure Postgres and Redis answer on the compose ports (starting just those two
containers if needed, [`scripts/test-db.sh`](../../scripts/test-db.sh)), then runs
`pnpm test:integration` with:

```bash
TEST_DATABASE_URL=postgres://chat:chat@localhost:5502/chat_test
TEST_REDIS_URL=redis://localhost:6439/1
```

What the harness does ([`vitest.integration.config.mts`](../../vitest.integration.config.mts),
[`apps/api/test/integration`](../../apps/api/test/integration)):

- **Refuses** any database whose name does not end in `_test`
  ([`guard.ts`](../../apps/api/test/integration/guard.ts)), then drops, recreates and
  migrates it once per run, and empties the numbered Redis database
  ([`global-setup.ts`](../../apps/api/test/integration/global-setup.ts)).
- **Starts the stubs in-process** on an ephemeral port (`startStubs` from
  `apps/stubs/server.mjs`) and hands the URL to every file, so the suite is hermetic.
- Sets the API's environment before it loads ([`env.ts`](../../apps/api/test/integration/env.ts)):
  `NODE_ENV=test`, `JOBS_MODE=inline` (job handlers run right after commit, so file
  processing and summaries are deterministic), `BCRYPT_ROUNDS=4`, rate limits off (tests that
  assert a 429 switch them on), `SEARCH_PROVIDER=stub`, `MODERATION_PROVIDER=stub`,
  `FETCH_ALLOW_HOSTS=127.0.0.1` (so `open_url` can read the stub's pages, and nothing else
  private), and `OPENAI_API_KEY` set to a canary value.
- Mounts the app in-process ([`harness.ts`](../../apps/api/test/integration/harness.ts)),
  seeds the starter catalogue with the stub provider, and offers helpers: `createUser()`,
  `chat(user, text)` (send to `new` and read the turn's events to `done`), `openEvents` (read
  events incrementally from a real listening server, for resume tests).
- Files share one database, so they run one at a time; each test creates its own users and
  chats and restores any shared state it changes (settings, the default tier, the catalogue).

What the suites cover, by file:

| File | Covers |
| --- | --- |
| `chat-turns.int.test.ts` | Sending, the event order, following and resuming with `after`, cancelling, branches (regenerate, edit, leaf), the conversation list and search |
| `chat-tools.int.test.ts` | `web_search` (numbered sources), `open_url` (including the redirect to the metadata address being refused), `generate_image`, `remember`, `search_project_files`, vision, image mode, and provider failures mapped to stable codes, never provider text |
| `files.int.test.ts` | The upload flow, rules checked up front and after upload (size and magic bytes), ownership (another user's file is 404), local signed links |
| `quotas.int.test.ts` | Usage and limits, running out (tokens and images), what `usage_daily` records (counts only) |
| `shares.int.test.ts` | Frozen snapshots, revoking, images served only through the share |
| `secrets.int.test.ts` | The provider key canary (below) |
| `admin.int.test.ts` | Who may open `/admin`, accounts, tiers, providers and models, settings, integrations, stats, shares, the audit trail |
| `auth.int.test.ts`, `native-auth.int.test.ts`, `account.int.test.ts` | Sign-up and verification, sign-in throttling, sessions and rotation, password reset, two-factor; native token mode; export and deletion |
| `hardening.int.test.ts` | The error envelope, headers and CORS, authentication failures, id and cursor validation, user text never becoming query syntax, rate limits |
| `images-speech.int.test.ts`, `me.int.test.ts` | The image studio and gallery, dictation, read aloud; `/api/meta`, `/api/models`, preferences, memories, projects |

### The provider key canary

[`secrets.int.test.ts`](../../apps/api/test/integration/secrets.int.test.ts) sets
`OPENAI_API_KEY=sk-test-canary-value`, then chats (one search, one provider failure),
shares, uploads and generates an image, and collects every body a user or an admin can
fetch: the event streams, every user page, the public share, the export, every admin page,
the model **Test** results and error envelopes. The canary must appear in none of them,
while the admin providers list still reports `keyConfigured: true`. A
change that echoes a key anywhere fails here.

## The stubs

[`apps/stubs/server.mjs`](../../apps/stubs/server.mjs) is one dependency-free Node process:
OpenAI-compatible chat (streaming and not, tool calls, vision), Anthropic Messages, Gemini
`streamGenerateContent` and `generateContent`, image generation and edits (a real PNG),
transcription and speech (a short WAV), moderation (flags input containing `STUB_FLAG`), a
search endpoint, and HTML pages to read, including `/pages/redirect-metadata`, a redirect to
`169.254.169.254` for the SSRF test.

The stub model decides from words in the last user message:

| Words | It does |
| --- | --- |
| `search`, `latest`, `news`, `look up` | Calls `web_search` (when offered) |
| `open http...` | Calls `open_url` with that link |
| `draw`, `image of`, `picture of` | Calls `generate_image` |
| `remember` | Calls `remember` |
| `in my files`, `document`, `project` | Calls `search_project_files` |
| `slow` | Streams a long answer slowly (resume and cancel tests) |
| `code`, `math` or `formula` | A fenced code block, or LaTeX |
| `fail` (the word) | Answers 500 |
| `ratelimit` | Answers 429 |
| `context overflow` | Answers 400 `context_length_exceeded` |

After a tool result it answers from it and cites `[1]`; with images it reports how many it
saw; titles and summaries have their own fixed answers. Every request is recorded for
`GET /__/requests` (newest first) and cleared by `POST /__/reset`, so a test can assert what
the API sent (for example that a tool result arrived as a tool message, not in the system
prompt).

Run the stubs alone with `PORT=5129 node apps/stubs/server.mjs`.

## Backend matrix

```bash
make up            # Postgres, Redis, Floci, Mailpit
make test-matrix   # ONLY=s3 to run some rows, FILTER=files to run some test files
```

[`scripts/test-matrix.sh`](../../scripts/test-matrix.sh) runs the integration suite under
`STORAGE` (`local`, `s3` on Floci) times `MAIL_MODE` (`outbox`, `smtp` to Mailpit, `ses` on
Floci relayed to Mailpit): 6 runs, each with a fresh `_test` database and its own Redis
database (1 to 6). Providers, search and moderation run against the stubs in every row. It
prints a table and exits non-zero if any row fails.

## End-to-end tests

```bash
make e2e
```

`make e2e` exports `SEARCH_PROVIDER=stub`, runs `make up` (recreating the API with stub
search so results are deterministic) and `make demo`, then `pnpm e2e`: Playwright
([`e2e/playwright.config.ts`](../../e2e/playwright.config.ts)) against
`http://localhost:3540` (`E2E_BASE_URL`), 4 workers (`E2E_WORKERS`). The suite
([`e2e/tests`](../../e2e/tests)) signs up in the UI, confirms through the email read from
Mailpit, survives a reload on the refresh cookie and signs out. Run `make up` afterwards to
switch search back to SearXNG.

## Static gates

| Gate | Command | Fails when |
| --- | --- | --- |
| Lint, types | `pnpm lint`, `pnpm typecheck` | ESLint or TypeScript strict errors |
| Build | `pnpm build` | Any package fails to build |
| OpenAPI | `pnpm openapi --check` | [`docs/api/openapi.yaml`](../api/openapi.yaml) is out of date with the route files. `pnpm openapi` regenerates it from the routes' doc comments ([`scripts/gen-openapi.ts`](../../scripts/gen-openapi.ts)); never edit it by hand |
| Sanitization | `make sanitize` | [`scripts/check-sanitization.sh`](../../scripts/check-sanitization.sh) finds a cloud credential, private key, AWS account or resource id, provider key shape (OpenAI, Anthropic, Gemini, Groq, Tavily, ...), a real email address or a public IP in any committable file |
| Terraform | `make tf-validate tf-lint tf-security` | fmt, validate, tflint or checkov findings |
| Secrets in history | gitleaks in [`.github/workflows-full/security.yml`](../../.github/workflows-full/security.yml) | A secret anywhere in the git history (rules in [`.gitleaks.toml`](../../.gitleaks.toml)) |

Fixtures in the tree must stay short or visibly fake, like the suite's
`sk-test-canary-value`, so the sanitization scan stays clean.

## CI

[`.github/workflows/checks.yml`](../../.github/workflows/checks.yml) runs on every push and
pull request: lint, typecheck, unit tests, the OpenAPI check, the sanitization scan, and
Terraform fmt and validate. The full pipeline lives in
[`.github/workflows-full`](../../.github/workflows-full/README.md) so it does not run
upstream: integration tests on Postgres and Redis service containers, gitleaks, CodeQL and
`pnpm audit`, tflint and checkov, multi-arch image builds, and the full stack with the
matrix and the browser tests. Move the files into `.github/workflows/` in your fork to enable
it.
