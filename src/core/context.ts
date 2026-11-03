import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

const session = new AsyncLocalStorage<string>();
const user = new AsyncLocalStorage<string | null>();

/** The authenticated application user bound by withUser; null explicitly means anonymous. */
export function currentUser(): string | null | undefined {
  return user.getStore();
}

/** Bind a server-verified endpoint user to all scans, including adapters, across awaits. */
export function withUser<T>(identity: string | null, fn: () => T): T {
  return user.run(normalizeUser(identity), fn);
}

export function normalizeUser(identity: string | null | undefined): string | null {
  if (identity == null) return null;
  if (typeof identity !== "string") throw new TypeError("user must be a string or null");
  return identity.trim() || null;
}

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
