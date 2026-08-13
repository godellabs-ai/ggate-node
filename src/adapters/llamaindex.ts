import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { textify } from "./common.js";

export function llamaIndexCallback(options: { framework?: string; sdkClient?: Client } = {}) {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "llamaindex";
  return {
    async onEventStart(eventType: unknown, payload: unknown, eventId?: string) {
      const text = textify(payload);
      if (text) await sdk.scanPrompt(text, { enforce: true, framework, request_id: String(eventId || "") });
    },
    async onEventEnd(eventType: unknown, payload: unknown, eventId?: string) {
      const text = textify(payload);
      if (text) await sdk.scanResponse(text, { framework, request_id: String(eventId || "") });
    },
  };
}
