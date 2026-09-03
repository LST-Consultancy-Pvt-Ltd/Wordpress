import { Fragment, useMemo, useState } from "react";
import { ExternalLink, Search, Gauge, Smartphone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { CheckRow, ScoreRing, scoreChip, scoreTone, fmtMs, sevChip } from "./shared";
import { cn } from "../../lib/utils";

const BAND_TONE = {
  good: "bg-emerald-500/10 text-emerald-500",
  "needs-improvement": "bg-yellow-500/10 text-yellow-500",
  poor: "bg-red-500/10 text-red-400",
  unknown: "bg-muted text-muted-foreground",
};

const FIELD_TONE = { FAST: "text-emerald-500", AVERAGE: "text-yellow-500", SLOW: "text-red-400" };

function Cell({ children, className }) {
  return <TableCell className={cn("text-xs py-2", className)}>{children}</TableCell>;
}

function PageLink({ url, path }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
       className="text-primary hover:underline inline-flex items-center gap-1 truncate max-w-[280px]">
      <ExternalLink size={9} className="shrink-0" />
      <span className="truncate">{path || url}</span>
    </a>
  );
}

/* ------------------------------------------------------------------ *
 * Per-category detail views.
 *
 * A generic key/value dump would technically show the data, but the whole
 * value of a category is that its numbers are the ones that matter for THAT
 * dimension — Core Web Vitals want bands and thresholds, image SEO wants a
 * per-image grid, robots wants the file as written. So each gets its own.
 * ------------------------------------------------------------------ */

