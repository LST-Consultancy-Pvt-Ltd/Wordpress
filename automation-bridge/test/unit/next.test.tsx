import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationJsonLd, EditableImage, EditableRichText, EditableText } from "../../src/next/components.js";
import { createRevalidateHandler } from "../../src/next/route-handlers.js";
import { configureAutomation, getRedirects, matchRedirect, serializeJsonLd, withAutomationMetadata } from "../../src/next/runtime.js";
import { signRevalidate } from "../../src/shared/revalidate-signing.js";
import { tmpDir } from "../helpers.js";

function writeStores(dir: string) {
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ version: 1, routes: { "/about": { fields: { title: "Override", openGraph: { image: "/og.png" }, robots: { index: false, follow: true }, jsonLd: [{ "@type": "Org", name: "</script><script>alert(1)</script>" }] }, change_id: "c" } } }),
  );
  fs.writeFileSync(path.join(dir, "blocks.json"), JSON.stringify({ version: 1, blocks: { t: { value: "<b>not html</b>", format: "text" }, r: { value: '<p onclick="x()">Hi<script>alert(1)</script></p>', format: "rich-text" } } }));
  fs.writeFileSync(path.join(dir, "images.json"), JSON.stringify({ version: 1, images: { img: { alt: "New alt" } } }));
  fs.writeFileSync(path.join(dir, "redirects.json"), JSON.stringify({ version: 1, redirects: [{ source: "/old", destination: "/new", permanent: true }] }));
}

async function render(el: Promise<React.ReactElement | null>) {
  const e = await el;
  return e ? renderToStaticMarkup(e) : "";
}

describe("site runtime helpers", () => {
  afterEach(() => configureAutomation({ overridesDir: tmpDir() }));

  it("merges metadata overrides over defaults, and returns defaults when absent or corrupt", async () => {
    const d = tmpDir();
    configureAutomation({ overridesDir: d });
    expect(await withAutomationMetadata("/about", { title: "Default" })).toEqual({ title: "Default" });
    writeStores(d);
    const m = await withAutomationMetadata("/about/", { title: "Default", description: "D" });
    expect(m).toMatchObject({ title: "Override", description: "D", robots: { index: false, follow: true }, openGraph: { title: "Override", description: "D", images: ["/og.png"] } });
    fs.writeFileSync(path.join(d, "metadata.json"), "{corrupt");
    expect(await withAutomationMetadata("/about", { title: "Default" })).toEqual({ title: "Default" });
  });

  it("renders blocks safely", async () => {
    const d = tmpDir();
    configureAutomation({ overridesDir: d });
    writeStores(d);
    expect(await render(EditableText({ id: "t", children: "fallback" }))).toBe("&lt;b&gt;not html&lt;/b&gt;");
    expect(await render(EditableText({ id: "missing", children: "fallback" }))).toBe("fallback");
    const rich = await render(EditableRichText({ id: "r" }));
    expect(rich).toBe("<div><p>Hi</p></div>");
    const img = await render(EditableImage({ id: "img", src: "/a.png", alt: "Old", width: 10 }));
    expect(img).toContain('<img src="/a.png" alt="New alt" width="10"/>');
    const ld = await render(AutomationJsonLd({ route: "/about", extra: { "@type": "Article", headline: "H" } }));
    expect(ld).not.toContain("</script><script>");
    expect(ld).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(serializeJsonLd([{ "@type": "X", a: "<b>" }]))).toEqual({ "@type": "X", a: "<b>" });
  });

  it("exposes redirects", async () => {
    const d = tmpDir();
    configureAutomation({ overridesDir: d });
    writeStores(d);
    expect(getRedirects()).toEqual([{ source: "/old", destination: "/new", permanent: true }]);
    expect(matchRedirect("/old/")).toEqual({ destination: "/new", permanent: true });
    expect(matchRedirect("/other")).toBeNull();
  });
});

describe("revalidate route handler (sidecar mode)", () => {
  const secret = "revalidate-secret-value";
  const call = (paths: unknown, sig?: string, ts = Math.floor(Date.now() / 1000)) => {
    const seen: string[] = [];
    const h = createRevalidateHandler({ secret, revalidatePath: (p) => void seen.push(p) });
    const body = JSON.stringify({ paths });
    const signature = sig ?? signRevalidate(secret, ts, Array.isArray(paths) ? paths : []);
    return h.POST(new Request("http://site/api/automation-revalidate", { method: "POST", body, headers: { "x-revalidate-timestamp": String(ts), "x-revalidate-signature": signature } })).then(async (r) => ({ status: r.status, seen }));
  };
  it("revalidates only the signed paths", async () => {
    expect(await call(["/", "/blog/a"])).toEqual({ status: 200, seen: ["/", "/blog/a"] });
    expect((await call(["/"], "0".repeat(64))).status).toBe(401);
    expect((await call(["/"], undefined, Math.floor(Date.now() / 1000) - 1000)).status).toBe(401);
    expect((await call(["/../x"])).status).toBe(400);
    expect((await call("not-array")).status).toBe(400);
  });
});
