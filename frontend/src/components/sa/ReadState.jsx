import { Loader2 } from "lucide-react";
import CapabilityNotice from "./CapabilityNotice";
import ErrorCallout from "./ErrorCallout";

/**
 * Standard loading / unsupported / error / empty wrapper for bridge reads.
 * Renders children only when data is ready.
 */
export default function ReadState({ state, site, capability, empty, isEmpty, children }) {
  if (capability && site && site.capabilities && site.capabilities.capabilities?.[capability] !== true) {
    return <CapabilityNotice capability={capability} site={site} />;
  }
  if (state.unsupported) return <CapabilityNotice capability={state.unsupported} site={site} />;
  if (state.loading && !state.data) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground" role="status">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading…
      </div>
    );
  }
  if (state.error) {
    return <ErrorCallout title="Could not load from the bridge" message={state.error.message} code={state.error.code} correlationId={state.error.correlationId} />;
  }
  if (isEmpty) {
    return <p className="text-sm text-muted-foreground py-8 text-center">{empty || "Nothing here yet."}</p>;
  }
  return children;
}
