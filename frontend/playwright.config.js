// @ts-check
const { defineConfig, devices } = require("@playwright/test");

const PORT = Number(process.env.E2E_PORT || 4173);

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The API is mocked per test with page.route (see e2e/mock-api.js), so only
  // the static build is served. Set E2E_SKIP_BUILD=1 to reuse an existing build/.
  webServer: {
    command: process.env.E2E_SKIP_BUILD ? "node e2e/serve.js" : "npx craco build && node e2e/serve.js",
    env: { PORT: String(PORT), REACT_APP_BACKEND_URL: "http://api.e2e.test", CI: "false" },
    url: `http://127.0.0.1:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
