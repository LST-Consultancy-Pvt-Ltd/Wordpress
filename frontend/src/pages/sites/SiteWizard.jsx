import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import { Check, Loader2, AlertTriangle, Eye, EyeOff, RefreshCw, ShieldCheck, Server, Boxes } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import ErrorCallout from "../../components/sa/ErrorCallout";
import ConfirmDialog from "../../components/sa/ConfirmDialog";
import { CapabilitiesTable, CopyBlock, HealthChecks, IdentityDetails } from "../../components/sa/HandshakeDetails";
import { ConnectionBadge } from "../../components/sa/StatusBadge";
import {
  apiErrorDetails,
  createSite,
  getSiteHealth,
  handshakeSite,
  replaceSiteCredential,
  setSiteWrites,
  updateSite,
  verifySiteWrite,
} from "../../lib/api";
import { SITE_KEY_RE, slugify, validateBaseUrl, validateBridgeUrl } from "../../lib/urlPolicy";
import { protocolSupported } from "../../lib/capabilities";

const STEPS = [
  { id: "mode", label: "Install mode" },
  { id: "endpoint", label: "Endpoint" },
  { id: "credential", label: "Credential" },
  { id: "handshake", label: "Handshake" },
  { id: "writes", label: "Write enablement" },
];

const SIDECAR_SNIPPET = `# docker-compose.yml — add beside your Next.js service
services:
  automation-bridge:
    image: site-autopilot/automation-bridge:1   # see automation-bridge/README.md
    restart: unless-stopped
    environment:
      BRIDGE_BOOTSTRAP_KEY_ID: \${BRIDGE_BOOTSTRAP_KEY_ID}
      BRIDGE_BOOTSTRAP_SECRET: \${BRIDGE_BOOTSTRAP_SECRET}
    volumes:
      - ./:/workspace/site            # repository (roots are declared in the bridge config)
      - bridge-state:/var/lib/automation-bridge
      # optional, enables deploy + container logs:
      # - /var/run/docker.sock:/var/run/docker.sock
volumes:
  bridge-state:`;

const INAPP_ROUTE_SNIPPET = `// app/api/automation-bridge/v1/[...path]/route.ts
// Mounts the bridge inside the site (same protocol, same base path).
export { GET, POST, PUT, DELETE } from "@site-autopilot/automation-bridge/next";`;

const METADATA_SNIPPET = `// app/blog/[slug]/page.tsx — opt a route in to metadata overrides
import { withAutomationMetadata } from "@site-autopilot/automation-bridge/metadata";

export const generateMetadata = withAutomationMetadata("/blog/[slug]", async ({ params }) => ({
  title: "…your existing metadata…",
}));`;

const ENV_SNIPPET = `# bridge environment (never commit real values)
BRIDGE_BOOTSTRAP_KEY_ID=k_example
BRIDGE_BOOTSTRAP_SECRET=<32 random bytes, base64url>`;

