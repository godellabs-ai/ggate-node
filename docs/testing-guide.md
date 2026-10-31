# SDK Testing Guide

Use this guide in three layers: unit tests, a live-Console smoke test, and Console validation.

## 1. Unit Tests

These need no Console: the transport is stubbed.

```bash
npm install
npm run build
npm test
```

Expected result: the TypeScript build passes and all tests pass.

## 2. Live Console Smoke Test

This validates the SDK as a main-product collector.

Prerequisites:

- A reachable Console (`GGATE_CONSOLE_URL`).
- An IAM API key from Console UI -> Admin -> API keys (`GGATE_API_KEY`).



```bash
npm install
npm run build
GGATE_MODE=sync \
GGATE_CONSOLE_URL=https://godel-gate.example.com \
GGATE_API_KEY=godel_... \
  node --input-type=module - <<'JS'
import { init, scanPrompt } from "./dist/index.js";

init({ agentName: "Smoke Test", team: "Platform Engineering", mode: "sync" });
const decision = await scanPrompt("Gödel Gate SDK smoke test", {
  framework: "manual",
  model: "test",
});
console.log(decision);
JS
```

Pass criteria:

- With the Console reachable, `fail_open` should be `false`.
- The event should appear in the Console's Activity stream.
- Point `GGATE_CONSOLE_URL` at an unreachable host and the same script should continue and return
  a fail-open pass decision; unset it entirely and it should do the same, logging which setting is
  missing.

## 3. Policy Enforcement Test

Use a policy/detector input that is known to block in your environment. Do not assume a generic text
prompt will block unless the policy says so.

```ts
import { init, scanPrompt } from "@ggate/sdk";

init({ agentName: "Smoke Test", team: "Platform Engineering", mode: "sync" });
const decision = await scanPrompt("YOUR_KNOWN_BLOCK_FIXTURE", { framework: "manual" });
if (decision.verdict !== "block") throw new Error(JSON.stringify(decision));
```

Pass criteria:

- Sync mode returns `verdict=block` before the LLM/provider call.
- Framework adapters using `enforce: true` raise/throw before the underlying call.
- Async mode records the event but does not block.

## 4. Framework Smoke Tests

Run each with fake/model-stub providers first, then with a real provider key.

| Framework | Smoke test |
|---|---|
| LangChain/LangGraph | Pass the handler from `instrument("langchain")` / `instrument("langgraph")` in the invoke config. Run one LLM call and one tool call. |
| AutoGen | Wrap the agent/team with `instrument("autogen", { agent })`. Run `agent.run(...)`. |
| OpenAI | Wrap the OpenAI client with `instrument("openai", { client })`. Test `chat.completions.create`, `responses.create`, `files.create`, `beta.threads.messages.create`, and `beta.threads.runs.create`. |
| OpenAI Agents SDK (Swarm) | `setDefaultOpenAIClient(instrument("openai-swarm", { client }))` and `instrument("openai-swarm", { agent })`. Run one tool call and one handoff path. |
| LlamaIndex | Register the callback handler from `instrument("llamaindex")`. Run one query. |
| Semantic Kernel | Attach the filters from `instrument("semantic-kernel")`. Invoke one prompt function and one tool/function. |

CrewAI, Haystack, DSPy, and Phidata/Agno are Python-only frameworks; see the Python SDK for those
adapters.

## 5. Edge Cases To Verify Before Release

- Console unreachable or unconfigured: SDK returns fail-open pass and the app still works.
- Console slow: `GGATE_TIMEOUT_MS` applies per HTTP request (per socket operation in Python); token work and retries can extend a whole scan. Queued calls do not wait; explicit response/tool-result waits still do.
- Expired access token: the SDK refreshes its pair; rejected refresh/API key fails open rather than throwing.
- Queue overflow: async queue drops oldest events and does not grow unbounded.
- Blocked prompt: provider call is not made.
- Blocked tool call: tool function is not made where the framework filter/wrapper supports preflight.
- Streaming output: app receives stream; final output is audited after consumption.
- File upload: file metadata is captured; optional text/content capture follows configured caps.
- Generated file: SDK captures metadata when visible through file APIs; otherwise call `scan_file`.
- Concurrent requests: correlation IDs differ per request and events do not leak context.
- Redaction: secrets are masked before leaving the app process.
- Disabled SDK: `GGATE_DISABLED=1` returns pass and emits nothing.

## 6. Console Validation

With the Console stack running:

1. Run the smoke script above.
2. Open Activity.
3. Filter by `collector.labels.language=node`.
4. Filter by `collector.labels.framework`.
5. Confirm prompt, response, tool, and file events are visible.
6. Confirm fail-open decisions are not produced when the Console is healthy.

## 7. What To Automate In CI

- Node build/tests on active LTS Node versions.
- Contract test of emitted `scan_text` events against the Console's event crates (the Rust crates
  are the wire-shape source of truth).
- Stub-Console HTTP integration test.
- Real-Console e2e test against a running deployment.
- Console e2e test that verifies events reach Activity.

## Local Console contract check

The mock in `postman/mocks/console` follows Gate's checked-out `ScanTextResponse` and token
exchange models. It is a local fixture for our own API, not a published vendor mock. It returns
a pass with incomplete attachment coverage, topic-resolution metadata, and unavailable file
classification so both SDKs must preserve those fields without turning them into a block.
It does not execute Gate's detector pipeline or validate live credentials.

From the Node SDK checkout, start it in one terminal:

```bash
postman simulation run postman/simulations/console.sim.yaml --port 4918 --output ndjson
```

In another terminal, from the same checkout:

```bash
npm run build
node postman/check-sdk.mjs
# If the Python SDK checkout is alongside this repository:
PYTHONPATH=../ggate-python/src python3 postman/check-python.py
```

Confirm the simulation log contains token exchange and scan requests for both clients. Stop
that simulation with Ctrl-C after the check. Unit tests also cover absent metadata from older
Consoles and preserving coverage metadata on both pass and block decisions.

## Microsoft 365 integration tests

The test suite uses the installed Microsoft Agents SDK TurnContext, exercising blocked inbound
messages, outgoing sends, batch atomicity, and message updates. The transport is simulated, so
these tests do not validate a live Microsoft tenant or Gate detector configuration.

In 0.2.1, `enforce` always waits, including when the default mode is audit. For responses and
tool results it also declares a pre-delivery boundary. A plain waited audit remains `post`.
