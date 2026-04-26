import { useState } from "react";
import { Copy, Check, ExternalLink, CheckCircle2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { toast } from "sonner";

/**
 * ManualApplySheet — side panel shown when Apply Mode is "manual".
 *
 * Props:
 *   open        {boolean}   — whether the sheet is visible
 *   onClose     {function}  — called when sheet should close
 *   title       {string}    — e.g. "Apply Meta Tags"
 *   wpAdminUrl  {string}    — WP admin deep-link opened in new tab
 *   fields      {Array<{ label, value, type?: "text"|"html"|"json"|"url" }>}
 *   instructions {string}   — plain-English step-by-step hint
 */
export default function ManualApplySheet({
  open,
  onClose,
  title = "",
  wpAdminUrl = "",
  fields = [],
  instructions = "",
}) {
  const [copied, setCopied] = useState({});

  const handleCopy = async (value, key) => {
    try {
      await navigator.clipboard.writeText(String(value ?? ""));
      setCopied((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setCopied((prev) => ({ ...prev, [key]: false })), 2000);
    } catch {
      toast.error("Copy failed — please copy manually");
    }
  };

  const handleDone = () => {
    onClose();
    toast.success("Changes marked as applied manually!");
  };

  const renderValue = (value, type) => {
    const str = String(value ?? "");
    if (type === "html" || type === "json") {
      return (
        <pre className="bg-muted/50 border border-border rounded-md p-3 text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono max-h-48">
          {str}
        </pre>
      );
    }
    if (type === "url") {
      return (
        <div className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm text-primary break-all">
          {str}
        </div>
      );
    }
    return (
      <div className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm break-words">
        {str}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[520px] flex flex-col p-0 overflow-hidden"
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-6 border-b border-border/30 flex-shrink-0">
            <SheetHeader>
              <div className="flex items-center gap-2 mb-2">
                <Badge className="bg-yellow-500/15 text-yellow-600 border-yellow-500/30 text-xs font-medium">
                  Manual Mode
                </Badge>
              </div>
              <SheetTitle className="text-base leading-snug">{title}</SheetTitle>
            </SheetHeader>

            {wpAdminUrl && (
              <Button className="mt-3 w-full" variant="outline" asChild>
                <a href={wpAdminUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} className="mr-2" />
                  Open in WordPress →
                </a>
              </Button>
            )}
          </div>

          {/* Instructions banner */}
          {instructions && (
            <div className="px-6 py-3 bg-yellow-500/5 border-b border-yellow-500/20 flex-shrink-0">
              <p className="text-xs text-yellow-700 dark:text-yellow-400 leading-relaxed">
                <strong>Instructions: </strong>{instructions}
              </p>
            </div>
          )}

          {/* Fields */}
          <ScrollArea className="flex-1 px-6 py-4">
            <div className="space-y-5">
              {fields.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No fields to display.
                </p>
              )}
              {fields.map((field, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {field.label}
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs gap-1"
                      onClick={() => handleCopy(field.value, i)}
                    >
                      {copied[i] ? (
                        <><Check size={11} className="text-emerald-500" />Copied</>
                      ) : (
                        <><Copy size={11} />Copy</>
                      )}
                    </Button>
                  </div>
                  {renderValue(field.value, field.type || "text")}
                </div>
              ))}
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="p-6 border-t border-border/30 flex-shrink-0">
            <Button className="w-full btn-primary" onClick={handleDone}>
              <CheckCircle2 size={14} className="mr-2" />
              Done — I've applied it manually
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
