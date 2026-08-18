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

/**
 * SDK settings with every field optional — the shape the `Client` constructor accepts, since
 * `agentName`/`team` may arrive from the environment instead. {@link ConfigOptions} is the
 * caller-facing version that requires them.
 */
export interface ConfigDefaults {
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
  /** See {@link ConfigOptions.agentName}. Optional here only so `GGATE_AGENT_NAME` can supply it;
   * a `Client` still refuses to construct without one. */
  agentName?: string;
  /** See {@link ConfigOptions.team}. Optional here only so `GGATE_TEAM` can supply it. */
  team?: string;
}

/**
 * Settings for {@link init}. `agentName` and `team` are required: the Console lists a session
 * under the agent's name and holds its team accountable, and neither is something the SDK can
 * infer from the process it happens to be running in.
 *
 * Both may equivalently come from `GGATE_AGENT_NAME` / `GGATE_TEAM` for deployments that
 * configure through the environment; the `Client` constructor accepts either source and throws
 * when it ends up with neither.
 */
export interface ConfigOptions extends ConfigDefaults {
  /**
   * What this agent is, as an operator would name it — `"JIRA Project Assistant"`, not the
   * framework it is built on. It travels as `identity.agent_name` and is what the Console's
   * Session column shows, so two assistants built on the same framework stay distinguishable.
   */
  agentName: string;
  /**
   * The team or owner accountable for this agent — `"Platform Engineering"`.
   *
   * A deployed agent has no person at a keyboard: the seat identity would otherwise fall back to
   * the build machine's `<os-user>@<hostname>`, naming whoever ran the deploy rather than whoever
   * owns the workload. The seat identity is still reported unchanged (the Console scopes event
   * access by it); this is the name shown alongside it.
   */
  team: string;
}
