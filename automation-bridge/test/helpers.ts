import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridge, type Bridge } from "../src/core/bridge.js";
import { resolveConfig, type ResolvedConfig } from "../src/core/config.js";
import type { BridgeOptions } from "../src/core/context.js";
import { signedHeaders } from "../src/core/auth/signing.js";
import { BASE_PATH } from "../src/core/http.js";
import { sha256Hex } from "../src/core/util.js";

export const KEY_ID = "k_test";
export const SECRET = Buffer.alloc(32, 7).toString("base64url");

export function tmpDir(prefix = "bridge-test-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A small Next.js App Router repository + content + overrides roots. */
export function makeFixture(): { dir: string; repo: string; content: string; overrides: string; state: string; assets: string } {
  const dir = tmpDir();
  const repo = path.join(dir, "repo");
  write(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", dependencies: { next: "^15.5.0" } }));
  write(path.join(repo, "app/layout.tsx"), "export default function L({children}){return <html><body>{children}</body></html>}\n");
  write(
    path.join(repo, "app/page.tsx"),
    'import { withAutomationMetadata } from "@lst/automation-bridge/next";\nexport async function generateMetadata(){ return withAutomationMetadata("/", { title: "Home" }); }\nexport default function P(){return <h1>Home</h1>}\n',
  );
  write(path.join(repo, "app/about/page.tsx"), 'export async function generateMetadata(){ return withAutomationMetadata("/about", {title:"About"}); }\nexport default function A(){return null}\n');
  write(path.join(repo, "app/(marketing)/pricing/page.tsx"), 'export const metadata = { title: "Pricing" };\nexport default function P(){return null}\n');
  write(path.join(repo, "app/blog/page.tsx"), "export default function B(){return null}\n");
  write(path.join(repo, "app/blog/[slug]/page.tsx"), "export async function generateMetadata({params}){ return withAutomationMetadata(`/blog/${params.slug}`, {}); }\nexport default function S(){return null}\n");
  write(path.join(repo, "app/docs/[...parts]/page.tsx"), "export default function D(){return null}\n");
  write(path.join(repo, "app/@modal/page.tsx"), "export default function M(){return null}\n");
  write(path.join(repo, "app/(.)photo/page.tsx"), "export default function I(){return null}\n");
  write(path.join(repo, "app/api/hello/route.ts"), "export function GET(){return new Response('hi')}\n");
  write(path.join(repo, "app/_components/x/page.tsx"), "export default function X(){return null}\n");
  write(path.join(repo, "components/Button.tsx"), "export const Button = () => null;\n");
  write(path.join(repo, ".env"), "SECRET=1\n");
  write(
    path.join(repo, "automation.manifest.json"),
    JSON.stringify({
      version: 1,
      blocks: [
        { id: "home.hero.title", route: "/", kind: "text", default: "Build faster" },
        { id: "about.body", route: "/about", kind: "rich-text", default: "<p>About</p>" },
        { id: "home.hero.image", route: "/", kind: "image", src: "/hero.svg", alt: "Hero" },
      ],
    }),
  );
  const content = path.join(dir, "content");
  write(path.join(content, "posts/hello-world.mdx"), '---\ntitle: Hello world\ndate: "2024-01-01"\n---\n\nHi ![pic](/images/pic.png)\n');
  write(path.join(content, "posts/_drafts/draft-one.mdx"), "---\ntitle: Draft one\n---\n\nWIP\n");
  write(path.join(content, "pages/team.json"), JSON.stringify({ frontmatter: { title: "Team" }, body: "We" }));
  const overrides = path.join(dir, "overrides");
  fs.mkdirSync(overrides, { recursive: true });
  const assets = path.join(repo, "public");
  write(path.join(assets, "images/pic.png"), "PNGDATA");
  const state = path.join(dir, "state");
  return { dir, repo, content, overrides, state, assets };
}

export function fixtureConfigInput(f: ReturnType<typeof makeFixture>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "sidecar",
    site: { site_id: "fixture-site", environment: "staging", public_base_url: "https://example.com", internal_url: null },
    state_dir: f.state,
    roots: [
      { id: "code", kind: "code", path: f.repo, writable: true, allow: ["app/**/*.{ts,tsx,css}", "components/**"], deny: [] },
      { id: "content", kind: "content", path: f.content, writable: true },
      { id: "overrides", kind: "overrides", path: f.overrides, writable: true },
      { id: "assets", kind: "assets", path: f.assets, writable: false, allow: ["**"] },
    ],
    overrides_root: "overrides",
    code_root: "code",
    manifest: { root: "code", path: "automation.manifest.json" },
    content: {
      collections: [
        {
          id: "posts",
          kind: "mdx",
          root: "content",
          dir: "posts",
          route_pattern: "/blog/[slug]",
          index_routes: ["/blog"],
          frontmatter_schema: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string", maxLength: 200 },
              date: { type: "string", format: "date" },
              tags: { type: "array", items: { type: "string" } },
              categories: { type: "array", items: { type: "string" } },
              description: { type: "string" },
              keywords: { type: ["string", "array"] },
              jsonLd: { type: "object" },
              content_format: { type: "string", enum: ["mdx", "markdown", "html"] },
            },
          },
        },
        { id: "pages", kind: "json", root: "content", dir: "pages", route_pattern: "/[slug]" },
      ],
    },
    ...extra,
  };
}

