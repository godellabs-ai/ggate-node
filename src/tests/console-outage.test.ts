import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "../core/client.js";
import { Config } from "../core/config.js";
import { ConsoleTransport, GgateConsoleUnreachableError, GgateTransportError } from "../core/console-transport.js";
import { CONSOLE_OUTAGE_MESSAGE, decisionFromResponse } from "../core/decision.js";

process.env.GGATE_AGENT_NAME ??= "Test Agent";
process.env.GGATE_TEAM ??= "Test Team";

const PASS = { kind: "verdict", verdict: "pass", message: "allowed" };
// The Console's answer when the rule blocks this user and every other user of this agent.
const BLOCK_ALL = { ...PASS, console_outage_action: "block", console_outage_fallback: "block" };

/** Answers each scan with the next scripted value; errors are thrown. */
class ScriptedTransport {
  constructor(private readonly replies: unknown[]) {}

  async request(request: Record<string, any>) {
    if (request.op !== "scan_text") return { kind: "ok" };
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply as Record<string, any>;
  }
}

function client(replies: unknown[], cooldownSecs = 0) {
  return new Client({ mode: "sync", cooldownSecs }, new ScriptedTransport(replies) as any);
}

const refused = () => new GgateConsoleUnreachableError("refused");

test("blocks when the Console said so and is unreachable", async () => {
  const sdk = client([BLOCK_ALL, refused()]);
  assert.equal((await sdk.scanPrompt("hello")).blocked, false);
  assert.equal(sdk.consoleOutageAction(), "block");
  const decision = await sdk.scanPrompt("hello");
  assert.equal(decision.blocked, true);
  assert.equal(decision.fail_open, false);
  assert.deepEqual(decision.reason_codes, ["console_unreachable"]);
  assert.equal(decision.message, CONSOLE_OUTAGE_MESSAGE);
});

test("remembers answers per user", async () => {
  // The Console blocks Alice only: other users of this agent keep failing open.
  const aliceOnly = { ...PASS, console_outage_action: "block", console_outage_fallback: "allow" };
  const sdk = client([aliceOnly, refused(), refused()]);
  await sdk.scanPrompt("hello", { user: "Alice@Acme.com" });
  assert.equal(sdk.consoleOutageAction("alice@acme.com"), "block");
  assert.equal((await sdk.scanPrompt("hello", { user: "alice@acme.com" })).blocked, true);
  assert.equal((await sdk.scanPrompt("hello", { user: "bob@acme.com" })).fail_open, true);
});

test("a fail-closed default lets a listed user through", async () => {
  const aliceExempt = { ...PASS, console_outage_action: "allow", console_outage_fallback: "block" };
  const sdk = client([aliceExempt, refused(), refused()]);
  await sdk.scanPrompt("hello", { user: "alice@acme.com" });
  assert.equal((await sdk.scanPrompt("hello", { user: "alice@acme.com" })).fail_open, true);
  assert.equal((await sdk.scanPrompt("hello", { user: "bob@acme.com" })).blocked, true);
});

test("cooldown keeps blocking without calling the Console", async () => {
  const sdk = client([BLOCK_ALL, refused()], 60);
  await sdk.scanPrompt("hello");
  assert.equal((await sdk.scanPrompt("hello")).blocked, true);
  // Nothing scripted remains: this answer comes from the breaker.
  assert.equal((await sdk.scanPrompt("hello")).blocked, true);
});

test("a Console that answered keeps failing open", async () => {
  const sdk = client([BLOCK_ALL, new GgateTransportError("HTTP 401")]);
  await sdk.scanPrompt("hello");
  const decision = await sdk.scanPrompt("hello");
  assert.equal(decision.blocked, false);
  assert.equal(decision.fail_open, true);
});

test("allow, unknown and never-learned settings fail open", async () => {
  for (const first of [
    { ...PASS, console_outage_action: "allow", console_outage_fallback: "allow" },
    PASS,
    { ...PASS, console_outage_action: "closed", console_outage_fallback: "closed" },
  ]) {
    const sdk = client([first, refused()]);
    await sdk.scanPrompt("hello");
    assert.equal((await sdk.scanPrompt("hello")).fail_open, true);
  }
  assert.equal((await client([refused()]).scanPrompt("hello")).fail_open, true);
});

test("follows the operator switching back to allow", async () => {
  const allowAll = { ...PASS, console_outage_action: "allow", console_outage_fallback: "allow" };
  const sdk = client([BLOCK_ALL, allowAll, refused()]);
  await sdk.scanPrompt("hello");
  await sdk.scanPrompt("hello");
  assert.equal((await sdk.scanPrompt("hello")).blocked, false);
});

async function scanWith(reply: () => Promise<Response>, event = {}): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/v1/detection-engine/token")) {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    return reply();
  }) as typeof fetch;
  try {
    const transport = new ConsoleTransport(new Config({ consoleUrl: "https://console.example", apiKey: "godel_test" }));
    return await transport.request({ op: "scan_text", event, redaction: {} });
  } catch (error) {
    return error;
  } finally {
    globalThis.fetch = original;
  }
}

test("partial responses enforce only a bound Console decision and retain model coverage", async () => {
  for (const status of [503, 504]) {
    for (const verdict of ["block", "warn", "pass"]) {
      let calls = 0;
      const reply = { event_id: "this-event", policy_resolved: true, decision: { verdict, message: "policy", fail_open: false },
        model_status: { state: "partial", attempted: 2, completed: 1 } };
      const result = await scanWith(async () => { calls++; return Response.json(reply, { status }); }, { id: "this-event" });
      assert.ok(result && typeof result === "object" && "verdict" in result);
      const decision = decisionFromResponse(result);
      assert.equal(calls, 1);
      assert.equal(decision.verdict, verdict);
      assert.equal(decision.blocked, verdict === "block");
      assert.equal(decision.fail_open, verdict !== "block");
      assert.deepEqual(decision.model_status, reply.model_status);
      for (const change of [{ event_id: "other" }, { policy_resolved: false }, { decision: { verdict } }]) {
        const error = await scanWith(async () => Response.json({ ...reply, ...change }, { status }), { id: "this-event" });
        assert.ok(error instanceof GgateTransportError);
      }
    }
  }
});

test("no connection and gateway pages are unreachable", async () => {
  for (const reply of [
    async () => { throw new TypeError("fetch failed"); },
    async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
    async () => new Response("", { status: 503 }),
  ]) {
    assert.ok((await scanWith(reply)) instanceof GgateConsoleUnreachableError);
  }
});

test("Console answers and slow scans are not unreachable", async () => {
  for (const reply of [
    async () => Response.json({ error: "model deadline exceeded", policy_resolved: true }, { status: 503 }),
    async () => new Response("", { status: 401 }),
    async () => { throw new DOMException("The operation timed out.", "TimeoutError"); },
  ]) {
    const error = await scanWith(reply);
    assert.ok(error instanceof GgateTransportError);
    assert.ok(!(error instanceof GgateConsoleUnreachableError));
  }
});
