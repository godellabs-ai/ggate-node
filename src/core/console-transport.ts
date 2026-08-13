/**
 * The SDK's transport: scan via the Console's HTTP API.
 *
 * Scans go to the Console's `POST /api/v1/scan` endpoint, which runs the full
 * pipeline — normalize, OCR/extraction of attachments, deterministic rules, the
 * security classifier, DLP, threat intel, document intelligence, and policy —
 * records the event, and returns the decision.
 *
 * Auth is the same scale path the agents use: the IAM API key is exchanged
 * ONCE at `/api/v1/agent/token` for a short-lived JWT, and scans carry
 * `Authorization: Bearer` — verified signature-only on the Console, so the
 * per-scan cost is a stateless check instead of an Argon2 hash (~1s). The
 * token is re-exchanged shortly before expiry, or after a 401.
 *
 * Collector registration is implicit — the Console reconciles its fleet
 * registry from the events themselves — so `collector_ready` is a no-op.
 */

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
  private tokenExpiresAt = 0;
  private exchange?: Promise<string>;
  private dispatcher?: Promise<unknown | undefined>;

  constructor(private readonly config: Config) {
    this.baseUrl = (config.consoleUrl ?? "").replace(/\/+$/, "");
  }

  /**
   * An undici `Agent` that skips TLS verification, used only when
   * `consoleInsecureTls` is set (dev with a self-signed Console cert). Built
   * lazily and cached; undici is Node's built-in `fetch` backend, so the
   * ignore comments keep bundlers from trying to resolve it at build time.
   */
  private tlsDispatcher(): Promise<unknown | undefined> {
    if (!this.config.consoleInsecureTls) return Promise.resolve(undefined);
    this.dispatcher ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "undici")
      .then(({ Agent }) => new Agent({ connect: { rejectUnauthorized: false } }))
      .catch(() => undefined);
    return this.dispatcher;
  }

  async request(request: Record<string, any>): Promise<Record<string, any>> {
    if (request.op === "collector_ready") return { kind: "ok" };
    if (request.op !== "scan_text") {
      throw new GgateTransportError(`op ${JSON.stringify(request.op)} is not supported by the console transport`);
    }

    let response = await this.scan(request, await this.token());
    if (response.status === 401) {
      // Token expired server-side (or was revoked): exchange fresh and retry once.
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
      throw new GgateTransportError(`console rejected the API key (HTTP ${response.status})`);
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

  /** Current access token, exchanging the API key when missing or near expiry. */
  private token(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_SLACK_MS) {
      return Promise.resolve(this.accessToken);
    }
    // Deduplicate concurrent exchanges onto one in-flight request.
    this.exchange ??= this.exchangeApiKey().finally(() => {
      this.exchange = undefined;
    });
    return this.exchange;
  }

  private async exchangeApiKey(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/agent/token`, {
        method: "POST",
        headers: { "x-api-key": this.config.apiKey ?? "" },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        dispatcher: await this.tlsDispatcher(),
      } as RequestInit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GgateTransportError(`console unreachable (${this.baseUrl}): ${message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GgateTransportError(`console rejected the API key (token exchange HTTP ${response.status})`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      const detail = body ? ` ${body}` : "";
      throw new GgateTransportError(`console token exchange failed: HTTP ${response.status}${detail}`);
    }
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new GgateTransportError("console token exchange returned no access_token");
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
