import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { currentSessionId } from "../core/context.js";
import { extractAttachments, lastUserMessage, reasoningOf, stripPromptEcho, templateUserText, textify } from "./common.js";

const MAX_TRACKED_RUNS = 10_000;

interface Run {
  session_id?: string;
  prompt?: string;
  tool?: string;
}

export function langchainCallback(options: { framework?: string; sdkClient?: Client; session_id?: string } = {}) {
  const sdk = options.sdkClient ?? getClient();
  const framework = options.framework ?? "langchain";
  const enforce = () => sdk.config.mode === "sync";
  // LangChain passes run metadata to start callbacks only, so what a run started with is kept for its
  // end callback and for the runs nested inside it.
  const runs = new Map<string, Run>();

  /**
   * The app's conversation id wins: run metadata (`session_id`, or LangGraph's `thread_id`), the
   * session an enclosing run is in, withSession(), then the handler's option. Only without any of
   * those does the outermost run become the session, keeping one invocation's events together.
   */
  const track = (runId?: string, parentRunId?: string, metadata?: Record<string, any>): Run => {
    const key = runId ?? "";
    const known = runs.get(key) ?? (parentRunId ? runs.get(parentRunId) : undefined);
    const sessionId = metadata?.session_id ?? metadata?.thread_id ?? known?.session_id ?? currentSessionId()
      ?? options.session_id ?? parentRunId ?? runId;
    const run = runs.get(key) ?? {};
    run.session_id = sessionId ? String(sessionId) : undefined;
    runs.delete(key);
    runs.set(key, run);
    if (runs.size > MAX_TRACKED_RUNS) runs.delete(runs.keys().next().value!);
    return run;
  };
  const forget = (runId?: string): Run => {
    const run = runs.get(runId ?? "") ?? {};
    runs.delete(runId ?? "");
    return run;
  };

  return {
    name: "ggate",
    // LangChain JS runs handlers in the background and ignores their errors by default, so the model
    // call went ahead before the scan returned and a block was never raised.
    awaitHandlers: true,
    raiseError: true,
    handleChainStart(_chain: unknown, _inputs: unknown, runId?: string, parentRunId?: string, _tags?: string[], metadata?: Record<string, any>) {
      track(runId, parentRunId, metadata);
    },
    handleChainEnd(_outputs: unknown, runId?: string) {
      forget(runId);
    },
    handleChainError(_error: unknown, runId?: string) {
      forget(runId);
    },
    async handleLLMStart(_llm: unknown, prompts: string[], runId?: string, parentRunId?: string, _extra?: unknown, _tags?: string[], metadata?: Record<string, any>) {
      const raw = (prompts || []).join("\n");
      const run = track(runId, parentRunId, metadata);
      run.prompt = raw;
      await sdk.scanPrompt(templateUserText(raw), { enforce: enforce(), framework, request_id: runId, session_id: run.session_id });
    },
    async handleChatModelStart(_llm: unknown, messages: any[][], runId?: string, parentRunId?: string, _extra?: unknown, _tags?: string[], metadata?: Record<string, any>) {
      const run = track(runId, parentRunId, metadata);
      for (const batch of messages || []) {
        const latest: any = lastUserMessage(batch);
        if (latest === undefined) continue; // a later step of this turn: handleToolEnd scanned its results
        await sdk.scanPrompt(textify(latest.content ?? latest), {
          enforce: enforce(),
          framework,
          request_id: runId,
          session_id: run.session_id,
          attachments: extractAttachments(latest, sdk),
        });
      }
    },
    async handleLLMEnd(output: any, runId?: string) {
      const run = forget(runId);
      const text = stripPromptEcho(llmOutputToText(output), run.prompt);
      if (text) await sdk.scanResponse(text, { enforce: enforce(), framework, request_id: runId, session_id: run.session_id, ...reasoningOf(output) });
    },
    handleLLMError(_error: unknown, runId?: string) {
      forget(runId);
    },
    async handleToolStart(tool: any, input: string, runId?: string, parentRunId?: string, _tags?: string[], metadata?: Record<string, any>, name?: string) {
      const run = track(runId, parentRunId, metadata);
      run.tool = name || tool?.name || "tool";
      await sdk.scanToolCall(run.tool ?? "tool", input, { enforce: enforce(), framework, request_id: runId, session_id: run.session_id });
    },
    async handleToolEnd(output: unknown, runId?: string) {
      const run = forget(runId);
      await sdk.scanToolResult(run.tool || "tool", textify(output) || String(output), { enforce: enforce(), framework, request_id: runId, session_id: run.session_id });
    },
    handleToolError(_error: unknown, runId?: string) {
      forget(runId);
    },
  };
}

function llmOutputToText(output: any): string {
  if (!output?.generations) return "";
  return output.generations
    .flat()
    .map((generation: any) => generation.text || textify(generation.message?.content) || "")
    .filter(Boolean)
    .join("\n");
}
