/**
 * The SDK's transport: scan via the Console's HTTP API.
 *
 * Scans go to the Console's `POST /api/v1/scan` endpoint, which runs the full
 * pipeline — normalize, OCR/extraction of attachments, deterministic rules, the
 * security classifier, DLP, threat intel, document intelligence, and policy —
 * records the event, and returns the decision.
 *
 * Auth is the same scale path the Detection Engine uses: the IAM API key is exchanged
 * at `/api/v1/detection-engine/token` for a short-lived JWT and long-lived refresh token. Scans
 * carry the access token as `Authorization: Bearer`; the Console verifies its signature without an
 * Argon2 hash on every request. The refresh endpoint rotates the pair shortly before expiry.
 *
 * Collector registration is implicit — the Console reconciles its fleet
 * registry from the events themselves — so `collector_ready` is a no-op.
 */

import fs from "node:fs";
import { Config } from "./config.js";

export class GgateTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GgateTransportError";
  }
}

/**
 * The Console itself could not be reached: no connection (DNS, refused, reset, TLS), or a gateway in
 * front of it answering 502/503/504 for it. A Console that answered with an error, or a scan still
 * running when the SDK's budget ran out, is not unreachable. Only this case applies the Console's
 * outage setting.
 */
export class GgateConsoleUnreachableError extends GgateTransportError {
  constructor(message: string) {
    super(message);
    this.name = "GgateConsoleUnreachableError";
  }
}

/** A gateway status whose body is not the Console's own JSON (its incomplete-scan 503 is JSON). */
function httpFailure(message: string, status: number, body: string): GgateTransportError {
  return GATEWAY_STATUSES.has(status) && !body.trimStart().startsWith("{")
    ? new GgateConsoleUnreachableError(message)
    : new GgateTransportError(message);
}

/** A degraded scan can still carry the Console's policy decision for this event. */
function partialScan(body: string, eventId: unknown): Record<string, any> | undefined {
  let result;
  try { result = JSON.parse(body); } catch { return undefined; }
  const decision = result?.decision;
  if (typeof eventId !== "string" || !eventId || result?.event_id !== eventId || result.policy_resolved !== true ||
      !decision || !["pass", "warn", "block", "system"].includes(decision.verdict) ||
      typeof decision.message !== "string" || typeof decision.fail_open !== "boolean" ||
      (decision.kind != null && decision.kind !== "verdict")) return undefined;
  return {
    ...decision,
    fail_open: decision.fail_open || decision.verdict !== "block",
    model_status: result.model_status ?? { state: "unknown" },
    pipeline_status: result.pipeline_status,
    document_intelligence: result.document_intelligence,
  };
}

/** A fetch that produced no response. A timeout means the Console may still be working on it. */
function connectionFailure(baseUrl: string, error: unknown): GgateTransportError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new GgateTransportError(`console scan timed out (${baseUrl}): ${message}`);
  }
  return new GgateConsoleUnreachableError(`console unreachable (${baseUrl}): ${message}`);
}

/** What the client and queue need from a transport: one JSON request/response exchange. */
export interface TransportLike {
  request(request: Record<string, any>): Promise<Record<string, any>>;
}

// Re-exchange this long before the access token expires.
const TOKEN_SLACK_MS = 60_000;

// Gateway/proxy statuses worth one transient retry before failing open.
const GATEWAY_STATUSES = new Set([502, 503, 504]);

export class ConsoleTransport {
  private readonly baseUrl: string;
  private accessToken?: string;
  private credential?: string;
  private refreshToken?: string;
  private tokenExpiresAt = 0;
  private exchange?: Promise<string>;
  private dispatcher?: Promise<unknown | undefined>;

  constructor(private readonly config: Config) {
    this.baseUrl = (config.consoleUrl ?? "").replace(/\/+$/, "");
  }

