import { useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Check, Code2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";

/** Some SEO surfaces genuinely cannot be edited from outside a Next.js repo:
 *  robots.txt and the sitemap come from app/robots.ts and app/sitemap.ts,
 *  redirects from next.config, canonical and noindex from the page's own
 *  generateMetadata(). Rather than offer inputs that would silently do
 *  nothing, the findings are turned into the code to paste. */
export default function SnippetsPanel({ snippets, note, siteId }) {
  const [copied, setCopied] = useState("");

  const copy = async (key, code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(key);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("");
    }
  };

  if (!snippets?.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Code2 size={28} className="mx-auto mb-2 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">
            {note || "Run an audit first — these snippets are generated from its findings."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="border-blue-500/30 bg-blue-500/5">
        <CardContent className="py-3">
          <p className="text-xs text-blue-400">
            Everything below is generated from this site's own audit, pre-filled with its URL and
            findings. These surfaces live in your Next.js source (e.g. <code>app/robots.ts</code>,{" "}
            <code>app/sitemap.ts</code>, <code>next.config</code>), so they change through a code change set.
            {siteId && (
              <>
                {" "}Paste a snippet into the{" "}
                <Link to={`/sites/${siteId}/code`} className="underline">Code workspace</Link> to propose it.
              </>
            )}
          </p>
        </CardContent>
      </Card>

      {snippets.map((s) => (
        <Card key={s.key}>
          <CardHeader className="flex flex-row items-start justify-between pb-3 gap-4">
            <div className="min-w-0">
              <CardTitle className="text-sm font-mono flex items-center gap-2">
                {s.title}
                <Badge className="text-[10px] bg-muted text-muted-foreground">{s.language}</Badge>
              </CardTitle>
              <CardDescription className="text-xs mt-1">{s.why}</CardDescription>
            </div>
            <Button size="sm" variant="outline" className="h-7 text-xs shrink-0"
                    onClick={() => copy(s.key, s.code)}>
              {copied === s.key
                ? <><Check size={11} className="mr-1 text-emerald-500" />Copied</>
                : <><Copy size={11} className="mr-1" />Copy</>}
            </Button>
          </CardHeader>
          <CardContent>
            <pre className="text-[11px] font-mono bg-muted/40 border rounded-md p-3 overflow-x-auto
                            max-h-[420px] overflow-y-auto whitespace-pre">
{s.code}
            </pre>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