function generateSecret() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateKeyId() {
  const bytes = new Uint8Array(6);
  window.crypto.getRandomValues(bytes);
  return `k_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function Stepper({ current }) {
  return (
    <ol className="flex flex-wrap gap-2 mb-6" aria-label="Connection steps">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li
            key={s.id}
            className={`flex items-center gap-2 text-xs rounded-full border px-3 py-1 ${
              active ? "border-primary text-primary" : done ? "border-emerald-500/40 text-emerald-500" : "border-border text-muted-foreground"
            }`}
            aria-current={active ? "step" : undefined}
          >
            <span className="font-mono">{done ? <Check size={12} aria-hidden="true" /> : i + 1}</span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

function FieldError({ id, error }) {
  if (!error) return null;
  return (
    <p id={id} className="text-xs text-red-500" role="alert">
      {error}
    </p>
  );
}

export default function SiteWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const headingRef = useRef(null);

  const [mode, setMode] = useState("sidecar");
  const [form, setForm] = useState({
    name: "",
    base_url: "",
    bridge_url: "",
    environment: "staging",
    site_key: "",
    allow_private_http: false,
  });
  const [keyTouched, setKeyTouched] = useState(false);
  const [bridgeTouched, setBridgeTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [revealSecret, setRevealSecret] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [site, setSite] = useState(null);
  const [health, setHealth] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [replace, setReplace] = useState({ key_id: "", secret: "" });

  const [verify, setVerify] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [enableOpen, setEnableOpen] = useState(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const set = (k) => (e) => {
    const v = e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e;
    setForm((f) => {
      const next = { ...f, [k]: v };
      if (k === "name" && !keyTouched) next.site_key = slugify(v);
      if (k === "base_url" && !bridgeTouched && mode === "in-app") {
        next.bridge_url = v ? `${v.replace(/\/+$/, "")}/api/automation-bridge/v1` : "";
      }
      return next;
    });
  };

  const chooseMode = (m) => {
    setMode(m);
    if (!bridgeTouched) {
      setForm((f) => ({
        ...f,
        bridge_url:
          m === "in-app"
            ? f.base_url
              ? `${f.base_url.replace(/\/+$/, "")}/api/automation-bridge/v1`
              : ""
            : "http://automation-bridge:8787/api/automation-bridge/v1",
        allow_private_http: m === "sidecar" ? f.allow_private_http : false,
      }));
    }
  };

  const errors = useMemo(
    () => ({
      name: form.name.trim() ? null : "Required.",
      base_url: validateBaseUrl(form.base_url.trim()),
      bridge_url: validateBridgeUrl(form.bridge_url.trim(), form.allow_private_http),
      site_key: SITE_KEY_RE.test(form.site_key) ? null : "Lowercase letters, digits and single hyphens.",
    }),
    [form]
  );
  const endpointValid = !Object.values(errors).some(Boolean);
  const credentialValid = /^[A-Za-z0-9_-]{3,64}$/.test(keyId) && secret.length >= 32;

  const next = () => {
    if (step === 1 && !endpointValid) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStep((s) => s + 1);
  };

  const loadHealth = async (id) => {
    try {
      const { data } = await getSiteHealth(id);
      setHealth(data);
    } catch {
      setHealth(null);
    }
  };

  const connect = async () => {
    if (!credentialValid) {
      setShowErrors(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data } = await createSite({
        name: form.name.trim(),
        base_url: form.base_url.trim(),
        bridge_url: form.bridge_url.trim(),
        environment: form.environment,
        site_key: form.site_key,
        install_mode: mode,
        key_id: keyId,
        secret,
        allow_private_http: form.allow_private_http,
      });
      // The secret is stored encrypted server-side and never shown again.
      setSecret("");
      setRevealSecret(false);
      setSite(data);
      setStep(3);
      if (data?.connection?.status !== "unreachable") loadHealth(data.id);
    } catch (e) {
      setSubmitError(apiErrorDetails(e));
    } finally {
      setSubmitting(false);
    }
  };

  const retryHandshake = async () => {
    if (!site) return;
    setRetrying(true);
    try {
      const { data } = await handshakeSite(site.id);
      setSite(data);
      if (data?.connection?.status !== "unreachable") loadHealth(site.id);
    } catch (e) {
      toast.error("Handshake failed", { description: apiErrorDetails(e).message });
    } finally {
      setRetrying(false);
    }
  };

  const saveEndpoint = async () => {
    if (!endpointValid) {
      setShowErrors(true);
      return;
    }
    setRetrying(true);
    try {
      await updateSite(site.id, { base_url: form.base_url.trim(), bridge_url: form.bridge_url.trim(), environment: form.environment });
      const { data } = await handshakeSite(site.id);
      setSite(data);
      if (data?.connection?.status !== "unreachable") loadHealth(site.id);
    } catch (e) {
      toast.error("Could not update the endpoint", { description: apiErrorDetails(e).message });
    } finally {
      setRetrying(false);
    }
  };

  const saveCredential = async () => {
    if (!replace.key_id || replace.secret.length < 32) return;
    setRetrying(true);
    try {
      await replaceSiteCredential(site.id, replace);
      setReplace({ key_id: "", secret: "" });
      const { data } = await handshakeSite(site.id);
      setSite(data);
      if (data?.connection?.status !== "unreachable") loadHealth(site.id);
    } catch (e) {
      toast.error("Could not replace the credential", { description: apiErrorDetails(e).message });
    } finally {
      setRetrying(false);
    }
  };

  const runVerify = async () => {
    setVerifying(true);
    try {
      const { data } = await verifySiteWrite(site.id);
      setVerify(data);
    } catch (e) {
      setVerify({ ok: false, details: apiErrorDetails(e).message });
    } finally {
      setVerifying(false);
    }
  };

  const enableWrites = async ({ typed }) => {
    try {
      const { data } = await setSiteWrites(site.id, true, typed);
      setSite((s) => ({ ...s, ...(data?.id ? data : { writes_enabled: true }) }));
      toast.success("Writes enabled", { description: "Approved change sets can now be applied to this site." });
      navigate(`/sites/${site.id}`);
    } catch (e) {
      toast.error("Could not enable writes", { description: apiErrorDetails(e).message });
      throw e;
    }
  };

  const failed = site?.connection?.status === "unreachable" || site?.connection?.status === "revoked";
  const e = (k) => (showErrors ? errors[k] : null);

  return (
    <div className="page-container max-w-4xl" data-testid="site-wizard">
      <Link to="/sites" className="text-xs text-muted-foreground hover:text-foreground">← All sites</Link>
      <h1 className="page-title mt-1">Connect a Next.js site</h1>
      <p className="page-description">
        The bridge agent runs beside your site and exposes a signed, allow-listed API. New connections are read-only until
        you verify and enable writes.
      </p>
      <Stepper current={step} />

      <Card className="content-card">
        <CardHeader>
          <CardTitle>
            <span ref={headingRef} tabIndex={-1} className="outline-none" data-testid="wizard-step-title">
              {step + 1}. {STEPS[step].label}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {step === 0 && (
            <>
              <RadioGroup value={mode} onValueChange={chooseMode} className="grid md:grid-cols-2 gap-3" aria-label="Install mode">
                {[
                  { v: "sidecar", icon: Boxes, t: "Sidecar agent (recommended)", d: "A separate container on the site's Docker network. Keeps write access out of the public Next.js process and enables deployments." },
                  { v: "in-app", icon: Server, t: "In-app route", d: "An App Router route inside the site, same protocol and base path. No Docker operations." },
                ].map(({ v, icon: Icon, t, d }) => (
                  <Label
                    key={v}
                    htmlFor={`mode-${v}`}
                    className={`flex gap-3 rounded-lg border p-4 cursor-pointer ${mode === v ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <RadioGroupItem id={`mode-${v}`} value={v} className="mt-1" data-testid={`mode-${v}`} />
                    <span>
                      <span className="flex items-center gap-2 font-medium"><Icon size={16} aria-hidden="true" />{t}</span>
                      <span className="block text-xs text-muted-foreground mt-1 font-normal">{d}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              {mode === "sidecar" ? (
                <CopyBlock label="docker-compose service" code={SIDECAR_SNIPPET} testId="snippet-sidecar" />
              ) : (
                <CopyBlock label="App Router route" code={INAPP_ROUTE_SNIPPET} testId="snippet-inapp" />
              )}
              <CopyBlock label="Bridge credential environment" code={ENV_SNIPPET} />
              <CopyBlock label="Opt a route in to metadata overrides" code={METADATA_SNIPPET} />
              <p className="text-xs text-muted-foreground">
                Roots, allow-list globs, content adapters, validation steps and deployment profiles live in the bridge config — see{" "}
                <code>automation-bridge/README.md</code>.
              </p>
            </>
          )}

          {step === 1 && (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="site-name">Site name</Label>
                <Input id="site-name" value={form.name} onChange={set("name")} aria-invalid={!!e("name")} aria-describedby="site-name-err" data-testid="site-name" />
                <FieldError id="site-name-err" error={e("name")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="site-key">Site key</Label>
                <Input id="site-key" value={form.site_key} onChange={(ev) => { setKeyTouched(true); set("site_key")(ev); }} aria-invalid={!!e("site_key")} aria-describedby="site-key-err site-key-help" data-testid="site-key" />
                <p id="site-key-help" className="text-xs text-muted-foreground">Must match the bridge's configured site id.</p>
                <FieldError id="site-key-err" error={e("site_key")} />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="base-url">Public site URL</Label>
                <Input id="base-url" type="url" placeholder="https://example.com" value={form.base_url} onChange={set("base_url")} aria-invalid={!!e("base_url")} aria-describedby="base-url-err" data-testid="base-url" />
                <FieldError id="base-url-err" error={e("base_url")} />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="bridge-url">Bridge URL</Label>
                <Input id="bridge-url" type="url" placeholder="https://example.com/api/automation-bridge/v1" value={form.bridge_url} onChange={(ev) => { setBridgeTouched(true); set("bridge_url")(ev); }} aria-invalid={!!e("bridge_url")} aria-describedby="bridge-url-err" data-testid="bridge-url" />
                <FieldError id="bridge-url-err" error={e("bridge_url")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="environment">Environment</Label>
                <Select value={form.environment} onValueChange={set("environment")}>
                  <SelectTrigger id="environment" data-testid="environment"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="production">Production</SelectItem>
                    <SelectItem value="staging">Staging</SelectItem>
                    <SelectItem value="development">Development</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-3 pt-6">
                  <Switch id="private-http" checked={form.allow_private_http} onCheckedChange={set("allow_private_http")} data-testid="private-http" />
                  <Label htmlFor="private-http">Allow plain HTTP on a private network</Label>
                </div>
              </div>
              {form.allow_private_http && (
                <div className="md:col-span-2 flex gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs" role="alert" data-testid="private-http-warning">
                  <AlertTriangle size={14} className="text-yellow-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    Requests are HMAC-signed but not encrypted. Only use this when the bridge is reachable exclusively on a
                    private Docker network, RFC 1918 or loopback address. Public hosts are always rejected over http://.
                  </span>
                </div>
              )}
              {form.environment === "production" && (
                <p className="md:col-span-2 text-xs text-muted-foreground">
                  Production sites require typing the site name to confirm every apply, deployment, rollback and restore.
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter the credential configured on the bridge (<code>BRIDGE_BOOTSTRAP_KEY_ID</code> /{" "}
                <code>BRIDGE_BOOTSTRAP_SECRET</code>). The secret is sent once, stored encrypted, and never shown again.
              </p>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="key-id">Key id</Label>
                  <Input id="key-id" value={keyId} onChange={(ev) => setKeyId(ev.target.value.trim())} autoComplete="off" aria-invalid={showErrors && !/^[A-Za-z0-9_-]{3,64}$/.test(keyId)} data-testid="key-id" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="secret">Secret</Label>
                  <div className="flex gap-2">
                    <Input
                      id="secret"
                      type={revealSecret ? "text" : "password"}
                      value={secret}
                      onChange={(ev) => setSecret(ev.target.value.trim())}
                      autoComplete="new-password"
                      spellCheck={false}
                      aria-describedby="secret-help"
                      aria-invalid={showErrors && secret.length < 32}
                      data-testid="secret"
                    />
                    <Button type="button" variant="outline" size="icon" onClick={() => setRevealSecret((r) => !r)} aria-label={revealSecret ? "Hide secret" : "Show secret"} aria-pressed={revealSecret}>
                      {revealSecret ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                    </Button>
                  </div>
                  <p id="secret-help" className="text-xs text-muted-foreground">32 random bytes, base64url (43 characters).</p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  const k = keyId || generateKeyId();
                  const s = generateSecret();
                  setKeyId(k);
                  setSecret(s);
                  try {
                    await navigator.clipboard.writeText(`BRIDGE_BOOTSTRAP_KEY_ID=${k}\nBRIDGE_BOOTSTRAP_SECRET=${s}`);
                    toast.success("New credential copied", { description: "Paste it into the bridge environment and restart the bridge before connecting." });
                  } catch {
                    toast.message("Credential generated", { description: "Use Show to copy it into the bridge environment." });
                  }
                }}
              >
                <ShieldCheck size={14} aria-hidden="true" /> Generate a credential for a new bridge
              </Button>
              {showErrors && !credentialValid && (
                <p className="text-xs text-red-500" role="alert">A key id (3–64 characters) and a secret of at least 32 characters are required.</p>
              )}
              {submitError && (
                <ErrorCallout title="Could not create the connection" message={submitError.message} code={submitError.code} correlationId={submitError.correlationId} />
              )}
            </div>
          )}

          {step === 3 && site && (
            <div className="space-y-5" data-testid="handshake-step">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm">Connection:</span>
                <ConnectionBadge status={site.connection?.status} data-testid="handshake-status" />
                <Button variant="outline" size="sm" onClick={retryHandshake} disabled={retrying} data-testid="retry-handshake">
                  <RefreshCw size={14} className={retrying ? "animate-spin" : ""} aria-hidden="true" /> Retry handshake
                </Button>
              </div>
              {failed ? (
                <div className="space-y-4">
                  <ErrorCallout title="Handshake failed" message={site.connection?.last_error || "The bridge could not be reached."} testId="handshake-error">
                    <ul className="list-disc ml-4 text-xs text-muted-foreground mt-1 space-y-0.5">
                      <li>Is the bridge running and reachable from the control plane at the bridge URL?</li>
                      <li>Do the key id and secret match the bridge's key store (and is the bridge clock within 5 minutes)?</li>
                      <li>Does the site key match the bridge's configured site id?</li>
                    </ul>
                  </ErrorCallout>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2 rounded-md border border-border/50 p-3">
                      <p className="text-sm font-medium">Fix the endpoint</p>
                      <Label htmlFor="fix-bridge-url" className="text-xs">Bridge URL</Label>
                      <Input id="fix-bridge-url" value={form.bridge_url} onChange={(ev) => { setBridgeTouched(true); set("bridge_url")(ev); }} />
                      <FieldError id="fix-bridge-err" error={errors.bridge_url} />
                      <Button size="sm" variant="outline" onClick={saveEndpoint} disabled={retrying || !endpointValid}>Save & retry</Button>
                    </div>
                    <div className="space-y-2 rounded-md border border-border/50 p-3">
                      <p className="text-sm font-medium">Replace the credential</p>
                      <Label htmlFor="fix-key-id" className="text-xs">Key id</Label>
                      <Input id="fix-key-id" value={replace.key_id} onChange={(ev) => setReplace((r) => ({ ...r, key_id: ev.target.value.trim() }))} autoComplete="off" />
                      <Label htmlFor="fix-secret" className="text-xs">Secret</Label>
                      <Input id="fix-secret" type="password" value={replace.secret} onChange={(ev) => setReplace((r) => ({ ...r, secret: ev.target.value.trim() }))} autoComplete="new-password" />
                      <Button size="sm" variant="outline" onClick={saveCredential} disabled={retrying || !replace.key_id || replace.secret.length < 32}>Replace & retry</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {!protocolSupported(site) && (
                    <ErrorCallout title="Unsupported bridge protocol" message={`The bridge reports protocol v${site.capabilities?.protocol_version}. Upgrade the bridge agent to protocol v1.`} />
                  )}
                  <section aria-labelledby="hs-caps">
                    <h3 id="hs-caps" className="text-sm font-semibold mb-2">Capabilities</h3>
                    <CapabilitiesTable capabilities={site.capabilities} />
                  </section>
                  <section aria-labelledby="hs-health">
                    <h3 id="hs-health" className="text-sm font-semibold mb-2">Health checks</h3>
                    <HealthChecks health={health} />
                  </section>
                  <IdentityDetails capabilities={site.capabilities} />
                </>
              )}
            </div>
          )}

          {step === 4 && site && (
            <div className="space-y-4" data-testid="writes-step">
              <p className="text-sm text-muted-foreground">
                The connection is <strong>read-only</strong>. Verifying writes plans and applies a no-op probe revision on the
                bridge's overrides root and rolls it back. Enabling writes requires a successful verification in the last 24 hours.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={runVerify} disabled={verifying} data-testid="verify-write">
                  {verifying ? <Loader2 className="animate-spin" size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
                  Verify write access
                </Button>
                <Button onClick={() => setEnableOpen(true)} disabled={!verify?.ok} data-testid="enable-writes">
                  Enable writes…
                </Button>
                <Button variant="ghost" onClick={() => navigate(`/sites/${site.id}`)} data-testid="finish-readonly">
                  Finish read-only
                </Button>
              </div>
              {verify && (
                <div
                  className={`rounded-md border p-3 text-sm ${verify.ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-red-500/40 bg-red-500/10"}`}
                  role="status"
                  data-testid="verify-result"
                >
                  <strong>{verify.ok ? "Write probe succeeded." : "Write probe failed."}</strong>
                  {verify.details && (
                    <pre className="mt-1 text-xs whitespace-pre-wrap">{typeof verify.details === "string" ? verify.details : JSON.stringify(verify.details, null, 2)}</pre>
                  )}
                </div>
              )}
              <ConfirmDialog
                open={enableOpen}
                onOpenChange={setEnableOpen}
                title={`Enable writes on ${site.name}?`}
                description="Approved change sets will be able to modify this site's files. You can disable writes at any time."
                confirmText={site.name}
                confirmLabel="Enable writes"
                onConfirm={enableWrites}
                testId="enable-writes-dialog"
              />
            </div>
          )}

          <div className="flex justify-between pt-2 border-t border-border/30">
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || step >= 3}>
              Back
            </Button>
            {step < 2 && (
              <Button onClick={next} data-testid="wizard-next">Next</Button>
            )}
            {step === 2 && (
              <Button onClick={connect} disabled={submitting} data-testid="wizard-connect">
                {submitting && <Loader2 className="animate-spin" size={14} aria-hidden="true" />} Connect & handshake
              </Button>
            )}
            {step === 3 && (
              <Button onClick={() => setStep(4)} disabled={failed} data-testid="wizard-to-writes">Continue</Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
