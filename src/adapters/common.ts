import fs from "node:fs";
import { Client } from "../core/client.js";
import { attachmentFromBytes, attachmentFromPath } from "../core/attachment.js";
import { Attachment } from "../core/types.js";

const MEDIA_TYPES = new Set([
  "image_url", "input_image", "image", "file", "input_file", "document", "attachment",
  "audio", "input_audio", "video", "input_video", "media",
]);

function isSystemMessage(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const record = value as Record<string, any>;
  const role = String(record.role || record.type || "").toLowerCase();
  if (role && role.includes("system")) return true;
  if (typeof record._getType === "function") {
    const type = String(record._getType()).toLowerCase();
    if (type && type.includes("system")) return true;
  }
  const className = record.constructor?.name || "";
  if (className && className.toLowerCase().includes("system")) return true;
  return false;
}

export function textify(value: unknown): string {
  if (value == null) return "";
  if (isSystemMessage(value)) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (Array.isArray(value)) return value.map(textify).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, any>;
    const blockType = String(record.type || "").toLowerCase();
    if (blockType === "text") {
      return textify(record.text);
    } else if (MEDIA_TYPES.has(blockType)) {
      return "";
    }
    if (["image_url", "file_path", "path", "url", "input_audio"].some(k => record[k] != null)) {
      return "";
    }
    for (const key of ["content", "text", "input", "prompt", "query", "response", "output", "message"]) {
      if (record[key] != null) return textify(record[key]);
    }
    return Object.entries(record)
      .map(([key, item]) => {
        const txt = textify(item);
        return txt ? `${key}: ${txt}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
}

export function wrapRunMethods<T extends object>(
  target: T,
  methods: string[],
  sdk: Client,
  framework: string,
): T {
  return new Proxy(target, {
    get(raw, prop, receiver) {
      const value = Reflect.get(raw, prop, receiver);
      if (typeof prop !== "string" || !methods.includes(prop) || typeof value !== "function") return value;
      return (...args: any[]) => {
        const stream = /stream/i.test(prop);
        const before = async () => {
          const prompt = latestTurnText(args);
          const attachments = extractAttachments(args, sdk);
          if (prompt || attachments.length) await sdk.scanPrompt(prompt, { enforce: sdk.config.mode === "sync", framework, attachments });
        };
        const after = async (result: unknown) => {
          const response = answerText(result);
          if (response) await sdk.scanResponse(response, { enforce: sdk.config.mode === "sync", framework });
        };
        if (stream) {
          return (async function* () {
            await before();
            const seen: unknown[] = [];
            for await (const item of value.apply(raw, args) as AsyncIterable<unknown>) {
              seen.push(item);
              yield item;
            }
            await after(seen);
          })();
        }
        return (async () => {
          await before();
          const result = await value.apply(raw, args);
          await after(result);
          return result;
        })();
      };
    },
  });
}

const LIST_KEYS = ["attachments", "files", "images", "uploads", "documents"];

const NESTED_MEDIA_KEYS = ["file", "input_audio", "audio", "video", "source"];
const AUDIO_FORMATS: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm" };

function fromDataUrl(url: string, sdk: Client, filename?: string, mimeType?: string): Attachment | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const raw = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!));
  return attachmentFromBytes(raw, sdk.config, { mimeType: mimeType || match[1] || undefined, filename, source: "paste" });
}

function mediaAttachment(record: Record<string, any>, sdk: Client): Attachment | null {
  const nested = NESTED_MEDIA_KEYS.map((key) => record[key]).find((item) => item && typeof item === "object");
  const holder = nested ?? record;
  const audioFormat = typeof holder.format === "string" ? holder.format.toLowerCase() : undefined;
  const mimeType = holder.mime_type ?? holder.mimeType ?? holder.media_type ?? record.mime_type ?? record.mimeType
    ?? (audioFormat ? (AUDIO_FORMATS[audioFormat] ?? `audio/${audioFormat}`) : undefined);
  const filename = holder.filename ?? holder.name ?? record.filename ?? record.metadata?.filename;
  for (const url of [holder.file_data, holder.data_uri, typeof holder.image_url === "object" ? holder.image_url?.url : holder.image_url, holder.url]) {
    if (typeof url === "string" && url.startsWith("data:")) return fromDataUrl(url, sdk, filename, mimeType);
  }
  for (const data of [holder.data, holder.base64, holder.base64_data, holder.content]) {
    if (data instanceof Uint8Array) return attachmentFromBytes(Buffer.from(data), sdk.config, { mimeType, filename });
    // A leading "/" is not a path here: every base64 JPEG starts with "/9j/".
    if (typeof data === "string" && data.length > 64 && !/^https?:/.test(data) && !(data.length < 4096 && fs.existsSync(data))) {
      return attachmentFromBytes(Buffer.from(data, "base64"), sdk.config, { mimeType, filename });
    }
  }
  for (const file of [holder.path, holder.file_path, holder.filepath]) {
    if (typeof file === "string" && fs.existsSync(file)) return attachmentFromPath(file, sdk.config, "upload");
  }
  const url = typeof holder.image_url === "object" ? holder.image_url?.url : holder.image_url ?? holder.url;
  if (typeof url === "string" && url) {
    return { filename: filename || url.split("?")[0]!.split("/").pop() || "file", source: "file_ref", capture: "metadata_only" };
  }
  return filename ? { filename, mime_type: mimeType, source: "file_ref", capture: "metadata_only" } : null;
}

/**
 * Files and images in framework inputs, so their content is scanned with the prompt: OpenAI chat and
 * Responses parts (`image_url`, `input_image`, `file`/`input_file` with `file_data`), LangChain content
 * blocks (`image`/`file` with base64 `data`, a URL or a path), and `attachments`/`files`/`images` lists.
 * Content is included only when content capture is on (`GGATE_CAPTURE_FILE_TEXT`).
 */
export function extractAttachments(value: unknown, sdk: Client, depth = 0, seen = new Set<unknown>()): Attachment[] {
  if (value == null || typeof value !== "object" || depth > 8 || seen.has(value)) return [];
  seen.add(value);
  const found: Attachment[] = [];
  if (Array.isArray(value)) {
    for (const item of value) found.push(...extractAttachments(item, sdk, depth + 1, seen));
  } else {
    const record = value as Record<string, any>;
    if (MEDIA_TYPES.has(String(record.type ?? "")) || (record.file && typeof record.file === "object") || (record.input_audio && typeof record.input_audio === "object")) {
      const attachment = mediaAttachment(record, sdk);
      return attachment ? [attachment] : [];
    }
    for (const key of LIST_KEYS) {
      const items = record[key];
      for (const item of Array.isArray(items) ? items : items != null ? [items] : []) {
        if (typeof item === "string") {
          found.push(fs.existsSync(item) ? attachmentFromPath(item, sdk.config, "file_ref")
            : { filename: item.split("/").pop() || item, source: "file_ref", capture: "metadata_only" });
        } else {
          const nested = extractAttachments(item, sdk, depth + 1, seen);
          const direct = nested.length ? nested : item && typeof item === "object" ? [mediaAttachment(item, sdk)].filter(Boolean) as Attachment[] : [];
          found.push(...direct);
        }
      }
    }
    for (const [key, item] of Object.entries(record)) {
      if (!LIST_KEYS.includes(key) && item && typeof item === "object") found.push(...extractAttachments(item, sdk, depth + 1, seen));
    }
  }
  const unique = new Map<string, Attachment>();
  for (const attachment of found) unique.set(attachment.sha256 || attachment.filename || String(unique.size), attachment);
  return [...unique.values()];
}

function messageRole(message: any): string {
  const role = message?.role ?? message?._getType?.() ?? message?.getType?.() ?? message?.type ?? "";
  return String(role).toLowerCase();
}

/**
 * The message that starts this model call, or undefined when the user said nothing new. A chat
 * history is resent on every call: only its newest user message is this turn's prompt, and a history
 * ending in a tool result or assistant message is a later step of the same turn.
 */
export function lastUserMessage(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as any;
    const role = messageRole(message);
    if (role.includes("system") || role.includes("developer")) continue;
    return !role || role.includes("user") || role.includes("human") ? message : undefined;
  }
  return undefined;
}

/** The newest assistant answer in a message list: the prompt it also contains is not the response. */
export function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messageRole(messages[index]);
    if (role.includes("assistant") || role === "ai" || role === "model") {
      const text = textify((messages[index] as any)?.content ?? messages[index]);
      if (text) return text;
    }
  }
  return "";
}

/** What a run was asked: a `messages` list contributes only its newest user turn. */
function latestTurnText(args: unknown[]): string {
  const parts = args.map((arg: any) => {
    const messages = Array.isArray(arg) ? arg : arg?.messages;
    return Array.isArray(messages) && messages.some((message) => messageRole(message)) ? textify((lastUserMessage(messages) as any)?.content) : textify(arg);
  });
  return parts.filter(Boolean).join("\n");
}

/** A run's answer: a result holding the whole conversation contributes only its final reply. */
function answerText(result: any): string {
  if (Array.isArray(result)) {
    const final = [...result].reverse().find((item) => Array.isArray(item?.messages));
    return final ? answerText(final) : lastAssistantText(result) || result.map((item) => textify(item?.content ?? item)).join("");
  }
  if (Array.isArray(result?.messages)) {
    for (let index = result.messages.length - 1; index >= 0; index -= 1) {
      const message = result.messages[index];
      if (String(message?.source ?? "") === "user") continue;
      const text = textify(message?.content);
      if (text && !["user", "human"].includes(messageRole(message))) return text;
    }
    return "";
  }
  return textify(result);
}

// [opens the first user turn, opens the assistant's reply, the template's remaining role markup]
const CHAT_TEMPLATES: Array<[string, string, RegExp]> = [
  ["<|im_start|>user", "<|im_start|>assistant", /<\|im_(?:start|end)\|>(?:user|assistant)?/g],
  ["<|start_header_id|>user<|end_header_id|>", "<|start_header_id|>assistant<|end_header_id|>", /<\|start_header_id\|>\w+<\|end_header_id\|>|<\|eot_id\|>/g],
  ["<start_of_turn>user", "<start_of_turn>model", /<(?:start|end)_of_turn>(?:user|model)?/g],
  ["<|user|>", "<|assistant|>", /<\|(?:user|assistant|end)\|>|<\/s>/g],
  ["[INST]", "[/INST]", /\[\/?INST\]|<s>|<\/s>/g],
];

/**
 * The user's words from a prompt an app rendered through a chat template itself. Everything from the
 * first user turn to the final assistant opener is kept, with the role markup removed: a template's
 * markers are ordinary text a user can type, so taking only the last user turn would let them hide
 * content from the scan.
 */
export function templateUserText(prompt: string): string {
  for (const [user, assistant, markup] of CHAT_TEMPLATES) {
    const start = prompt.indexOf(user);
    if (start < 0) continue;
    const end = prompt.lastIndexOf(assistant);
    const body = prompt.slice(start + user.length, end > start ? end : undefined);
    return body.replace(/<<SYS>>[\s\S]*?<<\/SYS>>/g, "").replace(markup, "\n").trim();
  }
  return prompt;
}

/** Remove the prompt from a completion that echoes it (a local text-generation pipeline's full text). */
export function stripPromptEcho(response: string, prompt?: string): string {
  let text = prompt && response.startsWith(prompt) ? response.slice(prompt.length) : response;
  for (const [, assistant, markup] of CHAT_TEMPLATES) {
    const at = text.lastIndexOf(assistant);
    if (at >= 0) text = text.slice(at + assistant.length);
    text = text.replace(markup, "");
  }
  return text.trim();
}

/** The model's reasoning when the provider returns it (`reasoning_content` / `reasoning`). */
export function reasoningOf(result: any): { thinking?: string; thinking_len?: number } {
  const parts: string[] = [];
  for (const choice of result?.choices ?? []) {
    const message = choice?.message ?? {};
    const value = message.reasoning_content ?? message.reasoning;
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  for (const generation of (result?.generations ?? []).flat()) {
    const kwargs = generation?.message?.additional_kwargs ?? {};
    const value = kwargs.reasoning_content ?? kwargs.reasoning;
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  if (!parts.length) return {};
  const thinking = parts.join("\n");
  return { thinking, thinking_len: thinking.length };
}
