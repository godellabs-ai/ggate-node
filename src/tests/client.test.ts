import assert from "node:assert/strict";
import test from "node:test";
import { instrumentOpenAI } from "../adapters/openai.js";
import { instrumentAutoGen } from "../adapters/autogen.js";
import { llamaIndexCallback } from "../adapters/llamaindex.js";
import { semanticKernelFilters } from "../adapters/semantic-kernel.js";
import { Client } from "../core/client.js";
import { ConsoleTransport } from "../core/console-transport.js";
import { Config } from "../core/config.js";
import { instrument } from "../index.js";

class FakeTransport {
  requests: Record<string, any>[] = [];

  async request(request: Record<string, any>) {
    this.requests.push(request);
    return { kind: "verdict", verdict: "pass", message: "allowed" };
  }
}

test("sync prompt sends scan_text request", async () => {
  const transport = new FakeTransport();
  const client = new Client({ mode: "sync" }, transport as any);

  const decision = await client.scanPrompt("hello", { framework: "openai", model: "gpt-4o" });

  assert.equal(decision.blocked, false);

  const readyReq = transport.requests.find(r => r.op === "collector_ready");
  assert.ok(readyReq);
  assert.equal(readyReq.collector_type, "sdk");
  assert.equal(readyReq.name, "ggate-node-sdk");

  const scanTextReq = transport.requests.find(r => r.op === "scan_text");
  assert.ok(scanTextReq);
  assert.equal(scanTextReq.event.payload.surface, "prompt");
  assert.equal(scanTextReq.event.collector.labels.framework, "openai");
  assert.equal(scanTextReq.event.source.model, "gpt-4o");
});

