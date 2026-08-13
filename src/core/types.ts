export type Mode = "sync" | "async";

/** Which protection fired, mirroring the Rust `DetectionSummary`. Present on warn/block. */
export interface DetectionSummary {
  source:
    | "ioc"
    | "security_classification"
    | "data_authority"
    | "sensitive_data"
    | "detection_rule"
    | "organization_policy";
  detail: string;
  other_sources?: number;
}

export interface Decision {
  verdict: "system" | "pass" | "warn" | "block" | "hard_block";
  reason_codes: string[];
  message: string;
  matched_detectors: unknown[];
  policy_source: unknown;
  detection?: DetectionSummary;
  fail_open: boolean;
  blocked: boolean;
  allowed: boolean;
}

export interface Attachment {
  id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
  sha256?: string;
  source?: "upload" | "paste" | "file_ref" | "generated" | "other";
  capture?: "metadata_only" | "text" | "content";
  text?: string;
  content_base64?: string;
  truncated?: boolean;
  redaction_count?: number;
}

/** Token accounting for one model turn (Anthropic naming, matching the wire `TokenUsage`). */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export interface ScanOptions {
  framework?: string;
  provider?: string;
  model?: string;
  session_id?: string;
  conversation_id?: string;
  request_id?: string;
  correlation_id?: string;
  parent_event_id?: string;
  repo?: string;
  permission_mode?: string;
  source_detail?: unknown;
  attachments?: Attachment[];
  /** Response-only turn telemetry. */
  stop_reason?: string;
  usage?: TokenUsage;
  api_calls?: number;
  tool_calls?: number;
  duration_ms?: number;
  /** Tool-call/tool-result-only: MCP server + recognized external service. */
  server?: string;
  service?: string;
  /** Tool-result-only: which kind of tool produced the output. */
  kind?: "shell" | "file_read" | "web" | "mcp" | "other";
}

export interface ConfigOptions {
  mode?: Mode;
  timeoutMs?: number;
  /** Console base URL (e.g. https://godels-gate.example.com). Required, with apiKey — it is
   * where every scan goes. */
  consoleUrl?: string;
  /** IAM API key for the Console scan API (Console UI -> Admin -> API keys). Required. */
  apiKey?: string;
  /** Skip TLS verification for the Console (dev only: accept a self-signed cert). */
  consoleInsecureTls?: boolean;
  queueMax?: number;
  enabled?: boolean;
  orgId?: string;
  user?: string;
  workstationId?: string;
  collectorId?: string;
  labels?: Record<string, string>;
  redact?: boolean;
  /** Seconds to fail open instantly after a sync-scan transport failure. */
  cooldownSecs?: number;
  /** Default deadline for flush() in milliseconds. */
  flushTimeoutMs?: number;
}
