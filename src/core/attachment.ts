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

const BINARY_MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function mimeTypeFor(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return extension === ".html" ? "text/html" : "text/plain";
  return BINARY_MIME_TYPES[extension] ?? "application/octet-stream";
}

/** Build a scan attachment from in-memory content (an upload, a data URL, a framework media object). */
export function attachmentFromBytes(
  raw: Buffer,
  config: Config,
  { mimeType, filename, source = "upload" }: { mimeType?: string; filename?: string; source?: Attachment["source"] } = {},
): Attachment {
  const mime = mimeType || (filename ? mimeTypeFor(filename) : "application/octet-stream");
  // Always name the file with an extension: Console file-type policies match on the name's extension.
  const base = filename ? path.basename(filename) : "inline";
  const attachment: Attachment = {
    filename: path.extname(base) ? base : `${base}.${extensionFor(mime)}`,
    mime_type: mime,
    size: raw.length,
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    source,
    capture: "metadata_only",
    truncated: raw.length > config.maxFileBytes,
  };
  if (!config.captureFileText) return attachment;
  const bounded = raw.subarray(0, config.maxFileBytes);
  if (mime.startsWith("text/")) {
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

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "image/png": "png",
  "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "audio/mpeg": "mp3",
  "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/flac": "flac", "video/mp4": "mp4", "video/webm": "webm", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

function extensionFor(mime: string): string {
  return MIME_EXTENSIONS[mime.split(";")[0]!.trim().toLowerCase()] ?? "bin";
}
