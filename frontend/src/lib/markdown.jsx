/**
 * Tiny Markdown → React renderer for editor previews. It builds React
 * elements (no HTML injection), so user content can never execute. Supports
 * headings, paragraphs, lists, blockquotes, fenced code, hr, links, images
 * (as alt-text placeholders), bold, italic and inline code. MDX/JSX tags are
 * shown verbatim.
 */
import { Fragment } from "react";

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

function inline(text, keyBase = "i") {
  const out = [];
  // Order matters: code, image, link, bold, italic.
  const re = /(`[^`]+`)|(!\[([^\]]*)\]\(([^)\s]+)[^)]*\))|(\[([^\]]+)\]\(([^)\s]+)[^)]*\))|(\*\*([^*]+)\*\*|__([^_]+)__)|(\*([^*]+)\*|_([^_]+)_)/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${k++}`;
    if (m[1]) out.push(<code key={key} className="px-1 rounded bg-muted font-mono text-[0.85em]">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<span key={key} className="inline-block text-xs text-muted-foreground border border-dashed rounded px-1">[image: {m[3] || "no alt text"}]</span>);
    else if (m[5]) {
      const href = m[7];
      out.push(
        SAFE_HREF.test(href) ? (
          <a key={key} href={href} className="text-primary underline" target="_blank" rel="noopener noreferrer">{inline(m[6], key)}</a>
        ) : (
          <span key={key}>{m[6]}</span>
        )
      );
    } else if (m[8]) out.push(<strong key={key}>{inline(m[9] || m[10], key)}</strong>);
    else if (m[11]) out.push(<em key={key}>{inline(m[12] || m[13], key)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src) {
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      blocks.push(<pre key={key++} className="bg-muted/50 rounded p-3 text-xs font-mono overflow-x-auto"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const Tag = `h${Math.min(h[1].length + 1, 6)}`;
      const size = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-sm"][h[1].length - 1];
      blocks.push(<Tag key={key++} className={`${size} font-semibold mt-4 mb-2`}>{inline(h[2], `h${key}`)}</Tag>);
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-4 border-border" />);
      i += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i += 1;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key++} className={`${ordered ? "list-decimal" : "list-disc"} ml-6 my-2 space-y-1`}>
          {items.map((it, j) => <li key={j}>{inline(it, `l${key}-${j}`)}</li>)}
        </Tag>
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key++} className="border-l-2 border-primary/50 pl-3 my-2 text-muted-foreground">{inline(buf.join(" "), `q${key}`)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(
      <p key={key++} className="my-2 leading-relaxed">
        {buf.map((b, j) => (
          <Fragment key={j}>
            {j > 0 && " "}
            {inline(b, `p${key}-${j}`)}
          </Fragment>
        ))}
      </p>
    );
  }
  return blocks;
}

export default function MarkdownPreview({ source, className = "" }) {
  return <div className={`text-sm ${className}`} data-testid="markdown-preview">{renderMarkdown(source)}</div>;
}
