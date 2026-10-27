<p align="center">
  <img src="docs/assets/banner.svg" alt="Euron Open AI Chat: a private AI assistant for your team with any model, web search with citations, files, vision, images, projects and memory" width="100%">
</p>

<p align="center">
  <img alt="Open source" src="https://img.shields.io/badge/open_source-%E2%9D%A4-0e99ad?style=flat">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3b82f6?style=flat"></a>
  <img alt="Node.js 22 LTS" src="https://img.shields.io/badge/node-22_LTS-339933?style=flat&logo=nodedotjs&logoColor=white">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat&logo=typescript&logoColor=white">
  <img alt="Next.js 15" src="https://img.shields.io/badge/Next.js-15-000000?style=flat&logo=nextdotjs&logoColor=white">
  <img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169e1?style=flat&logo=postgresql&logoColor=white">
  <img alt="Redis 7" src="https://img.shields.io/badge/Redis-7-dc382d?style=flat&logo=redis&logoColor=white">
  <img alt="OpenAI" src="https://img.shields.io/badge/models-OpenAI-412991?style=flat&logo=openai&logoColor=white">
  <img alt="Anthropic" src="https://img.shields.io/badge/models-Anthropic-191919?style=flat&logo=anthropic&logoColor=white">
  <img alt="Gemini" src="https://img.shields.io/badge/models-Gemini-4285f4?style=flat&logo=googlegemini&logoColor=white">
  <img alt="Ollama" src="https://img.shields.io/badge/models-Ollama_and_any_OpenAI--compatible-0a0f1c?style=flat&logo=ollama&logoColor=white">
  <img alt="Terraform" src="https://img.shields.io/badge/IaC-Terraform-7b42bc?style=flat&logo=terraform&logoColor=white">
  <img alt="AWS" src="https://img.shields.io/badge/AWS-ready-ff9900?style=flat&logo=amazonwebservices&logoColor=white">
</p>

<p align="center">
  <a href="https://github.com/euron-sde-team/euron-open-ai-chat/stargazers"><img alt="Star this repo" src="https://img.shields.io/github/stars/euron-sde-team/euron-open-ai-chat?style=social&label=Star%20this%20repo"></a>
  <a href="https://github.com/euron-sde-team/euron-open-ai-chat/fork"><img alt="Fork" src="https://img.shields.io/github/forks/euron-sde-team/euron-open-ai-chat?style=social&label=Fork"></a>
  <a href="https://github.com/euron-sde-team/euron-open-ai-chat/watchers"><img alt="Watch" src="https://img.shields.io/github/watchers/euron-sde-team/euron-open-ai-chat?style=social&label=Watch"></a>
  <br>
  <a href="https://github.com/euron-sde-team/euron-open-ai-chat/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/euron-sde-team/euron-open-ai-chat?style=flat&color=0e99ad"></a>
  <a href="https://github.com/euron-sde-team/euron-open-ai-chat/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-34d399?style=flat"></a>
  <a href="https://github.com/euron-sde-team/euron-open-ai-chat/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/euron-sde-team/euron-open-ai-chat?style=flat&color=8b95a8"></a>
  <img alt="Runs locally with no API key" src="https://img.shields.io/badge/runs_locally-no_API_key_needed-0a0f1c?style=flat">
  <br>
  <a href="#built-by-the-team-behind-euron"><img alt="Built by the team behind Euron" src="https://img.shields.io/badge/built_by-Euron-4f46e5?style=flat"></a>
</p>

<p align="center">
  <b><a href="#-quickstart">Quickstart</a></b> ·
  <b><a href="#️-architecture">Architecture</a></b> ·
  <b><a href="#-explore-the-repository">Explore the repo</a></b> ·
  <b><a href="docs/api/rest-contract.md">API reference</a></b> ·
  <b><a href="docs/api/streaming.md">Streaming</a></b> ·
  <b><a href="#️-deploy-to-aws">Deploy</a></b> ·
  <b><a href="docs/architecture/security.md">Security</a></b> ·
  <b><a href="#-documentation">Docs</a></b>
</p>

**Euron Open AI Chat** is an open-source, self-hosted **AI assistant for a team, a company or a
community, in the spirit of ChatGPT**: streaming answers from the models you choose, web search
with numbered citations, files and images you can attach, image generation, projects with shared
instructions and knowledge, and a memory people can see and edit, all on infrastructure you own.
It is MIT-licensed and part of the open-source initiative of **ENGAGESPHERE TECHNOLOGY PRIVATE
LIMITED**.

