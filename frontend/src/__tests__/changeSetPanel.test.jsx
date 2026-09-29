import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { baseSite, fail, ok, renderAt, signIn } from "../test-utils";
import { changeSet } from "../test-fixtures";

jest.mock("../lib/api", () => {
  const actual = jest.requireActual("../lib/api");
  return {
    ...actual,
    getChangeSet: jest.fn(),
    getSite: jest.fn(),
    approveChangeSet: jest.fn(),
    rejectChangeSet: jest.fn(),
    applyChangeSet: jest.fn(),
    rollbackChangeSet: jest.fn(),
    createStreamToken: jest.fn(),
    getTask: jest.fn(),
  };
});
const api = require("../lib/api");
const ChangeSetPanel = require("../components/sa/ChangeSetPanel").default;

function setup({ cs = changeSet(), site = baseSite(), role = "deployer" } = {}) {
  signIn(role);
  api.getChangeSet.mockImplementation(() => ok(cs));
  api.getSite.mockImplementation(() => ok(site));
  api.createStreamToken.mockImplementation(() => ok({ token: "st", expires_in: 120 }));
  api.getTask.mockImplementation(() => ok({ status: "running" }));
  return renderAt(<ChangeSetPanel changesetId={cs.id} />);
}

test("renders operations, plan, policy checks and a side-by-side diff", async () => {
  setup();
  await screen.findByTestId("changeset-panel");
  expect(screen.getByTestId("changeset-status")).toHaveTextContent("Pending approval");
  expect(screen.getByTestId("operations")).toHaveTextContent("Set metadata on /");
  expect(screen.getByTestId("impacted-routes")).toHaveTextContent("/");
  expect(screen.getByTestId("policy-checks")).toHaveTextContent("writes_enabled");
  const diff = screen.getByTestId("diff-view");
  expect(diff).toHaveAttribute("data-mode", "split");
  expect(screen.getByTestId("diff-file-path")).toHaveTextContent("overrides/metadata.json");
  const rows = screen.getAllByTestId("diff-split-row");
  const changed = rows.find((r) => r.textContent.includes("Old title"));
  expect(within(changed).getByText(/"title": "Old title"/).closest("td")).toHaveAttribute("data-side", "left");
  expect(changed).toHaveTextContent("New title"); // paired on the same row
  await userEvent.setup().click(screen.getByTestId("diff-mode-unified"));
  expect(screen.getByTestId("diff-view")).toHaveAttribute("data-mode", "unified");
});

test("editors cannot approve (disabled with reason); deployers can", async () => {
  const { unmount } = setup({ role: "editor" });
  await screen.findByTestId("changeset-panel");
  expect(screen.getByTestId("approve-btn")).toBeDisabled();
  expect(screen.getByTestId("approve-btn")).toHaveAttribute("title", "Requires the Deployer role");
  expect(screen.getByTestId("reject-btn")).toBeDisabled();
  unmount();

  const user = userEvent.setup();
  api.approveChangeSet.mockImplementation(() => ok(changeSet({ status: "approved" })));
  setup({ role: "deployer" });
  await screen.findByTestId("changeset-panel");
  expect(screen.getByTestId("approve-btn")).toBeEnabled();
  await user.click(screen.getByTestId("approve-btn"));
  const dialog = await screen.findByTestId("approve-dialog");
  await user.type(within(dialog).getByTestId("approve-dialog-reason"), "LGTM");
  await user.click(within(dialog).getByTestId("approve-dialog-confirm"));
  await waitFor(() => expect(api.approveChangeSet).toHaveBeenCalledWith("cs_1", "LGTM"));
  await waitFor(() => expect(screen.getByTestId("changeset-status")).toHaveTextContent("Approved"));
});

test("a deployer cannot approve their own production change set", async () => {
  setup({ role: "deployer", cs: changeSet({ created_by: "u-deployer" }) });
  await screen.findByTestId("changeset-panel");
  expect(screen.getByTestId("approve-btn")).toBeDisabled();
  expect(screen.getByTestId("approve-btn")).toHaveAttribute("title", "You cannot approve your own change set on production");
});

test("production apply needs the exact site name; the confirm value is sent", async () => {
  const user = userEvent.setup();
  api.applyChangeSet.mockImplementation(() => ok({ task_id: "task-apply" }));
  setup({ cs: changeSet({ status: "approved" }) });
  await screen.findByTestId("changeset-panel");
  await user.click(screen.getByTestId("apply-btn"));
  const dialog = await screen.findByTestId("apply-dialog");
  const confirm = within(dialog).getByTestId("apply-dialog-confirm");
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByTestId("apply-dialog-input"), "Marketing");
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByTestId("apply-dialog-input"), " site");
  expect(confirm).toBeEnabled();
  await user.click(confirm);
  await waitFor(() => expect(api.applyChangeSet).toHaveBeenCalledWith("cs_1", "Marketing site"));
  expect(await screen.findByTestId("task-progress")).toHaveTextContent("Applying change set");
  // Live progress uses a stream token, not the session JWT.
  await waitFor(() => expect(global.FakeEventSource.instances.length).toBe(1));
  expect(global.FakeEventSource.instances[0].url).toContain("/stream/task-apply?token=st");
});

