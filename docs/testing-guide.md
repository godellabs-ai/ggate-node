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
GGATE_CONSOLE_URL=https://godels-gate.example.com \
GGATE_API_KEY=godel_... \
  node --input-type=module - <<'JS'
import { init, scanPrompt } from "./dist/index.js";

init({ mode: "sync" });
const decision = await scanPrompt("Godel's Gate SDK smoke test", {
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

init({ mode: "sync" });
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
| OpenAI Swarm | Wrap the Swarm client with `instrument("openai-swarm", { client })`. Run one handoff path. |
| LlamaIndex | Register the callback handler from `instrument("llamaindex")`. Run one query. |
| Semantic Kernel | Attach the filters from `instrument("semantic-kernel")`. Invoke one prompt function and one tool/function. |

CrewAI, Haystack, DSPy, and Phidata/Agno are Python-only frameworks; see the Python SDK for those
adapters.

## 5. Edge Cases To Verify Before Release

- Console unreachable or unconfigured: SDK returns fail-open pass and the app still works.
- Console slow: sync timeout is bounded by `GGATE_TIMEOUT_MS`; async mode does not block.
- Rejected/expired API key: the SDK re-exchanges once, then fails open rather than throwing.
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
