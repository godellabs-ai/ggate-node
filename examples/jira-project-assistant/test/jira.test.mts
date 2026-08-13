import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  extractAttachments,
  fetchAttachmentContent,
  fetchIssueAttachments,
  withAttachmentField,
} from "../lib/jira.ts";

test("withAttachmentField makes issue attachments observable without changing other tools", () => {
  assert.deepEqual(
    withAttachmentField("jira_get_issue", { issue_key: "ECS-55" }),
    {
      issue_key: "ECS-55",
      fields:
        "summary,description,status,assignee,reporter,priority,created,updated,issuetype,comment,attachment",
    },
  );
  assert.deepEqual(
    withAttachmentField("jira_get_issue", {
      issue_key: "ECS-55",
      fields: "summary,Attachment",
    }),
    { issue_key: "ECS-55", fields: "summary,Attachment" },
  );
  assert.deepEqual(
    withAttachmentField("jira_search", { jql: "status = Open" }),
    {
      jql: "status = Open",
    },
  );
});

test("extractAttachments accepts the real mcp-atlassian attachment shape", () => {
  const attachments = extractAttachments({
    attachments: [
      {
        filename: "Jailbreak_Image_Test.png",
        size: 1234,
        content_type: "image/png",
        url: "https://jira.example.test/secure/attachment/10001/Jailbreak_Image_Test.png",
      },
    ],
  });

  assert.deepEqual(attachments, [
    {
      filename: "Jailbreak_Image_Test.png",
      mimeType: "image/png",
      size: 1234,
      contentUrl:
        "https://jira.example.test/secure/attachment/10001/Jailbreak_Image_Test.png",
    },
  ]);
});

test("extractAttachments follows JSON serialized inside MCP content wrappers", () => {
  const raw = {
    type: "text",
    text: JSON.stringify({
      fields: {
        attachment: [
          {
            filename: "wrapped.png",
            size: 42,
            content_type: "image/png",
            url: "https://jira.example.test/rest/api/2/attachment/content/42",
          },
        ],
      },
    }),
  };

  assert.deepEqual(extractAttachments(raw), [
    {
      filename: "wrapped.png",
      mimeType: "image/png",
      size: 42,
      contentUrl:
        "https://jira.example.test/rest/api/2/attachment/content/42",
    },
  ]);
});

test("fetchIssueAttachments recovers references hidden by an MCP resource adapter", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.JIRA_URL;
  process.env.JIRA_URL = "https://jira.example.test";
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.equal(
      url,
      "https://jira.example.test/rest/api/3/issue/ECS-55?fields=attachment",
    );
    return Response.json({
      fields: {
        attachment: [
          {
            filename: "screen.png",
            size: 99,
            mimeType: "image/png",
            content:
              "https://jira.example.test/rest/api/2/attachment/content/99",
          },
        ],
      },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.JIRA_URL;
    else process.env.JIRA_URL = originalUrl;
  });

  assert.equal(
    (await fetchIssueAttachments("jira_get_issue_images", {
      issue_key: "ECS-55",
    }))[0]?.filename,
    "screen.png",
  );
  assert.deepEqual(
    await fetchIssueAttachments("jira_search", { issue_key: "ECS-55" }),
    [],
  );
});

test("fetchAttachmentContent preserves the complete downloaded file bytes", async (t) => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes, { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const fetched = await fetchAttachmentContent({
    filename: "test.png",
    mimeType: "image/png",
    // Jira metadata is not authoritative; the downloaded byte length must win.
    size: 999,
    contentUrl: "https://jira.example.test/attachment/content/10001",
  });

  assert.equal(fetched.size, bytes.length);
  assert.equal(fetched.contentBase64, bytes.toString("base64"));
  assert.equal(
    fetched.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
});

test("fetchAttachmentContent does not download a declared oversized file", async (t) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response();
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const fetched = await fetchAttachmentContent({
    filename: "huge.pdf",
    mimeType: "application/pdf",
    size: 4 * 1024 * 1024 + 1,
    contentUrl: "https://jira.example.test/attachment/content/10002",
  });

  assert.equal(called, false);
  assert.equal(fetched.contentBase64, undefined);
});
