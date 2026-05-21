import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthSessionContext } from "../auth/auth-store";
import type { OperationJobRow, OperationRow, OperationStore } from "./operation-store";
import { createOperationHttpApiHandler } from "./operation-http-api";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe("operation HTTP API", () => {
  it("lists member-visible operations and returns operation job details", async () => {
    const operation = createOperation({ id: "op_1", organizationId: "org_1", status: "queued" });
    const job = createJob({ id: "opjob_1", operationId: operation.id, organizationId: "org_1" });
    const calls: unknown[] = [];
    const api = await startApi({
      operationStore: {
        listOperations: async (input: Parameters<OperationStore["listOperations"]>[0]) => {
          calls.push(input);
          return [operation];
        },
        readOperation: async ({ operationId }: Parameters<OperationStore["readOperation"]>[0]) => (
          operationId === operation.id ? operation : null
        ),
        listJobs: async ({ operationId }: Parameters<OperationStore["listJobs"]>[0]) => (
          operationId === operation.id ? [job] : []
        ),
      } as unknown as OperationStore,
      session: createSession(),
    });

    const listResponse = await fetch(`${api.url}/api/operations?organizationId=org_1&status=queued&resourceType=device&resourceId=gezilinll-claw`);
    const detailResponse = await fetch(`${api.url}/api/operations/op_1`);
    const forbiddenResponse = await fetch(`${api.url}/api/operations?organizationId=org_2`);

    await expect(listResponse.json()).resolves.toMatchObject({
      operations: [expect.objectContaining({ id: "op_1", status: "queued" })],
    });
    await expect(detailResponse.json()).resolves.toMatchObject({
      jobs: [expect.objectContaining({ id: "opjob_1" })],
      operation: expect.objectContaining({ id: "op_1" }),
    });
    await expect(forbiddenResponse.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(forbiddenResponse.status).toBe(403);
    expect(calls).toEqual([
      expect.objectContaining({
        organizationId: "org_1",
        resourceId: "gezilinll-claw",
        resourceType: "device",
        status: "queued",
      }),
    ]);
  });

  it("treats an empty status filter as no status filter", async () => {
    const operation = createOperation({ id: "op_empty_status", organizationId: "org_1", status: "running" });
    const calls: unknown[] = [];
    const api = await startApi({
      operationStore: {
        listOperations: async (input: Parameters<OperationStore["listOperations"]>[0]) => {
          calls.push(input);
          return [operation];
        },
      } as unknown as OperationStore,
      session: createSession(),
    });

    const response = await fetch(`${api.url}/api/operations?organizationId=org_1&status=`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operations: [expect.objectContaining({ id: "op_empty_status" })],
    });
    expect(calls).toEqual([expect.objectContaining({ organizationId: "org_1", status: undefined })]);
  });
});

function createOperation(overrides: Partial<OperationRow> = {}): OperationRow {
  const now = new Date("2026-05-14T10:00:00.000Z");
  return {
    createdAt: now,
    errorSummary: null,
    finishedAt: null,
    id: "op_default",
    manualInstruction: null,
    metadata: {},
    organizationId: "org_1",
    requestedByUserId: "user_1",
    resourceId: "thread_1",
    resourceType: "notification_thread",
    startedAt: null,
    status: "queued",
    summary: "Deliver notification",
    targetId: null,
    targetType: null,
    type: "notification_delivery",
    updatedAt: now,
    ...overrides,
  };
}

function createJob(overrides: Partial<OperationJobRow> = {}): OperationJobRow {
  const now = new Date("2026-05-14T10:00:00.000Z");
  return {
    attemptCount: 0,
    createdAt: now,
    finishedAt: null,
    id: "opjob_default",
    lastErrorSummary: null,
    lockedBy: null,
    lockedUntil: null,
    maxAttempts: 3,
    operationId: "op_default",
    organizationId: "org_1",
    payload: {},
    runAfter: now,
    startedAt: null,
    status: "queued",
    type: "notification_in_app",
    updatedAt: now,
    ...overrides,
  };
}

function createSession(): AuthSessionContext {
  const now = new Date("2026-05-14T10:00:00.000Z");
  return {
    id: "session_1",
    organizations: [{
      id: "membership_1",
      name: "Lorume Team",
      organizationId: "org_1",
      role: "owner",
      slug: "lorume-team",
    }],
    user: {
      createdAt: now,
      displayName: null,
      email: "owner@example.com",
      id: "user_1",
      updatedAt: now,
    },
  };
}

async function startApi(options: { operationStore: OperationStore; session: AuthSessionContext | null }) {
  const handler = createOperationHttpApiHandler({
    operationStore: options.operationStore,
    requireUserSession: async () => options.session,
  });
  const server = createServer((request, response) => {
    void handler(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const api = {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    url: `http://127.0.0.1:${address.port}`,
  };
  servers.push(api);
  return api;
}
