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
 * Console outages: General Settings sets a default for when the Console is down plus exceptions
 * (users, teams, tags, agents) that get the opposite. Every answered scan carries what applies to its
 * user and this agent (`console_outage_action`) and to this agent's other users
 * (`console_outage_fallback`). When that is `block` and a later waited-for scan cannot reach the
 * Console at all, the scan returns a block instead of failing open. A Console that answered with an
 * error, or a scan still running when the budget ran out, keeps failing open. Until the Console has
 * answered once, this process does not know the setting and fails open.
 *
 * Latency/failure contract: a transport problem never breaks the host application. In `sync`
 * mode a scan blocks only up to the configured budget for a verdict and fails open
 * on any transport problem; after a failure a cooldown breaker fails open instantly
 * instead of re-calling a struggling Console on every request. In `async` mode (and
 * for post-hoc surfaces like responses and tool results) events are queued to a
 * background drain loop and the call returns immediately.
 */

import { discoverWorkloadIdentity } from "./workload-identity.js";
import { Config } from "./config.js";
import { attachmentFromPath } from "./attachment.js";
import fs from "node:fs";
import { ConsoleTransport, GgateConsoleUnreachableError, GgateTransportError, type TransportLike } from "./console-transport.js";
import { consoleOutageDecision, decisionFromResponse, failOpenDecision, killSwitchHeld, passDecision } from "./decision.js";
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
/** Bound on users whose outage answer is remembered. */
const MAX_OUTAGE_SUBJECTS = 10_000;

/** The outage memory key for an event's user ("" when anonymous). */
function userKey(event: any): string {
  return String(event?.identity?.user ?? "").trim().toLowerCase();
}

class Breaker {
  private until = 0;
  /** Whether the failure that tripped the breaker was the Console being unreachable. */
  outage = false;

  constructor(private readonly cooldownMs: number) {}

  isOpen(): boolean {
    return Date.now() < this.until;
  }

  trip(outage = false): void {
    this.outage = outage;
    this.until = Date.now() + this.cooldownMs;
  }

  reset(): void {
    this.outage = false;
    this.until = 0;
  }
}

export class Client {
  readonly config: Config;
  private readonly workload: Promise<Record<string, string>>;
  private readonly transport: TransportLike;
  private readonly builder: RuntimeEventBuilder;
  private readonly queue: DeliveryQueue;
  private readonly breaker: Breaker;
  private readonly locks = new Map<string, Decision>();
  // What the Console said to do while it is down: per user, and for users not yet scanned.
  private readonly outageActions = new Map<string, "allow" | "block">();
  private outageFallback: "allow" | "block" = "allow";

