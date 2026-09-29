import { screen } from "@testing-library/react";
import { baseSite, fail, ok, renderAt, signIn } from "../test-utils";

jest.mock("../lib/api", () => {
  const actual = jest.requireActual("../lib/api");
  return {
    ...actual,
    getSite: jest.fn(),
    getInventory: jest.fn(),
    getContentCollections: jest.fn(),
    getContentItems: jest.fn(),
    getSiteHealth: jest.fn(),
    getRevisions: jest.fn(),
    getOpsStatus: jest.fn(),
    getDeploymentProfiles: jest.fn(),
    listDeployments: jest.fn(),
    listBackups: jest.fn(),
  };
});
const api = require("../lib/api");
const SiteContent = require("../pages/sites/SiteContent").default;
const SiteCode = require("../pages/sites/SiteCode").default;
const SiteOperations = require("../pages/sites/SiteOperations").default;
const SiteBackups = require("../pages/sites/SiteBackups").default;
const SiteInventory = require("../pages/sites/SiteInventory").default;

function siteWith(flags, over = {}) {
  const s = baseSite(over);
  s.capabilities.capabilities = { ...s.capabilities.capabilities, ...flags };
  return s;
}

beforeEach(() => {
  signIn("admin");
  api.getInventory.mockImplementation((id, kind) =>
    ok(
      kind === "routes"
        ? { items: [{ route: "/", kind: "page", router: "app", metadata: "static", blocks: [], adapter: null, source: { root: "code", path: "app/page.tsx" } }], unsupported: [] }
        : { items: [] }
    )
  );
  api.getContentCollections.mockImplementation(() => ok({ items: [] }));
  api.getContentItems.mockImplementation(() => ok({ items: [] }));
  api.getSiteHealth.mockImplementation(() => ok({ status: "ok", checks: [] }));
  api.getRevisions.mockImplementation(() => ok({ items: [] }));
  api.getOpsStatus.mockImplementation(() => ok({ items: [] }));
  api.getDeploymentProfiles.mockImplementation(() => ok([]));
  api.listDeployments.mockImplementation(() => ok({ items: [] }));
  api.listBackups.mockImplementation(() => ok({ items: [] }));
});

test("metadata editor shows a how-to-enable empty state when metadata.write is off", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({ "metadata.write": false })));
  renderAt(<SiteContent />, { path: "/sites/site-1/content?tab=metadata", pattern: "/sites/:id/content" });
  const notice = await screen.findByTestId("capability-missing-metadata.write");
  expect(notice).toHaveTextContent("withAutomationMetadata");
  expect(notice).toHaveTextContent("refresh the handshake");
});

test("metadata editor warns when the route has not opted in", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({})));
  renderAt(<SiteContent />, { path: "/sites/site-1/content?tab=metadata&route=/", pattern: "/sites/:id/content" });
  expect(await screen.findByTestId("not-opted-in")).toHaveTextContent("METADATA_NOT_OPTED_IN");
  expect(screen.getByTestId("source-of-truth")).toBeInTheDocument();
});

test("content tab shows the empty state when content.read is off", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({ "content.read": false })));
  renderAt(<SiteContent />, { path: "/sites/site-1/content", pattern: "/sites/:id/content" });
  expect(await screen.findByTestId("capability-missing-content.read")).toBeInTheDocument();
});

test("a 422 CAPABILITY_UNSUPPORTED from the API becomes the capability empty state", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({})));
  api.getContentCollections.mockImplementation(() => fail(422, { code: "CAPABILITY_UNSUPPORTED", capability: "content.read", message: "no" }));
  renderAt(<SiteContent />, { path: "/sites/site-1/content", pattern: "/sites/:id/content" });
  expect(await screen.findByTestId("capability-missing-content.read")).toBeInTheDocument();
});

test("code workspace requires files.read; proposing requires files.patch", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({ "files.read": false })));
  const { unmount } = renderAt(<SiteCode />, { path: "/sites/site-1/code", pattern: "/sites/:id/code" });
  expect(await screen.findByTestId("capability-missing-files.read")).toBeInTheDocument();
  unmount();

  api.getSite.mockImplementation(() => ok(siteWith({ "files.read": true, "files.patch": false })));
  renderAt(<SiteCode />, { path: "/sites/site-1/code", pattern: "/sites/:id/code" });
  expect(await screen.findByTestId("capability-missing-files.patch")).toBeInTheDocument();
  expect(screen.getByTestId("propose-code")).toBeDisabled();
});

test("operations: deploy and logs are gated on their capabilities", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({ deploy: false, "ops.logs": false })));
  renderAt(<SiteOperations />, { path: "/sites/site-1/operations", pattern: "/sites/:id/operations" });
  expect(await screen.findByTestId("capability-missing-deploy")).toBeInTheDocument();
  expect(screen.getByTestId("capability-missing-ops.logs")).toBeInTheDocument();
  expect(screen.getByTestId("deploy-btn")).toBeDisabled();
});

test("operations: viewers see deploy disabled even when the capability exists", async () => {
  signIn("viewer");
  api.getSite.mockImplementation(() => ok(siteWith({ deploy: true })));
  api.getDeploymentProfiles.mockImplementation(() => ok([{ name: "web", strategy: "compose-recreate", services: ["web"], smoke_paths: ["/"] }]));
  renderAt(<SiteOperations />, { path: "/sites/site-1/operations", pattern: "/sites/:id/operations" });
  await screen.findByTestId("deploy-profile");
  expect(screen.getByTestId("deploy-btn")).toBeDisabled();
  expect(screen.getByTestId("deploy-btn")).toHaveAttribute("title", "Requires the Deployer role");
});

test("backups page shows the empty state when backups are off", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({ backups: false })));
  renderAt(<SiteBackups />, { path: "/sites/site-1/backups", pattern: "/sites/:id/backups" });
  expect(await screen.findByTestId("capability-missing-backups")).toBeInTheDocument();
});

test("inventory shows read-only state prominently and route opt-in status", async () => {
  api.getSite.mockImplementation(() => ok(siteWith({}, { writes_enabled: false })));
  renderAt(<SiteInventory />, { path: "/sites/site-1/inventory", pattern: "/sites/:id/inventory" });
  expect(await screen.findByTestId("write-state")).toHaveAttribute("data-writes-enabled", "false");
  expect(screen.getByTestId("write-state")).toHaveTextContent("Read-only");
  expect(await screen.findByTestId("routes-table")).toHaveTextContent("not opted in");
});
