# Gödel Gate Node.js SDK

`@ggate/sdk` turns an AI agent application into a Gödel Gate collector: a few lines of code
capture framework activity (prompts, responses, tool calls, tool results, file access) as
`gate/v1` runtime events, send them for detection + policy evaluation, and — in sync mode —
enforce the returned verdict.

SDK events carry `identity.agent_source = "agent-framework"` and
`collector.collector_type = "sdk"`; the specific AI framework (langchain, openai, autogen, …)
travels in `collector.labels.framework` and `source.client`, which the Console renders as
`agent-framework:<framework>` connectors.

The Python SDK is [godellabs-ai/ggate-python](https://github.com/godellabs-ai/ggate-python).

## Release compatibility

This SDK release is **0.3.1**, released with Gödel Gate Console **0.3.1**.
Install a release tag rather than the moving default branch. Keep the SDK release selected by your Console when maintaining an older deployment.
SDK patch releases may advance independently within **0.3.x**. Keep an older SDK release for an older Console and validate minor upgrades together.

### Microsoft 365 Agents SDK

```ts
import { init, instrument } from "@ggate/sdk";

const gate = init({ agentName: "Microsoft 365 Assistant", team: "Platform Engineering", mode: "sync" });
// adapter is your existing Microsoft Agents CloudAdapter.
const middleware = instrument("microsoft-365-agents", { adapter, sdkClient: gate });
```

The middleware checks incoming content and outgoing sends/updates through public TurnContext
hooks, including inline cards and invoke values. It throws `GgateBlockedError` before continuing
a blocked operation. Catch it at your application's error boundary without echoing blocked content.
No Microsoft package is loaded by Gate itself; the host application supplies its Agents SDK.

Model calls and tools inside handlers still require their own adapter or explicit scans. Use
`middleware.metadata(context)` as scan options to correlate these calls with the same conversation.
Remote attachments are metadata-only, and Microsoft-managed internal execution is not visible.

### Changes in 0.3.1

- Decisions type the Console's optional `pipeline_status.file_extension_exemptions`: the files
  whose extension a Console exemption excluded from scanning, as `{ filename, extension }` entries.
  It reports scan coverage and does not change the verdict.
- Documents that Gate masks evaluated events before storage; SDK redaction remains optional.
- Released with Console 0.3.1. No runtime or API behavior changes from 0.3.0.

### Changes in 0.3.0

- **Kill Switch.** A lock in the Console raises `GgateAgentContainedError` (a `GgateBlockedError`) in
  `sync` and `async` mode, even where the caller did not pass `enforce`. In `async` mode the first
  queued verdict turns scanning synchronous, so an unlock is seen at the next scan. A known lock stays
  in force while the Console cannot confirm its release; an outage with no lock still fails open.
- **Sessions.** `await withSession(conversationId, () => runAgent(text))` puts every event of a turn in
  one session, across all adapters. LangChain and LangGraph also read `session_id` / `thread_id` from
  run metadata and share a session across nested runs.
- **One event, one text.** Prompts hold the newest user message, not the resent history. Responses hold
  the answer, without the task or an echoed prompt or chat template. LlamaIndex records only LLM events.
- **Responses in `sync` mode** are checked by adapters before they are returned, so a block withholds
  the answer. This adds one waited scan per model call. Streamed text cannot be recalled.
- **Streaming** OpenAI calls are recorded when the stream ends. LangChain adapters stop on a block by
  themselves, and `runStream` wrappers stay async iterables.
- **Media.** Audio and video parts join images and files: OpenAI `input_audio`, LangChain `audio`/`video`
  blocks, Anthropic-style `source` blocks, and `@openai/agents` tools through `instrument("openai-agents", { agent })`.

### Changes in 0.2.1

- `enforce: true` always waits, even when the default mode is `async`.
- `scanResponse` and `scanToolResult` accept `enforce: true`: content is checked before delivery,
  with `phase: "pre"`, and a block throws. Call these before releasing the content.
- `before_delivery: true` waits and declares the same boundary but returns the verdict for the
  caller to handle. `wait: true` alone remains a `post` audit scan.
- Decisions preserve Gate's `media_gate`, and scan options accept explicit `source_trust`.
- The [Jira example](examples/jira-project-assistant/README.md) uses delivery preflights for tool
  results, attachments, and the final answer, with refreshed dependencies and lockfile.

## Install

```bash
npm install git+https://github.com/godellabs-ai/ggate-node.git#v0.3.1
```

The package compiles on install (`prepare`), so no separate build step is needed. Node 22.19.0+.

## Quickstart

```ts
import { init, scanPrompt, scanResponse, instrument } from "@ggate/sdk";

init({
  agentName: "JIRA Project Assistant", // required: what the Console lists this agent as
  team: "Platform Engineering",        // required: who owns it
  mode: "sync",
});

const decision = await scanPrompt("Summarize this document", {
  framework: "langchain",
  model: "gpt-4o",
});
if (decision.blocked) throw new Error(decision.message);

await scanResponse("Summary text", { framework: "langchain", model: "gpt-4o" });

const openai = instrument("openai", { client: new OpenAI() });
```

Framework instrumentation — see [docs/framework-coverage.md](docs/framework-coverage.md) for the
full matrix of what each adapter hooks and where it can enforce.

### Naming your agent

`agentName` and `team` are required, and `init()` throws without them (or without
`GGATE_AGENT_NAME` / `GGATE_TEAM`). They are the two facts the SDK cannot work out for itself:

- **`agentName`** is what this agent *is*, as an operator would name it — `"JIRA Project
  Assistant"`, not the framework it is built on. The Console lists sessions under this name, so
  three assistants built on LangGraph stay three distinguishable agents. The framework is still
  reported alongside it and still drives the connector view.
- **`team`** is the workload's owning team. User identity comes from the configured `user` /
  `GGATE_USER`, falling back to the runtime machine's `<os-user>@<hostname>`. Shared applications
  should bind their authenticated user per request as described below.

`agentName` usually belongs in code (every install of an app is the same named agent), while
`team` usually belongs in the environment (it varies per deployment).

### AI access rules and application users

The Console's **Policies → Authorised AI** access rules apply to SDK scans. Select the named
application (`agentName`), its framework, or all supported agents. The Console resolves users,
groups, and user tags from its endpoint directory. `team` describes workload ownership; it does
not grant directory group membership.

In a shared application, bind the authenticated user's endpoint email or directory alias for the
whole request. Use a value verified by your server's authentication layer, never an identity
supplied directly in a prompt or request body:

```ts
import { withUser, withSession, scanPrompt, scanResponse } from "@ggate/sdk";

await withUser(authenticatedUserEmail, () => withSession(conversationId, async () => {
  // Explicit preflight waits even if GGATE_MODE=async; a block throws GgateBlockedError.
  await scanPrompt(prompt, { framework: "langgraph", enforce: true });
  const answer = await runAgent(prompt);
  await scanResponse(answer, { framework: "langgraph", enforce: true });
  // Deliver only after the final scan returns.
}));
```

`withUser` follows async calls and instrumented adapters and restores the previous identity on
exit. A scan's `{ user }` option overrides the scope; the scope overrides configured `user` /
`GGATE_USER`. An explicit `null` or blank user means anonymous and clears the fallback. Set it
explicitly for unauthenticated requests. Without an override, existing single-user/service
deployments keep their configured identity. `currentUser()` returns the scoped value, or
`undefined` outside a scope.

Block rules prevent operations only when scans run before the operation with `enforce: true`, or
the application checks the returned verdict. Adapter enforcement follows `GGATE_MODE=sync`.
Audit calls cannot prevent an operation already performed. Warn remains an allowed decision for
the application to present; `decision.policy_source` and `decision.matched_policies` retain policy
IDs and names, including Monitor matches. Ordinary access blocks are evaluated again at the next
scan. Cached Kill Switch locks are separate per user and framework; `client.contained` means at
least one such lock is known.

SDK API keys do not establish a human provider login or subscription plan. Approved **provider
account domains** and observed plan tags come from coding-agent/browser collectors. SDK access
rules use the endpoint user's Console identity and existing directory tags; the SDK does not
claim provider email, plan, groups, or tags from request metadata. Existing transport fail-open
behavior is unchanged; applications requiring fail-closed preflight must also check `decision.fail_open`.

## Connecting to a Console

The Console is the SDK's only destination. Set its URL and an IAM API key (Console UI →
**Admin → API keys**) and scans go to `POST /api/v1/scan`, which runs the full pipeline —
normalize, OCR/extraction of image and file attachments, deterministic rules, the security
classifier, DLP, threat intel, document intelligence, and policy — records the event, and
returns the verdict plus any topic/sensitivity classification:

