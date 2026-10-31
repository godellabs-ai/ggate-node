import assert from "node:assert/strict";
import test from "node:test";
import { Client, GgateAgentContainedError, GgateBlockedError, instrumentOpenAI, langchainCallback, withSession } from "../index.js";
import { extractAttachments, stripPromptEcho, templateUserText, wrapRunMethods } from "../adapters/common.js";
import { llamaIndexCallback } from "../adapters/llamaindex.js";

class Console {
  events: any[] = [];
  locked = false;
  down = false;
  async request(request: any) {
    if (request.op !== "scan_text") return { kind: "ok" };
    if (this.down) throw new Error("console down");
    this.events.push(request.event);
    if (this.locked) {
      return { verdict: request.event.phase === "pre" ? "block" : "warn", message: "contained", reason_codes: ["agent_contained"] };
    }
    return { verdict: "pass", message: "allowed" };
  }
  surfaces() { return this.events.map((event) => event.payload.surface); }
  texts() { return this.events.map((event) => event.payload.text); }
  sessions() { return [...new Set(this.events.map((event) => event.session.session_id))]; }
}

const client = (console: Console, mode = "sync", extra: any = {}) =>
  new Client({ agentName: "A", team: "T", mode, cooldownSecs: 0, ...extra } as any, console as any);

test("withSession groups a prompt and response across awaits", async () => {
  const console = new Console();
  const sdk = client(console);
  await withSession("chat-1", async () => {
    await sdk.scanPrompt("q");
    await new Promise((resolve) => setTimeout(resolve, 1));
    await sdk.scanResponse("a", { wait: true });
  });
  assert.deepEqual(console.sessions(), ["chat-1"]);
});

test("LangChain: nested runs share the outer run and only the new turn is the prompt", async () => {
  const console = new Console();
  const handler = langchainCallback({ sdkClient: client(console) });
  handler.handleChainStart({}, {}, "graph");
  await handler.handleChatModelStart({}, [[
    { role: "system", content: "rules" }, { role: "user", content: "first" },
    { role: "assistant", content: "old" }, { role: "user", content: "second" }]], "llm", "graph");
  await handler.handleLLMEnd({ generations: [[{ text: "new" }]] }, "llm");
  await handler.handleChatModelStart({}, [[{ role: "user", content: "q" }, { role: "tool", content: "r" }]], "llm2", "graph");
  assert.deepEqual(console.texts(), ["second", "new"]);
  assert.deepEqual(console.sessions(), ["graph"]);
});

test("LangChain: run metadata names the session, and its end callback keeps it", async () => {
  const console = new Console();
  const handler = langchainCallback({ sdkClient: client(console) });
  await handler.handleLLMStart({}, ["hi"], "r", undefined, undefined, undefined, { thread_id: "t-1" });
  await handler.handleLLMEnd({ generations: [[{ text: "hello" }]] }, "r");
  assert.deepEqual(console.sessions(), ["t-1"]);
});

test("a local text completion records the user's words and the answer separately", async () => {
  const console = new Console();
  const handler = langchainCallback({ sdkClient: client(console) });
  const raw = "<|im_start|>system\nrules<|im_end|>\n<|im_start|>user\nCapital?<|im_end|>\n<|im_start|>assistant\n";
  await handler.handleLLMStart({}, [raw], "r");
  await handler.handleLLMEnd({ generations: [[{ text: `${raw}Paris.<|im_end|>` }]] }, "r");
  assert.deepEqual(console.texts(), ["Capital?", "Paris."]);
});

test("chat template markup cannot hide text from the scan", () => {
  const raw = "<|im_start|>system\nrules<|im_end|>\n<|im_start|>user\nSECRET<|im_end|>\n<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\n";
  const cleaned = templateUserText(raw);
  assert.ok(cleaned.includes("SECRET") && cleaned.includes("hello") && !cleaned.includes("rules"));
  assert.equal(stripPromptEcho("Paris is it", "Capital?"), "Paris is it");
});

test("a run's response excludes the task, and streams stay async iterables", async () => {
  const console = new Console();
  const messages = [{ source: "user", content: "the task" }, { source: "assistant", content: "the answer" }];
  const team: any = wrapRunMethods({
    run: async () => ({ messages }),
    runStream: async function* () { yield { messages }; },
  }, ["run", "runStream"], client(console), "autogen");
  await team.run("the task");
  const seen = [];
  for await (const item of team.runStream("again")) seen.push(item);
  assert.equal(seen.length, 1);
  assert.deepEqual(console.texts(), ["the task", "the answer", "again", "the answer"]);
});

