import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import { setSession } from "./lib/session";

export function signIn(role = "admin", extra = {}) {
  setSession("session-jwt-SECRET", { id: `u-${role}`, email: `${role}@example.com`, role, ...extra });
}

/** Render `ui` at `path` matched by `pattern` inside a MemoryRouter. */
export function renderAt(ui, { path = "/", pattern = "*" } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={ui} />
        <Route path="*" element={<div data-testid="navigated-away" />} />
      </Routes>
      <Toaster />
    </MemoryRouter>
  );
}

export const ok = (data) => Promise.resolve({ data });
export const fail = (status, detail) => {
  const err = new Error(`HTTP ${status}`);
  err.response = { status, data: { detail } };
  return Promise.reject(err);
};

export const baseSite = (over = {}) => ({
  id: "site-1",
  name: "Marketing site",
  base_url: "https://example.com",
  bridge_url: "https://example.com/api/automation-bridge/v1",
  environment: "production",
  site_key: "marketing-site",
  install_mode: "sidecar",
  connection: { status: "connected", key_id: "k_1", last_handshake_at: "2026-09-01T00:00:00Z", last_error: null },
  writes_enabled: true,
  write_verified_at: "2026-09-28T00:00:00Z",
  capabilities: {
    protocol_version: "1",
    agent_version: "1.0.0",
    mode: "sidecar",
    site: { site_id: "marketing-site", environment: "production" },
    nextjs: { version: "15.1.0", router: "app" },
    repository: { available: true, commit: "abc123", branch: "main", dirty: false },
    deployment: { hostname: "web-1", container_id: "abcdef123456", image: "site:latest", profiles: ["web"] },
    writable_roots: [{ id: "content", kind: "content", writable: true }, { id: "overrides", kind: "overrides", writable: true }],
    capabilities: {
      inventory: true,
      "content.read": true,
      "content.write": true,
      "metadata.write": true,
      "blocks.write": true,
      "images.alt.write": true,
      "redirects.write": true,
      "files.read": true,
      "files.patch": false,
      validate: false,
      preview: false,
      revalidate: true,
      deploy: false,
      "ops.logs": false,
      backups: true,
    },
  },
  ...over,
});
