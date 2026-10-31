import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

const session = new AsyncLocalStorage<string>();

/** The session bound by an enclosing {@link withSession}, if any. */
export function currentSessionId(): string | undefined {
  return session.getStore();
}

/**
 * One conversation: every event in `fn`, across all adapters and awaits, joins the same session.
 * Pass the app's own conversation id so a conversation stays one session across requests; without
 * one a fresh id is generated for this call.
 */
export function withSession<T>(sessionId: string | undefined, fn: () => T): T {
  return session.run(sessionId || `node-sdk-${crypto.randomUUID()}`, fn);
}
