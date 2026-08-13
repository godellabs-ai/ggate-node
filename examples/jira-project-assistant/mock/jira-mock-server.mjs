#!/usr/bin/env node
/**
 * A tiny stdio MCP server that fakes just enough of Jira to demo the assistant
 * without a real Atlassian site. It also serves attachment content over
 * http://127.0.0.1:3011 so the attachment-scanning path is exercised for real.
 *
 * Tickets: ECS-55 (clean — the happy path), ECS-99 carries an attachment with
 * leaked credentials, so "Describe the ticket ECS-99" demonstrates Godel's Gate
 * blocking the chat.
 *
 * Use via .env:  JIRA_MCP_COMMAND=node  JIRA_MCP_ARGS=["mock/jira-mock-server.mjs"]
 */

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ATTACHMENT_PORT = 3011;

const ATTACHMENT_BODIES = {
  "1001": [
    "webhook-debug.log",
    "2026-07-20T09:14:02Z stripe webhook id=evt_9f2 retry=3 status=504",
    "2026-07-20T09:14:31Z upstream timeout after 30s, connection reset",
    "2026-07-20T09:15:00Z retry queue depth=42, alerting on-call",
  ].join("\n"),
  "1002": [
    "# incident scratchpad — DO NOT COMMIT",
    "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "api_key=sk-live-51HqXaz9prod-super-secret-key",
  ].join("\n"),
};

const ISSUES = {
  "ECS-55": {
    key: "ECS-55",
    summary: "Payment service intermittently drops Stripe webhooks",
    status: "In Progress",
    assignee: "Priya Sharma",
    priority: "High",
    created: "2026-07-14",
    description:
      "Stripe webhook deliveries time out roughly twice an hour since the 2.31 deploy. " +
      "Retries eventually succeed but ordering is no longer guaranteed. Suspect the new " +
      "connection pool cap. See webhook-debug.log for a captured failure window.",
    comments: [
      { author: "Marco Ruiz", body: "Reproduced on staging with pool cap 10. Raising to 50 clears it." },
      { author: "Priya Sharma", body: "Draft PR up; needs load-test sign-off before merge." },
    ],
    attachment: [
      {
        filename: "webhook-debug.log",
        mimeType: "text/plain",
        size: ATTACHMENT_BODIES["1001"].length,
        content: `http://127.0.0.1:${ATTACHMENT_PORT}/attachment/content/1001`,
      },
    ],
  },
  "ECS-99": {
    key: "ECS-99",
    summary: "Rotate credentials leaked in incident scratchpad",
    status: "In Progress",
    assignee: "Unassigned",
    priority: "Highest",
    created: "2026-07-19",
    description:
      "During the payment-webhook incident someone attached a scratchpad with live keys. " +
      "Rotate everything referenced in incident-notes.txt and purge the attachment.",
    comments: [],
    attachment: [
      {
        filename: "incident-notes.txt",
        mimeType: "text/plain",
        size: ATTACHMENT_BODIES["1002"].length,
        content: `http://127.0.0.1:${ATTACHMENT_PORT}/attachment/content/1002`,
      },
    ],
  },
  "ECS-12": {
    key: "ECS-12",
    summary: "Add SSO login to the merchant dashboard",
    status: "To Do",
    assignee: "Unassigned",
    priority: "Medium",
    created: "2026-07-08",
    description: "Support Okta and Entra ID via OIDC. Blocked on the tenant model decision.",
    comments: [],
    attachment: [],
  },
  "ECS-31": {
    key: "ECS-31",
    summary: "Nightly reconciliation job exceeds its window",
    status: "In Progress",
    assignee: "Marco Ruiz",
    priority: "Medium",
    created: "2026-07-11",
    description: "The 02:00 reconciliation run now takes 5h40m. Needs partitioning by merchant id.",
    comments: [],
    attachment: [],
  },
  "ECS-42": {
    key: "ECS-42",
    summary: "Upgrade payment-service to Node 22",
    status: "Done",
    assignee: "Priya Sharma",
    priority: "Low",
    created: "2026-06-30",
    description: "Runtime upgrade + CI matrix change. Shipped in 2.31.",
    comments: [],
    attachment: [],
  },
};

// Attachment content endpoint (mirrors Jira's /attachment/content/<id> shape).
createServer((req, res) => {
  const id = req.url?.match(/\/attachment\/content\/(\d+)/)?.[1];
  const body = id && ATTACHMENT_BODIES[id];
  if (!body) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" }).end(body);
}).listen(ATTACHMENT_PORT, "127.0.0.1");

const server = new McpServer({ name: "jira-mock", version: "1.0.0" });

server.tool(
  "jira_get_issue",
  "Get full details of a Jira issue by key (e.g. ECS-55): status, assignee, description, comments, attachments.",
  { issue_key: z.string().describe("Issue key, e.g. ECS-55") },
  async ({ issue_key }) => {
    const issue = ISSUES[issue_key.toUpperCase()];
    return {
      content: [
        {
          type: "text",
          text: issue ? JSON.stringify(issue, null, 2) : `No issue found with key ${issue_key}`,
        },
      ],
    };
  },
);

server.tool(
  "jira_search",
  'Search Jira issues with a JQL query, e.g. status = "In Progress". Returns matching issues.',
  { jql: z.string().describe("JQL query") },
  async ({ jql }) => {
    const statusMatch = jql.match(/status\s*(?:=|in)\s*\(?["']?([\w -]+?)["']?\)?\s*(?:$|and|order)/i);
    const wanted = statusMatch?.[1]?.trim().toLowerCase();
    const issues = Object.values(ISSUES)
      .filter((issue) => !wanted || issue.status.toLowerCase() === wanted)
      .map(({ key, summary, status, assignee, priority }) => ({ key, summary, status, assignee, priority }));
    return { content: [{ type: "text", text: JSON.stringify({ total: issues.length, issues }, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
