/**
 * Background fire-and-forget delivery.
 *
 * A single drain loop empties a bounded queue. Delivery failures are retried a few
 * times with capped exponential backoff (the agent may be restarting); when the
 * queue is full the oldest event is dropped. Backoff timers are unref'd so pending
 * retries never hold the process open — call `flush()` to drain explicitly.
 */

import type { TransportLike } from "./console-transport.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

interface Item {
  request: Record<string, any>;
  attempts: number;
}

export class DeliveryQueue {
  private queue: Item[] = [];
  private draining?: Promise<void>;
  private dropped = 0;

  constructor(
    private readonly transport: TransportLike,
    private readonly maxSize: number,
    private readonly flushTimeoutMs: number,
  ) {}

  submit(request: Record<string, any>): void {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
      this.dropped += 1;
      if ([1, 100, 10000].includes(this.dropped)) {
        console.warn(`[ggate] queue full; dropped ${this.dropped} event(s) so far`);
      }
    }
    this.queue.push({ request, attempts: 0 });
    if (!this.draining) this.draining = this.drain();
  }

  /** Wait until the queue drains. Resolves false when the deadline expired first. */
  async flush(timeoutMs?: number): Promise<boolean> {
    const deadline = Date.now() + (timeoutMs ?? this.flushTimeoutMs);
    while (this.draining) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await Promise.race([this.draining, sleep(Math.min(remaining, 100), false)]);
    }
    return true;
  }

  private async drain(): Promise<void> {
    let backoffMs = BACKOFF_START_MS;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.transport.request(item.request);
          backoffMs = BACKOFF_START_MS;
        } catch (error) {
          item.attempts += 1;
          if (item.attempts >= MAX_ATTEMPTS) {
            console.warn(`[ggate] delivery failed after ${item.attempts} attempts, dropping event:`, error);
          } else {
            this.queue.unshift(item);
          }
          // Unref'd: a dead agent must not keep the process alive just to retry.
          await sleep(backoffMs, true);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
        }
      }
    } finally {
      this.draining = undefined;
      if (this.queue.length > 0) this.draining = this.drain();
    }
  }
}

function sleep(ms: number, unref: boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) timer.unref?.();
  });
}
