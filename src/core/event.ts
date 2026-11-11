/**
 * RuntimeEvent construction, matching the Rust `gate/v1` contract.
 *
 * The shapes here mirror `shared/ggate-core/src/event.rs` exactly — that crate is
 * the source of truth. An SDK event carries `identity.agent_source =
 * "agent-framework"` and `collector.collector_type = "sdk"`; the operator-declared
 * agent name and owning team travel in `identity.agent_name` / `identity.team`, and
 * the specific AI framework in `collector.labels.framework` and `source.client`.
 *
 * The event states only what the SDK actually knows. Anything the receiver can work
 * out for itself is left off the wire: `schema_version` (a constant), and the payload
 * sizes `length` / `output_len`, which the agent and Console derive from the text in
 * the same payload (`RuntimeEvent::fill_derived`). Sending them again would be a
 * second source of truth for the same fact, and a chance for the two to disagree.
 *
 * What stays is what only this process knows and the Console reads: the event id
 * (also the retry idempotency key), the client-side timestamp, identity and seat
 * user, session/correlation ids the caller supplied, and the collector metadata the
 * fleet registry is reconciled from — SDK name and version, platform, framework.
 */

import os from "node:os";
import crypto from "node:crypto";
import { Config } from "./config.js";
import { currentSessionId, currentUser, normalizeUser } from "./context.js";
import { RedactionSummary, redactText, sha256Hex } from "./redactor.js";
import { Attachment, FileScanOptions, ScanOptions, ShellScanOptions, TokenUsage, WebScanOptions } from "./types.js";

export const SDK_VERSION = "0.3.1";

// Normalized to the Rust `std::env::consts` vocabulary the rest of the fleet reports
// (platform_os is a Console dimension, so casing must match the hook collectors).
const PLATFORM_OS = ({ darwin: "macos", win32: "windows" } as Record<string, string>)[os.platform()] ?? os.platform();
const PLATFORM_ARCH = ({ x64: "x86_64", arm64: "aarch64" } as Record<string, string>)[os.arch()] ?? os.arch();

const TOOL_RESULT_KINDS = new Set(["shell", "file_read", "web", "mcp", "other"]);
const TOKEN_USAGE_KEYS: Array<keyof TokenUsage> = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
];

const DEFAULT_SESSION_ID = `node-sdk-${crypto.randomUUID()}`;

export class RuntimeEventBuilder {
  constructor(private readonly config: Config) {}

  prompt(text: string, options: ScanOptions = {}): { event: any; redaction: RedactionSummary } {
    const payload = {
      surface: "prompt",
      text,
      attachments: options.attachments || [],
    };
    return this.event("pre", payload, text, options);
  }

  response(text: string, options: ScanOptions = {}): { event: any; redaction: RedactionSummary } {
    const payload = {
      surface: "response",
      text,
      thinking: options.thinking,
      thinking_len: options.thinking_len,
      thinking_redacted: options.thinking_redacted,
      model: options.model,
      stop_reason: options.stop_reason,
      usage: tokenUsage(options.usage),
      api_calls: options.api_calls,
      tool_calls: options.tool_calls,
      duration_ms: options.duration_ms,
      subagent_type: options.subagent_type,
      attachments: options.attachments || [],
    };
    return this.event(options.before_delivery ? "pre" : "post", payload, text, options);
  }

  toolCall(tool: string, inputSummary: unknown, options: ScanOptions = {}) {
    return this.event(
      "pre",
      {
        surface: "mcp_tool",
        // Defaulted to the framework name in event(): a framework tool has no MCP
        // server, and the framework reads best in the Console.
        server: options.server,
        tool,
        input_summary: inputSummary,
        service: options.service,
        server_info: options.server_info,
      },
      typeof inputSummary === "string" ? inputSummary : JSON.stringify(inputSummary ?? tool),
      options,
    );
  }

  toolResult(tool: string, output: string, options: ScanOptions = {}) {
    return this.event(
      options.before_delivery ? "pre" : "post",
      {
        surface: "tool_result",
        kind: options.kind && TOOL_RESULT_KINDS.has(options.kind) ? options.kind : "other",
        tool,
        server: options.server,
        service: options.service,
        output,
        output_len: options.output_len,
        truncated: options.truncated,
        exit_code: options.exit_code,
        ok: options.ok ?? true,
        duration_ms: options.duration_ms,
      },
      output,
      options,
    );
  }

  shell(command: string, options: ShellScanOptions = {}) {
    return this.event("pre", { surface: "shell", command, argv: options.argv || [] }, command, options);
  }

  file(filename: string, options: FileScanOptions = {}) {
    const action = options.action || "read";
    if (!["read", "write", "edit", "delete"].includes(action)) {
      throw new Error(`unsupported file action ${JSON.stringify(action)}`);
    }
    return this.event(
      "pre",
      {
        surface: action === "read" ? "file_read" : "file_write",
        action,
        path: filename,
        content_len: options.content_len,
        content: options.content,
      },
      options.content || filename,
      options,
    );
  }