function PerformanceDetail({ category }) {
  const items = category.items || [];
  const mobile = items.filter((i) => i.strategy === "mobile");
  const desktop = items.filter((i) => i.strategy === "desktop");
  if (!items.length) {
    return (
      <p className="text-xs text-muted-foreground px-3 py-6 text-center">
        No PageSpeed measurements in this audit. Turn on “Core Web Vitals” before running it —
        each URL takes 20–40 seconds, so only a small sample is measured.
      </p>
    );
  }
  const rows = [
    ["LCP", "lcp_ms", "lcp", "≤ 2.5 s"],
    ["CLS", "cls", "cls", "≤ 0.1"],
    ["TBT (INP proxy)", "tbt_ms", "tbt", "≤ 200 ms"],
    ["FCP", "fcp_ms", "fcp", "≤ 1.8 s"],
    ["TTFB", "ttfb_ms", "ttfb", "≤ 800 ms"],
  ];
  return (
    <div className="space-y-4">
      {[["Mobile", mobile], ["Desktop", desktop]].map(([label, set]) =>
        set.length === 0 ? null : (
          <div key={label} className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground px-1">{label}</p>
            {set.map((r) => (
              <div key={r.url + r.strategy} className="border rounded-md p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <PageLink url={r.url} path={r.path} />
                  <div className="flex items-center gap-1.5">
                    {[["Perf", r.performance_score], ["SEO", r.seo_score],
                      ["A11y", r.accessibility_score], ["Best pr.", r.best_practices_score]]
                      .map(([n, v]) => (
                        <Badge key={n} className={cn("text-[10px] font-mono", scoreChip(v))}>
                          {n} {v ?? "—"}
                        </Badge>
                      ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {rows.map(([name, labKey, bandKey, target]) => {
                    const v = r.lab?.[labKey];
                    const band = r.bands?.[bandKey] || "unknown";
                    return (
                      <div key={name} className="rounded border border-border/50 p-2">
                        <p className="text-[10px] text-muted-foreground">{name}</p>
                        <p className="text-sm font-mono">
                          {v == null ? "—" : bandKey === "cls" ? Number(v).toFixed(3) : fmtMs(v)}
                        </p>
                        <div className="flex items-center justify-between mt-1">
                          <Badge className={cn("text-[9px] px-1 py-0", BAND_TONE[band])}>{band}</Badge>
                          <span className="text-[9px] text-muted-foreground">{target}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {r.field?.overall ? (
                  <p className="text-[11px] text-muted-foreground">
                    Real users (Chrome CrUX):{" "}
                    <span className={cn("font-medium", FIELD_TONE[r.field.overall])}>{r.field.overall}</span>
                    {r.field.lcp?.percentile != null && ` · LCP p75 ${fmtMs(r.field.lcp.percentile)}`}
                    {r.field.inp?.percentile != null && ` · INP p75 ${fmtMs(r.field.inp.percentile)}`}
                    {r.field.cls?.percentile != null &&
                      ` · CLS p75 ${(r.field.cls.percentile / 100).toFixed(3)}`}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No real-user data for this URL yet — that needs traffic. Lab figures above are the proxy.
                  </p>
                )}
              </div>
            ))}
          </div>
        )
      )}
      {(category.opportunities || []).length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground px-1 mb-1.5">
            Biggest wins, measured by Lighthouse
          </p>
          <div className="border rounded-md divide-y divide-border/40">
            {category.opportunities.map((o, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{o.title}</span>
                  <span className="text-xs font-mono text-emerald-500 shrink-0">
                    −{fmtMs(o.savings_ms)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{o.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KeywordDetail({ category, query }) {
  const items = (category.items || []).filter(
    (i) => !query || (i.path + i.keyword).toLowerCase().includes(query)
  );
  const [open, setOpen] = useState({});
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs">Page</TableHead>
          <TableHead className="text-xs w-56">Focus keyword</TableHead>
          <TableHead className="text-xs w-16">Score</TableHead>
          <TableHead className="text-xs w-20">Density</TableHead>
          <TableHead className="text-xs w-16">Words</TableHead>
          <TableHead className="text-xs w-24">Words/sent.</TableHead>
          <TableHead className="text-xs w-20">Flesch</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i) => (
          <Fragment key={i.path}>
            <TableRow className="cursor-pointer"
                      onClick={() => setOpen((o) => ({ ...o, [i.path]: !o[i.path] }))}>
              <Cell><PageLink url={i.url} path={i.path} /></Cell>
              <Cell>
                <span className="truncate block max-w-[200px]">{i.keyword || "—"}</span>
                {i.inferred && i.keyword && (
                  <span className="text-[10px] text-yellow-500">inferred from H1</span>
                )}
              </Cell>
              <Cell><Badge className={cn("text-[10px] font-mono", scoreChip(i.keyword_score))}>
                {i.keyword_score ?? "—"}</Badge></Cell>
              <Cell className={cn("font-mono",
                i.density > 2.5 || i.density < 0.5 ? "text-yellow-500" : "")}>{i.density}%</Cell>
              <Cell className="font-mono">{i.word_count}</Cell>
              <Cell className={cn("font-mono", (i.avg_sentence_words ?? 0) > 25 ? "text-yellow-500" : "")}>
                {i.avg_sentence_words ?? "—"}
              </Cell>
              <Cell className={cn("font-mono", (i.reading_ease ?? 100) < 30 ? "text-yellow-500" : "")}>
                {i.reading_ease ?? "—"}
              </Cell>
            </TableRow>
            {open[i.path] && (
              <TableRow>
                <TableCell colSpan={7} className="bg-muted/20">
                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 py-1">
                    {(i.checks || []).map((c) => (
                      <div key={c.id} className="flex items-start gap-2">
                        <span className={cn("text-[10px] font-mono shrink-0 mt-0.5",
                          c.passed ? "text-emerald-500" : "text-red-400")}>
                          {c.passed ? "PASS" : "FAIL"}
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs">{c.label}</p>
                          {!c.passed && <p className="text-[11px] text-muted-foreground">{c.hint}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {(i.terms || []).length > 0 && (
                    <p className="text-[11px] text-muted-foreground pt-1.5 border-t border-border/40">
                      <span className="font-medium">What this page is actually about: </span>
                      {i.terms.map((t) => `${t.term} (${t.count})`).join(" · ")}
                    </p>
                  )}
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function ImagesDetail({ category, query }) {
  const items = (category.items || []).filter((i) => !query || i.path.toLowerCase().includes(query));
  const [open, setOpen] = useState({});
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs">Page</TableHead>
          <TableHead className="text-xs w-20">Images</TableHead>
          <TableHead className="text-xs w-28">Missing alt</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i) => (
          <Fragment key={i.path}>
            <TableRow className="cursor-pointer"
                      onClick={() => setOpen((o) => ({ ...o, [i.path]: !o[i.path] }))}>
              <Cell><PageLink url={i.url} path={i.path} /></Cell>
              <Cell className="font-mono">{i.image_count}</Cell>
              <Cell className={cn("font-mono", i.missing_alt ? "text-red-400" : "text-emerald-500")}>
                {i.missing_alt}
              </Cell>
            </TableRow>
            {open[i.path] && (
              <TableRow>
                <TableCell colSpan={3} className="bg-muted/20 p-0">
                  <div className="max-h-72 overflow-y-auto divide-y divide-border/20">
                    {(i.images || []).map((img, k) => (
                      <div key={k} className="px-3 py-1.5 text-xs flex items-start gap-3">
                        <span className="font-mono text-muted-foreground shrink-0 w-40 truncate"
                              title={img.src}>{img.filename || img.src}</span>
                        <span className={cn("shrink-0 w-14 text-[10px]",
                          img.ext ? "text-muted-foreground" : "opacity-40")}>
                          {img.ext || "?"}
                        </span>
                        <span className={cn("flex-1 min-w-0 truncate",
                          img.alt ? "" : "text-red-400 italic")}>
                          {img.alt || "no alt text"}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {img.width && img.height ? `${img.width}×${img.height}` : "no dims"}
                          {img.loading === "lazy" && " · lazy"}
                          {img.srcset && " · srcset"}
                        </span>
                      </div>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function RobotsDetail({ category }) {
  return (
    <div className="space-y-3">
      {category.robots_url && (
        <a href={category.robots_url} target="_blank" rel="noopener noreferrer"
           className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          <ExternalLink size={10} />{category.robots_url}
        </a>
      )}
      {category.raw ? (
        <pre className="text-[11px] font-mono bg-muted/40 border rounded-md p-3 overflow-x-auto whitespace-pre">
{category.raw}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">No robots.txt content to show.</p>
      )}
      {(category.items || []).map((g, i) => (
        <div key={i} className="border rounded-md p-3 text-xs space-y-1">
          <p className="font-medium">User-agent: {g.path}</p>
          {(g.disallow || []).map((d, k) => (
            <p key={k} className="font-mono text-muted-foreground">Disallow: {d || "(empty = allow all)"}</p>
          ))}
          {(g.allow || []).map((a, k) => (
            <p key={k} className="font-mono text-emerald-500">Allow: {a}</p>
          ))}
          {g.crawl_delay && <p className="font-mono text-muted-foreground">Crawl-delay: {g.crawl_delay}</p>}
        </div>
      ))}
    </div>
  );
}

function SitemapDetail({ category, query }) {
  const items = (category.items || []).filter((i) => !query || i.url.toLowerCase().includes(query));
  return (
    <div className="space-y-2">
      {category.sitemap_url && (
        <a href={category.sitemap_url} target="_blank" rel="noopener noreferrer"
           className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          <ExternalLink size={10} />{category.sitemap_url}
        </a>
      )}
      {(category.children || []).length > 0 && (
        <p className="text-xs text-muted-foreground">
          Index of {category.children.length} child sitemaps.
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">URL</TableHead>
            <TableHead className="text-xs w-44">Last modified</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.slice(0, 400).map((i, k) => (
            <TableRow key={k}>
              <Cell><PageLink url={i.url} path={i.path} /></Cell>
              <Cell className={cn("font-mono", i.lastmod ? "" : "text-yellow-500")}>
                {i.lastmod || "not set"}
              </Cell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {items.length > 400 && (
        <p className="text-[11px] text-muted-foreground">
          Showing the first 400 of {items.length} URLs.
        </p>
      )}
    </div>
  );
}

function SchemaDetail({ category, query }) {
  const items = (category.items || []).filter((i) => !query || i.path.toLowerCase().includes(query));
  return (
    <div className="space-y-3">
      {(category.type_counts || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {category.type_counts.map((t) => (
            <Badge key={t.type} className="text-[10px] bg-primary/10 text-primary">
              {t.type} ×{t.count}
            </Badge>
          ))}
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Page</TableHead>
            <TableHead className="text-xs">Types found</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) => (
            <TableRow key={i.path}>
              <Cell><PageLink url={i.url} path={i.path} /></Cell>
              <Cell>
                {i.types?.length ? (
                  <span className="flex flex-wrap gap-1">
                    {i.types.map((t) => (
                      <Badge key={t} className="text-[10px] bg-muted text-muted-foreground">{t}</Badge>
                    ))}
                  </span>
                ) : <span className="text-red-400">none</span>}
                {i.errors?.length > 0 && (
                  <span className="text-red-400 text-[11px] block mt-0.5">
                    JSON-LD parse error: {i.errors.join("; ")}
                  </span>
                )}
              </Cell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BrokenLinksDetail({ category, query }) {
  const items = (category.items || []).filter((i) => !query || i.url.toLowerCase().includes(query));
  if (!items.length) {
    return <p className="text-xs text-emerald-500 px-3 py-6 text-center">
      Every link checked resolves directly, with no redirects.
    </p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs">Link</TableHead>
          <TableHead className="text-xs w-28">Status</TableHead>
          <TableHead className="text-xs w-20">Scope</TableHead>
          <TableHead className="text-xs">Linked from</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i, k) => (
          <TableRow key={k}>
            <Cell><a href={i.url} target="_blank" rel="noopener noreferrer"
                     className="text-primary hover:underline truncate block max-w-[320px]">{i.url}</a></Cell>
            <Cell className={cn("font-mono",
              i.blocked ? "text-blue-400" : i.ok ? "text-yellow-500" : "text-red-400")}>
              {i.status ?? i.error ?? "—"}
              {/* A host refusing a bot is not a dead page, and saying so is
                  the difference between a report people act on and one they
                  learn to ignore. */}
              {i.blocked
                ? <span className="block text-[10px] text-muted-foreground">bot-blocked, not dead</span>
                : i.ok && i.final_url
                  ? <span className="block text-[10px] text-muted-foreground">redirect</span>
                  : null}
            </Cell>
            <Cell>
              <Badge className={cn("text-[10px]", i.internal
                ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                {i.internal ? "internal" : "external"}
              </Badge>
            </Cell>
            <Cell className="text-muted-foreground truncate max-w-[220px]">
              {(i.sources || []).join(", ")}
            </Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RedirectsDetail({ category, query }) {
  const items = (category.items || []).filter((i) => !query || i.url.toLowerCase().includes(query));
  if (!items.length) {
    return <p className="text-xs text-emerald-500 px-3 py-6 text-center">
      Every audited URL returned 200 directly — no redirects, chains or errors.
    </p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs">Requested URL</TableHead>
          <TableHead className="text-xs w-20">Status</TableHead>
          <TableHead className="text-xs w-16">Hops</TableHead>
          <TableHead className="text-xs">Resolves to</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i, k) => (
          <TableRow key={k}>
            <Cell><PageLink url={i.url} path={i.path} /></Cell>
            <Cell className={cn("font-mono",
              (i.status || 0) >= 400 ? "text-red-400" : i.hops ? "text-yellow-500" : "")}>
              {i.status ?? i.error ?? "—"}
            </Cell>
            <Cell className={cn("font-mono", i.hops > 1 ? "text-yellow-500" : "")}>{i.hops}</Cell>
            <Cell className="text-muted-foreground truncate max-w-[280px]">
              {i.chain?.length
                ? `${i.chain.map((h) => h.status).join(" → ")} → ${i.final_url || ""}`
                : i.final_url || i.error || "—"}
            </Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SocialDetail({ category, query }) {
  const items = (category.items || []).filter((i) => !query || i.path.toLowerCase().includes(query));
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      {items.map((i) => (
        <div key={i.path} className="border rounded-md overflow-hidden">
          {i.og_image ? (
            <img src={i.og_image} alt="" loading="lazy"
                 className="w-full aspect-[1200/630] object-cover bg-muted" />
          ) : (
            <div className="w-full aspect-[1200/630] bg-muted flex items-center justify-center">
              <span className="text-[11px] text-red-400">no og:image — previews render blank</span>
            </div>
          )}
          <div className="p-2.5 space-y-0.5">
            <PageLink url={i.url} path={i.path} />
            <p className="text-xs font-medium truncate">{i.og_title || "(no og:title)"}</p>
            <p className="text-[11px] text-muted-foreground line-clamp-2">
              {i.og_description || "(no og:description)"}
            </p>
            <div className="flex gap-1 pt-1 flex-wrap">
              <Badge className={cn("text-[9px]", i.twitter_card === "summary_large_image"
                ? "bg-emerald-500/10 text-emerald-500" : "bg-yellow-500/10 text-yellow-500")}>
                {i.twitter_card || "no twitter:card"}
              </Badge>
              {i.og_type && <Badge className="text-[9px] bg-muted text-muted-foreground">{i.og_type}</Badge>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MobileDetail({ category, query }) {
  const items = (category.items || []).filter((i) => !query || i.path.toLowerCase().includes(query));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs">Page</TableHead>
          <TableHead className="text-xs">Viewport</TableHead>
          <TableHead className="text-xs w-40">Responsive images</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i) => (
          <TableRow key={i.path}>
            <Cell><PageLink url={i.url} path={i.path} /></Cell>
            <Cell className={cn("font-mono text-[11px]", i.viewport ? "" : "text-red-400")}>
              {i.viewport || "not declared"}
            </Cell>
            <Cell className="font-mono">
              {i.image_count ? `${i.responsive_images}/${i.image_count}` : "—"}
            </Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GenericDetail({ category, query }) {
  const items = (category.items || []).filter(
    (i) => !query || `${i.path || ""}${i.url || ""}${i.detail || ""}`.toLowerCase().includes(query)
  );
  // The union of keys actually present, minus the ones rendered as the first
  // two columns — a fixed column list would hide fields for half the sections.
  // Computed before any early return: a hook behind a conditional breaks the
  // hook order React relies on.
  const extraKeys = useMemo(() => {
    const skip = new Set(["url", "path", "detail", "issues", "images", "headings",
                          "checks", "terms", "objects", "inbound_from", "sources", "headers",
                          "top_anchors", "chain", "lab", "field", "bands"]);
    const keys = [];
    for (const it of items.slice(0, 30)) {
      for (const k of Object.keys(it)) {
        if (!skip.has(k) && !keys.includes(k)) keys.push(k);
      }
    }
    return keys.slice(0, 7);
  }, [items]);

  if (!items.length) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs">Page</TableHead>
          {extraKeys.map((k) => (
            <TableHead key={k} className="text-xs whitespace-nowrap">
              {k.replace(/_/g, " ")}
            </TableHead>
          ))}
          <TableHead className="text-xs">Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.slice(0, 300).map((i, k) => (
          <TableRow key={k}>
            <Cell>{i.url ? <PageLink url={i.url} path={i.path} />
                          : <span className="font-mono">{i.path}</span>}</Cell>
            {extraKeys.map((key) => {
              const v = i[key];
              return (
                <Cell key={key} className="font-mono whitespace-nowrap max-w-[220px] truncate">
                  {v === true ? "yes" : v === false ? "no"
                    : Array.isArray(v) ? (v.length ? v.join(", ") : "—")
                    : v == null || v === "" ? "—" : String(v)}
                </Cell>
              );
            })}
            <Cell className="text-muted-foreground">{i.detail || ""}</Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const DETAIL_VIEWS = {
  performance: PerformanceDetail,
  keyword_content: KeywordDetail,
  images: ImagesDetail,
  robots: RobotsDetail,
  sitemap: SitemapDetail,
  schema: SchemaDetail,
  broken_links: BrokenLinksDetail,
  redirects: RedirectsDetail,
  social: SocialDetail,
  mobile: MobileDetail,
};

export default function CategoryPanel({ category }) {
  const [query, setQuery] = useState("");
  if (!category) return null;

  const Detail = DETAIL_VIEWS[category.key] || GenericDetail;
  const checks = category.checks || [];
  const failing = checks.filter((c) => c.status === "fail");
  const warning = checks.filter((c) => c.status === "warn");
  const rest = checks.filter((c) => c.status !== "fail" && c.status !== "warn");
  const q = query.trim().toLowerCase();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-2">
                {category.label}
                {category.score != null && (
                  <Badge className={cn("text-xs font-mono", scoreChip(category.score))}>
                    {category.score}/100
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs mt-1">{category.summary}</CardDescription>
            </div>
            <ScoreRing score={category.score} size={72} label="score" />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-t">
            {[...failing, ...warning, ...rest].map((c) => (
              <CheckRow key={c.id} check={c} defaultOpen={false} />
            ))}
            {!checks.length && (
              <p className="text-xs text-muted-foreground px-3 py-6 text-center">
                Nothing to evaluate in this section for this audit.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {(category.items || []).length > 0 || category.key === "performance" ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm flex items-center gap-1.5">
              {category.key === "performance" ? <Gauge size={13} />
                : category.key === "mobile" ? <Smartphone size={13} /> : null}
              Detail
            </CardTitle>
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-8 text-xs pl-7 w-44" placeholder="Filter…"
                     value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </CardHeader>
          <CardContent className={cn(category.key === "social" ? "" : "p-0 pb-2")}>
            <div className="max-h-[560px] overflow-auto">
              <Detail category={category} query={q} />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
