import { Client } from "../core/client.js";

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
    } else if (["image_url", "image", "file", "document", "attachment"].includes(blockType)) {
      return "";
    }
    if (["image_url", "file_path", "path", "url"].some(k => record[k] != null)) {
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
      return async (...args: any[]) => {
        const prompt = textify(args);
        if (prompt) await sdk.scanPrompt(prompt, { enforce: true, framework });
        const result = await value.apply(raw, args);
        const response = textify(result);
        if (response) await sdk.scanResponse(response, { framework });
        return result;
      };
    },
  });
}
