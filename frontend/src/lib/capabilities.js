/**
 * Bridge capability helpers (protocol/automation-bridge-v1.md §4).
 * A capability is true only when it is configured on the bridge AND its
 * self-check passed, so the UI gates every action on these flags.
 */
export const SUPPORTED_PROTOCOL_MAJOR = "1";

export const CAPABILITIES = {
  inventory: {
    label: "Inventory",
    help: "Always on when the bridge can read the site's source tree. Check the bridge's code root configuration and its health checks.",
  },
  "content.read": {
    label: "Read content",
    help: "Configure at least one content adapter (e.g. an MDX or JSON collection root) in the bridge config.",
  },
  "content.write": {
    label: "Write content",
    help: "Mark the content root as writable in the bridge config and give the bridge the `write` scope for this credential.",
  },
  "metadata.write": {
    label: "Write metadata",
    help: "Enable the overrides root in the bridge config, then wrap page metadata with the `withAutomationMetadata` helper so overrides take effect.",
  },
  "blocks.write": {
    label: "Write blocks",
    help: "Register editable blocks in the site's block manifest and enable the overrides root.",
  },
  "images.alt.write": {
    label: "Write image alt text",
    help: "Register image blocks in the block manifest and enable the overrides root.",
  },
  "redirects.write": {
    label: "Write redirects",
    help: "Enable the redirects store in the bridge config and read it from next.config / middleware.",
  },
  "files.read": {
    label: "Read files",
    help: "Declare a `code` root with allow-list globs in the bridge config.",
  },
  "files.patch": {
    label: "Patch files",
    help: "Mark the `code` root writable with allow-list globs (e.g. app/**/*.tsx, components/**, styles/**). Deny globs always win.",
  },
  validate: {
    label: "Validation",
    help: "Configure a project profile with validation step commands (format, lint, typecheck, build, test) and give the bridge access to the repository.",
  },
  preview: {
    label: "Preview",
    help: "Configure a preview profile (preview URL and build command) in the bridge config.",
  },
  revalidate: {
    label: "Revalidate",
    help: "Set the site's revalidation endpoint and secret in the bridge config.",
  },
  deploy: {
    label: "Deploy",
    help: "Mount the Docker socket into the sidecar and declare deployment profiles (compose file, project, services, smoke paths).",
  },
  "ops.logs": {
    label: "Container logs",
    help: "Enable log access for the configured services in the bridge config (requires the Docker socket).",
  },
  backups: {
    label: "Backups",
    help: "Give the bridge a writable state directory; set BRIDGE_BACKUP_KEY to encrypt archives.",
  },
};

export const CAPABILITY_ORDER = Object.keys(CAPABILITIES);

export function capabilityMap(site) {
  return site?.capabilities?.capabilities || {};
}

export function hasCapability(site, name) {
  return capabilityMap(site)[name] === true;
}

export function capabilityLabel(name) {
  return CAPABILITIES[name]?.label || name;
}

export function capabilityHelp(name) {
  return CAPABILITIES[name]?.help || "Enable this capability in the bridge configuration and refresh the handshake.";
}

/** Message for a control disabled because a capability is missing, else null. */
export function missingCapabilityReason(site, name) {
  return hasCapability(site, name) ? null : `The site's bridge does not offer "${capabilityLabel(name)}" (${name})`;
}

/** Reason writes are blocked for this site, else null. */
export function writeBlockedReason(site, capability) {
  if (!site) return "Site not loaded";
  if (site.connection?.status === "revoked") return "The site credential is revoked";
  if (capability && !hasCapability(site, capability)) return missingCapabilityReason(site, capability);
  return null;
}

export function protocolSupported(site) {
  const v = site?.capabilities?.protocol_version;
  return v == null || String(v) === SUPPORTED_PROTOCOL_MAJOR;
}

/** Map a bridge operation type to the capability that gates it (§8). */
export const OP_CAPABILITY = {
  "content.upsert": "content.write",
  "content.delete": "content.write",
  "metadata.set": "metadata.write",
  "metadata.clear": "metadata.write",
  "block.set": "blocks.write",
  "block.clear": "blocks.write",
  "image.alt.set": "images.alt.write",
  "image.alt.clear": "images.alt.write",
  "redirect.upsert": "redirects.write",
  "redirect.delete": "redirects.write",
  "file.write": "files.patch",
  "file.delete": "files.patch",
};
