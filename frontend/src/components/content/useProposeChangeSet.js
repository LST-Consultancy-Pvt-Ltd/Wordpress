import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { apiErrorDetails, createChangeSet } from "../../lib/api";
import { extractChangeSet, notifyChangeSetCreated } from "../../lib/changesets";

/** Create a change set from typed operations and show the standard feedback. */
export function useProposeChangeSet(siteId) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const propose = async ({ title, description, operations, source = "manual" }) => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await createChangeSet(siteId, { title, description, operations, source });
      const cs = extractChangeSet(data);
      notifyChangeSetCreated(cs, navigate);
      return cs;
    } catch (e) {
      const d = apiErrorDetails(e);
      setError(d);
      toast.error("Could not create change set", { description: d.message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return { propose, busy, error, setError };
}
