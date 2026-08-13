/**
 * Start Next.js with this example's local GGATE configuration.
 *
 * Next.js intentionally gives inherited process variables precedence over
 * `.env*` files. That is right for production, but surprising in this local
 * example: a stale shell-level GGATE_API_KEY silently wins over the key the
 * developer just placed in `.env.local` and every scan fails open with 401.
 *
 * Remove only locally-declared GGATE_* variables from the child environment.
 * The fresh Next.js process then loads their values from its normal `.env*`
 * precedence chain. Other inherited variables, and `npm start`, are unchanged.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const mode = process.env.NODE_ENV || "development";
const envFiles = [
  `.env.${mode}.local`,
  ".env.local",
  `.env.${mode}`,
  ".env",
];
const localGgateKeys = new Set();

for (const filename of envFiles) {
  const file = path.join(root, filename);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(GGATE_[A-Z0-9_]+)\s*=/);
    if (match) localGgateKeys.add(match[1]);
  }
}

const env = { ...process.env };
const overridden = [];
for (const key of localGgateKeys) {
  if (Object.hasOwn(env, key)) overridden.push(key);
  delete env[key];
}

if (overridden.length > 0) {
  console.log(
    `[jira-project-assistant] using local .env values instead of inherited: ${overridden.sort().join(", ")}`,
  );
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", "-p", "3010"], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`[jira-project-assistant] could not start Next.js: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
