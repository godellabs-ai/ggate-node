import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { textify } from "./common.js";

// The OpenAI Agents SDK (`@openai/agents`) is the maintained successor of Swarm. It calls the model
// through an OpenAI client, so model calls (every turn, every handoff, with their images and files)
// are enforced by handing it an instrumented client: `setDefaultOpenAIClient(instrument("openai-agents",
// { client }))`. Its function tools run in-process and never pass through that client, so each agent's
// tools are wrapped here: a block throws GgateBlockedError before the tool runs and fails the run.
const WRAPPED = Symbol.for("ggate.openai-agents.wrapped");

export function instrumentOpenAIAgent<T extends object>(
  agent: T,
  options: { framework?: string; sdkClient?: Client } = {},
): T {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "openai-agents";
  const seen = new Set<object>();
  const visit = (current: any) => {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    for (const tool of current.tools ?? []) wrapTool(tool, sdk, framework);
    // Handoffs are agents themselves or Handoff objects holding one; their tools need the same wrapping.
    for (const handoff of current.handoffs ?? []) visit(handoff?.agent ?? handoff);
  };
  visit(agent);
  return agent;
}

function wrapTool(tool: any, sdk: Client, framework: string) {
  if (tool?.type !== "function" || typeof tool.invoke !== "function" || tool[WRAPPED]) return;
  const invoke = tool.invoke.bind(tool);
  tool.invoke = async (runContext: unknown, input: string, details?: unknown) => {
    const name = tool.name || "tool";
    await sdk.scanToolCall(name, textify(input), { enforce: sdk.config.mode === "sync", framework });
    const result = await invoke(runContext, input, details);
    const output = textify(result);
    if (output) await sdk.scanToolResult(name, output, { enforce: sdk.config.mode === "sync", framework });
    return result;
  };
  tool[WRAPPED] = true;
}
