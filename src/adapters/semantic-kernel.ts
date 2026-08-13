import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { textify } from "./common.js";

export function semanticKernelFilters(options: { framework?: string; sdkClient?: Client } = {}) {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "semantic-kernel";
  return {
    async promptRenderFilter(context: any, next: () => Promise<void>) {
      const prompt = textify(context?.renderedPrompt ?? context?.prompt ?? context);
      const decision = await sdk.scanPrompt(prompt, { framework });
      if (decision.blocked) {
        context.result = decision.message;
        return;
      }
      await next();
      const response = textify(context?.result);
      if (response) await sdk.scanResponse(response, { framework });
    },
    async functionInvocationFilter(context: any, next: () => Promise<void>) {
      const name = context?.function?.name || "function";
      const decision = await sdk.scanToolCall(name, textify(context?.arguments), { framework });
      if (decision.blocked) {
        context.result = decision.message;
        return;
      }
      await next();
      const output = textify(context?.result);
      if (output) await sdk.scanToolResult(name, output, { framework });
    },
  };
}
