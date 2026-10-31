import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { extractAttachments, lastUserMessage, reasoningOf, textify } from "./common.js";

export function llamaIndexCallback(options: { framework?: string; sdkClient?: Client } = {}) {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "llamaindex";
  return {
    // LlamaIndex also reports retrieval and synthesis events; each pair is not a prompt and an answer.
    async onEventStart(eventType: unknown, payload: any, eventId?: string) {
      if (String(eventType).toLowerCase() !== "llm") return;
      const latest = payload?.messages ? lastUserMessage(payload.messages) : payload?.prompt ?? payload;
      const text = textify((latest as any)?.content ?? latest);
      const attachments = extractAttachments(latest, sdk);
      if (text || attachments.length) await sdk.scanPrompt(text, { enforce: sdk.config.mode === "sync", framework, request_id: String(eventId || ""), attachments });
    },
    async onEventEnd(eventType: unknown, payload: any, eventId?: string) {
      if (String(eventType).toLowerCase() !== "llm") return;
      const text = textify(payload?.response?.message?.content ?? payload?.response ?? payload);
      if (text) await sdk.scanResponse(text, { enforce: sdk.config.mode === "sync", framework, request_id: String(eventId || "") });
    },
  };
}

/**
 * Wrap a LlamaIndex.TS LLM so every `chat` / `complete` call is scanned before it runs. LlamaIndex.TS
 * reports through `Settings.callbackManager` events that it does not wait for, so a callback can
 * record a call but never stop it; wrapping the LLM is the enforcement point. Agents and query engines
 * built on the wrapped LLM are covered too.
 */
export function wrapLlamaIndexLLM<T extends object>(llm: T, options: { framework?: string; sdkClient?: Client } = {}): T {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "llamaindex";
  return new Proxy(llm, {
    get(target, prop) {
      // Read and call through the original object: LLM classes may use private fields, which fail
      // when a method runs with the proxy as `this`.
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop !== "chat" && prop !== "complete") return value.bind(target);
      return async (params: any, ...rest: any[]) => {
        const request = prop === "chat" ? params?.messages : params?.prompt;
        const latest = prop === "chat" ? lastUserMessage(request) : request;
        if (prop === "chat" && latest === undefined) return value.call(target, params, ...rest);
        await sdk.scanPrompt(textify((latest as any)?.content ?? latest), {
          enforce: sdk.config.mode === "sync",
          framework,
          attachments: extractAttachments(latest, sdk),
        });
        const result = await value.call(target, params, ...rest);
        // Streaming results are returned untouched; their text is not available until consumed.
        if (result && typeof result[Symbol.asyncIterator] === "function") return result;
        const text = textify(result?.message?.content ?? result?.text);
        if (text) await sdk.scanResponse(text, { enforce: sdk.config.mode === "sync", framework, ...reasoningOf(result?.raw ?? result) });
        return result;
      };
    },
  });
}