  /**
   * An undici `Agent` configured with either an explicit private CA or the opt-in insecure dev
   * escape hatch. Built lazily and cached; undici is Node's built-in `fetch` backend, so the ignore
   * comments keep bundlers from trying to resolve it at build time.
   */
  private tlsDispatcher(): Promise<unknown | undefined> {
    if (!this.config.consoleInsecureTls && !this.config.consoleCaCert) return Promise.resolve(undefined);
    this.dispatcher ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "undici")
      .then(({ Agent }) => {
        const connect = this.config.consoleCaCert
          ? { ca: fs.readFileSync(this.config.consoleCaCert), rejectUnauthorized: true }
          : { rejectUnauthorized: false };
        return new Agent({ connect });
      })
      .catch((error) => {
        throw new GgateTransportError(`unable to configure Console TLS: ${error}`);
      });
    return this.dispatcher;
  }

  async request(request: Record<string, any>): Promise<Record<string, any>> {
    if (request.op === "collector_ready") return { kind: "ok" };
    if (request.op !== "scan_text") {
      throw new GgateTransportError(`op ${JSON.stringify(request.op)} is not supported by the console transport`);
    }

    let response = await this.scan(request, await this.token());
    if (response.status === 401) {
      // Token expired server-side (or was revoked): refresh the pair and retry once.
      this.accessToken = undefined;
      response = await this.scan(request, await this.token());
    }
    for (let retries = 0; !response.ok; retries++) {
      if (response.status === 401 || response.status === 403) {
        throw new GgateTransportError(authFailure("scan", response.status));
      }
      const body = await response.text().catch(() => "");
      if (response.status === 503 || response.status === 504) {
        const resolved = partialScan(body, request.event?.id);
        if (resolved) return resolved;
      }
      if (retries === 0 && GATEWAY_STATUSES.has(response.status)) {
        response = await this.scan(request, await this.token());
        continue;
      }
      throw httpFailure(`console scan failed: HTTP ${response.status}`, response.status, body);
    }
    try {
      return (await response.json()) as Record<string, any>;
    } catch (error) {
      throw new GgateTransportError(`invalid console response: ${error}`);
    }
  }

  private async scan(request: Record<string, any>, token: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/api/v1/scan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ event: request.event, redaction: request.redaction }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        dispatcher: await this.tlsDispatcher(),
      } as RequestInit);
    } catch (error) {
      throw connectionFailure(this.baseUrl, error);
    }
  }

  /** Current access token, refreshing the token pair when missing or near expiry. */
  private async token(): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.exchange) {
        await this.exchange;
        continue;
      }
      const key = this.config.resolveApiKey();
      if (key !== this.credential) {
        this.credential = key;
        this.accessToken = undefined;
        this.refreshToken = undefined;
      }
      if (!key) throw new GgateTransportError("Console API key source is empty or unavailable");
      if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_SLACK_MS) return this.accessToken;
      this.exchange = this.obtainToken().finally(() => { this.exchange = undefined; });
      const token = await this.exchange;
      if (key === this.config.resolveApiKey()) return token;
    }
    throw new GgateTransportError("Console API key changed repeatedly during authentication");
  }

  private async obtainToken(): Promise<string> {
    if (this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) return refreshed;
    }
    return this.exchangeApiKey();
  }

  /** Refresh rejection means the pair was revoked/expired; fall back to the configured API key. */
  private async refreshAccessToken(): Promise<string | undefined> {
    const response = await this.fetchToken("/api/v1/detection-engine/token/refresh", {
      "content-type": "application/json",
    }, JSON.stringify({ refresh_token: this.refreshToken }));
    if (response.status === 401 || response.status === 403) {
      this.refreshToken = undefined;
      return undefined;
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw httpFailure(`console token refresh failed: HTTP ${response.status}${body ? ` ${body}` : ""}`, response.status, body);
    }
    return this.acceptTokenPair(response, "refresh");
  }

  private async exchangeApiKey(): Promise<string> {
    const response = await this.fetchToken(
      "/api/v1/detection-engine/token",
      { "x-api-key": this.credential ?? "" },
    );
    if (response.status === 401 || response.status === 403) {
      throw new GgateTransportError(authFailure("token exchange", response.status));
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      const detail = body ? ` ${body}` : "";
      throw httpFailure(`console token exchange failed: HTTP ${response.status}${detail}`, response.status, body);
    }
    return this.acceptTokenPair(response, "exchange");
  }

  private async fetchToken(path: string, headers: Record<string, string>, body?: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        dispatcher: await this.tlsDispatcher(),
      } as RequestInit);
    } catch (error) {
      throw connectionFailure(this.baseUrl, error);
    }
  }

  private async acceptTokenPair(response: Response, operation: string): Promise<string> {
    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new GgateTransportError(`console token ${operation} returned no access_token`);
    }
    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}

// Only a 401 means the Console rejected the key. A 403 usually comes from a proxy or WAF in front of
// the Console (e.g. Cloudflare bot rules) and never reached it.
function authFailure(step: string, status: number): string {
  if (status === 401) return `console rejected the API key (${step} HTTP 401)`;
  return `console request forbidden (${step} HTTP 403): usually a proxy or WAF in front of the Console blocking this client, not a bad API key`;
}