```bash
GGATE_CONSOLE_URL=https://godel-gate.example.com
GGATE_API_KEY=godel_...
```

The API key is exchanged at `/api/v1/detection-engine/token` for an access/refresh token pair.
The SDK rotates that pair through `/api/v1/detection-engine/token/refresh`, so per-scan auth is a
stateless signature check and hourly access-token renewal does not repeat the API-key hash.

For a Console signed by a private CA, set `GGATE_CONSOLE_CA_CERT=/path/to/ca.pem`. TLS verification
stays enabled. `GGATE_CONSOLE_INSECURE=1` is an explicit development-only escape hatch.

Both are required. With either missing the SDK logs one warning at startup and every scan fails
open with a message naming what is unset — a configuration mistake must not break the
application, and it must not silently look like an all-clear either.

The SDK sends **unredacted** content by default. The Console is the detection engine, so
client-side masking would hide exactly the secrets it exists to catch; set `GGATE_REDACT=1` for
deployments that would rather lose those detections than let the content leave the process.

Gate is responsible for masking the evaluated event before storage, including nested tool
arguments and detected personal data. Keep Gate updated with its storage-redaction fixes;
an SDK update cannot protect records written by an older server. A block prevents the guarded
action, but the content has already been sent to Gate for evaluation. SDK masking is an optional,
pattern-based privacy control, not a substitute for server-side storage masking.

