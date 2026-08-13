import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { textify } from "./common.js";

export function langchainCallback(options: { framework?: string; sdkClient?: Client } = {}) {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "langchain";
  return {
    name: "ggate",
    async handleLLMStart(_llm: unknown, prompts: string[], runId?: string) {
      await sdk.scanPrompt((prompts || []).join("\n"), {
        enforce: true,
        framework,
        request_id: runId,
      });
    },
    async handleChatModelStart(_llm: unknown, messages: any[][], runId?: string) {
      await sdk.scanPrompt(messagesToText(messages), {
        enforce: true,
        framework,
        request_id: runId,
      });
    },
    async handleLLMEnd(output: any, runId?: string) {
      const text = llmOutputToText(output);
      if (text) await sdk.scanResponse(text, { framework, request_id: runId });
    },
    async handleToolStart(tool: any, input: string, runId?: string) {
      await sdk.scanToolCall(tool?.name || "tool", input, { enforce: true, framework, request_id: runId });
    },
    async handleToolEnd(output: string, runId?: string) {
      await sdk.scanToolResult("tool", String(output), { framework, request_id: runId });
    },
  };
}

function messagesToText(messages: any[][]): string {
  return (messages || [])
    .flat()
    .filter((message) => {
      const role = String(message?.role || message?._getType?.() || "").toLowerCase();
      return !role.includes("system");
    })
    .map((message) => {
      const contentText = textify(message.content ?? message);
      const role = message.role || message._getType?.() || "message";
      return contentText ? `${role}: ${contentText}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function llmOutputToText(output: any): string {
  if (!output?.generations) return "";
  return output.generations
    .flat()
    .map((generation: any) => generation.text || generation.message?.content || "")
    .filter(Boolean)
    .join("\n");
}