export function fixtureConfig(f: ReturnType<typeof makeFixture>, extra: Record<string, unknown> = {}, env: Record<string, string> = {}): ResolvedConfig {
  return resolveConfig(fixtureConfigInput(f, extra), {
    baseDir: f.dir,
    env: { BRIDGE_BOOTSTRAP_KEY_ID: KEY_ID, BRIDGE_BOOTSTRAP_SECRET: SECRET, ...env },
  });
}

export async function makeBridge(extra: Record<string, unknown> = {}, opts: BridgeOptions = {}, env: Record<string, string> = {}) {
  const f = makeFixture();
  const cfg = fixtureConfig(f, extra, env);
  const bridge = await createBridge(cfg, { logSink: () => {}, ...opts });
  return { f, cfg, bridge, client: new TestClient(bridge) };
}

export interface CallResult {
  status: number;
  headers: Record<string, string>;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class TestClient {
  keyId = KEY_ID;
  secret = SECRET;
  constructor(private readonly bridge: Bridge) {}

  async call(method: string, rel: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<CallResult> {
    const url = BASE_PATH + rel;
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const headers: Record<string, string> = {
      ...signedHeaders({ keyId: this.keyId, secret: this.secret, method, pathWithQuery: url, body: buf }),
      ...(method === "POST" && body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    };
    const res = await this.bridge.handle({ method, url, headers, body: buf });
    let json: unknown = null;
    if (Buffer.isBuffer(res.body)) {
      try {
        json = JSON.parse(res.body.toString("utf8"));
      } catch {
        json = res.body.toString("utf8");
      }
    }
    return { status: res.status, headers: res.headers, json };
  }

  get(rel: string) {
    return this.call("GET", rel);
  }

  post(rel: string, body: unknown, idem: string | null = crypto.randomUUID()) {
    return this.call("POST", rel, body, idem ? { "idempotency-key": idem } : {});
  }

  async planAndApply(operations: unknown[], changeId = "cs_" + crypto.randomBytes(4).toString("hex")) {
    const plan = await this.post("/changesets/plan", { change_id: changeId, operations, base_revision: null }, null);
    if (plan.status !== 200) return { plan, apply: null };
    const apply = await this.post("/changesets/apply", { change_id: changeId, operations, base_revision: null, expected_plan_sha256: sha256Hex(plan.json.diff) });
    return { plan, apply };
  }
}
