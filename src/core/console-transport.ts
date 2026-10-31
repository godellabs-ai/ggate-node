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
    if (GATEWAY_STATUSES.has(response.status)) {
      // Transient upstream failure (a reverse proxy dropping a keep-alive
      // connection, or the API restarting): re-scanning the same content is
      // safe, so try once more before failing open.
      response = await this.scan(request, await this.token());
    }

    if (response.status === 401 || response.status === 403) {
      throw new GgateTransportError(authFailure("scan", response.status));
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new GgateTransportError(`console scan failed: HTTP ${response.status} ${body}`);
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
      const message = error instanceof Error ? error.message : String(error);
      throw new GgateTransportError(`console unreachable (${this.baseUrl}): ${message}`);
    }
  }

  /** Current access token, refreshing the token pair when missing or near expiry. */
  private token(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_SLACK_MS) {
      return Promise.resolve(this.accessToken);
    }
    // Deduplicate concurrent exchanges onto one in-flight request.
    this.exchange ??= this.obtainToken().finally(() => {
      this.exchange = undefined;
    });
    return this.exchange;
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
      throw new GgateTransportError(`console token refresh failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
    }
    return this.acceptTokenPair(response, "refresh");
  }

  private async exchangeApiKey(): Promise<string> {
    const response = await this.fetchToken(
      "/api/v1/detection-engine/token",
      { "x-api-key": this.config.apiKey ?? "" },
    );
    if (response.status === 401 || response.status === 403) {
      throw new GgateTransportError(authFailure("token exchange", response.status));
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      const detail = body ? ` ${body}` : "";
      throw new GgateTransportError(`console token exchange failed: HTTP ${response.status}${detail}`);
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
      const message = error instanceof Error ? error.message : String(error);
      throw new GgateTransportError(`console unreachable (${this.baseUrl}): ${message}`);
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
