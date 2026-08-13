/**
 * The LangGraph agent: OpenAI GPT + Atlassian Jira MCP tools, with every tool
 * call and tool result routed through Godel's Gate before the model or the user
 * sees it. A block verdict aborts the whole run via the turn's AbortSignal.
 */

import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

import { TurnGuard, ChatBlockedError } from "./ggate";
import {
  extractAttachments,
  fetchAttachmentContent,
  fetchIssueAttachments,
  withAttachmentField,
} from "./jira";

const SYSTEM_PROMPT = `You are the Jira Project Assistant for this team's Jira site.
Use the available Jira tools to answer questions about projects, tickets, sprints, and boards —
for example "Describe the ticket ECS-55" or "Show all in progress tasks".

Guidelines:
- Always look up live data with the tools; never invent ticket details.
- When describing a ticket, include its status, assignee, priority, and a concise summary of the
  description and recent activity. Mention attachments by name when the ticket has any.
- Prefer JQL searches for "show all ..." style questions and present results as a compact
  markdown table (key, summary, status, assignee).
- Keep answers short and factual. If a lookup fails, say what failed.`;

interface GuardedConfigurable {
  guard: TurnGuard;
  sessionId: string;
}

function guardOf(config: RunnableConfig | undefined): GuardedConfigurable {
  const value = config?.configurable as
    Partial<GuardedConfigurable> | undefined;
  if (!value?.guard || !value.sessionId) {
    throw new Error("ggate turn guard missing from runnable config");
  }
  return value as GuardedConfigurable;
}

function textify(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map((block) => textify(block)).join("\n");
  }
  // MCP tool results arrive as a text content block ({ type: "text", text: "<payload>" }); use its
  // inner text, not a JSON.stringify of the wrapper — otherwise the payload (e.g. a Jira issue's
  // `attachments`) is buried one JSON level deep and never scanned or discovered.
  if (
    typeof output === "object" &&
    typeof (output as { text?: unknown }).text === "string"
  ) {
    return (output as { text: string }).text;
  }
  return JSON.stringify(output ?? "");
}

async function buildAgent() {
  const mcpClient = new MultiServerMCPClient({
    mcpServers: {
      jira: {
        transport: "stdio",
        command: process.env.JIRA_MCP_COMMAND || "uvx",
        args: process.env.JIRA_MCP_ARGS
          ? JSON.parse(process.env.JIRA_MCP_ARGS)
          : ["mcp-atlassian"],
        env: {
          JIRA_URL: process.env.JIRA_URL || "",
          JIRA_USERNAME: process.env.JIRA_USERNAME || "",
          JIRA_API_TOKEN: process.env.JIRA_API_TOKEN || "",
          READ_ONLY_MODE: process.env.JIRA_READ_ONLY ?? "true",
          PATH: process.env.PATH || "",
        },
      },
    },
  });

  const mcpTools = await mcpClient.getTools();

  // Wrap every MCP tool: scan the call before it runs, scan the result (and any
  // referenced Jira attachments) before it reaches the model.
  const guardedTools = mcpTools.map((mcpTool) =>
    tool(
      async (input: unknown, config: RunnableConfig) => {
        const { guard, sessionId } = guardOf(config);
        await guard.scanToolCall(mcpTool.name, input, sessionId);

        // mcp-atlassian's `jira_get_issue` omits attachments from its default field set, so the guard
        // would never see them. Ask for the `attachment` field explicitly (the model's call is scanned
        // above as-is; this only enriches what we retrieve so the files can be fetched + scanned).
        const raw = await mcpTool.invoke(
          withAttachmentField(mcpTool.name, input) as never,
          config,
        );
        const output = textify(raw);
        await guard.scanToolResult(mcpTool.name, output, sessionId);

        // Inspect the raw MCP value, not the flattened model-facing string. Depending on the adapter,
        // Jira's issue JSON can live under a nested `text` string and attachment resource blocks can
        // otherwise disappear during flattening.
        const attachments = extractAttachments(raw);
        if (attachments.length === 0) {
          attachments.push(...(await fetchIssueAttachments(mcpTool.name, input)));
        }
        for (const attachment of attachments) {
          const fetched = await fetchAttachmentContent(attachment);
          await guard.scanAttachment(fetched, sessionId);
        }
        return output;
      },
      {
        name: mcpTool.name,
        description: mcpTool.description,
        schema: mcpTool.schema,
      },
    ),
  );

  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    maxTokens: 4096,
  });

  return createReactAgent({
    llm,
    tools: guardedTools,
    stateModifier: SYSTEM_PROMPT,
    checkpointSaver: new MemorySaver(),
  });
}

// Next.js dev re-evaluates route modules on hot reload, which resets any
// module-scoped state — so a plain `let` singleton would spawn a fresh MCP
// stdio server on every request. Stashing the promise on globalThis keeps one
// MCP client (and one agent) per server process, built lazily on first use and
// reused across every subsequent request and reload.
const globalForAgent = globalThis as typeof globalThis & {
  __jiraAgentPromise?: ReturnType<typeof buildAgent>;
};

export function getAgent() {
  return (globalForAgent.__jiraAgentPromise ??= buildAgent());
}

export interface TurnResult {
  reply: string;
  scans: ReturnType<TurnGuard["scans"]["slice"]>;
  blocked?: {
    label: string;
    surface: string;
    detection?: { source: string; detail: string };
  };
}

/** Run one chat turn: scan prompt → run agent (tools self-scanning) → scan reply. */
export async function runTurn(
  message: string,
  sessionId: string,
): Promise<TurnResult> {
  const guard = new TurnGuard();
  try {
    await guard.scanPrompt(message, sessionId);

    const agent = await getAgent();
    const result = await agent.invoke(
      { messages: [{ role: "user", content: message }] },
      {
        configurable: { thread_id: sessionId, guard, sessionId },
        signal: guard.abort.signal,
        recursionLimit: 40,
      },
    );

    const last = result.messages[result.messages.length - 1];
    const reply = textify(last?.content ?? "");
    await guard.scanResponse(reply, sessionId);

    return { reply, scans: guard.scans };
  } catch (error) {
    if (guard.blocked) {
      return {
        reply: "",
        scans: guard.scans,
        blocked: {
          label: guard.blocked.label,
          surface: guard.blocked.surface,
          detection: guard.blocked.detection,
        },
      };
    }
    if (error instanceof ChatBlockedError) {
      return {
        reply: "",
        scans: guard.scans,
        blocked: {
          label: error.scan.label,
          surface: error.scan.surface,
          detection: error.scan.detection,
        },
      };
    }
    throw error;
  }
}