test("correlation ids ride in source, not session; usage telemetry on responses", async () => {
  const transport = new FakeTransport();
  const client = new Client({ mode: "sync" }, transport as any);

  await client.scanResponse("hi", {
    wait: true,
    framework: "openai",
    model: "gpt-4o",
    conversation_id: "conv-1",
    request_id: "req-1",
    usage: { input_tokens: 10, output_tokens: 5 },
    duration_ms: 1200,
  });

  const scanTextReq = transport.requests.find(r => r.op === "scan_text")!;
  // The Rust Session struct has no model/conversation/request fields; they belong
  // to SourceContext and would be silently dropped from session.
  for (const key of ["model", "conversation_id", "request_id"]) {
    assert.equal(scanTextReq.event.session[key], undefined);
  }
  assert.equal(scanTextReq.event.source.conversation_id, "conv-1");
  assert.equal(scanTextReq.event.source.request_id, "req-1");
  assert.deepEqual(scanTextReq.event.payload.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(scanTextReq.event.payload.duration_ms, 1200);
});

test("derivable fields stay off the wire", async () => {
  const transport = new FakeTransport();
  const client = new Client({ mode: "sync" }, transport as any);

  await client.scanPrompt("hello");
  await client.scanToolResult("bash", "stdout", { kind: "shell", wait: true });

  const [prompt, result] = transport.requests.filter(r => r.op === "scan_text");
  // Sizes and the schema constant are the receiver's to fill (`RuntimeEvent::fill_derived`).
  assert.equal(prompt.event.schema_version, undefined);
  assert.equal(prompt.event.payload.length, undefined);
  assert.equal(result.event.payload.output_len, undefined);
  // A correlation nobody established, and the server process's cwd, are noise — not events.
  assert.equal(prompt.event.session.correlation_id, undefined);
  assert.equal(prompt.event.session.cwd, undefined);
  // The id and timestamp are NOT derivable: the id is the retry idempotency key, and the timestamp
  // is when the application saw the content, not when the Console received it.
  assert.ok(prompt.event.id);
  assert.ok(prompt.event.timestamp);
});

test("tool call defaults server to the framework and redacts input", async () => {
  const transport = new FakeTransport();
  // Redaction is opt-in: the Console is the detection engine, so the default sends raw
  // content. This exercises the deployments that turn masking on anyway.
  const client = new Client({ mode: "sync", redact: true }, transport as any);

  await client.scanToolCall("web_search", { query: "hello", auth: "token=abc1234567890" }, { framework: "langchain" });

  const scanTextReq = transport.requests.find(r => r.op === "scan_text")!;
  assert.equal(scanTextReq.event.payload.server, "langchain");
  assert.equal(scanTextReq.event.payload.input_summary.auth, "[REDACTED]");
});

test("decision parses the detection headline", async () => {
  const transport = {
    async request() {
      return {
        kind: "verdict",
        verdict: "block",
        message: "blocked",
        detection: { source: "sensitive_data", detail: "aws_access_key_id" },
      };
    },
  };
  const client = new Client({ mode: "sync" }, transport as any);

  const decision = await client.scanPrompt("hello");

  assert.equal(decision.blocked, true);
  assert.equal(decision.detection?.source, "sensitive_data");
});

test("breaker fails open without re-dialing after a transport failure", async () => {
  let calls = 0;
  const transport = {
    async request(request: Record<string, any>) {
      if (request.op === "collector_ready") return { kind: "ok" };
      calls += 1;
      throw new Error("down");
    },
  };
  const client = new Client({ mode: "sync" }, transport as any);

  await client.scanPrompt("first"); // trips the breaker
  const tripped = calls;
  const decision = await client.scanPrompt("second"); // inside the cooldown: no dial

  assert.equal(calls, tripped);
  assert.equal(decision.fail_open, true);
});

test("redaction is off by default; an explicit choice wins", () => {
  // The Console is the detection engine; masking client-side would hide what it exists to catch.
  const dflt = new Client({ consoleUrl: "https://godels-gate.example.com", apiKey: "godel_x", enabled: false });
  assert.equal(dflt.config.redact, false);

  const forced = new Client({
    consoleUrl: "https://godels-gate.example.com",
    apiKey: "godel_x",
    redact: true,
    enabled: false,
  });
  assert.equal(forced.config.redact, true);
});

/** Run `body` with GGATE_CONSOLE_URL/GGATE_API_KEY unset, then restore them. A developer
 * machine often exports a real key, which would otherwise decide these assertions. */
function withoutConsoleEnv<T>(body: () => T): T {
  const saved = { url: process.env.GGATE_CONSOLE_URL, key: process.env.GGATE_API_KEY };
  delete process.env.GGATE_CONSOLE_URL;
  delete process.env.GGATE_API_KEY;
  try {
    return body();
  } finally {
    if (saved.url != null) process.env.GGATE_CONSOLE_URL = saved.url;
    if (saved.key != null) process.env.GGATE_API_KEY = saved.key;
  }
}

test("the Console is the only destination", () => {
  const configured = new Client({
    consoleUrl: "https://godels-gate.example.com",
    apiKey: "godel_x",
    enabled: false,
  });
  assert.equal(configured.config.configured, true);

  // A URL without a key (or the reverse) is not a usable Console.
  withoutConsoleEnv(() => {
    assert.equal(new Client({ consoleUrl: "https://godels-gate.example.com", enabled: false }).config.configured, false);
    assert.equal(new Client({ apiKey: "godel_x", enabled: false }).config.configured, false);
    assert.equal(new Client({ enabled: false }).config.configured, false);
  });
});

test("without a Console every scan fails open", async () => {
  // The SDK has exactly one destination. With none configured there is nowhere to scan, and
  // the contract is to allow the call rather than break the application.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const client = withoutConsoleEnv(() => new Client({ mode: "sync" }));
    const decision = await client.scanPrompt("hello");
    assert.equal(decision.fail_open, true);
    assert.equal(decision.allowed, true);
    assert.match(decision.message, /GGATE_CONSOLE_URL/);
  } finally {
    console.warn = originalWarn;
  }
});