People pick a model (OpenAI, Anthropic, Gemini, or anything that speaks the OpenAI wire format,
from OpenRouter and Groq to a local Ollama), ask, and watch the answer stream in. The assistant
searches the web and reads pages when a question needs fresh facts, draws images, remembers what
matters, and searches the documents in a project. Regenerate an answer or edit a question and
both versions stay, one click apart. Share a conversation as a frozen public link. Admins run the
deployment from an `/admin` control plane: models and providers, daily allowances by tier, users,
shared links, settings and the audit log, and they never see anyone's conversations.

The parts that usually go wrong in AI chat apps are designed in, not bolted on:

- **Answers outlive the connection.** A turn runs on the server and writes every event to a
  Redis Stream. Close the tab, lose the network or put the phone away: the answer finishes, and
  the client picks up from the last event it saw.
- **Web content is data, never instructions.** Search results, fetched pages and file text reach
  the model as tool results, never inside the system prompt, and every redirect of a fetched page
  is checked again against private addresses.
- **Keys and conversations stay where they belong.** Provider keys live only in the environment
  or Secrets Manager, never in the database or a response; usage records hold counts, never what
  anyone wrote.

The same API is built to serve a **ChatGPT-like mobile app**: native sessions with a refresh
token in the body, resumable streams that work from React Native, presigned uploads with
progress, opt-in push notifications when an answer finishes in the background, and a typed
client package with no browser dependencies
([docs/guides/mobile-clients.md](docs/guides/mobile-clients.md)).

Everything runs on a laptop with no API key at all: deterministic stand-ins answer for the model
providers, image generation, speech and search, an AWS emulator stands in for S3, SES and Secrets
Manager, and it deploys to AWS with the same Terraform.

<p align="center">
  <img src="docs/assets/tour.gif" alt="Product tour: typing a question, the answer streaming in with a highlighted code block, then regenerating it and switching between the two versions" width="100%">
</p>

> [!NOTE]
> Everything in the tour and the screenshots ran for real: Docker Compose on a laptop, the API's
> real provider adapters talking to the local model stand-ins over the same wire formats the real
> providers use, and S3, SES and Secrets Manager emulated locally. `make up && make demo`
> reproduces it. Add a provider key and the same screens answer with a real model.

<h3 align="center">Built by the team behind Euron</h3>

<p align="center">
  <sub>Euron Open AI Chat is part of the open-source initiative of ENGAGESPHERE TECHNOLOGY PRIVATE LIMITED, made by the people who build<br>the platforms below. If you like how this repository is built, come and see what we build with it.</sub>
</p>

<p align="center">
  <a href="https://euron.one"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/euron-dark.svg"><img src="docs/assets/brand/euron-light.svg" alt="Euron: learn the latest technologies from industry experts. Visit euron.one" width="31%"></picture></a>
  <a href="https://euronsystems.com"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/euron-systems-dark.svg"><img src="docs/assets/brand/euron-systems-light.svg" alt="Euron Systems: the SaaS platform for educators and creators. Visit euronsystems.com" width="31%"></picture></a>
  <a href="https://alphaeuron.com"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/alpha-euron-dark.svg"><img src="docs/assets/brand/alpha-euron-light.svg" alt="Alpha Euron: where school kids grow creativity and tech skills with AI. Visit alphaeuron.com" width="31%"></picture></a>
</p>

<p align="center">
  <a href="https://www.instagram.com/euron_official"><img src="https://img.shields.io/badge/Instagram-E4405F?style=flat-square&logo=instagram&logoColor=white" alt="Instagram"></a>
  <a href="https://www.linkedin.com/company/euronone/posts/"><img src="https://img.shields.io/badge/LinkedIn-0A66C2?style=flat-square&logo=linkedin&logoColor=white" alt="LinkedIn"></a>
  <a href="https://x.com/euron712"><img src="https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white" alt="X"></a>
  <a href="https://www.youtube.com/@Euron-official"><img src="https://img.shields.io/badge/YouTube-FF0000?style=flat-square&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://whatsapp.com/channel/0029VaeeJwq9RZAfPW9P2l07"><img src="https://img.shields.io/badge/WhatsApp_channel-25D366?style=flat-square&logo=whatsapp&logoColor=white" alt="WhatsApp channel"></a>
</p>

---

## 📚 Table of contents

