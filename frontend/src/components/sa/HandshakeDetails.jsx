import { useState } from "react";
import { CheckCircle2, XCircle, Copy, Check, MinusCircle } from "lucide-react";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Button } from "../ui/button";
import { CAPABILITY_ORDER, capabilityHelp, capabilityLabel } from "../../lib/capabilities";

export function CopyBlock({ label, code, testId }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed — select the text and copy it manually");
    }
  };
  return (
    <div className="rounded-md border border-border/50 overflow-hidden" data-testid={testId}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b border-border/50">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? <Check size={12} className="text-emerald-500" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="p-3 text-xs font-mono overflow-x-auto whitespace-pre">{code}</pre>
    </div>
  );
}

const Flag = ({ ok }) =>
  ok === true ? (
    <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 size={14} aria-hidden="true" />on</span>
  ) : ok === false ? (
    <span className="inline-flex items-center gap-1 text-muted-foreground"><MinusCircle size={14} aria-hidden="true" />off</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );

export function CapabilitiesTable({ capabilities }) {
  const flags = capabilities?.capabilities || {};
  const names = [...CAPABILITY_ORDER, ...Object.keys(flags).filter((k) => !CAPABILITY_ORDER.includes(k))];
  if (!capabilities) return <p className="text-sm text-muted-foreground">No capability snapshot yet — run a handshake.</p>;
  return (
    <Table className="data-table" data-testid="capabilities-table">
      <TableHeader>
        <TableRow>
          <TableHead>Capability</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="hidden md:table-cell">How to enable</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {names.map((n) => (
          <TableRow key={n} data-testid={`cap-row-${n}`} data-enabled={flags[n] === true ? "true" : "false"}>
            <TableCell>
              <div className="font-medium text-sm">{capabilityLabel(n)}</div>
              <code className="text-[11px] text-muted-foreground">{n}</code>
            </TableCell>
            <TableCell className="text-xs"><Flag ok={flags[n]} /></TableCell>
            <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-md">
              {flags[n] === true ? "—" : capabilityHelp(n)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function HealthChecks({ health }) {
  if (!health) return <p className="text-sm text-muted-foreground">Health not loaded.</p>;
  const checks = health.checks || [];
  return (
    <div className="space-y-2" data-testid="health-checks">
      <p className="text-sm">
        Status: <strong className={health.status === "ok" ? "text-emerald-500" : health.status === "degraded" ? "text-yellow-500" : "text-red-500"}>{health.status || "unknown"}</strong>
        {health.ready === false && <span className="text-yellow-500"> · not ready</span>}
        {health.current_revision && <span className="text-muted-foreground"> · revision <code>{health.current_revision}</code></span>}
      </p>
      <ul className="space-y-1">
        {checks.map((c) => (
          <li key={c.name} className="flex items-start gap-2 text-sm">
            {c.ok ? (
              <CheckCircle2 size={14} className="text-emerald-500 mt-0.5" aria-label="passed" />
            ) : (
              <XCircle size={14} className="text-red-500 mt-0.5" aria-label="failed" />
            )}
            <code className="text-xs">{c.name}</code>
            {c.detail && <span className="text-xs text-muted-foreground">{c.detail}</span>}
          </li>
        ))}
        {!checks.length && <li className="text-sm text-muted-foreground">No checks reported.</li>}
      </ul>
    </div>
  );
}

const Row = ({ k, v }) => (
  <div className="flex justify-between gap-4 py-1 border-b border-border/20 text-sm">
    <dt className="text-muted-foreground">{k}</dt>
    <dd className="font-mono text-xs text-right break-all">{v ?? "—"}</dd>
  </div>
);

export function IdentityDetails({ capabilities }) {
  if (!capabilities) return null;
  const c = capabilities;
  const roots = c.writable_roots || [];
  return (
    <div className="grid md:grid-cols-2 gap-6" data-testid="identity-details">
      <div>
        <h3 className="text-sm font-semibold mb-2">Bridge & framework</h3>
        <dl>
          <Row k="Protocol" v={c.protocol_version ? `v${c.protocol_version}` : null} />
          <Row k="Agent version" v={c.agent_version} />
          <Row k="Mode" v={c.mode} />
          <Row k="Site key" v={c.site?.site_id} />
          <Row k="Next.js" v={c.nextjs ? `${c.nextjs.version || "?"} (${c.nextjs.router || "unknown"} router)` : null} />
          <Row k="Package manager" v={c.package_manager} />
        </dl>
        <h3 className="text-sm font-semibold mt-4 mb-2">Repository</h3>
        <dl>
          <Row k="Available" v={c.repository ? String(!!c.repository.available) : null} />
          <Row k="Commit" v={c.repository?.commit} />
          <Row k="Branch" v={c.repository?.branch} />
          <Row k="Dirty" v={c.repository ? String(!!c.repository.dirty) : null} />
        </dl>
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-2">Deployment identity</h3>
        <dl>
          <Row k="Hostname" v={c.deployment?.hostname} />
          <Row k="Container" v={c.deployment?.container_id} />
          <Row k="Image" v={c.deployment?.image} />
          <Row k="Compose project" v={c.deployment?.compose_project} />
          <Row k="Service" v={c.deployment?.service} />
          <Row k="Profiles" v={(c.deployment?.profiles || []).join(", ") || null} />
        </dl>
        <h3 className="text-sm font-semibold mt-4 mb-2">Writable roots</h3>
        <ul className="space-y-1" data-testid="writable-roots">
          {roots.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <code className="text-xs">{r.id}</code>
              <span className="text-xs text-muted-foreground">({r.kind})</span>
              <span className={`ml-auto text-xs ${r.writable ? "text-emerald-500" : "text-muted-foreground"}`}>
                {r.writable ? "writable" : "read-only"}
              </span>
            </li>
          ))}
          {!roots.length && <li className="text-sm text-muted-foreground">None reported.</li>}
        </ul>
      </div>
    </div>
  );
}
