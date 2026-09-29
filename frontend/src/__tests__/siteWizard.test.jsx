import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { baseSite, ok, renderAt, signIn } from "../test-utils";

jest.mock("../lib/api", () => {
  const actual = jest.requireActual("../lib/api");
  return {
    ...actual,
    createSite: jest.fn(),
    getSiteHealth: jest.fn(),
    handshakeSite: jest.fn(),
    verifySiteWrite: jest.fn(),
    setSiteWrites: jest.fn(),
    updateSite: jest.fn(),
    replaceSiteCredential: jest.fn(),
  };
});
const api = require("../lib/api");
const SiteWizard = require("../pages/sites/SiteWizard").default;

const SECRET = "A".repeat(43);

async function fillToCredential(user, { bridge = "https://example.com/api/automation-bridge/v1" } = {}) {
  await user.click(screen.getByTestId("wizard-next")); // install mode → endpoint
  await user.type(screen.getByTestId("site-name"), "Marketing site");
  await user.type(screen.getByTestId("base-url"), "https://example.com");
  const bridgeInput = screen.getByTestId("bridge-url");
  await user.clear(bridgeInput);
  await user.type(bridgeInput, bridge);
  await user.click(screen.getByTestId("wizard-next"));
  await user.type(screen.getByTestId("key-id"), "k_test1");
  await user.type(screen.getByTestId("secret"), SECRET);
}

beforeEach(() => {
  signIn("admin");
  api.getSiteHealth.mockImplementation(() =>
    ok({ status: "ok", ready: true, checks: [{ name: "state_dir_writable", ok: true }, { name: "site_reachable", ok: true, detail: "200 in 84 ms" }], current_revision: "r_1" })
  );
});

test("happy path: endpoint → credential → handshake → verify → typed-confirm enable", async () => {
  const user = userEvent.setup();
  const site = baseSite({ writes_enabled: false, write_verified_at: null });
  api.createSite.mockImplementation(() => ok(site));
  api.verifySiteWrite.mockImplementation(() => ok({ ok: true, details: "probe applied and rolled back" }));
  api.setSiteWrites.mockImplementation(() => ok({ ...site, writes_enabled: true }));

  renderAt(<SiteWizard />, { path: "/sites/new", pattern: "/sites/new" });
  expect(screen.getByTestId("snippet-sidecar")).toBeInTheDocument();
  await fillToCredential(user);

  // The secret field is masked.
  expect(screen.getByTestId("secret")).toHaveAttribute("type", "password");
  await user.click(screen.getByTestId("wizard-connect"));

  await screen.findByTestId("handshake-step");
  expect(api.createSite).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Marketing site",
      base_url: "https://example.com",
      bridge_url: "https://example.com/api/automation-bridge/v1",
      site_key: "marketing-site",
      install_mode: "sidecar",
      key_id: "k_test1",
      secret: SECRET,
      allow_private_http: false,
    })
  );
  expect(screen.getByTestId("handshake-status")).toHaveTextContent("connected");
  expect(screen.getByTestId("capabilities-table")).toBeInTheDocument();
  expect(screen.getByTestId("cap-row-metadata.write")).toHaveAttribute("data-enabled", "true");
  expect(screen.getByTestId("cap-row-files.patch")).toHaveAttribute("data-enabled", "false");
  expect(await screen.findByTestId("health-checks")).toHaveTextContent("site_reachable");
  expect(screen.getByTestId("writable-roots")).toHaveTextContent("overrides");
  expect(screen.getByTestId("identity-details")).toHaveTextContent("abc123");
  // The secret is never re-shown once submitted.
  expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();

  await user.click(screen.getByTestId("wizard-to-writes"));
  expect(screen.getByTestId("enable-writes")).toBeDisabled(); // must verify first
  await user.click(screen.getByTestId("verify-write"));
  expect(await screen.findByTestId("verify-result")).toHaveTextContent("Write probe succeeded");
  await user.click(screen.getByTestId("enable-writes"));

  const dialog = await screen.findByTestId("enable-writes-dialog");
  const confirm = within(dialog).getByTestId("enable-writes-dialog-confirm");
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByTestId("enable-writes-dialog-input"), "marketing site"); // wrong case
  expect(confirm).toBeDisabled();
  await user.clear(within(dialog).getByTestId("enable-writes-dialog-input"));
  await user.type(within(dialog).getByTestId("enable-writes-dialog-input"), "Marketing site");
  expect(confirm).toBeEnabled();
  await user.click(confirm);
  await waitFor(() => expect(api.setSiteWrites).toHaveBeenCalledWith("site-1", true, "Marketing site"));
});

test("handshake failure shows the error and recovery options, and blocks continuing", async () => {
  const user = userEvent.setup();
  api.createSite.mockImplementation(() =>
    ok(baseSite({ writes_enabled: false, capabilities: null, connection: { status: "unreachable", last_error: "AUTH_INVALID: signature mismatch" } }))
  );
  api.handshakeSite.mockImplementation(() => ok(baseSite({ writes_enabled: false })));

  renderAt(<SiteWizard />, { path: "/sites/new", pattern: "/sites/new" });
  await fillToCredential(user);
  await user.click(screen.getByTestId("wizard-connect"));

  const err = await screen.findByTestId("handshake-error");
  expect(err).toHaveTextContent("AUTH_INVALID: signature mismatch");
  expect(screen.getByTestId("handshake-status")).toHaveTextContent("unreachable");
  expect(screen.getByTestId("wizard-to-writes")).toBeDisabled();
  expect(screen.queryByTestId("capabilities-table")).not.toBeInTheDocument();

  // Retrying after fixing the bridge recovers.
  await user.click(screen.getByTestId("retry-handshake"));
  await waitFor(() => expect(screen.getByTestId("handshake-status")).toHaveTextContent("connected"));
  expect(screen.getByTestId("wizard-to-writes")).toBeEnabled();
});

test("endpoint validation: public http bridge is rejected; private toggle shows a warning", async () => {
  const user = userEvent.setup();
  renderAt(<SiteWizard />, { path: "/sites/new", pattern: "/sites/new" });
  await user.click(screen.getByTestId("wizard-next"));
  await user.type(screen.getByTestId("site-name"), "S");
  await user.type(screen.getByTestId("base-url"), "http://example.com");
  const bridge = screen.getByTestId("bridge-url");
  await user.clear(bridge);
  await user.type(bridge, "http://example.com/api/automation-bridge/v1");
  await user.click(screen.getByTestId("wizard-next"));
  expect(screen.getByText("The public site URL must use https://.")).toBeInTheDocument();
  expect(screen.getByText(/only allowed on a private network/)).toBeInTheDocument();
  await user.click(screen.getByTestId("private-http"));
  expect(screen.getByTestId("private-http-warning")).toBeInTheDocument();
  expect(screen.getByText(/only allowed for Docker service names/)).toBeInTheDocument();
});
