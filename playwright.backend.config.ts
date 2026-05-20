import { defineConfig } from "@playwright/test";

const backendPort = 4184;
const databaseUrl = "postgres://lorume:lorume@127.0.0.1:54329/lorume_backend_e2e";
process.env.LORUME_E2E_DATABASE_URL ??= databaseUrl;
process.env.LORUME_BACKEND_E2E_BASE_URL ??= `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "runtime-backend-api.spec.ts",
  timeout: 30_000,
  workers: 1,
  expect: {
    timeout: 5_000,
  },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${backendPort}`,
  },
  webServer: {
    command: "npm run dev:backend-e2e",
    env: {
      DATABASE_URL: databaseUrl,
      LORUME_BACKEND_E2E_LOGIN_CODE_PATH: ".lorume/backend-e2e/latest-login-code.json",
      LORUME_BACKEND_E2E_PORT: String(backendPort),
      LORUME_E2E_DATABASE_URL: databaseUrl,
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: `http://127.0.0.1:${backendPort}/healthz`,
  },
});
