import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { extractAttachments, lastUserMessage, reasoningOf, textify } from "./common.js";
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
          await sdk.scanPrompt(textify(args), { enforce: sdk.config.mode === "sync", framework, provider: "openai" });
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
      const attachment = fileAttachment(params?.file, sdk);
      await sdk.scanPrompt(`OpenAI file upload: ${attachment?.filename || "file"}`, {
        enforce: sdk.config.mode === "sync",
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
        enforce: sdk.config.mode === "sync",
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
      if (prompt) await sdk.scanPrompt(prompt, { enforce: sdk.config.mode === "sync", framework, provider: "openai", conversation_id: threadId });
      const result = await runs.create(threadId, params, ...rest);
      const text = responseToText(result) || textify(result);
      if (text) await sdk.scanResponse(text, { framework, provider: "openai", conversation_id: threadId });
      return result;
    },
    submitToolOutputs: runs.submitToolOutputs
      ? async (threadId: string, runId: string, params: any, ...rest: any[]) => {
          for (const output of params?.tool_outputs || []) {
            await sdk.scanToolResult(output.tool_call_id || "tool", inputToText(output.output), {
              enforce: sdk.config.mode === "sync",
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
      create: (params: any, ...rest: any[]) =>
        modelCall(sdk, framework, params?.messages ?? [], params, () => chat.completions.create(params, ...rest)),
    },
  };
}

function wrapResponses(responses: any, sdk: Client, framework: string) {
  return {
    ...responses,
    create: (params: any, ...rest: any[]) =>
      modelCall(sdk, framework, params?.input, params, () => responses.create(params, ...rest)),
  };
}

/** The conversation a request names: `metadata.session_id`, then a Responses `conversation`. */
function sessionOf(params: any): { session_id?: string } {
  const conversation = typeof params?.conversation === "string" ? params.conversation : params?.conversation?.id;
  const sessionId = params?.metadata?.session_id ?? conversation;
  return sessionId ? { session_id: String(sessionId) } : {};
}

async function modelCall(sdk: Client, framework: string, request: any, params: any, call: () => Promise<any>) {
  const enforce = sdk.config.mode === "sync";
  const meta = { framework, provider: "openai", model: params?.model, ...sessionOf(params) };
  await scanTurn(sdk, request, enforce, meta);
  const result = await call();
  if (result && typeof result[Symbol.asyncIterator] === "function") return recordStream(result, sdk, enforce, meta);
  const text = responseToText(result);
  if (text) await sdk.scanResponse(text, { enforce, ...meta, ...reasoningOf(result) });
  return result;
}

/** Scan what this model call adds to the conversation: a new user turn or a tool result. */
async function scanTurn(sdk: Client, request: any, enforce: boolean, meta: Record<string, any>) {
  const newest = Array.isArray(request) ? request[request.length - 1] : undefined;
  if (newest?.role === "tool" || newest?.role === "function") {
    const { model: _model, ...toolMeta } = meta;
    await sdk.scanToolResult(newest.name || newest.tool_call_id || "tool", inputToText(newest.content), { enforce, ...toolMeta });
    return;
  }
  const latest: any = lastUserMessage(request);
  if (latest === undefined) return;
  const text = inputToText(typeof latest === "object" && latest !== null && "content" in latest ? latest.content : latest);
  const attachments = extractAttachments(latest, sdk);
  if (text || attachments.length) await sdk.scanPrompt(text, { enforce, attachments, ...meta });
}

function chunkText(chunk: any): string {
  if (String(chunk?.type ?? "").endsWith("output_text.delta")) return String(chunk.delta ?? "");
  return (chunk?.choices ?? []).map((choice: any) => (typeof choice?.delta?.content === "string" ? choice.delta.content : "")).join("");
}

/**
 * Pass a streamed answer through unchanged and scan the whole text when it ends. The chunks have
 * already reached the caller by then, so a verdict can stop what follows but cannot recall them.
 */
function recordStream(stream: any, sdk: Client, enforce: boolean, meta: Record<string, any>) {
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return async function* () {
          const parts: string[] = [];
          for await (const chunk of target) {
            parts.push(chunkText(chunk));
            yield chunk;
          }
          const text = parts.join("");
          if (text) await sdk.scanResponse(text, { enforce, ...meta });
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
    } else if (["image_url", "input_image", "image", "file", "input_file", "document", "attachment", "audio", "input_audio", "video", "input_video", "media"].includes(blockType)) {
      return "";
    }
    if (["image_url", "file_path", "path", "url", "input_audio"].some(k => value[k] != null)) {
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

function fileAttachment(file: any, sdk: Client) {
  const filename = typeof file === "string" ? file : file?.path || file?.name;
  if (!filename || !fs.existsSync(filename)) {
    return filename
      ? { filename: String(filename), source: "upload" as const, capture: "metadata_only" as const }
      : undefined;
  }
  return sdk.attachmentFromPath(filename, "upload");
}