test("console token exchange distinguishes gateway failures from rejected keys", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"error":"upstream unavailable"}', {
      status: 502,
      headers: { "content-type": "application/json" },
    });

  try {
    const transport = new ConsoleTransport(
      new Config({
        consoleUrl: "https://godels-gate.example.com",
        apiKey: "godel_test",
      }),
    );
    await assert.rejects(
      () => transport.request({ op: "scan_text", event: {}, redaction: {} }),
      /console token exchange failed: HTTP 502/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI wrapper scans prompt and response", async () => {
  const transport = new FakeTransport();
  const sdkClient = new Client({ mode: "sync" }, transport as any);
  const openai = instrumentOpenAI(
    {
      chat: {
        completions: {
          async create() {
            return { choices: [{ message: { content: "hi" } }] };
          },
        },
      },
    },
    { sdkClient },
  );

  const result = await (openai as any).chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.choices[0].message.content, "hi");

  const scanTextReq = transport.requests.find(r => r.op === "scan_text");
  assert.ok(scanTextReq);
  assert.equal(scanTextReq.event.payload.surface, "prompt");
});

test("OpenAI wrapper scans Assistants thread messages and tool outputs", async () => {
  const transport = new FakeTransport();
  const sdkClient = new Client({ mode: "sync" }, transport as any);
  const openai = instrumentOpenAI(
    {
      beta: {
        threads: {
          messages: {
            async create(_threadId: string, params: any) {
              return { id: "msg_1", content: params.content };
            },
          },
          runs: {
            async create() {
              return { id: "run_1", messages: [{ content: "done" }] };
            },
            async submitToolOutputs() {
              return { id: "run_1" };
            },
          },
        },
      },
      files: {
        async create() {
          return { id: "file_1" };
        },
      },
    },
    { sdkClient },
  );

  await (openai as any).beta.threads.messages.create("thread_1", {
    content: "hello",
    attachments: [{ file_id: "file_1" }],
  });
  await (openai as any).beta.threads.runs.create("thread_1", {
    additional_messages: [{ role: "user", content: "run" }],
  });
  await (openai as any).beta.threads.runs.submitToolOutputs("thread_1", "run_1", {
    tool_outputs: [{ tool_call_id: "tool_1", output: "tool output" }],
  });

  const surfaces = transport.requests
    .filter(r => r.op === "scan_text")
    .map((request) => request.event.payload.surface);
  assert.ok(surfaces.includes("prompt"));
  assert.ok(surfaces.includes("tool_result"));
});

test("framework adapters route supported Node frameworks", async () => {
  const transport = new FakeTransport();
  const sdkClient = new Client({ mode: "sync" }, transport as any);

  assert.ok(instrument("langchain", { sdkClient }));
  assert.ok(instrument("langgraph", { sdkClient }));
  assert.ok(instrument("llamaindex", { sdkClient }));
  assert.ok(instrument("semantic-kernel", { sdkClient }));
  assert.ok(instrument("autogen", { agent: { async run() { return "done"; } }, sdkClient }));
});

test("AutoGen wrapper scans run boundary", async () => {
  const transport = new FakeTransport();
  const sdkClient = new Client({ mode: "sync" }, transport as any);
  const agent = instrumentAutoGen(
    {
      async run(task: string) {
        return `done ${task}`;
      },
    },
    { sdkClient },
  );

  await (agent as any).run("hello");

  assert.deepEqual(
    transport.requests.filter(r => r.op === "scan_text").map((request) => request.event.payload.surface),
    ["prompt", "response"],
  );
});

test("LlamaIndex callback scans start and end", async () => {
  const transport = new FakeTransport();
  const sdkClient = new Client({ mode: "sync" }, transport as any);
  const callback = llamaIndexCallback({ sdkClient });

  await callback.onEventStart("LLM", { prompt: "hello" }, "1");
  await callback.onEventEnd("LLM", { response: "hi" }, "1");

  assert.equal(transport.requests.filter(r => r.op === "scan_text").length, 2);
});

test("Semantic Kernel filters scan prompt and tool", async () => {
  const transport = new FakeTransport();
  const sdkClient = new Client({ mode: "sync" }, transport as any);
  const filters = semanticKernelFilters({ sdkClient });

  await filters.promptRenderFilter({ prompt: "hello", result: "hi" }, async () => undefined);
  await filters.functionInvocationFilter(
    { function: { name: "tool" }, arguments: { input: "x" }, result: "ok" },
    async () => undefined,
  );

  assert.ok(transport.requests.filter(r => r.op === "scan_text").length >= 2);
});