## Verdicts

A scan returns a `Decision`: `verdict` (`pass` | `warn` | `block` | `system`),
`message`, `reason_codes`, and — on warn/block — a `detection` headline naming which protection
fired (`{ source: "sensitive_data", detail: "aws_access_key_id", … }`). `decision.blocked` /
`decision.allowed` are the convenience accessors; passing `enforce: true` throws
`GgateBlockedError` on a block instead.

When the Console produces document intelligence, a waited scan also returns
`decision.document_intelligence` in the same normalized shape stored in event JSON:

```ts
const intel = decision.document_intelligence;
console.log(intel?.taxonomy.topic.label, intel?.sensitivity.severity);
console.log(intel?.sensitivity.sensitive_data_classes);
```

This field is classification context, not an enforcement finding. It is available only when the
call waits for the Console (`sync` prompt/tool/file/shell/web scans, or `wait: true` on response and
tool-result scans). Queued calls return an immediate local pass with `document_intelligence: null`.

### Scan coverage and file classification

A successful HTTP response may include `decision.pipeline_status` with `errors`, `warnings`,
`media`, and `visual_codes`. These describe coverage and evidence, independently of the verdict:
a `pass` with `attachment_scan_incomplete` is not confirmation that every attachment was scanned.
Missing pipeline status on a queued/local pass does not establish coverage either.

Document intelligence can also include `file_classification` (provider-qualified labels,
`status`, and `gate_sensitivity_available`) and `taxonomy.topic.resolution` (topic uncertainty
and resolution provenance). An `unavailable` file-classification status is not a clean result.

## Latency and failure semantics

Transport failures fail open; missing agent identity and explicit block enforcement can still raise errors:

- **Sync mode** blocks prompt, tool-call, file, shell, and web scans until the verdict. `GGATE_TIMEOUT_MS` (default 4000) applies to each HTTP request
  (Python uses a socket-operation timeout), not a whole-scan deadline. Token exchange, refresh,
  and retries can add to the total time. Raise it for attachments that need extraction or OCR. Responses and tool results are
  queued by default; pass `wait: true` to receive classification, or `enforce: true` for a
  block-capable tool-result boundary.
