# Jira Project Assistant

An example **LangGraph (Node.js)** agent guarded end-to-end by the **Godel's Gate SDK**.
A chat UI (styled like the Gödel's Gate console) answers questions such as
*"Describe the ticket ECS-55"* or *"Show all in progress tasks"* by driving OpenAI GPT
with **Atlassian Jira MCP** tools — and every piece of content on the way is scanned:

| What | When | On block |
|---|---|---|
| User prompt | before the agent runs | chat turn aborted |
| Each MCP tool call (name + arguments) | before the tool executes | chat turn aborted |
| Each MCP tool result (ticket details, descriptions, search results) | before the model sees it | chat turn aborted |
| Every Jira **attachment** on a returned ticket (content fetched via Jira REST) | after the tool result | chat turn aborted |
| Final assistant answer | before the UI shows it | chat turn aborted |

Blocks surface in the chat as a red "Chat blocked by Gödel's Gate" card naming the
protection that fired; every message carries an expandable trail of the scans it went through.

## How scanning works here

With `GGATE_CONSOLE_URL` + `GGATE_API_KEY` set, scans go to the Console's
`POST /api/v1/scan` endpoint, which evaluates the detection rules + DLP + policy engine,
records the event (visible in the Console's Activity view under the
`agent-framework:langgraph` connector), and returns the verdict. The API key is
exchanged once for a short-lived device JWT (`/api/v1/agent/token`), so per-scan auth
is a stateless signature check — warm scans take ~50 ms. Nothing runs on the machine
beside this app: the Console is the SDK's only dependency.

**Deep scans (file/image OCR).** The Console runs the full pipeline for every scan — the SDK sends
attachment bytes, and the Console extracts/OCRs them, classifies with the ML model and document
intelligence, and records the verdict as usual. That is what lets an image's pixel-text (a
screenshot carrying a jailbreak, say) be caught rather than passed through as an opaque blob.

There is no silent downgrade to a light text-only scan: if the Console cannot complete a scan,
`POST /api/v1/scan` returns an error (503 / 502) rather than a weaker verdict — the SDK's own
fail-open/closed policy then decides what to do on the client side.

## Setup

### 1. Console

Point the example at a Godel's Gate Console (`https://godels-gate.example.com`, or
`https://localhost` for a locally running one).

Create an API key: Console UI → **Admin → API keys** (or `POST /api/v1/api-keys` with an
admin JWT). Keys look like `godel_...` and are shown once.

### 2. Configure

```bash
cp .env.example .env.local     # then fill in:
#   GGATE_CONSOLE_URL=https://localhost
#   GGATE_API_KEY=godel_...
#   OPENAI_API_KEY=sk-...
#   JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN   (see below)
```

**Real Jira site** — the agent uses the community
[`mcp-atlassian`](https://github.com/sooperset/mcp-atlassian) MCP server via `uvx`
(install [uv](https://docs.astral.sh/uv/) first). The same credentials are used to
fetch attachment content over Jira's REST API for scanning.

**No Jira site?** Use the bundled mock (five tickets, live attachment serving):

```bash
# in .env.local
JIRA_MCP_COMMAND=node
JIRA_MCP_ARGS=["mock/jira-mock-server.mjs"]
```

### 3. Run

```bash
npm install
npm run dev                    # builds @ggate/sdk from this repo, then serves http://localhost:3010
```

The example consumes the SDK from the repo root (`"@ggate/sdk": "file:../.."`), so edits to
`src/` show up here after `npm run dev` rebuilds it. To run it against the published SDK
instead, swap that dependency for
`git+https://github.com/godellabs-ai/ggate-node.git` and drop the `build:sdk` step.

For local development, `npm run dev` gives `GGATE_*` values declared in this
project's `.env.local`/`.env` precedence over stale values inherited from the
shell. This prevents an unrelated exported `GGATE_API_KEY` from causing token
exchange 401s. Production `npm start` continues to use deployment environment
variables normally.

## Try it

- **"Describe the ticket ECS-55"** — clean path: tool call, ticket JSON, and the
  `webhook-debug.log` attachment all scan `pass`; the answer renders with its scan trail.
- **"Show all in progress tasks"** — JQL search rendered as a table.
- **"Describe the ticket ECS-99"** (mock) — the ticket's `incident-notes.txt` attachment
  contains leaked AWS credentials; the attachment scan comes back `block` and the chat
  is stopped with a *Sensitive data* detection card. The blocked event appears in the
  Console's Activity view.

## Where things live

- `lib/ggate.ts` — SDK client + `TurnGuard`: collects scan verdicts for the UI and aborts
  the LangGraph run (via `AbortSignal`) the moment anything blocks.
- `lib/agent.ts` — `createReactAgent` over OpenAI GPT (`gpt-5.5`) with each MCP tool
  wrapped to scan its input and output before anything else happens.
- `lib/jira.ts` — attachment discovery in tool results + REST content fetch.
- `app/api/chat/route.ts` — one chat turn: scan prompt → run agent → scan reply.
- `mock/jira-mock-server.mjs` — stdio MCP server faking Jira + an HTTP endpoint for
  attachment bodies, so the whole pipeline (including attachment scanning) runs for real.
