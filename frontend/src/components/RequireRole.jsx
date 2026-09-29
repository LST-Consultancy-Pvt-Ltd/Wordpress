import { ShieldAlert } from "lucide-react";
import { useRole } from "../hooks/useRole";
import { ROLE_LABELS } from "../lib/roles";

/**
 * Renders children only when the signed-in user has at least `min` role.
 * Otherwise renders `fallback`, or (for whole pages) an explanatory notice.
 * The backend enforces the same rule; this only avoids dead UI.
 */
export default function RequireRole({ min, children, fallback, page = false }) {
  const { can, role } = useRole();
  if (can(min)) return children;
  if (fallback !== undefined) return fallback;
  if (!page) return null;
  return (
    <div className="page-container" data-testid="require-role-denied">
      <div className="max-w-lg mx-auto mt-16 text-center content-card p-8" role="alert">
        <ShieldAlert size={40} className="mx-auto mb-4 text-yellow-500" aria-hidden="true" />
        <h1 className="text-lg font-semibold mb-2">{ROLE_LABELS[min] || min} role required</h1>
        <p className="text-sm text-muted-foreground">
          You are signed in as <strong>{ROLE_LABELS[role] || role}</strong>. Ask an administrator to
          grant the {ROLE_LABELS[min] || min} role if you need this page.
        </p>
      </div>
    </div>
  );
}
