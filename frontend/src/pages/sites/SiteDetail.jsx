import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { RefreshCw, KeyRound, ShieldCheck, ShieldOff, Trash2, Loader2, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import SiteHeader from "../../components/sa/SiteHeader";
import GatedButton from "../../components/sa/GatedButton";
import ConfirmDialog from "../../components/sa/ConfirmDialog";
import ErrorCallout from "../../components/sa/ErrorCallout";
import { CapabilitiesTable, HealthChecks, IdentityDetails } from "../../components/sa/HandshakeDetails";
import { useSite } from "../../hooks/useSite";
import { useRole } from "../../hooks/useRole";
import {
  apiErrorDetails,
  apiErrorMessage,
  deleteSite,
  getSiteHealth,
  getSitePolicy,
  handshakeSite,
  replaceSiteCredential,
  revokeSiteCredential,
  rotateSiteCredential,
  setSiteWrites,
  updateSitePolicy,
  verifySiteWrite,
} from "../../lib/api";
import { formatDate } from "../../lib/changesets";

const Row = ({ k, v, testId }) => (
  <div className="flex justify-between gap-4 py-1.5 border-b border-border/20 text-sm">
    <dt className="text-muted-foreground">{k}</dt>
    <dd className="text-right break-all" data-testid={testId}>{v ?? "—"}</dd>
  </div>
);

function PolicyCard({ site }) {
  const { can } = useRole();
  const [policy, setPolicy] = useState(null);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSitePolicy(site.id)
      .then(({ data }) => {
        setPolicy(data);
        setText(JSON.stringify(data, null, 2));
      })
      .catch((e) => setError(apiErrorMessage(e)));
  }, [site.id]);

  let parseError = null;
  try {
    if (text) JSON.parse(text);
  } catch (e) {
    parseError = e.message;
  }

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await updateSitePolicy(site.id, JSON.parse(text));
      setPolicy(data || JSON.parse(text));
      toast.success("Policy saved");
    } catch (e) {
      toast.error("Could not save policy", { description: apiErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="content-card">
      <CardHeader>
        <CardTitle className="text-base">Automation policy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorCallout message={error} title="Could not load policy" />
        {policy && (
          <>
            <p className="text-xs text-muted-foreground">
              Auto-apply never covers production (unless listed), <code>file.*</code>, <code>content.delete</code>,{" "}
              <code>redirect.*</code>, deployments or restores.
            </p>
            <Label htmlFor="policy-json" className="sr-only">Policy JSON</Label>
            <Textarea
              id="policy-json"
              className="font-mono text-xs min-h-[220px]"
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={!can("admin")}
              aria-invalid={!!parseError}
              aria-describedby="policy-json-err"
              data-testid="policy-json"
            />
            {parseError && <p id="policy-json-err" className="text-xs text-red-500" role="alert">Invalid JSON: {parseError}</p>}
            <GatedButton minRole="admin" onClick={save} disabled={saving || !!parseError} blocked={null} size="sm">
              {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />} Save policy
            </GatedButton>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function SiteDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { site, setSite, loading, error, reload } = useSite(id);
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [verify, setVerify] = useState(null);
  const [dialog, setDialog] = useState(null); // enable|disable|revoke|delete|rotate
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replace, setReplace] = useState({ key_id: "", secret: "" });

  useEffect(() => {
    if (!site?.id) return;
    getSiteHealth(site.id)
      .then(({ data }) => {
        setHealth(data);
        setHealthError(null);
      })
      .catch((e) => setHealthError(apiErrorMessage(e)));
  }, [site?.id]);

  const run = async (key, fn, success) => {
    setBusy(key);
    try {
      const r = await fn();
      if (success) toast.success(success);
      return r;
    } catch (e) {
      const d = apiErrorDetails(e);
      toast.error(d.message, { description: d.correlationId ? `correlation id ${d.correlationId}` : undefined });
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const doHandshake = () =>
    run("handshake", async () => {
      const { data } = await handshakeSite(site.id);
      setSite(data);
      const h = await getSiteHealth(site.id).catch(() => null);
      if (h) setHealth(h.data);
    }, "Handshake refreshed").catch(() => {});

  const doVerify = () =>
    run("verify", async () => {
      const { data } = await verifySiteWrite(site.id);
      setVerify(data);
      await reload();
    }).catch(() => {});

  const doRotate = () =>
    run("rotate", async () => {
      const { data } = await rotateSiteCredential(site.id);
      await reload();
      toast.success("Credential rotated", { description: `New key id ${data?.key_id || ""}. The old key stays valid for the grace period.` });
    });

  const doReplace = async () => {
    await run("replace", async () => {
      await replaceSiteCredential(site.id, replace);
      setReplace({ key_id: "", secret: "" });
      setReplaceOpen(false);
      const { data } = await handshakeSite(site.id);
      setSite(data);
    }, "Credential replaced").catch(() => {});
  };

  const writesOn = !!site?.writes_enabled;
  const verifiedAt = site?.write_verified_at ? new Date(site.write_verified_at) : null;
  const verifiedRecently = verifiedAt && Date.now() - verifiedAt.getTime() < 24 * 3600 * 1000;
  const revoked = site?.connection?.status === "revoked";

  return (
    <div className="page-container" data-testid="site-detail">
      <SiteHeader site={site} loading={loading} error={error}>
        <GatedButton minRole="editor" variant="outline" size="sm" onClick={doHandshake} disabled={busy === "handshake"} data-testid="refresh-handshake">
          <RefreshCw size={14} className={busy === "handshake" ? "animate-spin" : ""} aria-hidden="true" /> Refresh handshake
        </GatedButton>
      </SiteHeader>

      {site && (
        <div className="grid lg:grid-cols-2 gap-6">
          <Card className="content-card">
            <CardHeader><CardTitle className="text-base">Connection</CardTitle></CardHeader>
            <CardContent>
              <dl>
                <Row k="Install mode" v={site.install_mode} />
                <Row k="Bridge URL" v={<code className="text-xs">{site.bridge_url}</code>} />
                <Row k="Site key" v={site.site_key} />
                <Row k="Key id" v={<code className="text-xs">{site.connection?.key_id}</code>} testId="key-id" />
                <Row k="Credential rotated" v={formatDate(site.connection?.credential_rotated_at)} />
                <Row k="Last handshake" v={formatDate(site.connection?.last_handshake_at)} />
                <Row k="Private-network HTTP" v={site.connection?.private_network_http ? "allowed" : "no"} />
              </dl>
              {site.connection?.last_error && (
                <div className="mt-3">
                  <ErrorCallout title="Last error" message={site.connection.last_error} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="content-card">
            <CardHeader><CardTitle className="text-base">Write enablement</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">
                {writesOn ? (
                  <span className="text-emerald-500 font-semibold">Writes are enabled.</span>
                ) : (
                  <span className="text-yellow-500 font-semibold">Read-only.</span>
                )}{" "}
                <span className="text-muted-foreground">
                  Last write verification: {formatDate(site.write_verified_at)}
                  {verifiedAt && !verifiedRecently && " (older than 24 h — verify again before enabling)"}
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <GatedButton minRole="admin" variant="outline" size="sm" onClick={doVerify} disabled={busy === "verify"} blocked={revoked ? "The credential is revoked" : null} data-testid="verify-write">
                  {busy === "verify" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />} Verify write access
                </GatedButton>
                {writesOn ? (
                  <GatedButton minRole="admin" variant="outline" size="sm" onClick={() => setDialog("disable")} data-testid="disable-writes">
                    <ShieldOff size={14} aria-hidden="true" /> Disable writes…
                  </GatedButton>
                ) : (
                  <GatedButton
                    minRole="admin"
                    size="sm"
                    onClick={() => setDialog("enable")}
                    blocked={revoked ? "The credential is revoked" : !(verifiedRecently || verify?.ok) ? "Run a successful write verification first (valid for 24 h)" : null}
                    data-testid="enable-writes"
                  >
                    Enable writes…
                  </GatedButton>
                )}
              </div>
              {verify && (
                <div className={`rounded-md border p-2 text-xs ${verify.ok ? "border-emerald-500/40" : "border-red-500/40"}`} role="status" data-testid="verify-result">
                  {verify.ok ? "Write probe succeeded." : "Write probe failed."}{" "}
                  {verify.details && (typeof verify.details === "string" ? verify.details : JSON.stringify(verify.details))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="content-card">
            <CardHeader><CardTitle className="text-base">Credential</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Secrets are stored encrypted and never displayed. Rotation asks the bridge for a new key; the old key keeps working
                for a short grace period. Revocation disables writes immediately.
              </p>
              <div className="flex flex-wrap gap-2">
                <GatedButton minRole="admin" variant="outline" size="sm" onClick={() => setDialog("rotate")} blocked={revoked ? "The credential is revoked — replace it instead" : null} data-testid="rotate-credential">
                  <KeyRound size={14} aria-hidden="true" /> Rotate
                </GatedButton>
                <GatedButton minRole="admin" variant="outline" size="sm" onClick={() => setReplaceOpen(true)} data-testid="replace-credential">
                  Replace…
                </GatedButton>
                <GatedButton minRole="admin" variant="destructive" size="sm" onClick={() => setDialog("revoke")} blocked={revoked ? "Already revoked" : null} data-testid="revoke-credential">
                  Revoke…
                </GatedButton>
              </div>
            </CardContent>
          </Card>

          <Card className="content-card">
            <CardHeader><CardTitle className="text-base">Bridge health</CardTitle></CardHeader>
            <CardContent>
              <ErrorCallout message={healthError} title="Health unavailable" />
              {!healthError && <HealthChecks health={health} />}
            </CardContent>
          </Card>

          <Card className="content-card lg:col-span-2">
            <CardHeader><CardTitle className="text-base">Capabilities</CardTitle></CardHeader>
            <CardContent>
              <CapabilitiesTable capabilities={site.capabilities} />
            </CardContent>
          </Card>

          <Card className="content-card lg:col-span-2">
            <CardHeader><CardTitle className="text-base">Identity</CardTitle></CardHeader>
            <CardContent>
              {site.capabilities ? <IdentityDetails capabilities={site.capabilities} /> : <p className="text-sm text-muted-foreground">No handshake data yet.</p>}
            </CardContent>
          </Card>

          <PolicyCard site={site} />

          <Card className="content-card border-red-500/30">
            <CardHeader><CardTitle className="text-base text-red-500">Danger zone</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">Removing the connection deletes the stored credential. The site itself is not touched.</p>
              <GatedButton minRole="admin" variant="destructive" size="sm" onClick={() => setDialog("delete")} data-testid="delete-site">
                <Trash2 size={14} aria-hidden="true" /> Remove connection…
              </GatedButton>
            </CardContent>
          </Card>
        </div>
      )}

      {site && (
        <>
          <ConfirmDialog
            open={dialog === "enable"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Enable writes on ${site.name}?`}
            description="Approved change sets will be able to modify this site's files."
            confirmText={site.name}
            confirmLabel="Enable writes"
            testId="enable-writes-dialog"
            onConfirm={({ typed }) => run("writes", async () => { await setSiteWrites(site.id, true, typed); await reload(); }, "Writes enabled")}
          />
          <ConfirmDialog
            open={dialog === "disable"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Disable writes on ${site.name}?`}
            description="Nothing will be applied to this site until writes are enabled again."
            confirmText={site.name}
            confirmLabel="Disable writes"
            destructive
            testId="disable-writes-dialog"
            onConfirm={({ typed }) => run("writes", async () => { await setSiteWrites(site.id, false, typed); await reload(); }, "Writes disabled")}
          />
          <ConfirmDialog
            open={dialog === "rotate"}
            onOpenChange={(o) => !o && setDialog(null)}
            title="Rotate the bridge credential?"
            description="The bridge issues a new key; the control plane stores it encrypted. The old key stops working after the grace period."
            confirmLabel="Rotate"
            testId="rotate-dialog"
            onConfirm={doRotate}
          />
          <ConfirmDialog
            open={dialog === "revoke"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Revoke the credential for ${site.name}?`}
            description="The key is revoked on the bridge and writes are disabled. You'll need an operator-issued key (Replace) to reconnect."
            confirmText={site.name}
            confirmLabel="Revoke credential"
            destructive
            testId="revoke-dialog"
            onConfirm={({ typed }) => run("revoke", async () => { await revokeSiteCredential(site.id, typed); await reload(); }, "Credential revoked")}
          />
          <ConfirmDialog
            open={dialog === "delete"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Remove ${site.name}?`}
            description="Change-set history and audit events are kept."
            confirmText={site.name}
            confirmLabel="Remove connection"
            destructive
            testId="delete-site-dialog"
            onConfirm={({ typed }) => run("delete", async () => { await deleteSite(site.id, typed); navigate("/sites"); }, "Connection removed")}
          />
          <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Replace credential</DialogTitle>
                <DialogDescription>Enter an operator-issued key from the bridge's key store. The secret is never shown again.</DialogDescription>
              </DialogHeader>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  doReplace();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="replace-key-id">Key id</Label>
                  <Input id="replace-key-id" value={replace.key_id} onChange={(e) => setReplace((r) => ({ ...r, key_id: e.target.value.trim() }))} autoComplete="off" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="replace-secret">Secret</Label>
                  <Input id="replace-secret" type="password" value={replace.secret} onChange={(e) => setReplace((r) => ({ ...r, secret: e.target.value.trim() }))} autoComplete="new-password" />
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setReplaceOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={busy === "replace" || !replace.key_id || replace.secret.length < 32}>
                    {busy === "replace" && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Replace
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
