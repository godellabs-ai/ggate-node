import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { textify } from "./common.js";
import fs from "node:fs";

export function instrumentOpenAI<T extends object>(
  client: T,
  options: { framework?: string; sdkClient?: Client } = {},
): T {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "openai";
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "chat" && (target as any).chat?.completions?.create) {
        return wrapChat((target as any).chat, sdk, framework);
      }
      if (prop === "responses" && (target as any).responses?.create) {
        return wrapResponses((target as any).responses, sdk, framework);
      }
      if (prop === "files" && (target as any).files?.create) {
        return wrapFiles((target as any).files, sdk, framework);
      }
      if (prop === "beta" && (target as any).beta?.threads) {
        return wrapBeta((target as any).beta, sdk, framework);
      }
      if (prop === "run" && typeof (target as any).run === "function") {
        return async (...args: any[]) => {
          await sdk.scanPrompt(textify(args), { enforce: true, framework, provider: "openai" });
          const result = await (target as any).run(...args);
          const text = responseToText(result) || textify(result);
          if (text) await sdk.scanResponse(text, { framework, provider: "openai" });
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapFiles(files: any, sdk: Client, framework: string) {
  return {
    ...files,
    create: async (params: any, ...rest: any[]) => {
      const attachment = fileAttachment(params?.file);
      await sdk.scanPrompt(`OpenAI file upload: ${attachment?.filename || "file"}`, {
        enforce: true,
        framework,
        provider: "openai",
        attachments: attachment ? [attachment] : [],
      });
      return files.create(params, ...rest);
    },
    content: files.content
      ? async (...args: any[]) => {
          const result = await files.content(...args);
          const text = responseToText(result) || textify(result);
          if (text) await sdk.scanResponse(text, { framework, provider: "openai" });
          return result;
        }
      : undefined,
  };
}

function wrapBeta(beta: any, sdk: Client, framework: string) {
  return {
    ...beta,
    threads: {
      ...beta.threads,
      messages: beta.threads.messages ? wrapThreadMessages(beta.threads.messages, sdk, framework) : beta.threads.messages,
      runs: beta.threads.runs ? wrapThreadRuns(beta.threads.runs, sdk, framework) : beta.threads.runs,
    },
  };
}

function wrapThreadMessages(messages: any, sdk: Client, framework: string) {
  return {
    ...messages,
    create: async (threadId: string, params: any, ...rest: any[]) => {
      await sdk.scanPrompt(inputToText(params?.content), {
        enforce: true,
        framework,
        provider: "openai",
        conversation_id: threadId,
        attachments: (params?.attachments || []).map((item: any) => ({
          id: item.file_id,
          source: "file_ref",
          capture: "metadata_only",
        })),
      });
      return messages.create(threadId, params, ...rest);
    },
    list: messages.list
      ? async (...args: any[]) => {
          const result = await messages.list(...args);
          const text = responseToText(result) || textify(result);
          if (text) await sdk.scanResponse(text, { framework, provider: "openai" });
          return result;
        }
      : undefined,
  };
}

function wrapThreadRuns(runs: any, sdk: Client, framework: string) {
  return {
    ...runs,
    create: async (threadId: string, params: any, ...rest: any[]) => {
      const prompt = inputToText(params?.additional_messages) || inputToText(params?.instructions);
      if (prompt) await sdk.scanPrompt(prompt, { enforce: true, framework, provider: "openai", conversation_id: threadId });
      const result = await runs.create(threadId, params, ...rest);
      const text = responseToText(result) || textify(result);
      if (text) await sdk.scanResponse(text, { framework, provider: "openai", conversation_id: threadId });
      return result;
    },
    submitToolOutputs: runs.submitToolOutputs
      ? async (threadId: string, runId: string, params: any, ...rest: any[]) => {
          for (const output of params?.tool_outputs || []) {
            await sdk.scanToolResult(output.tool_call_id || "tool", inputToText(output.output), {
              framework,
              provider: "openai",
              conversation_id: threadId,
              request_id: runId,
            });
          }
          return runs.submitToolOutputs(threadId, runId, params, ...rest);
        }
      : undefined,
  };
}

function wrapChat(chat: any, sdk: Client, framework: string) {
  return {
    ...chat,
    completions: {
      ...chat.completions,
      create: async (params: any, ...rest: any[]) => {
        const prompt = messagesToText(params?.messages || []);
        await sdk.scanPrompt(prompt, {
          enforce: true,
          framework,
          provider: "openai",
          model: params?.model,
        });
        const result = await chat.completions.create(params, ...rest);
        const text = responseToText(result);
        if (text) {
          await sdk.scanResponse(text, { framework, provider: "openai", model: params?.model });
        }
        return result;
      },
    },
  };
}

function wrapResponses(responses: any, sdk: Client, framework: string) {
  return {
    ...responses,
    create: async (params: any, ...rest: any[]) => {
      await sdk.scanPrompt(inputToText(params?.input), {
        enforce: true,
        framework,
        provider: "openai",
        model: params?.model,
      });
      const result = await responses.create(params, ...rest);
      const text = responseToText(result);
      if (text) await sdk.scanResponse(text, { framework, provider: "openai", model: params?.model });
      return result;
    },
  };
}

function messagesToText(messages: any[]): string {
  return (messages || [])
    .filter((message) => {
      const role = String(message?.role || "unknown").toLowerCase();
      return !role.includes("system");
    })
    .map((message) => `${message.role || "unknown"}: ${inputToText(message.content)}`)
    .join("\n");
}

function inputToText(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (Array.isArray(value)) return value.map(inputToText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const blockType = String(value.type || "").toLowerCase();
    if (blockType === "text") {
      return inputToText(value.text);
    } else if (["image_url", "image", "file", "document", "attachment"].includes(blockType)) {
      return "";
    }
    if (["image_url", "file_path", "path", "url"].some(k => value[k] != null)) {
      return "";
    }
    if ("text" in value) return String(value.text);
    if ("input_text" in value) return String(value.input_text);
    if ("content" in value) return inputToText(value.content);
    return "";
  }
  return String(value);
}

function responseToText(result: any): string {
  if (!result) return "";
  if (typeof result.output_text === "string") return result.output_text;
  if (Array.isArray(result.choices)) {
    return result.choices
      .map((choice: any) => inputToText(choice.message?.content ?? choice.text))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function fileAttachment(file: any) {
  const filename = typeof file === "string" ? file : file?.path || file?.name;
  if (!filename || !fs.existsSync(filename)) {
    return filename
      ? { filename: String(filename), source: "upload" as const, capture: "metadata_only" as const }
      : undefined;
  }
  const stat = fs.statSync(filename);
  return {
    filename: String(filename).split(/[\\/]/).pop(),
    size: stat.size,
    source: "upload" as const,
    capture: "metadata_only" as const,
  };
}
