import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Config } from "./config.js";
import { redactText } from "./redactor.js";
import { Attachment } from "./types.js";

const TEXT_EXTENSIONS = new Set([
  ".csv", ".html", ".json", ".log", ".md", ".rst", ".text", ".toml", ".tsv", ".txt", ".xml", ".yaml", ".yml",
]);

/** Build a scan attachment while hashing the full file and bounding captured content. */
export function attachmentFromPath(
  filename: string,
  config: Config,
  source: Attachment["source"] = "upload",
): Attachment {
  const stat = fs.statSync(filename);
  const handle = fs.openSync(filename, "r");
  const hash = crypto.createHash("sha256");
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!read) break;
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      if (capturedBytes <= config.maxFileBytes) {
        const needed = config.maxFileBytes + 1 - capturedBytes;
        if (needed > 0) {
          const part = Buffer.from(chunk.subarray(0, needed));
          captured.push(part);
          capturedBytes += part.length;
        }
      }
    }
  } finally {
    fs.closeSync(handle);
  }

  const mimeType = mimeTypeFor(filename);
  const raw = Buffer.concat(captured);
  const truncated = raw.length > config.maxFileBytes;
  const bounded = raw.subarray(0, config.maxFileBytes);
  const attachment: Attachment = {
    filename: path.basename(filename),
    mime_type: mimeType,
    size: stat.size,
    sha256: hash.digest("hex"),
    source,
    capture: "metadata_only",
    truncated,
  };
  if (!config.captureFileText) return attachment;

  if (mimeType.startsWith("text/")) {
    const rawText = bounded.toString("utf8");
    const redacted = config.redact ? redactText(rawText) : { text: rawText, count: 0 };
    attachment.capture = "text";
    attachment.text = redacted.text;
    attachment.redaction_count = redacted.count;
  } else {
    attachment.capture = "content";
    attachment.content_base64 = bounded.toString("base64");
  }
  return attachment;
}

function mimeTypeFor(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return extension === ".html" ? "text/html" : "text/plain";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  return "application/octet-stream";
}
