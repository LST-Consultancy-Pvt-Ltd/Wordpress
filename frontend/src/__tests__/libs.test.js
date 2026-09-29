import { parseUnifiedDiff, simpleFileDiff, toSideBySideRows } from "../lib/diff";
import { validateBaseUrl, validateBridgeUrl, isPrivateHost } from "../lib/urlPolicy";
import { formToFields, fieldsToForm, validateMetadataForm, EMPTY_FORM } from "../lib/metadata";
import { apiErrorDetails, apiErrorMessage, listItems } from "../lib/api";
import { extractChangeSet, describeOperation, canApply, canSubmit } from "../lib/changesets";
import { DIFF } from "../test-fixtures";

describe("diff", () => {
  test("parses files, hunks and line numbers", () => {
    const [f] = parseUnifiedDiff(DIFF);
    expect(f.path).toBe("overrides/metadata.json");
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    expect(f.hunks[0].lines.map((l) => l.type)).toEqual(["context", "del", "add", "context"]);
    expect(f.hunks[0].lines[2].newNo).toBe(2);
  });
  test("pairs deletions with additions for side-by-side rows", () => {
    const rows = toSideBySideRows(parseUnifiedDiff(DIFF)[0].hunks[0]);
    expect(rows).toHaveLength(3);
    expect(rows[1].left.text).toContain("Old title");
    expect(rows[1].right.text).toContain("New title");
  });
  test("handles git headers, new files and multiple files", () => {
    const text = `diff --git a/code/a.ts b/code/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/code/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git a/code/b.ts b/code/b.ts\n--- a/code/b.ts\n+++ b/code/b.ts\n@@ -1 +1 @@\n-x\n+y\n`;
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(["code/a.ts", "code/b.ts"]);
    expect(files[0].additions).toBe(2);
    expect(toSideBySideRows(files[0].hunks[0])[0].left).toBeNull();
  });
  test("simpleFileDiff round-trips through the parser", () => {
    const d = simpleFileDiff("code/x.ts", "a\nb\nc", "a\nB\nc");
    const [f] = parseUnifiedDiff(d);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    expect(simpleFileDiff("x", "same", "same")).toBe("");
  });
  test("empty input yields no files", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff(null)).toEqual([]);
  });
});

describe("url policy", () => {
  test("base URL must be https without credentials/fragments", () => {
    expect(validateBaseUrl("https://example.com")).toBeNull();
    expect(validateBaseUrl("http://example.com")).toMatch(/https/);
    expect(validateBaseUrl("https://u:p@example.com")).toMatch(/Credentials/);
    expect(validateBaseUrl("https://example.com/#x")).toMatch(/Fragments/);
    expect(validateBaseUrl("https://example.com:8443")).toMatch(/ports/);
  });
  test("bridge URL: http only on private hosts with the toggle", () => {
    const p = "/api/automation-bridge/v1";
    expect(validateBridgeUrl(`https://example.com${p}`, false)).toBeNull();
    expect(validateBridgeUrl(`http://automation-bridge:8787${p}`, false)).toMatch(/private network/);
    expect(validateBridgeUrl(`http://automation-bridge:8787${p}`, true)).toBeNull();
    expect(validateBridgeUrl(`http://10.0.0.5${p}`, true)).toBeNull();
    expect(validateBridgeUrl(`http://example.com${p}`, true)).toMatch(/Docker service/);
    expect(validateBridgeUrl("https://example.com/other", false)).toMatch(/should end with/);
  });
  test("private host detection", () => {
    ["localhost", "127.0.0.1", "192.168.1.2", "172.20.0.3", "bridge"].forEach((h) => expect(isPrivateHost(h)).toBe(true));
    ["example.com", "8.8.8.8", "172.32.0.1"].forEach((h) => expect(isPrivateHost(h)).toBe(false));
  });
});

describe("metadata form", () => {
  test("validates lengths, canonical and JSON-LD @type", () => {
    const e = validateMetadataForm({ ...EMPTY_FORM, title: "x".repeat(301), canonical: "ftp://x", jsonLd: '{"name":"no type"}' });
    expect(e.title).toMatch(/300/);
    expect(e.canonical).toMatch(/https/);
    expect(e.jsonLd).toMatch(/@type/);
    expect(validateMetadataForm({ ...EMPTY_FORM, jsonLd: "{bad" }).jsonLd).toMatch(/Invalid JSON/);
  });
  test("round-trips MetadataFields", () => {
    const fields = { title: "T", description: "D", canonical: "/a", robots: { index: false, follow: true }, openGraph: { title: "O", image: "/i.png" }, jsonLd: [{ "@type": "Article" }] };
    expect(formToFields(fieldsToForm(fields))).toEqual(fields);
    expect(formToFields(EMPTY_FORM)).toEqual({});
  });
});

describe("api helpers", () => {
  const err = (status, detail) => ({ response: { status, data: { detail } } });
  test("error messages from FastAPI and bridge envelopes", () => {
    expect(apiErrorMessage(err(400, "bad"))).toBe("bad");
    expect(apiErrorMessage(err(502, { code: "UPSTREAM_FAILED", message: "down" }))).toBe("down (UPSTREAM_FAILED)");
    expect(apiErrorDetails(err(422, { code: "CAPABILITY_UNSUPPORTED", capability: "validate", correlation_id: "c1" }))).toMatchObject({
      status: 422, code: "CAPABILITY_UNSUPPORTED", capability: "validate", correlationId: "c1",
    });
  });
  test("listItems unwraps both shapes", () => {
    expect(listItems([1])).toEqual([1]);
    expect(listItems({ items: [2], next_cursor: null })).toEqual([2]);
    expect(listItems(null)).toEqual([]);
  });
});

describe("change-set helpers", () => {
  test("extractChangeSet handles {changeset} and bare shapes", () => {
    expect(extractChangeSet({ changeset: { id: "cs" } })).toEqual({ id: "cs" });
    expect(extractChangeSet({ id: "cs", status: "planned" }).id).toBe("cs");
    expect(extractChangeSet({ foo: 1 })).toBeNull();
  });
  test("state predicates", () => {
    expect(canApply({ status: "approved" })).toBe(true);
    expect(canApply({ status: "pending_approval" })).toBe(false);
    expect(canSubmit({ status: "planned", plan: { valid: true } })).toBe(true);
    expect(canSubmit({ status: "planned", plan: { valid: false } })).toBe(false);
  });
  test("describes every operation type", () => {
    expect(describeOperation({ op: "redirect.upsert", source: "/a", destination: "/b", permanent: true })).toMatch(/308/);
    expect(describeOperation({ op: "file.write", root: "code", path: "a.ts", base_sha256: null })).toMatch(/Create code\/a.ts/);
    expect(describeOperation({ op: "content.upsert", collection: "posts", slug: "x", status: "draft" })).toMatch(/draft/);
  });
});
