import { Decision, Verdict } from "./types.js";

export function passDecision(): Decision {
  return {
    verdict: "pass",
    reason_codes: [],
    message: "allowed",
    matched_detectors: [],
    policy_source: null,
    document_intelligence: null,
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
    policy_source: null,
    document_intelligence: null,
    fail_open: true,
    blocked: false,
    allowed: true,
  };
}

/**
 * Parse a scan response body. The Console returns a flattened decision plus optional document
 * intelligence; an explicit
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
  // Consoles before the unified block semantics serialized `hard_block`. Treat it as the current
  // `block` verdict so upgrading the SDK never weakens enforcement against an older Console.
  const rawVerdict = response.verdict || "pass";
  const verdict = (rawVerdict === "hard_block" ? "block" : rawVerdict) as Verdict;
  if (!["system", "pass", "warn", "block"].includes(verdict)) {
    return failOpenDecision(`unexpected scan verdict ${JSON.stringify(rawVerdict)}`);
  }
  return {
    verdict,
    reason_codes: response.reason_codes || [],
    message: response.message || "allowed",
    matched_detectors: response.matched_detectors || [],
    policy_source: response.policy_source ?? null,
    detection: response.detection ?? undefined,
    document_intelligence: response.document_intelligence ?? null,
    ...(response.pipeline_status != null ? { pipeline_status: response.pipeline_status } : {}),
    fail_open: Boolean(response.fail_open),
    blocked: verdict === "block",
    allowed: ["pass", "warn", "system"].includes(verdict),
  };
}