- **Async mode** (`init({ mode: "async" })`) queues preflight scans and returns an immediate local
  pass. Explicit `wait` on response/tool-result scans and all `enforce` calls still wait
  for the Console in either mode.
- **Fail open**: any problem reaching the Console (unreachable, restarting, slow, rejected key,
  unconfigured) yields an allow decision with `fail_open: true`. After a failure the SDK fails
  open instantly for a cooldown (`GGATE_COOLDOWN_SECS`, default 30) instead of re-calling a
  struggling Console on every request.
- **Background queue**: bounded (`GGATE_QUEUE_MAX`, drop-oldest), retries transient failures
  with capped backoff, and its shutdown flush is deadline-bounded (`GGATE_FLUSH_TIMEOUT_MS`,
  default 3000) so application exit never hangs. Call `flush()` to drain explicitly.
- **Redaction**: with `GGATE_REDACT` on, known secret patterns are masked before anything leaves
  the process; the original content hash + mask count travel in the scan's redaction summary.

## Configuration

`GGATE_CONSOLE_URL` and `GGATE_API_KEY` are required, as are the agent's name and owning team
(in code or via `GGATE_AGENT_NAME` / `GGATE_TEAM`); everything else has a default. Identity
falls back to the device config at `~/.ggate/config.yaml` when an agent installed on the same
machine wrote one — read for identity only, so SDK events land under the same org/seat/device as
that machine's other collectors. Environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `GGATE_AGENT_NAME` | agent name — **required** (or `agentName`) | unset |
| `GGATE_TEAM` | owning team — **required** (or `team`) | unset |
| `GGATE_MODE` | `sync` (enforce) or `async` (observe) | `sync` |
| `GGATE_CONSOLE_URL` | Console base URL, e.g. `https://godel-gate.example.com` — **required** | unset |
| `GGATE_API_KEY` | Console IAM API key (`godel_...`) — **required** | unset |
| `GGATE_CONSOLE_CA_CERT` | PEM CA used to verify a private-CA Console | system trust |
| `GGATE_CONSOLE_INSECURE` | Dev only: accept a self-signed Console certificate | off |
| `GGATE_TIMEOUT_MS` | per-request timeout (Python: socket-operation timeout) | 4000 |
| `GGATE_DISABLED` | `1` disables the SDK entirely | off |
| `GGATE_HOME` | where the device config is looked for | `~/.ggate` |
| `GGATE_CONFIG` | device config.yaml path (identity defaults only) | `$GGATE_HOME/config.yaml` |
| `GGATE_ORG_ID` | organization id | config `org_id`, else `local` |
| `GGATE_USER` / `GGATE_USER_EMAIL` | seat identity | config `user_email`, else `<os-user>@<host>` |
| `GGATE_WORKSTATION_ID` | stable device id | config `workstation_id` |
| `GGATE_COLLECTOR_ID` | collector id | `<workstation_id>:ggate-node-sdk` |
| `GGATE_QUEUE_MAX` | background queue bound | 1024 |
| `GGATE_COOLDOWN_SECS` | fail-open cooldown after a failure | 30 |
| `GGATE_FLUSH_TIMEOUT_MS` | default/atexit flush deadline | 3000 |
| `GGATE_REDACT` | mask secrets before sending | off |
| `GGATE_CAPTURE_FILE_TEXT` | capture attachment content (else metadata only) | off |
| `GGATE_MAX_FILE_BYTES` | attachment capture cap | 65536 |

The same values can be passed programmatically to `init({ … })`.

## Example

[examples/jira-project-assistant](examples/jira-project-assistant) is a complete application: a
LangGraph Jira assistant whose prompts, MCP tool traffic, attachments, and answers are all
scanned, with blocking chat UX.

## Development

```bash
npm install
npm run build     # src/ -> dist/ (tsc)
npm test          # node --test dist/tests/
```

See [docs/testing-guide.md](docs/testing-guide.md) for the layered test approach — unit tests, a
live-Console smoke test, policy enforcement, and per-framework checks.

## License

Apache-2.0 — see [LICENSE](LICENSE).
