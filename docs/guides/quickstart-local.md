# Quickstart: run Euron Open AI Chat locally

Start the whole stack on your machine with emulated AWS, seed demo accounts and chats, and
talk to a deterministic stand-in model that streams, searches the web, reads pages, draws
images and remembers things. No cloud account and no model API key are needed; adding a real
key later is one line.

What runs ([`deploy/compose/compose.yaml`](../../deploy/compose/compose.yaml) plus
[`compose.floci.yaml`](../../deploy/compose/compose.floci.yaml)): Postgres 16, Redis 7,
Mailpit, the Floci AWS emulator provisioned by the production Terraform modules
([ADR 0014](../architecture/adr/0014-floci-for-local-aws.md)), the stubs (OpenAI-compatible,
Anthropic and Gemini stand-ins plus images, speech, moderation and search), SearXNG for real
web search, then a one-shot `migrate`, the `api`, the `worker` and the `web` app.

## Prerequisites

- Docker with Compose v2 (Docker Desktop, OrbStack, Colima or plain Docker Engine), about
  4 GB of memory for the containers.
- `make`, `bash` and `openssl` (for `make env`).
- For the tests and for running apps outside Docker: Node 22 (`.nvmrc`) and pnpm 9
  (`corepack enable`), then `pnpm install`.

## Start the stack

```bash
make up
```

`make up` runs `make env` first: it writes `deploy/compose/.env` with random, local-only
secrets (JWT and refresh secrets, the TOTP key, the demo password, the SearXNG secret) and
never overwrites a value ([`scripts/gen-local-env.sh`](../../scripts/gen-local-env.sh)).
Then it builds the images, waits for the `terraform` one-shot to create the bucket and the
mail identity inside Floci, runs the migration and waits until every service is healthy.
The first build takes a few minutes. When it is done it prints:

```
  app      http://localhost:3540
  api      http://localhost:5036/api/ready
  mail     http://localhost:8056
  s3/ses   http://localhost:4607  (Floci)
  stubs    http://localhost:5129  (model, image, speech, moderation and search stand-ins)
  search   http://localhost:8089  (SearXNG)
```

Check the API: `curl -s localhost:5036/api/ready` answers `{"ok":true}` when Postgres and
Redis respond.

## Ports

Every host port binds to `127.0.0.1` and can be moved in `deploy/compose/.env` (or your
shell) if it clashes with something else:

| Service | Host port | Variable |
| --- | --- | --- |
| Web app (and the `/api` proxy) | 3540 | `CHAT_WEB_PORT` |
| API | 5036 | `CHAT_API_PORT` |
| Postgres | 5502 | `CHAT_PG_PORT` |
| Redis | 6439 | `CHAT_REDIS_PORT` |
| Mailpit web UI / SMTP | 8056 / 1056 | `CHAT_MAILPIT_PORT` / `CHAT_SMTP_PORT` |
| Floci (S3, SES) | 4607 | `CHAT_FLOCI_PORT` |
| Stubs | 5129 | `CHAT_STUB_PORT` |
| SearXNG | 8089 | `CHAT_SEARXNG_PORT` |

The browser only ever talks to the web app: Next proxies `/api/*` to the API
(`API_INTERNAL_URL`), so the refresh cookie is first-party exactly as behind the load balancer
on AWS. The API port is published for curl and the integration tools.

## Seed the demo

```bash
make demo
```

This runs `node dist/cli.js demo:seed` inside the API container
([`apps/api/src/demo/seed.ts`](../../apps/api/src/demo/seed.ts)) with `DEMO_PASSWORD` set
to `CHAT_DEMO_PASSWORD` from `deploy/compose/.env`. It creates:

- the starter model catalogue ([`demo/catalog.ts`](../../apps/api/src/demo/catalog.ts)):
  providers `openai`, `anthropic` and `gemini` with a few current models each (hidden until
  their key is set), and the **Local stub** provider with `Stub Pro` (tools, vision,
  default), `Stub Lite` (no tools, no vision), `Stub Image`, `Stub Transcribe` and
  `Stub Speech`;
- an admin and four members, a `Staff` quota tier (Leo is on it), and thirty days of usage
  for the admin overview;
- for Priya, a full history: pinned and dated chats, a regenerated answer kept as a second
  branch, web sources with citations, an attached image, generated images, the project
  "Q3 launch: Team Workspaces" with a knowledge file, memories, preferences and a shared link.

