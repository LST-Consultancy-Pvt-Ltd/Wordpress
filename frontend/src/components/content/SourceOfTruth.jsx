import { Database } from "lucide-react";

/** Small "where does this value live" line shown on every editor. */
export default function SourceOfTruth({ children }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="source-of-truth">
      <Database size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span>
        <span className="font-medium">Source of truth:</span> {children}
      </span>
    </p>
  );
}
