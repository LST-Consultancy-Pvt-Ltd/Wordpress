import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: here,
  // Server-only packages that read the filesystem; keep them out of the bundle.
  serverExternalPackages: ["@lst/automation-bridge", "sanitize-html"],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
