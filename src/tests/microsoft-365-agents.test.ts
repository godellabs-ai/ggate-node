import assert from "node:assert/strict";
import test from "node:test";
import { CloudAdapter, TurnContext } from "@microsoft/agents-hosting";
import { Activity } from "@microsoft/agents-activity";
import { Client, GgateBlockedError, instrument, Microsoft365AgentsMiddleware } from "../index.js";
import { decisionFromResponse } from "../core/decision.js";

function setup(mode: "sync" | "async" = "sync") {
  const events: any[] = [];
  const client = new Client({ agentName: "M365 test", team: "Tests", mode }, {
    async request(request) {
      if (request.op === "collector_ready") return {};
      events.push(request.event);
      const blocked = JSON.stringify(request.event.payload).includes("DENY") && request.event.phase === "pre";
      return { verdict: blocked ? "block" : "pass", message: "policy decision" };
    },
  });
  const adapter = new CloudAdapter();
  const sent: any[] = [];
  adapter.sendActivities = async (_ctx, activities) => { sent.push(...activities); return activities.map(() => ({ id: "sent" })); };
  adapter.updateActivity = async (_ctx, activity) => { sent.push(activity); return { id: "updated" }; };
  const middleware = new Microsoft365AgentsMiddleware(client);
  adapter.use(middleware); // Typecheck against Microsoft's actual Middleware contract.
  const context = new TurnContext(adapter, Activity.fromJson(JSON.stringify({ type: "message", text: "hello", id: "turn-1", channelId: "msteams", serviceUrl: "https://channel.example.test",
    conversation: { id: "conversation-1", tenantId: "tenant-1" }, from: { id: "user-1" }, recipient: { id: "agent-1" } })));
  return { client, middleware, adapter, context, events, sent };
}

test("M365 real TurnContext scans incoming/outgoing with conversation metadata", async () => {
  const { middleware, context, events, sent, client, adapter } = setup();
  assert.ok(instrument("m365", { sdkClient: client, adapter }));
  await middleware.onTurn(context, async () => { await context.sendActivity("answer"); });
  assert.equal(sent.length, 1);
  assert.deepEqual(events.map(e => [e.payload.surface, e.phase]), [["prompt", "pre"], ["response", "pre"]]);
  assert.ok(events.every(e => e.session.session_id === "m365:msteams:tenant-1:conversation-1"));
});

for (const boundary of ["incoming", "send", "update", "batch"] as const) {
  test(`M365 block prevents ${boundary}`, async () => {
    const { middleware, context, sent } = setup();
    if (boundary === "incoming") context.activity.text = "DENY";
    let entered = false;
    await assert.rejects(middleware.onTurn(context, async () => {
      entered = true;
      if (boundary === "update") await context.updateActivity({ type: "message", text: "DENY", id: "existing" } as any);
      else if (boundary === "batch") await context.sendActivities([
        { type: "message", text: "ok" }, { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { text: "DENY" } }] },
      ] as any);
      else await context.sendActivity("DENY");
    }), GgateBlockedError);
    assert.equal(sent.length, 0);
    assert.equal(entered, boundary !== "incoming");
  });
}

test("explicit delivery enforcement waits in audit mode; audit-only calls remain post", async () => {
  const { client, events } = setup("async");
  await assert.rejects(client.scanPrompt("DENY", { enforce: true }), GgateBlockedError);
  await assert.rejects(client.scanResponse("DENY", { enforce: true }), GgateBlockedError);
  await assert.rejects(client.scanToolResult("tool", "DENY", { enforce: true }), GgateBlockedError);
  assert.ok(events.every(e => e.phase === "pre"));
  await client.scanResponse("old audit", { wait: true });
  assert.equal(events.at(-1).phase, "post");
});

test("Gate media policy metadata survives response parsing", () => {
  assert.deepEqual(decisionFromResponse({ verdict: "block", media_gate: { action: "block" } }).media_gate, { action: "block" });
});

test("proactive turns without activity IDs retain one correlation ID", () => {
  const { middleware, context } = setup();
  context.activity.id = undefined;
  assert.equal(middleware.metadata(context).correlation_id, middleware.metadata(context).correlation_id);
});

test("framework adapters respect audit mode while explicit enforcement can override it", async () => {
  const { client } = setup("async");
  const handler = instrument("langchain", { sdkClient: client });
  await handler.handleLLMStart({}, ["DENY"]);
  await handler.handleToolStart({ name: "tool" }, "DENY");
  await client.flush();
});
