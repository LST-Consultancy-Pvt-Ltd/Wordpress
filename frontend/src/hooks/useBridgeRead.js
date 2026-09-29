import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorDetails, isCapabilityUnsupported } from "../lib/api";

/**
 * Run a bridge-backed read (inventory, content, revisions…). Distinguishes a
 * missing capability (422 CAPABILITY_UNSUPPORTED) from other errors so pages
 * can show a "how to enable" empty state instead of an error.
 *
 * `deps` works like an effect dependency list: the read re-runs when it changes.
 */
export function useBridgeRead(fetcher, deps, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [unsupported, setUnsupported] = useState(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const depKey = JSON.stringify(deps);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setLoading(true);
    fetcherRef
      .current()
      .then((res) => {
        if (cancelled) return;
        setData(res?.data ?? null);
        setError(null);
        setUnsupported(null);
      })
      .catch((e) => {
        if (cancelled) return;
        if (isCapabilityUnsupported(e)) setUnsupported(apiErrorDetails(e).capability || "unknown");
        else setError(apiErrorDetails(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [depKey, enabled, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, setData, loading, error, unsupported, reload };
}
