/**
 * Rich-text sanitiser (protocol §8): allow-list
 *   p, br, strong, em, b, i, u, a[href|title|rel], ul, ol, li, h2, h3, h4, blockquote, code
 * `href` must be http(s), mailto, or relative. Used on write (bridge) and
 * again on render (site runtime helpers). Built on sanitize-html
 * (htmlparser2), which tolerates malformed nesting and entity tricks.
 */
import sanitizeHtml from "sanitize-html";

export const RICH_TEXT_TAGS = ["p", "br", "strong", "em", "b", "i", "u", "a", "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "code"];
const REL_TOKENS = new Set(["nofollow", "noopener", "noreferrer", "ugc", "sponsored", "external"]);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\s]+/g;

/** True for http(s), mailto, or a relative reference (path, ?query, #fragment). */
export function isSafeHref(raw: string): boolean {
  const v = raw.replace(CONTROL, "");
  if (v === "") return false;
  if (v.startsWith("//")) return false; // protocol-relative → another origin
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v);
  if (!m) return !v.includes("\\");
  const scheme = m[1]!.toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: RICH_TEXT_TAGS,
  allowedAttributes: { a: ["href", "title", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  allowedClasses: {},
  allowedStyles: {},
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "template", "svg", "math", "title", "xmp", "noembed", "noframes", "plaintext"],
  enforceHtmlBoundary: false,
  parseStyleAttributes: false,
  transformTags: {
    a: (tagName, attribs) => {
      const out: Record<string, string> = {};
      if (attribs.href !== undefined && isSafeHref(attribs.href)) out.href = attribs.href.trim();
      if (attribs.title !== undefined) out.title = attribs.title.slice(0, 300);
      if (attribs.rel !== undefined) {
        const rel = attribs.rel
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => REL_TOKENS.has(t));
        if (rel.length) out.rel = [...new Set(rel)].join(" ");
      }
      return { tagName, attribs: out };
    },
  },
};

export function sanitizeRichText(html: string): string {
  if (typeof html !== "string" || html === "") return "";
  // Two passes: the second is a fixed point check against parser differentials.
  const once = sanitizeHtml(html, OPTIONS);
  return sanitizeHtml(once, OPTIONS);
}

/**
 * Broader allow-list for whole article bodies (`frontmatter.content_format:
 * "html"`, e.g. AI-generated posts): rich-text tags plus headings, images,
 * figures, tables, pre and hr. Styles, classes, scripts, event handlers,
 * iframes and forms are always dropped; img src must be http(s) or relative.
 */
const ARTICLE_OPTIONS: sanitizeHtml.IOptions = {
  ...OPTIONS,
  allowedTags: [
    ...RICH_TEXT_TAGS,
    "h1", "h5", "h6", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "caption", "pre", "hr", "span", "div", "sup", "sub", "s", "del", "ins", "mark", "small", "dl", "dt", "dd",
  ],
  allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height", "loading"], th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"] },
  allowedSchemesByTag: { img: ["http", "https"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  transformTags: {
    ...OPTIONS.transformTags,
    img: (tagName, attribs) => {
      const out: Record<string, string> = {};
      const src = attribs.src?.trim();
      if (src && isSafeHref(src) && !/^mailto:/i.test(src)) out.src = src;
      for (const k of ["alt", "title"]) if (attribs[k] !== undefined) out[k] = attribs[k]!.slice(0, 500);
      for (const k of ["width", "height"]) if (attribs[k] && /^\d{1,5}$/.test(attribs[k]!)) out[k] = attribs[k]!;
      if (attribs.loading === "lazy" || attribs.loading === "eager") out.loading = attribs.loading;
      return { tagName, attribs: out };
    },
  },
};

export function sanitizeArticleHtml(html: string): string {
  if (typeof html !== "string" || html === "") return "";
  return sanitizeHtml(sanitizeHtml(html, ARTICLE_OPTIONS), ARTICLE_OPTIONS);
}

/** Plain text never contains markup; used for `format: "text"` blocks. */
export function normalizePlainText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