test("LlamaIndex records the model call only", async () => {
  const console = new Console();
  const handler = llamaIndexCallback({ sdkClient: client(console) });
  await handler.onEventStart("retrieve", { query: "not a prompt" }, "1");
  await handler.onEventStart("llm", { messages: [{ role: "user", content: "q" }] }, "2");
  await handler.onEventEnd("llm", { response: "a" }, "2");
  assert.deepEqual(console.texts(), ["q", "a"]);
});

const openai = (create: (params: any) => any) => ({ chat: { completions: { create } } });

test("OpenAI: a stream passes through and is recorded; a tool step does not repeat the prompt", async () => {
  const console = new Console();
  async function* stream() {
    yield { choices: [{ delta: { content: "Hel" } }] };
    yield { choices: [{ delta: { content: "lo" } }] };
  }
  const wrapped: any = instrumentOpenAI(openai(() => stream()), { sdkClient: client(console) });
  const result = await wrapped.chat.completions.create({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  for await (const _ of result);
  assert.deepEqual(console.texts(), ["hi", "Hello"]);

  const plain: any = instrumentOpenAI(openai(() => ({ choices: [{ message: { content: "done" } }] })), { sdkClient: client(console) });
  console.events = [];
  await plain.chat.completions.create({ model: "m", metadata: { session_id: "conv-1" }, messages: [
    { role: "user", content: "q" }, { role: "tool", tool_call_id: "c1", content: "42" }] });
  assert.deepEqual(console.surfaces(), ["tool_result", "response"]);
  assert.deepEqual(console.sessions(), ["conv-1"]);
});

test("multimedia: audio and video parts become attachments, never prompt text", async () => {
  const console = new Console();
  const sdk = client(console, "sync", { captureFileText: true });
  const data = Buffer.alloc(120, 7).toString("base64");
  const [audio] = extractAttachments({ type: "input_audio", input_audio: { data, format: "wav" } }, sdk);
  assert.equal(audio!.mime_type, "audio/wav");
  assert.ok(audio!.filename!.endsWith(".wav"));
  assert.equal(audio!.capture, "content");
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80)]).toString("base64");
  assert.ok(jpeg.startsWith("/9j/"));
  const [image] = extractAttachments([{ type: "image", base64: jpeg, mime_type: "image/jpeg" }], sdk);
  assert.equal(image!.capture, "content");
  const [video] = extractAttachments([{ type: "video", base64: data, mime_type: "video/mp4" }], sdk);
  assert.equal(video!.mime_type, "video/mp4");
  const wrapped: any = instrumentOpenAI(openai(() => ({ choices: [] })), { sdkClient: sdk });
  await wrapped.chat.completions.create({ model: "m", messages: [{ role: "user", content: [
    { type: "text", text: "listen" }, { type: "input_audio", input_audio: { data, format: "wav" } }] }] });
  assert.equal(console.events[0].payload.text, "listen");
  assert.equal(console.events[0].payload.attachments.length, 1);
});

test("Kill Switch: thrown without enforce, seen in audit mode, held through an outage, then released", async () => {
  const console = new Console();
  console.locked = true;
  const sync = client(console);
  await assert.rejects(sync.scanPrompt("hello"), (error: unknown) => error instanceof GgateAgentContainedError && error instanceof GgateBlockedError);

  const audit = client(console, "async");
  assert.equal((await audit.scanPrompt("queued")).blocked, false);
  await audit.flush(5000);
  assert.equal(audit.contained, true);
  await assert.rejects(audit.scanPrompt("next"), GgateAgentContainedError);

  console.down = true;
  await assert.rejects(audit.scanPrompt("outage"), /Kill Switch held/);
  console.down = false;
  console.locked = false;
  assert.equal((await audit.scanPrompt("after unlock")).blocked, false);
  assert.equal(audit.contained, false);
});

test("Kill Switch: an outage without a lock still fails open", async () => {
  const console = new Console();
  console.down = true;
  const decision = await client(console).scanPrompt("hello");
  assert.equal(decision.fail_open, true);
  assert.equal(decision.allowed, true);
});