  web(url: string, options: WebScanOptions = {}) {
    let domain = options.domain;
    if (!domain) {
      try { domain = new URL(url).hostname || undefined; } catch { /* receiver validates the URL */ }
    }
    return this.event("pre", { surface: "web", url, method: options.method, domain }, url, options);
  }

  private event(phase: string, payload: any, primaryText: string, options: ScanOptions) {
    const framework = options.framework || "generic";
    const scopedUser = currentUser();
    const user = normalizeUser(options.user !== undefined ? options.user
      : scopedUser !== undefined ? scopedUser : this.config.user);
    if (payload.surface === "mcp_tool" && !payload.server) payload.server = framework;

    let redactionCount = 0;
    if (this.config.redact) {
      const redacted = redactPayload(payload);
      payload = redacted.payload;
      redactionCount = redacted.count;
    }
    return {
      event: clean({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        phase,
        identity: clean({
          org_id: this.config.orgId,
          user,
          host: this.config.host,
          workstation_id: this.config.workstationId,
          agent_source: "agent-framework",
          // What this deployment *is* and who owns it — declared at init(), never inferred.
          // `agent_source` only says an SDK reported the event; `agent_name` is what the Console
          // lists the session under, and `team` is the owner shown beside the seat identity.
          agent_name: this.config.agentName,
          team: this.config.team,
          agent_version: SDK_VERSION,
          install_source: "manual",
        }),
        session: clean({
          session_id: options.session_id || currentSessionId() || DEFAULT_SESSION_ID,
          // Only a correlation the caller actually established. A fresh per-event UUID would
          // correlate one event with itself and fill the Console's correlation column with noise.
          correlation_id: options.correlation_id,
          parent_event_id: options.parent_event_id,
          repo: options.repo,
          source_trust: options.source_trust,
          permission_mode: options.permission_mode,
        }),
        payload: clean(payload),
        collector: clean({
          collector_id: this.config.collectorId,
          collector_type: "sdk",
          name: "ggate-node-sdk",
          version: SDK_VERSION,
          mode: this.config.mode === "sync" ? "enforce" : "audit",
          platform: clean({ os: PLATFORM_OS, arch: PLATFORM_ARCH }),
          labels: { ...this.config.labels, language: "node", framework },
        }),
        source: clean({
          surface: "api",
          provider: options.provider,
          client: framework,
          conversation_id: options.conversation_id,
          model: options.model,
          request_id: options.request_id,
          detail: options.source_detail,
        }),
      }),
      redaction: {
        content_sha256: this.config.redact ? sha256Hex(primaryText) : undefined,
        redaction_count: redactionCount,
      },
    };
  }
}

/** Coerce a usage object to the wire `TokenUsage` shape, dropping unknown keys. */
function tokenUsage(value: TokenUsage | undefined): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage: Record<string, number> = {};
  for (const key of TOKEN_USAGE_KEYS) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) usage[key] = Math.floor(raw);
  }
  return Object.keys(usage).length ? usage : undefined;
}

function redactPayload(payload: any): { payload: any; count: number } {
  const next = { ...payload };
  let count = 0;
  for (const key of ["text", "thinking", "output", "command", "content"]) {
    if (typeof next[key] === "string") {
      const redacted = redactText(next[key]);
      next[key] = redacted.text;
      count += redacted.count;
    }
  }
  if (next.input_summary != null) {
    const redacted = redactValue(next.input_summary, 0);
    next.input_summary = redacted.value;
    count += redacted.count;
  }
  next.attachments = (next.attachments || []).map((attachment: Attachment) => {
    if (typeof attachment.text !== "string") return attachment;
    const redacted = redactText(attachment.text);
    count += redacted.count;
    return {
      ...attachment,
      text: redacted.text,
      redaction_count: (attachment.redaction_count || 0) + redacted.count,
    };
  });
  return { payload: next, count };
}

/** Redact every string leaf of a JSON-ish value (tool inputs routinely carry secrets). */
function redactValue(value: unknown, depth: number): { value: unknown; count: number } {
  if (typeof value === "string") {
    const redacted = redactText(value);
    return { value: redacted.text, count: redacted.count };
  }
  if (depth >= 8 || value == null || typeof value !== "object") return { value, count: 0 };
  let count = 0;
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const redacted = redactValue(item, depth + 1);
      count += redacted.count;
      return redacted.value;
    });
    return { value: items, count };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const redacted = redactValue(item, depth + 1);
    out[key] = redacted.value;
    count += redacted.count;
  }
  return { value: out, count };
}

function clean<T extends Record<string, any>>(input: T): Partial<T> {
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    output[key] = value;
  }
  return output as Partial<T>;
}
