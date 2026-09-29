#!/usr/bin/env node
/**
 * Sidecar entry point.
 *   BRIDGE_CONFIG=/etc/automation-bridge/automation-bridge.config.json node dist/sidecar/main.js
 * Secrets come from env (or *_FILE): BRIDGE_BOOTSTRAP_KEY_ID, BRIDGE_BOOTSTRAP_SECRET,
 * BRIDGE_REVALIDATE_SECRET, BRIDGE_BACKUP_KEY.
 */
import { ConfigError, loadConfigFile } from "../core/config.js";
import { startSidecar } from "./server.js";

async function main(): Promise<void> {
  const file = process.env.BRIDGE_CONFIG || "automation-bridge.config.json";
  let cfg;
  try {
    cfg = loadConfigFile(file);
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : "failed to load config";
    process.stderr.write(JSON.stringify({ level: "error", msg }) + "\n");
    process.exit(2);
  }
  const s = await startSidecar(cfg);
  const stop = (sig: string) => {
    s.bridge.ctx.logger.info("shutting down", { signal: sig });
    s.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

main().catch(() => {
  process.stderr.write(JSON.stringify({ level: "error", msg: "sidecar failed to start" }) + "\n");
  process.exit(1);
});
