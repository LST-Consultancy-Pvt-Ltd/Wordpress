import { useCallback, useEffect, useState } from "react";
import { apiErrorDetails, isCapabilityUnsupported } from "../lib/api";

/**
 * Run a bridge-backed read (inventory, content, revisions…). Distinguishes a
 * missing capability (422 CAPABILITY_UNSUPPORTED) from other errors so pages
 * can show a "how to enable" empty state instead of an error.
 */
export function useBridgeRead(fetcher, deps, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [unsupported, setUnsupported] = useState(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const res = await run();
      setData(res?.data ?? null);
      setError(null);
      setUnsupported(null);
    } catch (e) {
      if (isCapabilityUnsupported(e)) setUnsupported(apiErrorDetails(e).capability || "unknown");
      else setError(apiErrorDetails(e));
    } finally {
      setLoading(false);
    }
  }, [run, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, setData, loading, error, unsupported, reload };
}
