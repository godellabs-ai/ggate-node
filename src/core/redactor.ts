import crypto from "node:crypto";

const patterns = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export interface RedactionSummary {
  content_sha256?: string;
  redaction_count: number;
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function redactText(text: string): { text: string; count: number } {
  let output = text;
  let count = 0;
  for (const pattern of patterns) {
    output = output.replace(pattern, () => {
      count += 1;
      return "[REDACTED]";
    });
  }
  return { text: output, count };
}
