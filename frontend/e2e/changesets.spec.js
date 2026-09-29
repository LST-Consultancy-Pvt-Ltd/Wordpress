const { test, expect } = require("@playwright/test");
const { installMockApi, makeSite, capabilities, makeChangeSet } = require("./mock-api");

test("editor proposes a metadata change set from the editor", async ({ page }) => {
  const state = await installMockApi(page, { role: "editor" });
  await page.goto("/sites/site-1/content?tab=metadata&route=/");
  await expect(page.getByTestId("metadata-editor")).toBeVisible();
  await expect(page.getByTestId("meta-title")).toHaveValue("Old title");
  await page.getByTestId("meta-jsonld").fill('{"name": "missing type"}');
  await expect(page.getByText('Every JSON-LD object needs an "@type".')).toBeVisible();
  await expect(page.getByTestId("save-metadata")).toBeDisabled();
  await page.getByTestId("meta-jsonld").fill('{"@context": "https://schema.org", "@type": "WebSite"}');
  await page.getByTestId("meta-title").fill("New homepage title");
  await page.getByTestId("save-metadata").click();
  await expect(page.getByText("Change set created")).toBeVisible();
  const post = state.requests.find((r) => r.method === "POST" && r.path === "/sites/site-1/changesets");
  expect(post.body.operations).toEqual([
    { op: "metadata.set", route: "/", fields: { title: "New homepage title", jsonLd: [{ "@context": "https://schema.org", "@type": "WebSite" }] } },
  ]);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/changesets\/cs_2$/);
  await expect(page.getByTestId("changeset-status")).toHaveText("Planned");
});

test("preview diff, approve and apply with typed production confirmation and live progress", async ({ page }) => {
  const state = await installMockApi(page, { role: "deployer" });
  await page.goto("/changesets");
  await page.getByTestId("changeset-row").first().getByRole("link").click();
  await expect(page.getByTestId("changeset-status")).toHaveText("Pending approval");

  const diff = page.getByTestId("diff-view");
  await expect(diff).toHaveAttribute("data-mode", "split");
  await expect(diff.locator('[data-side="left"]', { hasText: "Old title" })).toBeVisible();
  await expect(diff.locator('[data-side="right"]', { hasText: "New homepage title" })).toBeVisible();
  await page.getByTestId("diff-mode-unified").click();
  await expect(diff).toHaveAttribute("data-mode", "unified");

  await page.getByTestId("approve-btn").click();
  await page.getByTestId("approve-dialog-reason").fill("Looks right");
  await page.getByTestId("approve-dialog-confirm").click();
  await expect(page.getByTestId("changeset-status")).toHaveText("Approved");
  await expect(page.getByTestId("approvals")).toContainText("Looks right");

  await page.getByTestId("apply-btn").click();
  const confirm = page.getByTestId("apply-dialog-confirm");
  await expect(confirm).toBeDisabled();
  await page.getByTestId("apply-dialog-input").fill("marketing site");
  await expect(confirm).toBeDisabled();
  await page.getByTestId("apply-dialog-input").fill("Marketing site");
  await confirm.click();

  await expect(page.getByTestId("changeset-status")).toHaveText("Applied");
  await expect(page.getByTestId("apply-revision")).toHaveText("r_3");
  const apply = state.requests.find((r) => r.path === "/changesets/cs_1/apply");
  expect(apply.body).toEqual({ confirm: "Marketing site" });
  // The SSE URL carried a stream token, never the session JWT.
  const stream = state.requests.find((r) => r.path.startsWith("/stream/"));
  expect(stream.search).toMatch(/token=st_\d+/);
  expect(stream.search).not.toContain("session-jwt");
  expect(state.streamTokens[0]).toMatchObject({ task_id: "task-apply-cs_1" });
});

test("capability gating: missing capabilities show how-to-enable states and disabled controls", async ({ page }) => {
  const site = makeSite({ capabilities: capabilities({ "metadata.write": false, deploy: false, "files.read": false }) });
  await installMockApi(page, { role: "admin", state: { sites: [site], changesets: [makeChangeSet({ status: "approved" })] } });
  await page.goto("/sites/site-1/content?tab=metadata");
  await expect(page.getByTestId("capability-missing-metadata.write")).toContainText("withAutomationMetadata");
  await page.goto("/sites/site-1/operations");
  await expect(page.getByTestId("capability-missing-deploy")).toBeVisible();
  await expect(page.getByTestId("deploy-btn")).toBeDisabled();
  await page.goto("/sites/site-1/code");
  await expect(page.getByTestId("capability-missing-files.read")).toBeVisible();
  // An approved change set that needs metadata.write cannot be applied.
  await page.goto("/changesets/cs_1");
  await expect(page.getByTestId("apply-btn")).toBeDisabled();
  await expect(page.getByTestId("apply-btn")).toHaveAttribute("title", /metadata\.write/);
});

