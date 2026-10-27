import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests against the running local stack (`make up && make demo`):
 * the web app (which proxies /api), the API and worker, Postgres, Redis, S3 and SES on the
 * Floci emulator, Mailpit for the mail SES relays, and the provider stubs (models, search,
 * images, speech). `make e2e` starts the stack with SEARCH_PROVIDER=stub so answers and
 * sources are deterministic.
 *
 *   pnpm e2e                               every spec
 *   pnpm e2e e2e/tests/02-chat.spec.ts     one spec
 *   E2E_HEADED=1 pnpm e2e                  watch it
 *
 * Every spec creates its own people through the API, so spec files run in parallel and
 * never see each other's chats; tests inside a file run in order. The admin spec changes
 * one user's quota, never deployment-wide settings.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: ".report", open: "never" }]],
  outputDir: ".results",
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3540",
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    headless: !process.env.E2E_HEADED,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
