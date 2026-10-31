/**
 * High-level SDK client.
 *
 * Every scan goes to the Console's `POST /api/v1/scan`. That is the only destination
 * the SDK has: it holds the Console URL and an API key, and talks to nothing else.
 *
 * Kill Switch: a lock the Console reported raises GgateAgentContainedError in both modes, turns `async`
 * scanning synchronous so a release is seen at once, and stays in force (fails closed) while the
 * Console cannot confirm that release.
 *
 * Latency/failure contract: a transport problem never breaks the host application. In `sync`
 * mode a scan blocks only up to the configured budget for a verdict and fails open
 * on any transport problem; after a failure a cooldown breaker fails open instantly
 * instead of re-calling a struggling Console on every request. In `async` mode (and
 * for post-hoc surfaces like responses and tool results) events are queued to a
 * background drain loop and the call returns immediately.
 */

import { Config } from "./config.js";
import { attachmentFromPath } from "./attachment.js";
import fs from "node:fs";
import { ConsoleTransport, GgateTransportError, type TransportLike } from "./console-transport.js";
import { decisionFromResponse, failOpenDecision, killSwitchHeld, passDecision } from "./decision.js";
import { RuntimeEventBuilder, SDK_VERSION } from "./event.js";
import { DeliveryQueue } from "./queue.js";
import { ConfigDefaults, Decision, FileScanOptions, ScanOptions, ShellScanOptions, WebScanOptions } from "./types.js";

export class GgateBlockedError extends Error {
  constructor(public readonly decision: Decision) {
    super(decision.message);
    this.name = "GgateBlockedError";
  }
}

/**
 * The Console's Kill Switch has locked this agent. Extends GgateBlockedError so existing block handling
 * keeps working; unlike an ordinary block it is thrown even where the caller did not ask to enforce,
 * including `async` mode: an agent under a lock must stop, not merely be observed.
 */
export class GgateAgentContainedError extends GgateBlockedError {
  constructor(decision: Decision) {
    super(decision);
    this.name = "GgateAgentContainedError";
  }
}

const UNCONFIGURED =
  "GGATE_CONSOLE_URL and GGATE_API_KEY are not set, so there is nowhere to scan: every scan " +
  "will fail open. Set both (Console UI -> Admin -> API keys), or pass consoleUrl/apiKey to init().";

/**
 * Stands in when no Console was configured.
 *
 * Throwing here rather than at construction keeps the promise that the SDK never breaks
 * the host application: a misconfigured deployment degrades to fail-open allows with a
 * message naming the missing setting, exactly as an unreachable Console would.
 */
class UnconfiguredTransport implements TransportLike {
  async request(): Promise<Record<string, any>> {
    throw new GgateTransportError(UNCONFIGURED);
  }
}

/** Fail open instantly for a cooldown after a sync-scan failure. */
class Breaker {
  private until = 0;

  constructor(private readonly cooldownMs: number) {}

  isOpen(): boolean {
    return Date.now() < this.until;
  }

  trip(): void {
    this.until = Date.now() + this.cooldownMs;
  }

  reset(): void {
    this.until = 0;
  }
}

export class Client {
  readonly config: Config;
  private readonly transport: TransportLike;
  private readonly builder: RuntimeEventBuilder;
  private readonly queue: DeliveryQueue;
  private readonly breaker: Breaker;
  private lock?: Decision;

  /**
   * `options.agentName` and `options.team` are required (see {@link ConfigOptions}); they may come
   * from `GGATE_AGENT_NAME` / `GGATE_TEAM` instead, which is why they are optional in this
   * signature. Construction throws when neither source supplies them.
   */
  constructor(options: ConfigDefaults = {}, transport?: TransportLike) {
    this.config = new Config(options);
    if (transport) {
      this.transport = transport;
    } else if (this.config.configured) {
      this.transport = new ConsoleTransport(this.config);
    } else {
      if (this.config.enabled) console.warn(`[ggate] ${UNCONFIGURED}`);
      this.transport = new UnconfiguredTransport();
    }
    this.builder = new RuntimeEventBuilder(this.config);
    this.queue = new DeliveryQueue(this.transport, this.config.queueMax, this.config.flushTimeoutMs, (request, response) => {
      // A queued event's verdict is how an `async` deployment first learns of a lock. From then on
      // every scan waits for the Console, so a release takes effect at the very next scan.
      if (request.op === "scan_text") this.observe(decisionFromResponse(response));
    });
    this.breaker = new Breaker(this.config.cooldownSecs * 1000);
    if (this.config.enabled) {
      // Queued, not sent inline: registration must never delay application startup.
      this.queue.submit({
        op: "collector_ready",
        collector_id: this.config.collectorId,
        collector_type: "sdk",
        name: "ggate-node-sdk",
        agents: ["agent-framework"],
        metadata: {
          language: "javascript",
          version: SDK_VERSION,
          agent_name: this.config.agentName,
          team: this.config.team,
        },
      });
    }
  }

