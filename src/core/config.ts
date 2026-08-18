/**
 * Configuration and identity resolution.
 *
 * The SDK scans against a Console and nothing else: `GGATE_CONSOLE_URL` + `GGATE_API_KEY`
 * are the only required settings. The device config an installed agent maintains at
 * `~/.ggate/config.yaml` is read for **identity only** (org, seat user, workstation id), and
 * only when the file happens to exist — the SDK never talks to an agent. Sharing those values
 * keeps SDK events attributed to the same org/seat/device as the coding-agent and browser
 * events from the same machine, so the Console correlates them instead of inventing a second
 * identity.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigDefaults, Mode } from "./types.js";

/** Scan budget when nothing is configured. A ceiling, not a per-call cost: a text scan answers
 * in tens of milliseconds. Raise it (`GGATE_TIMEOUT_MS`) for prompts carrying attachments,
 * where the Console also extracts and OCRs the file before deciding. */
export const DEFAULT_TIMEOUT_MS = 4000;

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] != null ? value : fallback;
}

function ggateHome(): string {
  return expandHome(process.env.GGATE_HOME || "~/.ggate");
}

/** Read one top-level scalar from the device config.yaml (line-oriented, no YAML dep). An
 * absent or unreadable file resolves to undefined: this is an optional source of identity
 * defaults, never a requirement. */
function readConfigScalar(name: string): string | undefined {
  try {
    const file = expandHome(process.env.GGATE_CONFIG || "") || path.join(ggateHome(), "config.yaml");
    for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
      const line = rawLine.split("#", 1)[0];
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      if (line.slice(0, idx).trim() !== name) continue;
      const value = line
        .slice(idx + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      return value || undefined;
    }
  } catch {
    /* no config file — fall through */
  }
  return undefined;
}

/** Scan budget: `GGATE_TIMEOUT_MS`, else {@link DEFAULT_TIMEOUT_MS}. */
function defaultTimeoutMs(): number {
  const value = Number(process.env.GGATE_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_TIMEOUT_MS;
}

/** Seat identity, matching the Rust collectors' `seat_user`: explicit GGATE_USER /
 * GGATE_USER_EMAIL, else the device config's `user_email`, else `<os-user>@<hostname>`. */
function defaultUser(host: string): string | undefined {
  const explicit = process.env.GGATE_USER || process.env.GGATE_USER_EMAIL;
  if (explicit) return explicit;
  const email = readConfigScalar("user_email");
  if (email) return email;
  let osUser = process.env.USER || process.env.USERNAME;
  if (!osUser) {
    try {
      osUser = os.userInfo().username;
    } catch {
      osUser = undefined;
    }
  }
  if (osUser && host) return `${osUser}@${host}`;
  return osUser || host || undefined;
}

/**
 * Refuse to build a Config without an identity the SDK cannot infer. Always throws; typed as
 * returning `string` so it can terminate a `??` chain at the point the value is resolved.
 *
 * Raised at construction rather than at scan time: this is a deployment that was never named,
 * not a Console that went away. Failing open on it would file every event the process ever
 * writes under an anonymous agent, which no later configuration can repair.
 */
function required(name: string, envVar: string, option: string, example: string): string {
  throw new Error(
    `ggate: ${name} is required. Pass ${option} to init() (e.g. ${option}: ${JSON.stringify(example)}) ` +
      `or set ${envVar}.`,
  );
}

export class Config {
  mode: Mode;
  timeoutMs: number;
  consoleUrl?: string;
  apiKey?: string;
  consoleInsecureTls: boolean;
  queueMax: number;
  enabled: boolean;
  orgId: string;
  user?: string;
  host: string;
  workstationId: string;
  collectorId: string;
  labels: Record<string, string>;
  redact: boolean;
  cooldownSecs: number;
  flushTimeoutMs: number;
  /** Operator-declared name of this agent. Required — see {@link ConfigOptions.agentName}. */
  agentName: string;
  /** Operator-declared owning team. Required — see {@link ConfigOptions.team}. */
  team: string;

  constructor(options: ConfigDefaults = {}) {
    this.mode = options.mode ?? ((process.env.GGATE_MODE as Mode | undefined) || "sync");
    if (!["sync", "async"].includes(this.mode)) {
      throw new Error("mode must be 'sync' or 'async'");
    }
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs();
    // Where scans go. Both are required; without them every scan fails open with a message
    // saying so (see `Client`), because a missing setting must never break the host app.
    this.consoleUrl = options.consoleUrl ?? process.env.GGATE_CONSOLE_URL ?? undefined;
    this.apiKey = options.apiKey ?? process.env.GGATE_API_KEY ?? undefined;
    // Dev escape hatch: accept a self-signed Console cert (e.g. https://localhost).
    this.consoleInsecureTls =
      options.consoleInsecureTls ?? boolEnv("GGATE_CONSOLE_INSECURE", false);
    this.queueMax = options.queueMax ?? intEnv("GGATE_QUEUE_MAX", 1024);
    this.enabled = options.enabled ?? !boolEnv("GGATE_DISABLED", false);
    this.orgId = options.orgId ?? process.env.GGATE_ORG_ID ?? readConfigScalar("org_id") ?? "local";
    this.host = os.hostname();
    this.user = options.user ?? defaultUser(this.host);
    this.workstationId =
      options.workstationId ??
      process.env.GGATE_WORKSTATION_ID ??
      readConfigScalar("workstation_id") ??
      this.host;
    this.collectorId =
      options.collectorId ?? process.env.GGATE_COLLECTOR_ID ?? `${this.workstationId}:ggate-node-sdk`;
    this.labels = options.labels ?? {};
    // Off by default: the Console IS the detection engine, so masking client-side would hide
    // exactly the secrets it exists to catch. `GGATE_REDACT=1` / `redact: true` turns it on for
    // deployments that would rather lose those detections than let the content leave the process.
    this.redact = options.redact ?? boolEnv("GGATE_REDACT", false);
    this.cooldownSecs = options.cooldownSecs ?? Math.max(0, intEnv("GGATE_COOLDOWN_SECS", 30));
    this.flushTimeoutMs = options.flushTimeoutMs ?? Math.max(0, intEnv("GGATE_FLUSH_TIMEOUT_MS", 3000));
    // Identity the SDK cannot infer, so it is asked for rather than guessed. Unlike a missing
    // Console (which degrades to fail-open scans), an unnamed agent is a permanent labelling
    // error in the event store, so it is caught at startup.
    this.agentName =
      trimmed(options.agentName) ??
      trimmed(process.env.GGATE_AGENT_NAME) ??
      required("agentName", "GGATE_AGENT_NAME", "agentName", "JIRA Project Assistant");
    this.team =
      trimmed(options.team) ??
      trimmed(process.env.GGATE_TEAM) ??
      required("team", "GGATE_TEAM", "team", "Platform Engineering");
  }

  /** Whether a Console to scan against has been supplied. */
  get configured(): boolean {
    return Boolean(this.consoleUrl && this.apiKey);
  }
}

/** A non-blank string, or undefined — so whitespace never counts as a supplied value. */
function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
