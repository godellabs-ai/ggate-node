import { randomUUID } from "node:crypto";
import { Client } from "../core/client.js";
import type { Attachment, ScanOptions } from "../core/types.js";

/** Structural public SDK contract; importing Gate does not load Microsoft's packages. */
export interface AgentsTurnContext {
  activity: any;
  onSendActivities(handler: (context: any, activities: any[], next: () => Promise<any>) => Promise<any>): unknown;
  onUpdateActivity(handler: (context: any, activity: any, next: () => Promise<any>) => Promise<any>): unknown;
}

function content(activity: any): { text: string; attachments: Attachment[] } {
  const parts = [activity.text, activity.speak].filter(Boolean).map(String);
  if (activity.value != null) parts.push(JSON.stringify(activity.value));
  const attachments: Attachment[] = (activity.attachments ?? []).map((item: any) => {
    if (item.content != null) parts.push(JSON.stringify(item.content));
    return { filename: item.name || "attachment", mime_type: item.contentType,
      source: "upload", capture: "metadata_only" };
  });
  return { text: parts.join("\n"), attachments };
}

/** Message boundary protection. Instrument internal model/tool calls separately. */
export class Microsoft365AgentsMiddleware {
  private readonly contexts = new WeakMap<AgentsTurnContext, ScanOptions>();
  constructor(private readonly sdk: Client) {}

  /** Pass these options to explicit model/tool scans within the same turn. */
  metadata(context: AgentsTurnContext): ScanOptions {
    const existing = this.contexts.get(context);
    if (existing) return { ...existing };
    const a = context.activity;
    const turnId = a.id || randomUUID();
    const metadata: ScanOptions = {
      framework: "microsoft-365-agents",
      session_id: `m365:${a.channelId || "unknown"}:${a.conversation?.tenantId || ""}:${a.conversation?.id || turnId}`,
      conversation_id: a.conversation?.id, correlation_id: turnId, request_id: turnId,
      source_detail: { channel_id: a.channelId, tenant_id: a.conversation?.tenantId,
        activity_type: a.type, from_id: a.from?.id },
    };
    this.contexts.set(context, metadata);
    return { ...metadata };
  }

  async onTurn(context: AgentsTurnContext, next: () => Promise<void>): Promise<void> {
    const metadata = this.metadata(context);
    const enforce = this.sdk.config.mode === "sync";
    const scan = async (activity: any) => {
      const { text, attachments } = content(activity);
      if (text || attachments.length) await this.sdk.scanResponse(text, { ...metadata, attachments, enforce });
    };
    context.onSendActivities(async (_context, activities, send) => {
      for (const activity of activities) await scan(activity);
      return send();
    });
    context.onUpdateActivity(async (_context, activity, update) => {
      await scan(activity);
      return update();
    });
    const { text, attachments } = content(context.activity);
    if (text || attachments.length) await this.sdk.scanPrompt(text, { ...metadata, attachments, enforce });
    await next();
  }
}
