import { useEffect, useState, useCallback } from "react";
import { getUser } from "../lib/session";
import { hasRole } from "../lib/roles";

/**
 * Current user + role from the `sa_user` session entry. Re-reads when the
 * session changes (login/logout in this tab, or storage events from others).
 * Users without a recognised role are treated as viewers.
 */
export function useRole() {
  const [user, setUser] = useState(() => getUser());

  useEffect(() => {
    const refresh = () => setUser(getUser());
    window.addEventListener("sa:session", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("sa:session", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const role = user?.role || "viewer";
  const can = useCallback((min) => hasRole(role, min), [role]);

  return { user, role, can };
}
