import assert from "node:assert/strict";
import test from "node:test";
import {
  Client, GgateAgentContainedError, GgateBlockedError, currentUser, instrumentOpenAI,
  withSession, withUser,
} from "../index.js";
import { decisionFromResponse } from "../core/decision.js";

const policy = { id: "access-123", name: "Engineering only", description: "Application access" };
class Console {
  events: any[] = [];
  locks = new Set<string>();
  down = false;
  verdict = "pass";
  async request(request: any) {
    if (request.op !== "scan_text") return { kind: "ok" };
    if (this.down) throw new Error("console down");
    const event = request.event;
    this.events.push(event);
    if (this.locks.has(`${event.identity.user}:${event.source.client}`)) {
      return { verdict: event.phase === "pre" ? "block" : "warn", reason_codes: ["agent_contained"] };
    }
    return { verdict: this.verdict, message: "Application access policy", reason_codes: ["ai_access_restricted"],
      policy_source: policy, matched_policies: [policy] };
  }
}
const client = (console: Console, mode: "sync" | "async" = "sync") => new Client({
  agentName: "Operations Assistant", team: "Platform", user: "service@example.com", mode, cooldownSecs: 0,
}, console);

test("concurrent scopes retain user and named agent/framework on every surface", async () => {
  const console = new Console();
  const sdk = client(console);
  await Promise.all(["alice@example.com", "bob@example.com"].map(user => withUser(user, () =>
    withSession(user, async () => {
      await Promise.resolve();
      const options = { framework: "langgraph", enforce: true };
      await sdk.scanPrompt("q", options);
      await sdk.scanResponse("a", options);
      await sdk.scanToolCall("search", {}, options);
      await sdk.scanToolResult("search", "found", options);
      await sdk.scanShell("pwd", options);
      await sdk.scanFile("/tmp/report.txt", options);
      await sdk.scanWeb("https://example.com", options);
    }))));
  assert.equal(console.events.length, 14);
  for (const event of console.events) {
    assert.equal(event.identity.user, event.session.session_id);
    assert.equal(event.identity.agent_name, "Operations Assistant");
    assert.equal(event.identity.agent_source, "agent-framework");
    assert.equal(event.source.client, "langgraph");
    assert.equal(event.collector.labels.framework, "langgraph");
  }
  assert.equal(currentUser(), undefined);
  await sdk.scanPrompt("outside");
  assert.equal(console.events.at(-1).identity.user, "service@example.com");
});

test("explicit user wins; null and blank clear the fallback; nested scopes restore after errors", async () => {
  const console = new Console();
  const sdk = client(console);
  await withUser(" alice@example.com ", async () => {
    await sdk.scanPrompt("override", { user: "bob@example.com" });
    await sdk.scanPrompt("anonymous", { user: null });
    await sdk.scanPrompt("anonymous", { user: "  " });
    await assert.rejects(withUser(null, async () => {
      await sdk.scanPrompt("anonymous");
      throw new Error("app error");
    }));
    await sdk.scanPrompt("restored");
  });
  assert.deepEqual(console.events.map(e => e.identity.user), ["bob@example.com", undefined, undefined, undefined, "alice@example.com"]);
  assert.equal(currentUser(), undefined);
  await assert.rejects(sdk.scanPrompt("bad", { user: 123 as any }), TypeError);
});

test("shared OpenAI adapter and queued responses retain the request user", async () => {
  const console = new Console();
  const sdk = client(console);
  const api = instrumentOpenAI({ chat: { completions: { create: async (_options: any) => ({
    choices: [{ message: { content: "answer" } }],
  }) } } }, { sdkClient: sdk });
  await Promise.all(["alice@example.com", "bob@example.com"].map(user => withUser(user, () =>
    api.chat.completions.create({ model: "test", messages: [{ role: "user", content: user }] }))));
  assert.equal(await sdk.flush(), true);
  for (const user of ["alice@example.com", "bob@example.com"]) {
    const events = console.events.filter(e => e.identity.user === user);
    assert.deepEqual(events.map(e => e.payload.surface), ["prompt", "response"]);
  }
});

for (const verdict of ["pass", "warn", "block"]) {
  test(`access ${verdict} preserves attribution and never latches a Kill Switch`, async () => {
    const console = new Console(); console.verdict = verdict;
    const sdk = client(console, "async");
    let decision;
    try {
      decision = await sdk.scanPrompt("q", { user: "alice@example.com", enforce: true });
      assert.notEqual(verdict, "block");
    } catch (error) {
      assert.equal(verdict, "block");
      assert.ok(error instanceof GgateBlockedError);
      assert.ok(!(error instanceof GgateAgentContainedError));
      decision = error.decision;
    }
    assert.deepEqual(decision.matched_policies, [policy]);
    assert.equal(decision.policy_source?.id, policy.id);
    assert.equal(sdk.contained, false);
    console.verdict = "pass";
    assert.equal((await sdk.scanPrompt("retry", { user: "alice@example.com", enforce: true })).allowed, true);
  });
}

for (const mode of ["sync", "async"] as const) {
  test(`Kill Switch is isolated by user and framework, including queued results (${mode})`, async () => {
    const console = new Console(); console.locks.add("alice@example.com:openai");
    const sdk = client(console, mode);
    const alice = { user: "alice@example.com", framework: "openai" };
    if (mode === "sync") await assert.rejects(sdk.scanPrompt("q", alice), GgateAgentContainedError);
    else { await withUser(alice.user, () => sdk.scanPrompt("q", { framework: "openai" })); await sdk.flush(); }
    assert.equal(sdk.contained, true);
    await sdk.scanPrompt("other user", { ...alice, user: "bob@example.com", enforce: true });
    await sdk.scanPrompt("other framework", { ...alice, framework: "langchain", enforce: true });
    assert.equal(sdk.contained, true);
    console.down = true;
    await assert.rejects(sdk.scanPrompt("locked", { ...alice, user: "ALICE@example.com" }), GgateAgentContainedError);
    assert.equal((await sdk.scanPrompt("unlocked", { ...alice, user: "bob@example.com", enforce: true })).fail_open, true);
    assert.equal((await sdk.scanPrompt("unlocked", { ...alice, framework: "langchain", enforce: true })).fail_open, true);
    console.down = false; console.locks.clear();
    await sdk.scanPrompt("released", alice);
    assert.equal(sdk.contained, false);
  });
}

test("older Consoles without matched policies remain compatible", () => {
  assert.deepEqual(decisionFromResponse({ verdict: "pass" }).matched_policies, []);
});
