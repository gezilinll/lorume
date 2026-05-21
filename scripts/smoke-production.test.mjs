import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("production smoke script", () => {
  it("keeps default smoke checks public and skips protected runtime reads", async () => {
    const requests = [];
    const server = await createSmokeServer((request, response) => {
      requests.push({ authorization: request.headers.authorization, cookie: request.headers.cookie, url: request.url });
      if (request.url === "/healthz" || request.url === "/readyz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.url === "/api/device-collector/install.sh") {
        response.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
        response.end([
          'download "install-device-collector.sh"',
          'download "lorume-device-collector.mjs"',
          'download "lorume-runtime-adapters.mjs"',
          'download "lorume.mjs"',
        ].join("\n"));
        return;
      }
      sendJson(response, 401, { error: "unauthorized" });
    });
    try {
      const result = await runSmoke(server.url);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("smoke:healthz: ok");
      expect(result.stdout).toContain("smoke:readyz: ok");
      expect(result.stdout).toContain("smoke:installer: ok");
      expect(result.stdout).toContain("smoke:authenticated-read: skipped");
      expect(requests.map((request) => request.url)).toEqual([
        "/healthz",
        "/readyz",
        "/api/device-collector/install.sh",
      ]);
    } finally {
      await server.close();
    }
  });

  it("checks protected runtime reads only when smoke auth is provided", async () => {
    const requests = [];
    const server = await createSmokeServer((request, response) => {
      requests.push({ authorization: request.headers.authorization, cookie: request.headers.cookie, url: request.url });
      if (request.url === "/healthz" || request.url === "/readyz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.url === "/api/device-collector/install.sh") {
        response.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
        response.end([
          'download "install-device-collector.sh"',
          'download "lorume-device-collector.mjs"',
          'download "lorume-runtime-adapters.mjs"',
          'download "lorume.mjs"',
        ].join("\n"));
        return;
      }
      if (request.headers.cookie !== "lorume_session=test-session") {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.url === "/api/runtime-fleet") {
        sendJson(response, 200, { devices: [], runtimes: [], agents: [] });
        return;
      }
      if (request.url === "/api/runtime-tasks?limit=1") {
        sendJson(response, 200, { items: [], total: 0 });
        return;
      }
      if (request.url === "/api/devices/fixture-device/collection-health") {
        sendJson(response, 200, { checks: [], deviceId: "fixture-device" });
        return;
      }
      if (request.url === "/api/devices/fixture-device/diagnostics") {
        sendJson(response, 200, { deviceId: "fixture-device", label: "在线", status: "online" });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    });
    try {
      const result = await runSmoke(server.url, {
        LORUME_DEVICE_ID: "fixture-device",
        LORUME_SMOKE_COOKIE: "lorume_session=test-session",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("smoke:runtime fleet: ok");
      expect(result.stdout).toContain("smoke:runtime tasks: ok");
      expect(result.stdout).toContain("smoke:collection health: ok");
      expect(result.stdout).toContain("smoke:diagnostics: ok");
      expect(requests.filter((request) => request.url?.startsWith("/api/runtime")).map((request) => request.cookie)).toEqual([
        "lorume_session=test-session",
        "lorume_session=test-session",
      ]);
    } finally {
      await server.close();
    }
  });
});

function runSmoke(baseUrl, env = {}) {
  const child = spawn(process.execPath, ["scripts/smoke-production.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      LORUME_BASE_URL: baseUrl,
      LORUME_SMOKE_TIMEOUT_MS: "2000",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });
}

function createSmokeServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("smoke server did not expose a TCP address"));
        return;
      }
      resolve({
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