test("role gating: editors see approve/apply disabled with a reason", async ({ page }) => {
  await installMockApi(page, { role: "editor" });
  await page.goto("/changesets/cs_1");
  await expect(page.getByTestId("approve-btn")).toBeDisabled();
  await expect(page.getByTestId("approve-btn")).toHaveAttribute("title", "Requires the Deployer role");
  await page.getByTestId("approve-btn-gate").hover();
  await expect(page.getByRole("tooltip")).toContainText("Requires the Deployer role");
});

test("error and recovery: a revision conflict on apply is explained, then re-planned", async ({ page }) => {
  const state = await installMockApi(page, {
    role: "deployer",
    state: { conflictOnce: true, changesets: [makeChangeSet({ status: "approved" })] },
  });
  await page.goto("/changesets/cs_1");
  await page.getByTestId("apply-btn").click();
  await page.getByTestId("apply-dialog-input").fill("Marketing site");
  await page.getByTestId("apply-dialog-confirm").click();
  const err = page.getByTestId("action-error");
  await expect(err).toContainText("CONFLICT_REVISION");
  await expect(err).toContainText("c_conflict");
  await expect(err).toContainText("Re-plan");
  // Dialog stays open after a failure; cancel it and re-plan.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("replan-btn").click();
  await expect(page.getByTestId("changeset-status")).toHaveText("Planned");
  expect(state.requests.some((r) => r.path === "/changesets/cs_1/plan")).toBe(true);
});

test("confirmation barrier on rollback requires the site name and a reason", async ({ page }) => {
  const applied = makeChangeSet({
    status: "applied",
    apply: { revision_id: "r_3", applied_by: "deployer@example.com", applied_at: "2026-09-28T11:00:00Z", result: { operations: [{ index: 0, effective: false }], verification: { hashes_ok: true, routes: [] } }, error: null },
  });
  const state = await installMockApi(page, { role: "deployer", state: { changesets: [applied] } });
  await page.goto("/changesets/cs_1");
  await expect(page.getByTestId("ineffective-warning")).toContainText("effective: false");
  await page.getByTestId("rollback-btn").click();
  const confirm = page.getByTestId("rollback-dialog-confirm");
  await page.getByTestId("rollback-dialog-input").fill("Marketing site");
  await expect(confirm).toBeDisabled();
  await page.getByTestId("rollback-dialog-reason").fill("Bad title");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("changeset-status")).toHaveText("Rolled back");
  await expect(page.getByTestId("rollback-info")).toContainText("Bad title");
  expect(state.requests.find((r) => r.path === "/changesets/cs_1/rollback").body).toEqual({ confirm: "Marketing site", reason: "Bad title" });
});

test("audit history shows the requester, approver and applier with correlation ids", async ({ page }) => {
  await installMockApi(page, { role: "deployer" });
  // Drive a full flow, then read the audit log.
  await page.goto("/changesets/cs_1");
  await page.getByTestId("approve-btn").click();
  await page.getByTestId("approve-dialog-confirm").click();
  await expect(page.getByTestId("changeset-status")).toHaveText("Approved");
  await page.getByTestId("apply-btn").click();
  await page.getByTestId("apply-dialog-input").fill("Marketing site");
  await page.getByTestId("apply-dialog-confirm").click();
  await expect(page.getByTestId("changeset-status")).toHaveText("Applied");

  await page.getByTestId("nav-audit").click();
  const rows = page.getByTestId("audit-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("changeset.apply");
  await expect(rows.nth(0)).toContainText("r_3");
  await expect(rows.nth(0)).toContainText("deployer@example.com");
  await expect(rows.nth(1)).toContainText("changeset.approve");
  await expect(rows.nth(0)).toContainText(/corr-\d+/);
  await page.getByTestId("audit-action").fill("changeset.approve");
  await page.getByRole("button", { name: /Filter/ }).click();
  await expect(rows).toHaveCount(1);
});
