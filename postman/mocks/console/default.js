// Local contract mock: Gate handlers::ScanTextResponse and detection_engine_token.rs.
const http = require("node:http");
const response = {
  "verdict": "pass",
  "message": "allowed",
  "document_intelligence": {
    "taxonomy": {
      "topic": {
        "label": "FINANCE",
        "confidence": 0.8,
        "resolution": {
          "method": "broad_fallback",
          "uncertain": true,
          "reason": "ambiguous candidates",
          "evidence_ids": [],
          "raw_label": "INVOICE",
          "raw_confidence": 0.51,
          "raw_runner_up": "RECEIPT",
          "raw_runner_up_confidence": 0.49
        }
      },
      "overall_confidence": 0.8,
      "content_types": [],
      "business_domains": []
    },
    "sensitivity": {
      "severity": "medium",
      "sensitive_data_classes": [],
      "business_confidentiality_classes": [],
      "privacy_classes": [],
      "rights_and_restrictions": [],
      "required_handling": []
    },
    "file_classification": {
      "status": "unavailable",
      "labels": [],
      "gate_sensitivity_available": true
    }
  },
  "pipeline_status": {
    "errors": [
      {
        "code": "attachment_scan_incomplete",
        "message": "1 referenced file could not be fully scanned"
      }
    ],
    "warnings": [
      {
        "code": "partial_media",
        "message": "Partial media coverage"
      }
    ],
    "visual_codes": [],
    "media": []
  }
};
http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  const send = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
  if (req.method === "POST" && req.url === "/api/v1/detection-engine/token") {
    return send(200, { access_token: "local-access", refresh_token: "local-refresh", expires_in: 3600, token_type: "Bearer" });
  }
  if (req.method === "POST" && req.url === "/api/v1/scan") {
    if (!req.body?.event?.collector?.collector_id) return send(400, { error: "collector identity required" });
    return send(200, response);
  }
  send(501, { error: "Endpoint outside this scan contract fixture" });
}).listen(process.env.PORT);
