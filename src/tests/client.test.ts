import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { instrumentOpenAI } from "../adapters/openai.js";
import { instrumentAutoGen } from "../adapters/autogen.js";
import { llamaIndexCallback } from "../adapters/llamaindex.js";
import { semanticKernelFilters } from "../adapters/semantic-kernel.js";
import { Client } from "../core/client.js";
import { ConsoleTransport } from "../core/console-transport.js";
import { Config } from "../core/config.js";
import { instrument } from "../index.js";

// Every Client requires a declared agent name and owning team. The suite supplies them the way a
// containerized deployment does — through the environment — so each test can keep naming only the
// setting it is actually exercising. `identity is required` below removes them again.
process.env.GGATE_AGENT_NAME ??= "Test Agent";
process.env.GGATE_TEAM ??= "Test Team";

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

test("waited scan returns document topic and sensitivity classification", async () => {
  const transport = {
    async request() {
      return {
        verdict: "pass",
        message: "allowed",
        document_intelligence: {
          taxonomy: {
            topic: { label: "INVESTOR_RELATIONS", confidence: 0.94 },
            content_types: ["FINANCIAL_REPORT"],
            business_domains: ["FINANCE"],
            overall_confidence: 0.91,
          },
          sensitivity: {
            severity: "high",
            business_confidentiality_classes: ["material_non_public_information"],
            required_handling: ["HUMAN_REVIEW_BEFORE_EXTERNAL_SEND"],
          },
          matched_text: "Quarterly guidance",
        },
      };
    },
  };
  const client = new Client({ mode: "sync" }, transport as any);

  const decision = await client.scanPrompt("Quarterly guidance");

  assert.equal(decision.document_intelligence?.taxonomy.topic.label, "INVESTOR_RELATIONS");
  assert.equal(decision.document_intelligence?.sensitivity.severity, "high");
  assert.deepEqual(
    decision.document_intelligence?.sensitivity.business_confidentiality_classes,
    ["material_non_public_information"],
  );
});