test("apply is blocked with a reason when writes are disabled or a capability is missing", async () => {
  const { unmount } = setup({ cs: changeSet({ status: "approved" }), site: baseSite({ writes_enabled: false }) });
  await screen.findByTestId("changeset-panel");
  expect(screen.getByTestId("apply-btn")).toBeDisabled();
  expect(screen.getByTestId("apply-btn").getAttribute("title")).toMatch(/Writes are not enabled/);
  unmount();

  const site = baseSite();
  site.capabilities.capabilities["metadata.write"] = false;
  setup({ cs: changeSet({ status: "approved" }), site });
  await screen.findByTestId("changeset-panel");
  expect(screen.getByTestId("apply-btn").getAttribute("title")).toMatch(/metadata.write/);
});

test("apply errors are surfaced with code and correlation id", async () => {
  const user = userEvent.setup();
  api.applyChangeSet.mockImplementation(() =>
    fail(409, { code: "CONFLICT_REVISION", message: "Base revision moved", correlation_id: "c_999" })
  );
  setup({ cs: changeSet({ status: "approved" }), site: baseSite({ environment: "staging" }) });
  await screen.findByTestId("changeset-panel");
  await user.click(screen.getByTestId("apply-btn"));
  const dialog = await screen.findByTestId("apply-dialog");
  // Non-production: no typed barrier.
  expect(within(dialog).queryByTestId("apply-dialog-input")).not.toBeInTheDocument();
  await user.click(within(dialog).getByTestId("apply-dialog-confirm"));
  const err = await screen.findByTestId("action-error");
  expect(err).toHaveTextContent("Base revision moved");
  expect(err).toHaveTextContent("CONFLICT_REVISION");
  expect(err).toHaveTextContent("c_999");
  expect(err).toHaveTextContent(/Re-plan/);
  expect(api.applyChangeSet).toHaveBeenCalledWith("cs_1", undefined);
});

test("failed apply (VERIFY_FAILED) explains the automatic restore", async () => {
  setup({
    cs: changeSet({
      status: "apply_failed",
      apply: { error: { code: "VERIFY_FAILED", message: "Route / returned 500", correlation_id: "c_1", details: { revision_id: "r_9" } } },
    }),
  });
  const err = await screen.findByTestId("apply-error");
  expect(err).toHaveTextContent("VERIFY_FAILED");
  expect(err).toHaveTextContent("r_9");
  expect(err).toHaveTextContent(/site is unchanged/);
});

test("applied result shows revision, effective:false warning, and a gated rollback with reason + typed confirmation", async () => {
  const user = userEvent.setup();
  api.rollbackChangeSet.mockImplementation(() => ok({ task_id: "task-rb" }));
  setup({
    cs: changeSet({
      status: "applied",
      apply: {
        revision_id: "r_2",
        applied_by: "deployer@example.com",
        applied_at: "2026-09-28T11:00:00Z",
        result: { operations: [{ index: 0, effective: false }], verification: { hashes_ok: true, routes: [{ route: "/", status: 200 }] } },
        error: null,
      },
    }),
  });
  expect(await screen.findByTestId("apply-revision")).toHaveTextContent("r_2");
  expect(screen.getByTestId("ineffective-warning")).toHaveTextContent("effective: false");
  await user.click(screen.getByTestId("rollback-btn"));
  const dialog = await screen.findByTestId("rollback-dialog");
  const confirm = within(dialog).getByTestId("rollback-dialog-confirm");
  await user.type(within(dialog).getByTestId("rollback-dialog-input"), "Marketing site");
  expect(confirm).toBeDisabled(); // reason required
  await user.type(within(dialog).getByTestId("rollback-dialog-reason"), "Wrong title");
  expect(confirm).toBeEnabled();
  await user.click(confirm);
  await waitFor(() => expect(api.rollbackChangeSet).toHaveBeenCalledWith("cs_1", "Marketing site", "Wrong title"));
});

test("viewers see the rollback control disabled", async () => {
  setup({ role: "viewer", cs: changeSet({ status: "applied", apply: { revision_id: "r_2", result: {}, error: null } }) });
  await screen.findByTestId("changeset-panel");
  expect(screen.getByTestId("rollback-btn")).toBeDisabled();
});