- [Why Euron Open AI Chat](#-why-euron-open-ai-chat)
- [At a glance](#-at-a-glance)
- [Screenshots](#️-screenshots)
- [Features](#-features)
- [Architecture](#️-architecture)
  - [A turn, from send to done](#a-turn-from-send-to-done)
  - [Tools and the line between data and instructions](#tools-and-the-line-between-data-and-instructions)
  - [Branches](#branches)
  - [Data model](#data-model)
- [Tech stack](#-tech-stack)
- [Prerequisites](#-prerequisites)
- [Quickstart](#-quickstart)
- [Use real models](#-use-real-models)
- [Explore the repository](#-explore-the-repository)
- [API](#-api)
- [Configuration](#️-configuration)
- [Deploy to AWS](#️-deploy-to-aws)
- [Security model](#-security-model)
- [Testing](#-testing)
- [Documentation](#-documentation)
- [Roadmap](#️-roadmap)
- [FAQ](#-faq)
- [Contributing, security and license](#-contributing-security-and-license)

---

## 💡 Why Euron Open AI Chat

Most teams that want "ChatGPT, but ours" end up choosing between a hosted product they cannot
control and a weekend project that streams text but falls apart at the edges: answers lost when
a phone sleeps, tool output that can hijack the prompt, provider keys sitting in a database
table, usage logs full of what people typed, and no way to give one group more than another.

Euron Open AI Chat is a complete assistant you run yourself, with those edges done and tested:

- **Any model, one catalogue.** Admins add providers and models in `/admin`; the picker shows only
  models whose provider has a key. Mix OpenAI, Anthropic, Gemini and a local Ollama in one
  deployment, and weight each model against the daily allowance.
- **Answers that survive real networks.** Turns are decoupled from HTTP and resumable by sequence
  number; stop works from any device; a reload mid-answer rebuilds it from the event log.
- **Tools with guard rails.** Native function calling for search, page reading, images, memory and
  project files, bounded per turn, with results kept out of the system prompt.
- **Privacy by construction.** Admins see accounts, counts and configuration, never conversations.
  Shares are frozen copies. Usage rows and logs never hold message text.
- **Allowances without billing.** Quota tiers and per-person overrides, counted atomically across
  every API task, with a friendly message when a day's allowance runs out.

## 📊 At a glance

| | |
|---|---|
| **Apps** | Web app (Next.js) with the `/admin` control plane, API, background worker, and a stubs server standing in for the model providers, image generation, speech, moderation and web search |
| **Chat** | Streaming answers, model picker, regenerate and edit with branches, stop, titles, pin, archive, search, Markdown with tables, code and math, read aloud and dictation |
| **Knowledge** | Web search with numbered citations (SearXNG, Tavily, Exa or Brave), reading pages, attachments (images for vision models, PDF, Word, Excel, CSV, text and code), projects with instructions and searchable files, memory |
| **Images** | Generation and editing in chat or in a studio, a gallery, OpenAI or Gemini image models |
| **Control plane** | Users and roles, quota tiers and overrides, providers and models with a test call, settings and feature switches, shared links, audit log, usage overview |
| **Mobile-ready API** | Native token mode, resumable SSE that works from React Native, presigned uploads, opt-in push (FCM), a DOM-free typed client |
| **Infrastructure** | 13 Terraform modules, 3 environments (local emulator, AWS dev, AWS prod) |
| **Tests** | 318 unit, 185 integration on real Postgres and Redis, 13 browser end-to-end |
| **License** | MIT |

## 🖼️ Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/01-home.png" alt="The new chat screen with a greeting, the composer with search on and four suggestions, and the sidebar with projects, a pinned chat and chats grouped by day"><br><sub><b>New chat.</b> The composer, suggestions, and every chat grouped by day, with projects and pins.</sub></td>
    <td width="50%"><img src="docs/assets/screenshots/02-web-search-citations.png" alt="An answer about solid-state batteries with the search steps above it, numbered citations in the text and a list of sources below"><br><sub><b>Web search.</b> What the assistant did, citations in the answer, and the sources it used.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/03-code-and-branches.png" alt="An answer with a highlighted TypeScript code block, a copy button and a 2 of 2 version switcher"><br><sub><b>Code and branches.</b> Highlighted code with copy, and every regenerated version kept.</sub></td>
    <td><img src="docs/assets/screenshots/04-vision.png" alt="A whiteboard photo attached to a question and an answer describing the architecture in it"><br><sub><b>Vision.</b> Attach a photo or a screenshot; vision models see it, others are not offered it.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/05-image-in-chat.png" alt="A generated illustration of a lighthouse at dusk inside the conversation"><br><sub><b>Images in chat.</b> Ask for a picture and it appears in the thread and in your gallery.</sub></td>
    <td><img src="docs/assets/screenshots/06-math.png" alt="An answer with the compound interest formula rendered as typeset math"><br><sub><b>Math.</b> LaTeX rendered with KaTeX, inline and as display formulas.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/07-project.png" alt="A project page with its name, a composer, instructions, a knowledge file and the chats in the project"><br><sub><b>Projects.</b> Shared instructions and knowledge files for a group of chats.</sub></td>
    <td><img src="docs/assets/screenshots/08-project-chat.png" alt="A chat in a project answering from the project's launch brief with a table of risks and owners"><br><sub><b>Answers from your files.</b> The assistant searches the project's documents and says where it looked.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/09-model-picker.png" alt="The model picker open with two models, their descriptions and capability icons"><br><sub><b>Model picker.</b> Only models an admin enabled and configured, with what each can do.</sub></td>
    <td><img src="docs/assets/screenshots/10-composer-menu.png" alt="The composer's add menu with add photos and files and create an image"><br><sub><b>Composer.</b> Attach, paste or drop files, switch search on or off, draw, or dictate.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/11-images.png" alt="The image studio with a prompt box, aspect ratios and a gallery of generated images"><br><sub><b>Image studio.</b> Describe, pick a shape, create or edit, and browse everything you made.</sub></td>
    <td><img src="docs/assets/screenshots/12-settings.png" alt="Settings with theme, default model, answer length, web search, voice and today's use"><br><sub><b>Settings.</b> Default model, answer length, search, voice, and today's use against your allowance.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/13-personalization.png" alt="Personalization with what the assistant should know about you and how it should respond"><br><sub><b>Personalization.</b> Tell it about yourself and how you like answers.</sub></td>
    <td><img src="docs/assets/screenshots/14-memory.png" alt="The memory tab with a switch and a list of remembered facts, each with who saved it"><br><sub><b>Memory.</b> Everything it remembers, who saved it, and a way to forget each one.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/15-shared-link.png" alt="The public page of a shared conversation, readable without an account"><br><sub><b>Shared links.</b> A frozen copy anyone with the link can read; later messages stay private.</sub></td>
    <td><img src="docs/assets/screenshots/19-admin-overview.png" alt="The admin overview with users, active users, conversations, messages, images and weighted tokens, a daily chart and usage by model"><br><sub><b>Control plane.</b> Accounts and usage across the deployment, by day and by model.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/20-admin-user.png" alt="An admin user detail with status, role, tier, own limits and thirty days of usage"><br><sub><b>Users.</b> Tiers, own limits, suspensions and roles; never the person's chats.</sub></td>
    <td><img src="docs/assets/screenshots/21-admin-models.png" alt="Admin providers and models with key status, capabilities, weights and a test action"><br><sub><b>Models.</b> Providers with key status (never the key), models by kind, weights and a test call.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/22-admin-quotas.png" alt="Admin quota tiers with daily tokens, daily images and file size limits"><br><sub><b>Quotas.</b> Tiers with daily tokens, images and file size, and how many people use each.</sub></td>
    <td><img src="docs/assets/screenshots/23-admin-settings.png" alt="Admin settings with name, sign-up rules, feature switches, assistant guidance and retention"><br><sub><b>Settings.</b> Sign-up rules, feature switches, house rules for the assistant and retention.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/16-home-dark.png" alt="The new chat screen in dark mode"><br><sub><b>Dark mode.</b> Every screen, following the system setting or your choice.</sub></td>
    <td><img src="docs/assets/screenshots/18-answer-dark.png" alt="An answer with a numbered list and a table in dark mode"><br><sub><b>Tables and lists.</b> Clean Markdown in both themes.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/25-phone-chat.png" alt="A conversation with citations on a phone" width="48%"> <img src="docs/assets/screenshots/24-phone-sidebar.png" alt="The sidebar on a phone" width="48%"><br><sub><b>Phone.</b> Every screen works down to phone width.</sub></td>
    <td><img src="docs/assets/screenshots/17-image-dark.png" alt="A generated poster concept in a project chat, in dark mode"><br><sub><b>Drawing in a project.</b> Images use the same tools in every chat.</sub></td>
  </tr>
</table>

## ✨ Features

| Area | What you get |
|---|---|
| **Chat** | Streaming answers with a stop button, regenerate and edit as branches with a version switcher, automatic titles, rename, pin, archive, delete, search across titles and message text, copy, thumbs up or down, read aloud |
| **Models** | OpenAI, Anthropic and Gemini through their native APIs, plus any OpenAI-compatible endpoint (OpenRouter, Groq, Together, DeepInfra, Ollama, vLLM, LM Studio); a per-user default and a per-chat choice; vision, tools and reasoning flags per model |
| **Web** | A `web_search` tool with numbered sources (self-hosted SearXNG by default, or Tavily, Exa or Brave), an `open_url` tool that reads one page safely, and a single pre-search for models without function calling |
| **Files** | Images, PDF, Word, Excel, CSV, Markdown, JSON, text and source code; presigned uploads with progress, paste and drag and drop; images re-encoded without EXIF, documents read and indexed |
| **Projects** | Instructions and knowledge files shared by every chat in a project; the assistant searches the files with Postgres full-text search |
| **Memory** | A `remember` tool and a settings page to add, see and forget memories, plus "about you" and "how to respond" instructions |
| **Images** | Generation and editing in chat (as a tool, or an image mode in the composer) and in a studio, aspect ratios, a gallery |
| **Voice** | Dictation into the composer and read aloud for answers, through the configured speech models |
| **Sharing** | Frozen snapshot links with view counts, revocation by the owner or an admin, a public read-only page |
| **Account** | Sign-up with email verification (open, invite-only by email domain, or closed), two-factor sign-in with recovery codes, sessions, data export, account deletion with a grace period |
| **Control plane** | Overview, users (roles, tiers, own limits, suspend, ban, erase), quota tiers, providers and models with a test call, settings and feature switches, shared links, audit log |
| **Mobile clients** | Native token mode, resumable streams over SSE (fetch or XHR), presigned uploads, `minSupportedVersion` and feature flags in `/api/meta`, "your answer is ready" push through Firebase Cloud Messaging, armed per answer ([push guide](docs/guides/push.md)) |

## 🏗️ Architecture

<p align="center">
  <img src="docs/assets/diagrams/context.svg" alt="People use the web app and future mobile apps backed by the API, a worker, Postgres and Redis; the API calls model providers, web search, S3 and mail" width="100%">
</p>

- **One origin for the browser.** The load balancer routes `/api/*` to the API and everything else
  to the web app, so the refresh cookie is first-party and there is no CORS in production. Answers
  stream through the same path as Server-Sent Events.
- **Providers behind one interface.** Each adapter speaks its provider's own wire format with
  plain `fetch` and one SSE reader, and turns failures into stable codes
  ([ADR 0004](docs/architecture/adr/0004-providers-behind-one-interface.md)). Nothing above
  [`integrations/llm`](apps/api/src/integrations/llm) knows which provider answered.
- **Bytes bypass the API.** Uploads go straight to a private S3 bucket with presigned URLs; the
  API verifies the size and the magic bytes before it trusts a file.
- **The worker does the slow work.** Reading documents, re-encoding images, conversation summaries,
  retention and cleanup run on BullMQ queues in a separate service built from the same image.

### A turn, from send to done

<p align="center">
  <img src="docs/assets/diagrams/turn-streaming.svg" alt="The client sends a message; the API stores the question and an empty answer, starts the turn and streams its events; events go to a Redis Stream with sequence numbers and a pub/sub wake-up; any API task can serve GET /turns/:id/events?after=n to a client that reconnects" width="100%">
</p>

Sending stores the question and an empty answer in one transaction and starts the turn without
waiting for it ([`services/chat/turns.ts`](apps/api/src/services/chat/turns.ts)). Every event
(text deltas, tool steps, sources, images, the title, usage, done) is appended to the Redis
Stream `turn:<id>:events` under its sequence number and announced on pub/sub. Clients follow
`GET /api/turns/:id/events?after=<seq>` from any API task and miss nothing; stop reaches the
running turn through Redis; a crashed task's turn is failed by a sweep
([docs/api/streaming.md](docs/api/streaming.md),
[ADR 0005](docs/architecture/adr/0005-turns-decoupled-via-redis-streams.md)).

### Tools and the line between data and instructions

<p align="center">
  <img src="docs/assets/diagrams/tools-loop.svg" alt="The model may call web_search, open_url, generate_image, remember and search_project_files; each result goes back as a tool message labelled as untrusted data; at most four rounds and eight calls per turn" width="100%">
</p>

The system prompt is assembled on the server only: base rules, the deployment's guidance, the
project's instructions and the person's preferences (fenced and labelled as preferences), then
memories. Everything that came from outside goes back to the model as a tool message labelled as
untrusted ([ADR 0007](docs/architecture/adr/0007-tool-results-as-tool-messages.md)). `open_url`
resolves the host, refuses private, loopback, link-local and metadata addresses, pins the
connection to the vetted address and repeats the check on every redirect
([ADR 0008](docs/architecture/adr/0008-ssrf-guard-per-hop-with-dns-pinning.md)).

### Branches

Messages form a tree: regenerating adds a sibling answer, editing adds a sibling question, and the
conversation remembers which leaf is on screen. The context sent to a model is the path from the
root to that leaf, fitted to the model's window, with a rolling summary standing in for older
turns ([ADR 0006](docs/architecture/adr/0006-message-tree-for-branching.md)).

### Data model

<p align="center">
  <img src="docs/assets/diagrams/data-model.svg" alt="The tables grouped by area: identity, files, providers and models, conversations and messages, projects, memory, images, shares, quotas and usage, and operations" width="100%">
</p>

23 tables in one SQL migration. Provider keys have no column anywhere; usage rows hold counts and
model ids only; a share stores a snapshot, not a pointer. See
[docs/architecture/data-model.md](docs/architecture/data-model.md).

## 🧰 Tech stack

| Layer | Choice |
|---|---|
| Web | Next.js 15 (App Router), React 19, TanStack Query, Radix UI, Tailwind CSS, react-markdown with KaTeX and highlight.js |
| API | Node.js 22, Express 5, Kysely on PostgreSQL 16 (full-text and trigram search), zod |
| Streaming | Server-Sent Events, Redis Streams and pub/sub |
| Jobs | BullMQ on Redis 7 |
| Models | OpenAI, Anthropic and Gemini native APIs, and the OpenAI-compatible format, through plain `fetch` |
| Search | SearXNG (self-hosted, default), Tavily, Exa or Brave |
| Documents | unpdf, mammoth and exceljs for text; sharp for images |
| Mail | Amazon SES (or SMTP, or a local outbox) |
| Infrastructure | Terraform, ECS Fargate, ALB, CloudFront and WAF, RDS, ElastiCache, S3, KMS, SES, Secrets Manager, CloudWatch |
| Local AWS | The Floci emulator (S3, SES, KMS, Secrets Manager) and Mailpit ([ADR 0014](docs/architecture/adr/0014-floci-for-local-aws.md)) |
| Tooling | pnpm workspaces, Turborepo, TypeScript strict, Vitest, Playwright, ESLint, Prettier |

## 📋 Prerequisites

- Docker with Compose v2 (about 4 GB of memory for the containers)
- Node.js 22 and pnpm 9 (only to run tests or develop outside Docker)
- For real models: a key for at least one provider, or a local [Ollama](https://ollama.com)
- For AWS: an account, a domain in Route 53 with an ACM certificate, and Terraform 1.10 or later

No AWS account and no model key are needed to run it locally.

## 🚀 Quickstart

```bash
git clone https://github.com/euron-sde-team/euron-open-ai-chat.git
cd euron-open-ai-chat
make up      # the stack on emulated AWS, provisioned by the same Terraform as production
make demo    # a demo workspace: people, chats, a project, images, memories, a shared link
```

Open http://localhost:3540 and sign in as `priya.nair@example.com` (a person with a full history)
or `admin@example.com` (the control plane) with the password `make demo` prints. Every demo account
shares it.

| URL | What |
|---|---|
| http://localhost:3540 | The app (and `/admin`) |
| http://localhost:5036/api/ready | The API readiness check |
| http://localhost:8056 | Mailpit: every email the app sends |
| http://localhost:5129 | The stubs: models, images, speech, moderation and search stand-ins |
| http://localhost:8089 | SearXNG, the self-hosted web search |

Locally the demo models are deterministic stand-ins, so you can try every feature (search with
citations, vision, images, memory, project files, stop and resume) without a key. `make help`
lists every target; [docs/guides/quickstart-local.md](docs/guides/quickstart-local.md) explains
each step.

## 🤖 Use real models

1. Put a key in `deploy/compose/.env`, for example `OPENAI_API_KEY=sk-...`, or several at once:
   `PROVIDER_KEYS={"openai":"sk-...","anthropic":"sk-ant-...","openrouter":"sk-or-..."}`.
2. `make up` again. The starter catalogue already lists current OpenAI, Anthropic and Gemini
   models; a provider appears in the picker as soon as its key is configured.
3. In **Admin, Models**, pick the default model, adjust weights, and press **Test** to check a key
   and a model id in a second.

For a fully local setup, add an OpenAI-compatible provider with the base URL
`http://host.docker.internal:11434/v1` and add the Ollama models you pulled. Details for every
provider: [docs/guides/providers.md](docs/guides/providers.md).

## 🧭 Explore the repository

```
apps/
  api/          Express API and worker (one image, two commands)
    src/
      routes/          every endpoint, with its contract in a doc comment
      services/chat/   turns, the event log, context, tools, prompt, titles, summaries
      integrations/    llm (OpenAI, Anthropic, Gemini, OpenAI-compatible), images, search,
                       speech, moderation, fetch-page (the SSRF-safe reader), extract, storage
      domain/          pure rules: file types, chunking, network guard, usernames
  web/          Next.js: the chat app, the shared page, /admin
  stubs/        dependency-free provider stand-ins for development and tests
packages/
  types/        the API contract: DTOs and the turn event catalogue
  api-client/   typed client for web and React Native: refresh, uploads, resumable streams
  ui/           design tokens and primitives
db/migrations/  one SQL migration
deploy/compose/ the local stack (Floci, Mailpit, SearXNG, stubs)
infra/          Terraform modules and environments, Dockerfiles
docs/           architecture, ADRs, API, guides
e2e/            Playwright end-to-end tests
```

[docs/guides/walkthrough.md](docs/guides/walkthrough.md) follows one message from the composer to
the database and back, naming every file on the way.

## 🔌 API

- [REST contract](docs/api/rest-contract.md): envelopes, error codes, pagination, auth modes,
  uploads and rate limits.
- [Streaming](docs/api/streaming.md): every turn event with examples, resume and cancel, and
  JavaScript and React Native clients.
- [OpenAPI 3.1](docs/api/openapi.yaml): 99 operations, generated from the route files
  (`pnpm openapi`, checked in CI with `--check`).
- [`@open-chat/api-client`](packages/api-client): the typed client the web app uses, ready for a
  mobile app.

```bash
# Stream an answer from the command line
TOKEN=$(curl -s localhost:5036/api/auth/login -H 'content-type: application/json' \
  -d '{"login":"priya.nair@example.com","password":"<demo password>"}' | jq -r .accessToken)
curl -N localhost:5036/api/chats/new/messages -H "authorization: Bearer $TOKEN" \
  -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"content":"Explain HTTP caching in three sentences"}'
```

## ⚙️ Configuration

Server settings are environment variables, validated at boot
([`core/config.ts`](apps/api/src/core/config.ts)); production refuses to start with a development
secret or a test double still configured. Everything people can change at runtime lives in
**Admin, Settings**: the name, sign-up rules, feature switches, guidance added to every system
prompt, the default answer length, retention and the minimum app version. Every variable and
setting: [docs/guides/configuration.md](docs/guides/configuration.md).

## ☁️ Deploy to AWS

```bash
cp infra/terraform/envs/aws-dev/terraform.tfvars.example infra/terraform/envs/aws-dev/terraform.tfvars
make aws-plan ENV=aws-dev
make aws-deploy ENV=aws-dev
```

ECS Fargate services for the web app, the API and the worker behind one ALB (with the idle
timeout raised for streaming), RDS PostgreSQL, ElastiCache Redis, a private S3 bucket encrypted
with KMS, SES, CloudFront and WAF, and Secrets Manager holding the provider keys as one JSON
secret. See [docs/guides/deploy-aws.md](docs/guides/deploy-aws.md).

## 🔐 Security model

- **Every lookup is scoped to its owner in the query.** Another account's conversation, message,
  file, project or turn is a plain 404, never a 403 that confirms it exists.
- **Clients hold ids, never storage keys.** A message can only carry the sender's own processed
  files; downloads are short-lived signed URLs.
- **Tool output cannot become instructions.** Results are tool messages labelled untrusted; the
  system prompt is server-side and user text inside it is fenced.
- **Fetched pages cannot reach your network.** Private, loopback, link-local and metadata
  addresses are refused on every redirect hop, with the connection pinned to the vetted address.
- **Keys never leave the server.** No database column, no response field, no log line; admins see
  only whether a key is configured, and provider errors are mapped to stable codes before anyone
  sees them.
- **Conversations stay private.** No admin endpoint reads chats; usage rows and logs hold counts,
  never text; shares are frozen snapshots served through a route that only knows their own images.
- **Allowances hold under load.** Daily token and image counters are atomic across API tasks;
  every route has a rate limit, with tighter ones on sending, images, speech and sign-in.

The threat model and what remains open: [docs/architecture/threat-model.md](docs/architecture/threat-model.md).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## 🧪 Testing

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests in every package
make test-integration                      # the API against real Postgres and Redis, stubs in-process
make e2e                                   # Playwright against make up
pnpm openapi --check && make sanitize      # contract drift and secret hygiene
```

318 unit tests, 185 integration tests and 13 browser tests. The integration suite runs real turns
through the provider adapters and the in-process stubs: streaming, resume, cancel, every tool, the
SSRF guard against a redirect to the metadata address, a prompt-injection page that must never
reach the system prompt, quotas under parallel requests, and a canary key that must never appear
in any response or row. See [docs/guides/testing.md](docs/guides/testing.md).

## 📖 Documentation

| | |
|---|---|
| **Architecture** | [HLD](docs/architecture/HLD.md), [LLD](docs/architecture/LLD.md), [data model](docs/architecture/data-model.md), [chat engine](docs/architecture/chat-engine.md), [streaming and resume](docs/architecture/streaming-and-resume.md), [providers](docs/architecture/providers.md), [tools and safety](docs/architecture/tools-and-safety.md), [files](docs/architecture/files.md), [quotas](docs/architecture/quotas.md), [security](docs/architecture/security.md), [threat model](docs/architecture/threat-model.md) |
| **Decisions** | [14 architecture decision records](docs/architecture/adr/README.md) |
| **API** | [REST contract](docs/api/rest-contract.md), [streaming](docs/api/streaming.md), [OpenAPI](docs/api/openapi.yaml) |
| **Guides** | [Quickstart](docs/guides/quickstart-local.md), [configuration](docs/guides/configuration.md), [providers](docs/guides/providers.md), [web search](docs/guides/web-search.md), [deploy to AWS](docs/guides/deploy-aws.md), [operations](docs/guides/operations.md), [mobile clients](docs/guides/mobile-clients.md), [push notifications](docs/guides/push.md), [testing](docs/guides/testing.md), [troubleshooting](docs/guides/troubleshooting.md), [walkthrough](docs/guides/walkthrough.md) |

## 🗺️ Roadmap

- A React Native app for iOS and Android, served by this API
- Voice conversations in real time
- Retrieval with embeddings as an optional upgrade to full-text project search
- SSO with OpenID Connect

## ❓ FAQ

<details>
<summary><b>Do I need an API key to try it?</b></summary>

No. Locally every provider is a deterministic stand-in that speaks the real wire format, so search,
citations, vision, images, memory, project files and streaming all work. Add a key when you want
real answers.
</details>

<details>
<summary><b>Which models can I use?</b></summary>

Anything from OpenAI, Anthropic or Gemini through their native APIs, and any server that speaks the
OpenAI Chat Completions format: OpenRouter, Groq, Together, DeepInfra, Ollama, vLLM, LM Studio and
more. Admins choose which models people see.
</details>

<details>
<summary><b>Can admins read people's conversations?</b></summary>

No. There is no endpoint for it. Admins see accounts, counts and usage, the configuration, and
links people chose to share.
</details>

<details>
<summary><b>How do allowances work without billing?</b></summary>

Each person is on a quota tier (or the default) with daily weighted tokens and images; an admin
can override one person's numbers. A model's weight decides how much a token counts, so a large
model can use the allowance four times faster than a small one. Counters reset at midnight UTC.
</details>

<details>
<summary><b>Can I build a mobile app on it?</b></summary>

Yes, that is a design goal. Send `X-Client: native` to get the refresh token in the body, stream
with `followTurn` from `@open-chat/api-client` using the XHR transport, and resume when the app
comes back to the foreground. See [docs/guides/mobile-clients.md](docs/guides/mobile-clients.md).
</details>

<details>
<summary><b>Is the demo data real?</b></summary>

No. Every person and conversation is fictional, addresses use reserved example domains, and every
image is drawn by code.
</details>

## 🤝 Contributing, security and license

- Contributions: read [CONTRIBUTING.md](CONTRIBUTING.md) and the
  [code of conduct](CODE_OF_CONDUCT.md).
- Security issues: please report privately, as described in [SECURITY.md](SECURITY.md).
- License: [MIT](LICENSE).

Released under the [MIT License](LICENSE). Copyright (c) 2026 ENGAGESPHERE TECHNOLOGY
PRIVATE LIMITED and the Euron Open AI Chat contributors.

<p align="center">
  <sub>If Euron Open AI Chat is useful to you, <a href="https://github.com/euron-sde-team/euron-open-ai-chat/stargazers">star the repository</a>: it helps others find it.</sub>
</p>
