const { test, expect } = require("@playwright/test");
const { installMockApi } = require("./mock-api");

const SECRET = "Q".repeat(43);

async function fillWizard(page) {
  await page.goto("/sites");
  await page.getByTestId("connect-site-btn").click();
  await expect(page.getByTestId("site-wizard")).toBeVisible();
  await expect(page.getByTestId("snippet-sidecar")).toContainText("automation-bridge");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("site-name").fill("Docs site");
  await page.getByTestId("base-url").fill("https://docs.example.com");
  await page.getByTestId("bridge-url").fill("https://docs.example.com/api/automation-bridge/v1");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("key-id").fill("k_docs");
  await page.getByTestId("secret").fill(SECRET);
  await expect(page.getByTestId("secret")).toHaveAttribute("type", "password");
  await page.getByTestId("wizard-connect").click();
}

test("admin connects a site, reviews the handshake and enables writes", async ({ page }) => {
  const state = await installMockApi(page, { role: "admin" });
  await fillWizard(page);

  await expect(page.getByTestId("handshake-status")).toHaveText("connected");
  await expect(page.getByTestId("capabilities-table")).toBeVisible();
  await expect(page.getByTestId("cap-row-files.patch")).toHaveAttribute("data-enabled", "false");
  await expect(page.getByTestId("health-checks")).toContainText("site_reachable");
  await expect(page.getByTestId("identity-details")).toContainText("abc1234def");
  // The secret was sent once and is not shown again.
  expect(state.requests.find((r) => r.method === "POST" && r.path === "/sites").body.secret).toBe(SECRET);
  await expect(page.getByText(SECRET)).toHaveCount(0);

  await page.getByTestId("wizard-to-writes").click();
  await expect(page.getByTestId("enable-writes")).toBeDisabled();
  await page.getByTestId("verify-write").click();
  await expect(page.getByTestId("verify-result")).toContainText("succeeded");
  await page.getByTestId("enable-writes").click();
  const dialog = page.getByTestId("enable-writes-dialog");
  await dialog.getByTestId("enable-writes-dialog-input").fill("docs site");
  await expect(dialog.getByTestId("enable-writes-dialog-confirm")).toBeDisabled();
  await dialog.getByTestId("enable-writes-dialog-input").fill("Docs site");
  await dialog.getByTestId("enable-writes-dialog-confirm").click();

  await expect(page.getByTestId("site-detail")).toBeVisible();
  await expect(page.getByTestId("write-state")).toHaveAttribute("data-writes-enabled", "true");
  const writes = state.requests.find((r) => r.path === "/sites/site-new/writes");
  expect(writes.body).toEqual({ enabled: true, confirm: "Docs site" });
});

test("handshake failure is explained and can be recovered", async ({ page }) => {
  await installMockApi(page, { role: "admin", state: { handshakeFails: true } });
  await fillWizard(page);
  await expect(page.getByTestId("handshake-error")).toContainText("AUTH_INVALID");
  await expect(page.getByTestId("wizard-to-writes")).toBeDisabled();
  await page.getByTestId("retry-handshake").click();
  await expect(page.getByTestId("handshake-status")).toHaveText("connected");
  await expect(page.getByTestId("wizard-to-writes")).toBeEnabled();
});

test("non-admins cannot open the wizard and see the connect button disabled", async ({ page }) => {
  await installMockApi(page, { role: "editor" });
  await page.goto("/sites");
  await expect(page.getByTestId("connect-site-btn")).toBeDisabled();
  await expect(page.getByTestId("nav-connect-a-site")).toHaveCount(0);
  await page.goto("/sites/new");
  await expect(page.getByTestId("require-role-denied")).toContainText("Admin role required");
});
