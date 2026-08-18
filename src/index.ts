import { instrumentOpenAI } from "./adapters/openai.js";
import { langchainCallback } from "./adapters/langchain.js";
import { instrumentAutoGen } from "./adapters/autogen.js";
import { llamaIndexCallback } from "./adapters/llamaindex.js";
import { semanticKernelFilters } from "./adapters/semantic-kernel.js";
import { Client } from "./core/client.js";
import { ConfigOptions, ScanOptions } from "./core/types.js";

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
  if (name === "openai" || name === "openai-assistants" || name === "openai-swarm" || name === "swarm") {
    if (!options.client) throw new Error("OpenAI instrumentation requires { client }");
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

export function scanResponse(text: string, options: ScanOptions & { wait?: boolean } = {}) {
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

/** Drain queued events. Resolves false when the deadline expired with events left. */
export function flush(timeoutMs?: number): Promise<boolean> {
  return getClient().flush(timeoutMs);
}

export { Client, GgateBlockedError } from "./core/client.js";
export { ConsoleTransport, GgateTransportError } from "./core/console-transport.js";
export { instrumentAutoGen } from "./adapters/autogen.js";
export { instrumentOpenAI } from "./adapters/openai.js";
export { langchainCallback } from "./adapters/langchain.js";
export { llamaIndexCallback } from "./adapters/llamaindex.js";
export { semanticKernelFilters } from "./adapters/semantic-kernel.js";
export type { Attachment, ConfigDefaults, ConfigOptions, Decision, DetectionSummary, Mode, ScanOptions, TokenUsage } from "./core/types.js";
