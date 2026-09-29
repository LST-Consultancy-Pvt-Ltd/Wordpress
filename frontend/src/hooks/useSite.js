import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage, getSite, getSites } from "../lib/api";

/** Load one site by id (control-plane `Site`), with reload(). */
export function useSite(siteId) {
  const [site, setSite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!siteId) return null;
    setLoading(true);
    try {
      const { data } = await getSite(siteId);
      setSite(data);
      setError(null);
      return data;
    } catch (e) {
      setError(apiErrorMessage(e, "Could not load site"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { site, setSite, loading, error, reload };
}

/** Load all sites (for pickers and cross-site lists). */
export function useSites() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getSites();
      setSites(Array.isArray(data) ? data : data?.items || []);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, "Could not load sites"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { sites, loading, error, reload };
}
