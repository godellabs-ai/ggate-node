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
import { ConfigOptions, Mode } from "./types.js";

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

  constructor(options: ConfigOptions = {}) {
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
  }

  /** Whether a Console to scan against has been supplied. */
  get configured(): boolean {
    return Boolean(this.consoleUrl && this.apiKey);
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
