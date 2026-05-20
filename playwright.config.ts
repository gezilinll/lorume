import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "skill-registry-auth.spec.ts",
  timeout: 30_000,
  workers: 1,
  expect: {
    timeout: 5_000,
  },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4175",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev:e2e",
    env: {
      LORUME_BACKEND_PORT: "4174",
      LORUME_E2E_FRONTEND_PORT: "4175",
      DATABASE_URL: "postgres://lorume:lorume@127.0.0.1:54329/lorume_e2e",
      VITE_LORUME_APP_MODE: "agent",
      VITE_LORUME_AUTH_MODE: "agent",
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:4175",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
