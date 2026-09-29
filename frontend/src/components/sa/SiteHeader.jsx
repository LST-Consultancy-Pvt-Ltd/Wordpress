import { NavLink, Link } from "react-router-dom";
import { Lock, Unlock, ArrowLeft, Loader2, AlertTriangle } from "lucide-react";
import { ConnectionBadge, EnvironmentBadge } from "./StatusBadge";
import { protocolSupported } from "../../lib/capabilities";

const TABS = [
  { to: "", label: "Overview", end: true },
  { to: "inventory", label: "Inventory" },
  { to: "content", label: "Content" },
  { to: "code", label: "Code" },
  { to: "operations", label: "Operations" },
  { to: "backups", label: "Backups" },
];

/** Write state banner: read-only vs write-enabled, shown on every site page. */
export function WriteStateBanner({ site }) {
  if (!site) return null;
  const on = !!site.writes_enabled;
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
        on ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500" : "border-yellow-500/40 bg-yellow-500/10 text-yellow-500"
      }`}
      data-testid="write-state"
      data-writes-enabled={on ? "true" : "false"}
      role="status"
    >
      {on ? <Unlock size={16} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
      <span className="font-semibold">{on ? "Write-enabled" : "Read-only"}</span>
      <span className="text-foreground/70">
        {on
          ? "Approved change sets can be applied to this site."
          : "Change sets can be created and reviewed, but nothing can be applied until an admin verifies and enables writes."}
      </span>
    </div>
  );
}

export default function SiteHeader({ site, loading, error, title, children }) {
  if (loading && !site) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8" role="status">
        <Loader2 className="animate-spin" size={18} aria-hidden="true" /> Loading site…
      </div>
    );
  }
  if (error && !site) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm" role="alert">
        {error} — <Link to="/sites" className="underline">back to sites</Link>
      </div>
    );
  }
  if (!site) return null;
  return (
    <div className="space-y-4 mb-6">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/sites" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-1">
            <ArrowLeft size={12} aria-hidden="true" /> All sites
          </Link>
          <h1 className="page-title mb-1 truncate" data-testid="site-title">
            {title ? `${title} · ${site.name}` : site.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <EnvironmentBadge environment={site.environment} data-testid="site-environment" />
            <ConnectionBadge status={site.connection?.status} data-testid="site-connection" />
            <a href={site.base_url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground truncate">
              {site.base_url}
            </a>
          </div>
        </div>
        {children && <div className="flex flex-wrap gap-2">{children}</div>}
      </div>
      <WriteStateBanner site={site} />
      {!protocolSupported(site) && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm" role="alert">
          <AlertTriangle size={16} className="text-red-500" aria-hidden="true" />
          This bridge speaks protocol v{site.capabilities?.protocol_version}; Site Autopilot supports v1. Upgrade the bridge agent.
        </div>
      )}
      <nav aria-label="Site sections" className="flex flex-wrap gap-1 border-b border-border/40">
        {TABS.map((t) => (
          <NavLink
            key={t.label}
            to={t.to ? `/sites/${site.id}/${t.to}` : `/sites/${site.id}`}
            end={t.end}
            className={({ isActive }) =>
              `px-3 py-2 text-sm border-b-2 -mb-px ${
                isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
        <NavLink
          to={`/changesets?site=${site.id}`}
          className="px-3 py-2 text-sm border-b-2 -mb-px border-transparent text-muted-foreground hover:text-foreground"
        >
          Change sets
        </NavLink>
      </nav>
    </div>
  );
}
