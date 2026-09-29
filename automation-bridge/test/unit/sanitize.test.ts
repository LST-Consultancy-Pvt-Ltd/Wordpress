import { describe, expect, it } from "vitest";
import { isSafeHref, sanitizeArticleHtml, sanitizeRichText } from "../../src/core/sanitize.js";
import { Redactor } from "../../src/core/logger.js";

const XSS = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
  '<img src=x onerror="alert(1)">',
  '<svg onload="alert(1)"><circle/></svg>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="  javascript:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="//evil.example">x</a>',
  '<p onclick="alert(1)">x</p>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<iframe src="https://evil.example"></iframe>',
  "<<script>script>alert(1)<</script>/script>",
  '<p><strong><em>unclosed <a href="https://ok.example">link',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  "<style>body{background:red}</style>",
  '<form action="https://evil.example"><input name="x"></form>',
  '<a href="https://ok.example" onmouseover="alert(1)">ok</a>',
  "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">",
  '<object data="javascript:alert(1)"></object>',
  "<!--<script>alert(1)</script>-->",
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
];

describe("rich-text sanitizer", () => {
  it.each(XSS)("neutralises %s", (input) => {
    const out = sanitizeRichText(input);
    expect(out.toLowerCase()).not.toMatch(/<script|onerror|onload|onclick|onmouseover|javascript:|vbscript:|data:text|<iframe|<svg|<style|<form|<input|<object|<meta|<base|style=/);
    expect(out).not.toMatch(/href="\/\//);
    // Idempotent: sanitising the output again changes nothing.
    expect(sanitizeRichText(out)).toBe(out);
  });
  it("keeps the allow-list", () => {
    const html = '<h2>T</h2><p>a <strong>b</strong> <em>c</em> <a href="https://x.example/p?q=1" title="t" rel="nofollow">l</a> <a href="/rel">r</a> <a href="mailto:a@b.example">m</a><br></p><ul><li>1</li></ul><blockquote>q</blockquote><code>c</code>';
    const out = sanitizeRichText(html);
    expect(out).toContain('<a href="https://x.example/p?q=1" title="t" rel="nofollow">l</a>');
    expect(out).toContain('<a href="/rel">r</a>');
    expect(out).toContain("<h2>T</h2>");
    expect(out).toContain("<blockquote>q</blockquote>");
  });
  it("drops tags outside the allow-list but keeps their text", () => {
    expect(sanitizeRichText("<h1>big</h1><div>d</div>")).toBe("bigd");
    expect(sanitizeRichText('<a href="https://x.example" rel="opener evil nofollow">x</a>')).toBe('<a href="https://x.example" rel="nofollow">x</a>');
  });
  it("href rules", () => {
    expect(isSafeHref("https://a")).toBe(true);
    expect(isSafeHref("/a")).toBe(true);
    expect(isSafeHref("#frag")).toBe(true);
    expect(isSafeHref("mailto:x@y")).toBe(true);
    expect(isSafeHref("ftp://x")).toBe(false);
    expect(isSafeHref("//x")).toBe(false);
  });
});

describe("article sanitizer (content_format html)", () => {
  it("keeps images and structure, drops styles and scripts", () => {
    const out = sanitizeArticleHtml('<h1 style="color:red">T</h1><p style="margin:0">x</p><img src="/i.png" alt="a" onerror="x()"><img src="javascript:alert(1)"><table><tr><td>1</td></tr></table><script>x</script>');
    expect(out).toContain("<h1>T</h1>");
    expect(out).toContain('<img src="/i.png" alt="a" />');
    expect(out).not.toMatch(/style=|onerror|javascript:|<script/);
    expect(out).toContain("<td>1</td>");
  });
});

describe("log redaction", () => {
  it("masks secrets, secret-like keys and absolute paths", () => {
    const r = new Redactor();
    r.addSecret("SUPERSECRETVALUE123");
    r.addPath("/srv/site/content", "<root:content>");
    const out = JSON.stringify(
      r.redact({ msg: "failed at /srv/site/content/posts/a.mdx with SUPERSECRETVALUE123", headers: { authorization: "Bearer abcdefghijkl" }, secret: "x", nested: { api_key: "y" }, text: "token=abcd1234efgh" }),
    );
    expect(out).not.toContain("SUPERSECRETVALUE123");
    expect(out).not.toContain("/srv/site");
    expect(out).toContain("<root:content>/posts/a.mdx");
    expect(out).not.toContain("abcdefghijkl");
    expect(out).not.toContain("abcd1234efgh");
  });
});
