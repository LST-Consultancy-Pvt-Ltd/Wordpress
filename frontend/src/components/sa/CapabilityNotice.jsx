import { Link } from "react-router-dom";
import { PlugZap } from "lucide-react";
import { capabilityHelp, capabilityLabel } from "../../lib/capabilities";

/**
 * Empty state shown instead of a feature when the site's bridge doesn't offer
 * the capability. Explains how to enable it on the bridge.
 */
export default function CapabilityNotice({ capability, site, children, compact = false }) {
  return (
    <div
      className={`rounded-lg border border-dashed border-border/60 bg-muted/20 ${compact ? "p-4" : "p-8"} text-center`}
      role="status"
      data-testid={`capability-missing-${capability}`}
    >
      <PlugZap size={compact ? 20 : 32} className="mx-auto mb-3 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium text-sm">
        {capabilityLabel(capability)} is not available for {site?.name || "this site"}
      </p>
      <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
        The bridge reports <code className="font-mono">{capability}</code> as disabled. {capabilityHelp(capability)}
      </p>
      <p className="text-xs text-muted-foreground mt-2">
        After changing the bridge configuration, refresh the handshake
        {site?.id ? (
          <>
            {" "}on the <Link className="text-primary underline" to={`/sites/${site.id}`}>site page</Link>
          </>
        ) : null}
        . See <code className="font-mono">automation-bridge/README.md</code> → Capabilities.
      </p>
      {children}
    </div>
  );
}
