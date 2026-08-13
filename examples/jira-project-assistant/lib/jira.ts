/**
 * Jira attachment fetching.
 *
 * MCP tool results only reference attachments (filename + content URL); the
 * bytes never flow through the MCP server. When a ticket carries attachments,
 * we fetch them directly from Jira's REST API with the same credentials the
 * MCP server uses, and hand the original bytes to Godel's Gate. The agent then
 * owns text extraction/OCR for every file type (an image's pixel-text, e.g. a
 * screenshot, is invisible unless the bytes are sent).
 */

import { createHash } from "node:crypto";

// Files are sent whole for extraction/OCR — a truncated PNG/PDF is generally undecodable, so anything
// over this ceiling is represented by metadata only rather than sending a partial file.
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

// mcp-atlassian's defaults omit `attachment`, so a normal issue lookup never exposes the references
// needed by the fetch-and-scan path. Keep its essential defaults and add the attachment field.
const ISSUE_FIELDS =
  "summary,description,status,assignee,reporter,priority,created,updated,issuetype,comment,attachment";

export interface JiraAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
}

/** One fetched attachment, ready to hand to Godel's Gate as raw bytes for extraction/OCR. */
export interface FetchedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  sha256?: string;
  /** Complete base64 raw bytes. Missing when Jira could not supply a safely bounded file. */
  contentBase64?: string;
}

const ATTACHMENT_TOOL = /(?:attachment|issue_images)/i;

function jiraHeaders(): Record<string, string> {
  const user = process.env.JIRA_USERNAME;
  const token = process.env.JIRA_API_TOKEN;
  return user && token
    ? {
        Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
      }
    : {};
}

/** Add attachment metadata to `jira_get_issue` reads without changing any other Jira tool call. */
export function withAttachmentField(toolName: string, input: unknown): unknown {
  if (
    toolName !== "jira_get_issue" ||
    typeof input !== "object" ||
    input === null
  )
    return input;
  const obj = input as Record<string, unknown>;
  const fields = typeof obj.fields === "string" ? obj.fields.trim() : "";
  if (fields === "*all" || /(^|,)\s*attachment\s*(,|$)/i.test(fields))
    return input;
  return { ...obj, fields: fields ? `${fields},attachment` : ISSUE_FIELDS };
}

/** Walk any Jira-ish JSON payload and collect attachment references. */
export function extractAttachments(
  value: unknown,
  found: JiraAttachment[] = [],
  depth = 0,
): JiraAttachment[] {
  if (depth > 12 || value == null) return found;
  // LangChain adapters may preserve an MCP content block as an object, or may serialize its `text`
  // / `content` field to JSON first. Follow those JSON strings so attachment references are not lost
  // merely because the adapter added a wrapper layer.
  if (typeof value === "string") {
    const text = value.trim();
    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      try {
        extractAttachments(JSON.parse(text), found, depth + 1);
      } catch {
        // Ordinary text tool results are not attachment containers.
      }
    }
    return found;
  }
  if (typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) extractAttachments(item, found, depth + 1);
    return found;
  }
  const obj = value as Record<string, unknown>;
  // The mock uses `content`; the real mcp-atlassian result exposes the download URL as `content` or
  // `url`. Match any Jira attachment content URL (`/attachment/...`) — both `/attachment/content/<id>`
  // (mock + REST v3) and `/secure/attachment/<id>/<name>` (classic) qualify.
  const contentUrl =
    obj.content ?? obj.contentUrl ?? obj.content_url ?? obj.url;
  if (
    typeof obj.filename === "string" &&
    typeof contentUrl === "string" &&
    /^https?:\/\//.test(contentUrl) &&
    /\/attachment\//.test(contentUrl)
  ) {
    // Jira/mcp-atlassian expose the MIME under `content_type`; the mock uses `mimeType`.
    const mimeType =
      typeof obj.mimeType === "string"
        ? obj.mimeType
        : typeof obj.mime_type === "string"
          ? (obj.mime_type as string)
          : typeof obj.content_type === "string"
            ? (obj.content_type as string)
            : "application/octet-stream";
    found.push({
      filename: obj.filename,
      mimeType,
      size: typeof obj.size === "number" ? obj.size : 0,
      contentUrl,
    });
    return found;
  }
  for (const item of Object.values(obj))
    extractAttachments(item, found, depth + 1);
  return found;
}

/**
 * Obtain attachment references for attachment-specific MCP calls.
 *
 * Some MCP adapters drop `EmbeddedResource` blobs (notably image resources returned by
 * `jira_download_attachments`). Reading the issue's attachment metadata directly gives us stable
 * download URLs, so the guard can still fetch and scan the original file bytes.
 */
export async function fetchIssueAttachments(
  toolName: string,
  input: unknown,
): Promise<JiraAttachment[]> {
  if (
    !ATTACHMENT_TOOL.test(toolName) ||
    typeof input !== "object" ||
    input === null
  ) {
    return [];
  }
  const issueKey = (input as Record<string, unknown>).issue_key;
  const jiraUrl = process.env.JIRA_URL;
  if (typeof issueKey !== "string" || !jiraUrl) return [];

  try {
    const url = new URL(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      jiraUrl,
    );
    url.searchParams.set("fields", "attachment");
    const response = await fetch(url, {
      headers: jiraHeaders(),
      redirect: "follow",
    });
    if (!response.ok) return [];
    return extractAttachments(await response.json());
  } catch {
    return [];
  }
}

/**
 * Fetch an attachment's complete bytes for scanning. Anything too large — or a failed fetch — comes
 * back as metadata only, so the trail still records that the file was accessed. Files are never
 * truncated because that can make images, PDFs, and other containers undecodable by the agent.
 */
export async function fetchAttachmentContent(
  attachment: JiraAttachment,
): Promise<FetchedAttachment> {
  const meta: FetchedAttachment = {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    return meta;
  }

  try {
    const response = await fetch(attachment.contentUrl, {
      headers: jiraHeaders(),
      redirect: "follow",
    });
    if (!response.ok) return meta;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) return meta;
    return {
      ...meta,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    };
  } catch {
    return meta;
  }
}
