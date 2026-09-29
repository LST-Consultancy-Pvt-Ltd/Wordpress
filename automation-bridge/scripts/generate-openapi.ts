/** Writes openapi.json (the same document the bridge serves at {base}/openapi.json). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "../src/core/openapi.js";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");
fs.writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`wrote ${path.basename(out)}`);
