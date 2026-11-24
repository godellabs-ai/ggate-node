import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { decisionFromResponse, passDecision } from "../core/decision.js";

// Captured contract shape from Gate ScanTextResponse and shared/ggate-core models.
const response = JSON.parse(fs.readFileSync(new URL("../../src/tests/fixtures/scan-response.json", import.meta.url), "utf8"));

test("preserve scan coverage independently of pass and block verdicts", () => {
  for (const verdict of ["pass", "block"]) {
    const decision = decisionFromResponse({ ...response, verdict });
    assert.equal(decision.blocked, verdict === "block");
    assert.equal(decision.fail_open, false);
    assert.equal(decision.console_outage_action, "allow");
    assert.equal(decision.console_outage_fallback, "block");
    assert.deepEqual(decision.document_intelligence?.coverage?.selected_chunk_indices, [0]);
    assert.equal(decision.document_intelligence?.taxonomy.topic.aggregation?.classified_windows, 1);
    assert.deepEqual(decision.pipeline_status, response.pipeline_status);
    assert.deepEqual(decision.document_intelligence, response.document_intelligence);
  }
});

test("only an explicit verdict is a completed scan and blocked decisions retain their link", () => {
  assert.equal(decisionFromResponse({ kind: "verdict" }).fail_open, true);
  const url = "https://console.example/detections?event=test";
  assert.equal(decisionFromResponse({ verdict: "block", detection_url: url }).detection_url, url);
});

test("old Console responses and queued passes need no added metadata", () => {
  assert.equal(decisionFromResponse({ verdict: "pass" }).pipeline_status, undefined);
  assert.equal(passDecision().pipeline_status, undefined);
  assert.equal(passDecision().document_intelligence, null);
});