  /**
   * `options.agentName` and `options.team` are required (see {@link ConfigOptions}); they may come
   * from `GGATE_AGENT_NAME` / `GGATE_TEAM` instead, which is why they are optional in this
   * signature. Construction throws when neither source supplies them.
   */
  constructor(options: ConfigDefaults = {}, transport?: TransportLike) {
    this.config = new Config(options);
    this.workload = this.config.enabled && this.config.cloudInstanceMetadata ? discoverWorkloadIdentity(this.config.workloadIdentity) : Promise.resolve({});
    if (transport) {
      this.transport = transport;
    } else if (this.config.consoleUrl) {
      this.transport = new ConsoleTransport(this.config);
    } else {
      if (this.config.enabled) console.warn(`[ggate] ${UNCONFIGURED}`);
      this.transport = new UnconfiguredTransport();
    }
    this.builder = new RuntimeEventBuilder(this.config);
    this.queue = new DeliveryQueue(this.transport, this.config.queueMax, this.config.flushTimeoutMs, (request, response) => {
      // A queued event's verdict is how an `async` deployment first learns of a lock. From then on
      // every scan waits for the Console, so a release takes effect at the very next scan.
      if (request.op === "scan_text") {
        this.learn(response, userKey(request.event));
        this.observe(decisionFromResponse(response), this.subject(request.event));
      }
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

  /** Scan plaintext and metadata before persistence. Always waits, even in async mode. */
  async scanMemoryWrite(content: unknown, options: ScanOptions & { store?: string; operation?: string; enforce?: boolean } = {}): Promise<Decision> {
    const { store = "memory", operation = "put", enforce = true, ...metadata } = options;
    // Validate and detach before transport error handling: unserializable content must never
    // become a fail-open network error followed by an unscanned persistence operation.
    const snapshot = JSON.parse(JSON.stringify(content));
    const { event, redaction } = this.builder.toolCall("memory.write", { store, operation, content: snapshot }, { framework: "memory", ...metadata });
    const decision = await this.sendOrQueue(event, redaction, true);
    return this.finish(decision, enforce);
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

  /** Whether any user/framework on this client has a known Kill Switch lock. */
  get contained(): boolean {
    return this.locks.size > 0;
  }

  private finish(decision: Decision, enforce?: boolean): Decision {
    if (decision.contained && decision.blocked) throw new GgateAgentContainedError(decision);
    if (enforce && decision.blocked) throw new GgateBlockedError(decision);
    return decision;
  }

  /** Track the Kill Switch. Only a real Console answer can set or clear the lock. */
  private observe(decision: Decision, subject: string): Decision {
    if (decision.contained) {
      if (!this.locks.has(subject)) console.warn(`[ggate] Kill Switch active for this agent: ${decision.message}`);
      this.locks.set(subject, decision);
    } else if (!decision.fail_open) {
      if (this.locks.delete(subject)) console.warn("[ggate] Kill Switch released for this agent");
    }
    return decision;
  }

  /** What a scan for `user` gets while the Console is unreachable, as last learned from an answer. */
  consoleOutageAction(user?: string | null): "allow" | "block" {
    return this.outageActions.get(user?.trim().toLowerCase() ?? "") ?? this.outageFallback;
  }

  /** Remember the Console's outage answer from an answered scan. Older Consoles omit it. */
  private learn(response: Record<string, any> | undefined, user: string): void {
    const action = response?.console_outage_action;
    const fallback = response?.console_outage_fallback;
    if (fallback === "allow" || fallback === "block") this.outageFallback = fallback;
    if (action === "allow" || action === "block") {
      this.outageActions.delete(user);
      this.outageActions.set(user, action);
      // Bounded: forget the users seen longest ago first.
      while (this.outageActions.size > MAX_OUTAGE_SUBJECTS) {
        this.outageActions.delete(this.outageActions.keys().next().value as string);
      }
    }
  }

  /** The Console gave no answer: fail open, unless a known lock has not been released or the
   * Console is down and its settings block this user's events until it is back. */
  private unavailable(message: string, subject: string, outage = false, user = ""): Decision {
    const lock = this.locks.get(subject);
    if (lock) return killSwitchHeld(lock, "the Console has not confirmed a release");
    return outage && this.consoleOutageAction(user) === "block" ? consoleOutageDecision() : failOpenDecision(message);
  }

  private subject(event: any): string {
    // The named agent and owning team are fixed for this client; frameworks may vary per scan.
    const framework = String(event.source?.client ?? "generic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return JSON.stringify([event.identity.user?.trim().toLowerCase() ?? null, framework]);
  }

  private async sendOrQueue(event: any, redaction: any, wait: boolean): Promise<Decision> {
    if (!this.config.enabled) return passDecision();
    const identity = await this.workload;
    if (Object.keys(identity).length) event.workload_identity = { ...identity };
    const request = { op: "scan_text", event, redaction };
    const subject = this.subject(event);
    if (!wait && !this.locks.has(subject)) {
      this.queue.submit(request);
      return passDecision();
    }
    const user = userKey(event);
    if (this.breaker.isOpen()) {
      return this.unavailable("console unavailable (cooling down after failure)", subject, this.breaker.outage, user);
    }
    try {
      const response = await this.transport.request(request);
      this.learn(response, user);
      const decision = this.observe(decisionFromResponse(response), subject);
      this.breaker.reset();
      return decision;
    } catch (error) {
      const outage = error instanceof GgateConsoleUnreachableError;
      this.breaker.trip(outage);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ggate] console scan failed (cooling down for ${this.config.cooldownSecs}s): ${message}`);
      return this.unavailable(message, subject, outage, user);
    }
  }
}