test("legacy hard_block is normalized to the current block verdict", async () => {
  const client = new Client(
    { mode: "sync" },
    { async request() { return { verdict: "hard_block", message: "blocked" }; } } as any,
  );
  const decision = await client.scanPrompt("hello");
  assert.equal(decision.verdict, "block");
  assert.equal(decision.blocked, true);
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

test("every event names the agent and its owning team", async () => {
  const transport = new FakeTransport();
  const client = new Client(
    { mode: "sync", agentName: "JIRA Project Assistant", team: "Platform Engineering" },
    transport as any,
  );

  await client.scanPrompt("hello", { framework: "langgraph" });

  const scanTextReq = transport.requests.find((r) => r.op === "scan_text")!;
  assert.equal(scanTextReq.event.identity.agent_name, "JIRA Project Assistant");
  assert.equal(scanTextReq.event.identity.team, "Platform Engineering");
  // The declared name replaces nothing: the framework still travels where the Console reads it
  // for connector/logo resolution.
  assert.equal(scanTextReq.event.identity.agent_source, "agent-framework");
  assert.equal(scanTextReq.event.collector.labels.framework, "langgraph");
  assert.equal(scanTextReq.event.source.client, "langgraph");

  const readyReq = transport.requests.find((r) => r.op === "collector_ready")!;
  assert.equal(readyReq.metadata.agent_name, "JIRA Project Assistant");
  assert.equal(readyReq.metadata.team, "Platform Engineering");
});

test("identity is required, and an explicit value beats the environment", () => {
  const saved = { name: process.env.GGATE_AGENT_NAME, team: process.env.GGATE_TEAM };
  delete process.env.GGATE_AGENT_NAME;
  delete process.env.GGATE_TEAM;
  try {
    // Unlike a missing Console (which fails open), an unnamed agent is refused at construction:
    // it would otherwise mislabel every event it ever writes.
    assert.throws(() => new Client({ enabled: false }), /agentName is required/);
    assert.throws(
      () => new Client({ agentName: "Support Bot", enabled: false }),
      /team is required/,
    );
    // Whitespace is not a name.
    assert.throws(() => new Client({ agentName: "  ", team: "Ops", enabled: false }), /agentName/);

    process.env.GGATE_AGENT_NAME = "Env Agent";
    process.env.GGATE_TEAM = "Env Team";
    assert.equal(new Client({ enabled: false }).config.agentName, "Env Agent");
    assert.equal(
      new Client({ agentName: "Explicit Agent", enabled: false }).config.agentName,
      "Explicit Agent",
    );
  } finally {
    delete process.env.GGATE_AGENT_NAME;
    delete process.env.GGATE_TEAM;
    if (saved.name != null) process.env.GGATE_AGENT_NAME = saved.name;
    if (saved.team != null) process.env.GGATE_TEAM = saved.team;
  }
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

test("private CA trust cannot be combined with insecure TLS", () => {
  assert.throws(
    () => new Config({ consoleCaCert: "/tmp/console-ca.pem", consoleInsecureTls: true }),
    /cannot be used together/,
  );
  assert.equal(new Config({ consoleCaCert: "/tmp/console-ca.pem" }).consoleCaCert, "/tmp/console-ca.pem");
});

test("attachmentFromPath hashes the full file and bounds captured content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ggate-node-test-"));
  const filename = path.join(directory, "report.txt");
  try {
    fs.writeFileSync(filename, "classified report");
    const client = new Client({ enabled: false, captureFileText: true, maxFileBytes: 5 });
    const attachment = client.attachmentFromPath(filename);
    assert.equal(attachment.capture, "text");
    assert.equal(attachment.text, "class");
    assert.equal(attachment.truncated, true);
    assert.match(attachment.sha256 || "", /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test("console uses canonical Detection Engine auth and refreshes the token pair", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/api/v1/detection-engine/token")) {
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 1 });
    }
    if (url.endsWith("/api/v1/detection-engine/token/refresh")) {
      return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
    }
    return Response.json({ verdict: "pass", message: "allowed", document_intelligence: null });
  };

  try {
    const transport = new ConsoleTransport(
      new Config({ consoleUrl: "https://godels-gate.example.com", apiKey: "godel_test" }),
    );
    await transport.request({ op: "scan_text", event: {}, redaction: {} });
    await transport.request({ op: "scan_text", event: {}, redaction: {} });
    assert.equal(urls.filter((url) => url.endsWith("/api/v1/detection-engine/token")).length, 1);
    assert.equal(urls.filter((url) => url.endsWith("/api/v1/detection-engine/token/refresh")).length, 1);
    assert.equal(urls.some((url) => url.includes("/api/v1/agent/token")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("event builders carry current response, MCP, tool-result, and policy surfaces", async () => {
  const transport = new FakeTransport();
  const client = new Client({ mode: "sync" }, transport as any);

  await client.scanResponse("done", {
    wait: true,
    thinking: "analysis",
    thinking_redacted: false,
    subagent_type: "Explore",
  });
  await client.scanToolCall("search", { q: "x" }, { server_info: { transport: "stdio" } });
  await client.scanToolResult("bash", "failed", {
    wait: true,
    kind: "shell",
    ok: false,
    exit_code: 2,
    output_len: 100,
    truncated: true,
    duration_ms: 50,
  });
  await client.scanShell("curl https://example.com", { argv: ["curl", "https://example.com"] });
  await client.scanWeb("https://example.com/path", { method: "GET" });

  const events = transport.requests.filter((request) => request.op === "scan_text").map((request) => request.event);
  assert.equal(events[0].payload.thinking, "analysis");
  assert.equal(events[0].payload.subagent_type, "Explore");
  assert.deepEqual(events[1].payload.server_info, { transport: "stdio" });
  assert.equal(events[2].payload.ok, false);
  assert.equal(events[2].payload.exit_code, 2);
  assert.equal(events[3].payload.surface, "shell");
  assert.equal(events[4].payload.domain, "example.com");
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
