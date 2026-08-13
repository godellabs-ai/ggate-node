import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // MCP child-process spawning is server-side only; keep it out of the bundle.
  serverExternalPackages: ["@langchain/mcp-adapters"],
  // @ggate/sdk is a file: dependency on the SDK at the repo root (two directories
  // up); widen Turbopack's root so it may resolve through that symlink.
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

export default nextConfig;
