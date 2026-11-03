import { instrumentOpenAI } from "./adapters/openai.js";
import { langchainCallback } from "./adapters/langchain.js";
import { instrumentAutoGen } from "./adapters/autogen.js";
import { instrumentOpenAIAgent } from "./adapters/openai-agents.js";
import { llamaIndexCallback, wrapLlamaIndexLLM } from "./adapters/llamaindex.js";
import { semanticKernelFilters } from "./adapters/semantic-kernel.js";
import { Client } from "./core/client.js";
import { Microsoft365AgentsMiddleware } from "./adapters/microsoft-365-agents.js";
import { ConfigOptions, FileScanOptions, ScanOptions, ShellScanOptions, WebScanOptions } from "./core/types.js";

let client: Client | undefined;

/**
 * Configure the process-wide client. `agentName` and `team` are required — see
 * {@link ConfigOptions} — so that every event says which agent produced it and who owns it.
 */
export function init(options: ConfigOptions): Client {
  client = new Client(options);
  return client;
}

/**
 * The process-wide client, built from the environment when {@link init} was never called. That
 * fallback still needs `GGATE_AGENT_NAME` and `GGATE_TEAM`, and throws naming whichever is absent.
 */
export function getClient(): Client {
  if (!client) client = new Client();
  return client;
}

export function instrument(framework: string, options: any = {}) {
  const name = framework.toLowerCase().replace(/_/g, "-");
  if (["microsoft-365-agents", "m365", "microsoft-365-agents-sdk"].includes(name)) {
    const middleware = new Microsoft365AgentsMiddleware(options.sdkClient ?? getClient());
    if (options.adapter) options.adapter.use(middleware);
    return middleware;
  }
  // Swarm's maintained successor is the OpenAI Agents SDK: { agent } wraps its tools, { client } its model calls.
  if ((name === "openai-agents" || name === "openai-swarm" || name === "swarm") && options.agent) {
    return instrumentOpenAIAgent(options.agent, { framework: name, sdkClient: options.sdkClient });
  }
  if (name === "openai" || name === "openai-assistants" || name === "openai-agents" || name === "openai-swarm" || name === "swarm") {
    if (!options.client) throw new Error(`${framework} instrumentation requires { client }${name === "openai" || name === "openai-assistants" ? "" : " or { agent }"}`);
    return instrumentOpenAI(options.client, { framework: name, sdkClient: options.sdkClient });
  }
  if (name === "langchain" || name === "langgraph") {
    return langchainCallback({ framework: name, sdkClient: options.sdkClient });
  }
  if (name === "autogen") {
    if (!options.client && !options.agent && !options.team) throw new Error("AutoGen instrumentation requires { client }, { agent }, or { team }");
    return instrumentAutoGen(options.client || options.agent || options.team, { framework: name, sdkClient: options.sdkClient });
  }
  if (name === "llamaindex" || name === "llama-index") {
    // Pass { llm } to get an enforcing wrapper; without it, an observe-only callback handler.
    if (options.llm) return wrapLlamaIndexLLM(options.llm, { framework: "llamaindex", sdkClient: options.sdkClient });
    return llamaIndexCallback({ framework: "llamaindex", sdkClient: options.sdkClient });
  }
  if (name === "semantic-kernel" || name === "sk") {
    return semanticKernelFilters({ framework: "semantic-kernel", sdkClient: options.sdkClient });
  }
  throw new Error(`unsupported framework adapter ${framework}; use scanPrompt/scanResponse for generic monitoring`);
}

export function scanPrompt(text: string, options: ScanOptions & { enforce?: boolean } = {}) {
  return getClient().scanPrompt(text, options);
}

export function scanResponse(text: string, options: ScanOptions & { wait?: boolean; enforce?: boolean } = {}) {
  return getClient().scanResponse(text, options);
}

export function scanToolCall(tool: string, inputSummary: unknown, options: ScanOptions & { enforce?: boolean } = {}) {
  return getClient().scanToolCall(tool, inputSummary, options);
}

export function scanToolResult(
  tool: string,
  output: string,
  options: ScanOptions & { wait?: boolean; enforce?: boolean } = {},
) {
  return getClient().scanToolResult(tool, output, options);
}

export function scanShell(command: string, options: ShellScanOptions = {}) {
  return getClient().scanShell(command, options);
}

export function scanFile(filename: string, options: FileScanOptions = {}) {
  return getClient().scanFile(filename, options);
}

export function scanWeb(url: string, options: WebScanOptions = {}) {
  return getClient().scanWeb(url, options);
}

export function attachmentFromPath(
  filename: string,
  source: "upload" | "paste" | "file_ref" | "generated" | "other" = "upload",
) {
  return getClient().attachmentFromPath(filename, source);
}

/** Drain queued events. Resolves false when the deadline expired with events left. */
export function flush(timeoutMs?: number): Promise<boolean> {
  return getClient().flush(timeoutMs);
}

export { withSession, currentSessionId, withUser, currentUser } from "./core/context.js";
export { Client, GgateAgentContainedError, GgateBlockedError } from "./core/client.js";
export { ConsoleTransport, GgateTransportError } from "./core/console-transport.js";
export { instrumentAutoGen } from "./adapters/autogen.js";
export { instrumentOpenAI } from "./adapters/openai.js";
export { instrumentOpenAIAgent } from "./adapters/openai-agents.js";
export { langchainCallback } from "./adapters/langchain.js";
export { llamaIndexCallback, wrapLlamaIndexLLM } from "./adapters/llamaindex.js";
export { semanticKernelFilters } from "./adapters/semantic-kernel.js";
export { Microsoft365AgentsMiddleware } from "./adapters/microsoft-365-agents.js";
export type { AgentsTurnContext } from "./adapters/microsoft-365-agents.js";
export type {
  Attachment,
  ClassificationLabel,
  ConfigDefaults,
  ConfigOptions,
  Decision,
  DetectionClass,
  DetectionSummary,
  DetectorMatch,
  DocumentIntelligence,
  DocumentTaxonomy,
  FileScanOptions,
  FileClassification,
  FrameworkMappings,
  MatchEvidence,
  Mode,
  PolicySource,
  PipelineIssue,
  PipelineStatus,
  ScanOptions,
  SensitivityClassification,
  Severity,
  ShellScanOptions,
  TokenUsage,
  TopicClassification,
  TopicResolution,
  Verdict,
  WebScanOptions,
} from "./core/types.js";
