/**
 * Godel's Gate integration.
 *
 * Every piece of content that flows through the assistant — the user's prompt,
 * each MCP tool call, each tool result, every Jira attachment, and the final
 * answer — is scanned synchronously. A block verdict anywhere aborts the chat
 * turn; the UI shows which protection fired.
 *
 * The SDK scans against the Console named by GGATE_CONSOLE_URL, authenticated
 * with GGATE_API_KEY. That is its only destination.
 *
 * Every event is filed under the agent's declared name and owning team, so the Console lists
 * this assistant's sessions as "JIRA Project Assistant" rather than as the framework it happens
 * to be built on.
 */

import { Client, type Attachment, type Decision } from "@ggate/sdk";

import type { FetchedAttachment } from "./jira";

const FRAMEWORK = "langgraph";

/** What this agent is, as it appears in the Console's Session column. Part of the application,
 * not a deployment knob: every install of this assistant is the same named agent. */
const AGENT_NAME = "JIRA Project Assistant";

/** Who is accountable for it. Deployment-specific, so it comes from the environment; the default
 * keeps the example runnable before anyone has set GGATE_TEAM. */
const TEAM = process.env.GGATE_TEAM?.trim() || "Project Management";

let client: Client | undefined;

export function ggate(): Client {
  // OCR/model extraction can take longer than the SDK's general 4s default, especially on the first
  // image scan. Keep the deadline configurable, with enough headroom for the scanner's 30s budget.
  if (!client) {
    const configured = Number(process.env.GGATE_TIMEOUT_MS);
    client = new Client({
      agentName: AGENT_NAME,
      team: TEAM,
      mode: "sync",
      timeoutMs:
        Number.isFinite(configured) && configured > 0 ? configured : 45_000,
    });
  }
  return client;
}

/** One scan verdict, as surfaced to the chat UI. */
export interface ScanRecord {
  surface: "prompt" | "tool_call" | "tool_result" | "attachment" | "response";
  label: string;
  verdict: Decision["verdict"];
  detection?: { source: string; detail: string };
  failOpen: boolean;
}

/** Thrown when Godel's Gate blocks the turn; carries the scan that tripped. */
export class ChatBlockedError extends Error {
  constructor(public readonly scan: ScanRecord) {
    super(
      scan.detection ? `${scan.detection.detail}` : "blocked by Godel's Gate",
    );
    this.name = "ChatBlockedError";
  }
}

export function toRecord(
  surface: ScanRecord["surface"],
  label: string,
  decision: Decision,
): ScanRecord {
  return {
    surface,
    label,
    verdict: decision.verdict,
    detection: decision.detection
      ? { source: decision.detection.source, detail: decision.detection.detail }
      : undefined,
    failOpen: decision.fail_open,
  };
}

/** Collects the scans of one chat turn and aborts the run on a block. */
export class TurnGuard {
  readonly scans: ScanRecord[] = [];
  readonly abort = new AbortController();
  private blockedScan: ScanRecord | undefined;
  private readonly scannedAttachments = new Set<string>();

  get blocked(): ScanRecord | undefined {
    return this.blockedScan;
  }

  /** Record a decision; on block, remember it and abort the agent run. */
  check(
    surface: ScanRecord["surface"],
    label: string,
    decision: Decision,
  ): void {
    const record = toRecord(surface, label, decision);
    this.scans.push(record);
    if (decision.blocked) {
      this.blockedScan = this.blockedScan ?? record;
      this.abort.abort(new ChatBlockedError(record));
      throw new ChatBlockedError(record);
    }
  }

  async scanPrompt(text: string, sessionId: string): Promise<void> {
    const decision = await ggate().scanPrompt(text, {
      framework: FRAMEWORK,
      session_id: sessionId,
    });
    this.check("prompt", "user prompt", decision);
  }

  async scanToolCall(
    tool: string,
    input: unknown,
    sessionId: string,
  ): Promise<void> {
    const decision = await ggate().scanToolCall(tool, input, {
      framework: FRAMEWORK,
      server: "jira",
      service: "jira",
      session_id: sessionId,
    });
    this.check("tool_call", tool, decision);
  }

  async scanToolResult(
    tool: string,
    output: string,
    sessionId: string,
  ): Promise<void> {
    const decision = await ggate().scanToolResult(tool, output, {
      wait: true,
      kind: "mcp",
      framework: FRAMEWORK,
      server: "jira",
      service: "jira",
      session_id: sessionId,
    });
    this.check("tool_result", tool, decision);
  }

  async scanAttachment(
    fetched: FetchedAttachment,
    sessionId: string,
  ): Promise<void> {
    // The model may read an issue, request its images, and download its attachments in one turn.
    // Scan identical bytes once even when several Jira tools expose the same file.
    const attachmentKey =
      fetched.sha256 ?? `${fetched.filename}:${fetched.mimeType}:${fetched.size}`;
    if (this.scannedAttachments.has(attachmentKey)) return;
    this.scannedAttachments.add(attachmentKey);

    const attachment: Attachment = {
      filename: fetched.filename,
      mime_type: fetched.mimeType,
      size: fetched.size,
      sha256: fetched.sha256,
      // The Jira file is already fetched into this event. It is not a local path for the agent to
      // resolve; marking it as `file_ref` could make a failed download scan an unrelated same-named
      // file under the application's cwd.
      source: "upload",
      capture: fetched.contentBase64 ? "content" : "metadata_only",
      content_base64: fetched.contentBase64,
    };
    // The scanner OCRs/extracts attachments carried on a prompt/response event, so the fetched file is
    // scanned as a response-surface attachment. That is what lets an image's pixel-text (e.g. a
    // screenshot with an embedded jailbreak) be OCR'd and caught; the UI still labels this an attachment.
    const decision = await ggate().scanResponse("", {
      wait: true,
      framework: FRAMEWORK,
      session_id: sessionId,
      attachments: [attachment],
    });
    this.check("attachment", fetched.filename, decision);
  }

  async scanResponse(text: string, sessionId: string): Promise<void> {
    const decision = await ggate().scanResponse(text, {
      wait: true,
      framework: FRAMEWORK,
      session_id: sessionId,
    });
    this.check("response", "assistant response", decision);
  }
}
