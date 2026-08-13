import { Decision } from "./types.js";

export function passDecision(): Decision {
  return {
    verdict: "pass",
    reason_codes: [],
    message: "allowed",
    matched_detectors: [],
    policy_source: { kind: "none" },
    fail_open: false,
    blocked: false,
    allowed: true,
  };
}

export function failOpenDecision(message: string): Decision {
  return {
    verdict: "pass",
    reason_codes: ["engine_unreachable"],
    message,
    matched_detectors: [],
    policy_source: { kind: "none" },
    fail_open: true,
    blocked: false,
    allowed: true,
  };
}

/**
 * Parse a scan response body. The Console answers with the decision itself; an explicit
 * `{"kind": "error", ...}` — or any shape this SDK does not recognize — fails open rather
 * than being reported as a verdict nobody reached.
 */
export function decisionFromResponse(response: Record<string, any>): Decision {
  if (response.kind === "error") {
    return failOpenDecision(String(response.message || "console returned an error"));
  }
  if (response.kind != null && response.kind !== "verdict") {
    return failOpenDecision(`unexpected scan response kind ${JSON.stringify(response.kind)}`);
  }
  const verdict = response.verdict || "pass";
  return {
    verdict,
    reason_codes: response.reason_codes || [],
    message: response.message || "allowed",
    matched_detectors: response.matched_detectors || [],
    policy_source: response.policy_source || { kind: "none" },
    detection: response.detection ?? undefined,
    fail_open: Boolean(response.fail_open),
    blocked: verdict === "block" || verdict === "hard_block",
    allowed: ["pass", "warn", "system"].includes(verdict),
  };
}