It refuses to run with `NODE_ENV=production`. Running it again only prints the logins.

| Account | Email | Role |
| --- | --- | --- |
| Morgan Ellis | `admin@example.com` | ADMIN: `/admin` |
| Priya Nair | `priya.nair@example.com` | USER, the full demo history |
| Leo Marquez | `leo.marquez@example.com` | USER, on the `Staff` tier |
| Sam Kowalski | `sam.kowalski@example.com` | USER |
| Amara Okafor | `amara.okafor@example.com` | USER |

Every demo account signs in with the password `make demo` prints (`CHAT_DEMO_PASSWORD` in
`deploy/compose/.env`).

## A first chat

Sign in at http://localhost:3540 as Priya and start a new chat. The model picker shows only
models whose provider is usable, so without keys that is `Stub Pro` and `Stub Lite`.

The stub model decides what to do from words in your last message
([`apps/stubs/server.mjs`](../../apps/stubs/server.mjs)), so you can watch each part of the
engine:

| Try | What happens |
| --- | --- |
| `Hello there` | A streamed answer, then an automatic title in the sidebar |
| `What is the latest news on solar panels?` (web search on) | A `web_search` tool step, numbered sources, citations like `[1]` |
| `open http://stubs:5129/pages/1` | An `open_url` step: the page is fetched through the SSRF guard (`stubs` is the one host `FETCH_ALLOW_HOSTS` lets through locally; any public page works too) |
| `show me some code`, `the quadratic formula` | A fenced code block, or LaTeX math |
| `draw a lighthouse at dusk` | A `generate_image` step and an image in the answer and the gallery |
| `remember that I prefer metric units` | A `remember` step; the memory appears in Settings |
| `what does my project document say about pricing?` (inside the project) | A `search_project_files` step over the knowledge file |
| `write something slow` | A long, slow answer: reload the page mid-way and it resumes; press Stop and the partial text is kept |
| the word `fail`, `ratelimit`, `context overflow` | The stub answers 500, 429 or a context error; you see a plain message, never provider text |

Then try the rest of the interface: edit a question or regenerate an answer and switch
between the versions (message branches, [ADR 0006](../architecture/adr/0006-message-tree-for-branching.md)),
attach a PDF or an image, switch to image mode, dictate with the microphone (the stub
transcribes to fixed text), read an answer aloud, share a chat and open the link in a
private window.

By default web search uses the bundled SearXNG, which queries public search engines from
your machine: the stub model still calls the tool, but the results are real and vary. Set
`SEARCH_PROVIDER=stub` in `deploy/compose/.env` and run `make up` again for deterministic
results ([web-search.md](web-search.md)).

Every mail the stack sends (verification, password reset, the admin set-password link) is
at http://localhost:8056. `GET http://localhost:5129/__/requests` lists every request the API
sent to the stubs, newest first.

## The admin control plane

Sign in as `admin@example.com` and open `/admin`: the overview (usage charts), accounts
(roles, suspend, ban, erase, tier and per-user limits), quotas, models (providers, models,
the Test button), shared links, settings and the audit trail. Admins see accounts, usage and
configuration, never anyone's conversations.

## Use a real model

Add a key to `deploy/compose/.env`, either as one JSON object keyed by provider slug or with
a single-key shortcut (placeholders shown):

```bash
PROVIDER_KEYS={"openai":"<openai-key>","anthropic":"<anthropic-key>"}
# or
OPENAI_API_KEY=<openai-key>
```

then `make up` again (compose recreates the API and worker with the new environment). The
starter OpenAI, Anthropic or Gemini models appear in the picker. Model ids change often:
check one with **Test** in `/admin/models` and edit it there. OpenRouter, Groq, a local
Ollama and others: [providers.md](providers.md).

## Stop and reset

```bash
make down      # stop everything and delete the volumes (database, files, emulator state)
make logs SERVICE=api    # tail one service: api, worker, web, stubs, searxng, migrate, floci, terraform
make ps        # status
```

`deploy/compose/.env` survives `make down`; delete it to generate new secrets.

## Next

- Run the tests: [testing.md](testing.md).
- Follow one message through the code: [walkthrough.md](walkthrough.md).
- Every setting: [configuration.md](configuration.md).
- Deploy it: [deploy-aws.md](deploy-aws.md).