  async scanPrompt(text: string, options: ScanOptions & { enforce?: boolean } = {}): Promise<Decision> {
    const { event, redaction } = this.builder.prompt(text, options);
    const decision = await this.sendOrQueue(event, redaction, this.config.mode === "sync" || Boolean(options.enforce));
    return this.finish(decision, options.enforce);
  }

  async scanResponse(text: string, options: ScanOptions & { wait?: boolean; enforce?: boolean } = {}): Promise<Decision> {
    if (options.enforce) options = { ...options, before_delivery: true };
    const { event, redaction } = this.builder.response(text, options);
    const decision = await this.sendOrQueue(event, redaction, Boolean(options.wait || options.before_delivery));
    return this.finish(decision, options.enforce);
  }

  async scanToolCall(
    tool: string,
    inputSummary: unknown,
    options: ScanOptions & { enforce?: boolean } = {},
  ): Promise<Decision> {
    const { event, redaction } = this.builder.toolCall(tool, inputSummary, options);
    const decision = await this.sendOrQueue(event, redaction, this.config.mode === "sync" || Boolean(options.enforce));
    return this.finish(decision, options.enforce);
  }

  async scanToolResult(
    tool: string,
    output: string,
    options: ScanOptions & { wait?: boolean; enforce?: boolean } = {},
  ): Promise<Decision> {
    if (options.enforce) options = { ...options, before_delivery: true };
    const { event, redaction } = this.builder.toolResult(tool, output, options);
    const decision = await this.sendOrQueue(event, redaction, Boolean(options.wait || options.enforce || options.before_delivery));
    return this.finish(decision, options.enforce);
  }

  async scanShell(command: string, options: ShellScanOptions = {}): Promise<Decision> {
    const { event, redaction } = this.builder.shell(command, options);
    const decision = await this.sendOrQueue(event, redaction, this.config.mode === "sync" || Boolean(options.enforce));
    return this.finish(decision, options.enforce);
  }

  async scanFile(filename: string, options: FileScanOptions = {}): Promise<Decision> {
    let effective = options;
    if (options.content === undefined && this.config.captureFileText && fs.existsSync(filename)) {
      try {
        const attachment = attachmentFromPath(filename, this.config, "file_ref");
        effective = { ...options, content: attachment.text, content_len: attachment.size };
      } catch {
        // A path-only policy scan is still useful when the process cannot read the content.
      }
    }
    const { event, redaction } = this.builder.file(filename, effective);
    const decision = await this.sendOrQueue(event, redaction, this.config.mode === "sync" || Boolean(options.enforce));
    return this.finish(decision, options.enforce);
  }

  async scanWeb(url: string, options: WebScanOptions = {}): Promise<Decision> {
    const { event, redaction } = this.builder.web(url, options);
    const decision = await this.sendOrQueue(event, redaction, this.config.mode === "sync" || Boolean(options.enforce));
    return this.finish(decision, options.enforce);
  }

  /** Build an attachment for prompt/response scanning using the configured capture limit. */
  attachmentFromPath(filename: string, source: "upload" | "paste" | "file_ref" | "generated" | "other" = "upload") {
    return attachmentFromPath(filename, this.config, source);
  }

  /** Drain queued events. Resolves false when the deadline expired with events left. */
  flush(timeoutMs?: number): Promise<boolean> {
    return this.queue.flush(timeoutMs);
  }

  /** Whether the Console last reported this agent as locked by the Kill Switch. */
  get contained(): boolean {
    return this.lock !== undefined;
  }

  private finish(decision: Decision, enforce?: boolean): Decision {
    if (decision.contained && decision.blocked) throw new GgateAgentContainedError(decision);
    if (enforce && decision.blocked) throw new GgateBlockedError(decision);
    return decision;
  }

  /** Track the Kill Switch. Only a real Console answer can set or clear the lock. */
  private observe(decision: Decision): Decision {
    if (decision.contained) {
      if (!this.lock) console.warn(`[ggate] Kill Switch active for this agent: ${decision.message}`);
      this.lock = decision;
    } else if (!decision.fail_open) {
      if (this.lock) console.warn("[ggate] Kill Switch released for this agent");
      this.lock = undefined;
    }
    return decision;
  }

  /** The Console gave no answer: fail open, unless a known lock has not been released. */
  private unavailable(message: string): Decision {
    return this.lock ? killSwitchHeld(this.lock, "the Console has not confirmed a release") : failOpenDecision(message);
  }

  private async sendOrQueue(event: any, redaction: any, wait: boolean): Promise<Decision> {
    if (!this.config.enabled) return passDecision();
    const request = { op: "scan_text", event, redaction };
    if (!wait && !this.lock) {
      this.queue.submit(request);
      return passDecision();
    }
    if (this.breaker.isOpen()) {
      return this.unavailable("console unavailable (cooling down after failure)");
    }
    try {
      const decision = this.observe(decisionFromResponse(await this.transport.request(request)));
      this.breaker.reset();
      return decision;
    } catch (error) {
      this.breaker.trip();
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ggate] console scan failed (failing open for ${this.config.cooldownSecs}s): ${message}`);
      return this.unavailable(message);
    }
  }
}
