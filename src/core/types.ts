export type Mode = "sync" | "async";
export type Verdict = "system" | "pass" | "warn" | "block";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type DetectionClass = "d0" | "d1" | "d2" | "d3" | "d4" | "d5" | "d6" | "d7" | "d8" | "d9";

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

export interface FrameworkMappings {
  asi?: string[];
  llm?: string[];
  atlas?: string[];
  attack?: string[];
  nist?: string[];
}

export interface MatchEvidence {
  data_labels?: string[];
  entities?: string[];
  channel?: string;
  rationale?: string;
  hit_count?: number;
  /** Versioned model-routing evidence; its nested schema is owned by the active model bundle. */
  model_routing?: Record<string, unknown>;
}

export interface DetectorMatch {
  detector_id: string;
  category: string;
  severity: Severity;
  action: Verdict;
  detection_class: DetectionClass;
  confidence: number;
  message: string;
  owasp?: string[];
  frameworks?: FrameworkMappings;
  evidence?: MatchEvidence;
  matched_text?: string;
}

export interface PolicySource {
  name: string;
  description?: string;
}

export interface TopicClassification {
  label: string;
  confidence: number;
  runner_up?: string;
  runner_up_confidence?: number;
}

export interface DocumentTaxonomy {
  topic: TopicClassification;
  content_types?: string[];
  business_domains?: string[];
  overall_confidence: number;
}

export interface SensitivityClassification {
  severity: Severity;
  sensitive_data_classes?: string[];
  business_confidentiality_classes?: string[];
  privacy_classes?: string[];
  rights_and_restrictions?: string[];
  required_handling?: string[];
}

/** Non-enforcement topic and sensitivity output returned beside the scan decision. */
export interface DocumentIntelligence {
  taxonomy: DocumentTaxonomy;
  sensitivity: SensitivityClassification;
  matched_text?: string;
}

export interface Decision {
  verdict: Verdict;
  reason_codes: string[];
  message: string;
  matched_detectors: DetectorMatch[];
  policy_source: PolicySource | null;
  detection?: DetectionSummary;
  /** Present on waited scans when rclassifier produced topic/sensitivity output. */
  document_intelligence: DocumentIntelligence | null;
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
  thinking?: string;
  thinking_len?: number;
  thinking_redacted?: boolean;
  stop_reason?: string;
  usage?: TokenUsage;
  api_calls?: number;
  tool_calls?: number;
  duration_ms?: number;
  subagent_type?: string;
  /** Tool-call/tool-result-only: MCP server + recognized external service. */
  server?: string;
  service?: string;
  server_info?: Record<string, unknown>;
  /** Tool-result-only: which kind of tool produced the output. */
  kind?: "shell" | "file_read" | "web" | "mcp" | "other";
  /** Tool-result-only execution metadata. `output_len` is needed only for truncated output. */
  output_len?: number;
  truncated?: boolean;
  exit_code?: number;
  ok?: boolean;
}

export interface ShellScanOptions extends ScanOptions {
  argv?: string[];
  enforce?: boolean;
}

export interface FileScanOptions extends ScanOptions {
  action?: "read" | "write" | "edit" | "delete";
  /** Transient text/patch sent for scanning; it is removed by the product retention pass. */
  content?: string;
  content_len?: number;
  enforce?: boolean;
}

export interface WebScanOptions extends ScanOptions {
  method?: string;
  domain?: string;
  enforce?: boolean;
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
  /** PEM CA certificate used to verify a Console signed by a private CA. */
  consoleCaCert?: string;
  queueMax?: number;
  enabled?: boolean;
  orgId?: string;
  user?: string;
  workstationId?: string;
  collectorId?: string;
  labels?: Record<string, string>;
  redact?: boolean;
  /** Capture attachment bytes/text for Console extraction and document classification. */
  captureFileText?: boolean;
  /** Maximum attachment bytes captured; the full file is still hashed. */
  maxFileBytes?: number;
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
