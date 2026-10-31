import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { textify } from "./common.js";

// Semantic Kernel filters are middleware: each receives the context and must hand it on with
// `next(context)`; the JavaScript kernel renders and invokes with the context it is given, so calling
// `next()` without it rendered nothing and the model was never called.
type Next = (context: any) => Promise<unknown>;

export function semanticKernelFilters(options: { framework?: string; sdkClient?: Client } = {}) {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "semantic-kernel";
  return {
    // The prompt exists only after rendering, so render first and scan the result. A block throws
    // GgateBlockedError, which stops the invocation before the model is called.
    async promptRenderFilter(context: any, next: Next) {
      await next(context);
      const prompt = textify(context?.renderedPrompt ?? context?.prompt);
      if (prompt) await sdk.scanPrompt(prompt, { enforce: sdk.config.mode === "sync", framework });
    },
    async functionInvocationFilter(context: any, next: Next) {
      const name = context?.function?.name || "function";
      // Prompt functions are scanned by the render filter; only real tools are tool calls.
      const isPromptFunction = String(context?.function?.constructor?.name ?? "").includes("FromPrompt");
      if (!isPromptFunction) {
        await sdk.scanToolCall(name, textify(context?.arguments), { enforce: sdk.config.mode === "sync", framework });
      }
      await next(context);
      const output = textify(context?.result?.value ?? context?.result);
      if (!output) return;
      if (isPromptFunction) await sdk.scanResponse(output, { enforce: sdk.config.mode === "sync", framework });
      else await sdk.scanToolResult(name, output, { enforce: sdk.config.mode === "sync", framework });
    },
  };
}
