import { describe, expect, it } from "vitest";
import deviceStateFixture from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { createDeviceStateSnapshot, type DeviceStateSnapshot } from "../runtime/runtime-model";
import { createTemporaryPostgresDatabase, runMigrationsScript, shouldRunPostgresTests } from "../test/postgres";
import { createPostgresStore } from "./postgres-store";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("Postgres runtime store", () => {
  it("upserts device-state snapshots into current Device Runtime Agent Task tables", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();

        const result = await store.upsertDeviceStateSnapshot(snapshot);

        expect(result).toEqual({
          counts: { agents: 1, devices: 1, runtimes: 1, tasks: 2 },
          deviceId: "fixture-mac",
          snapshotType: "device_state",
        });
        expect(await store.readEntityCounts()).toEqual({
          agentSkillProbeSnapshots: 0,
          agents: 1,
          collectorIngestions: 1,
          devices: 1,
          runtimes: 1,
          tasks: 2,
        });
        await expect(store.listCollectorIngestions("fixture-mac")).resolves.toEqual([
          expect.objectContaining({
            counts: { agents: 1, devices: 1, runtimes: 1, tasks: 2 },
            deviceId: "fixture-mac",
            observedAt: expect.any(Date),
            receivedAt: expect.any(Date),
            snapshotType: "device_state",
            status: "succeeded",
          }),
        ]);
        await expect(store.readDeviceCollectionHealth("fixture-mac")).resolves.toMatchObject({
          checks: [expect.objectContaining({ id: "device_state", message: "采集正常", status: "healthy" })],
          deviceId: "fixture-mac",
          status: "healthy",
          summary: "设备状态采集正常",
        });

        const fleet = await store.readRuntimeFleet();
        expect(fleet.summary).toEqual({ agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 2 });
        expect(fleet.runtimes[0]).not.toHaveProperty("endpoint");
        expect(fleet.runtimes[0]).not.toHaveProperty("capabilities");
        expect(fleet.runtimes[0]).not.toHaveProperty("sourceRefs");
        expect(fleet.agents[0]).not.toHaveProperty("origin");
        expect(fleet.agents[0]).not.toHaveProperty("load");
        expect(fleet.agents[0]).not.toHaveProperty("sourceRefs");

        const tasks = await store.listRuntimeTasks({ channelKind: "dingtalk", status: "in_progress" });
        expect(tasks).toMatchObject({
          items: [expect.objectContaining({
            agentId: "fixture-mac:runtime:openclaw:agent:main",
            id: "fixture-mac:runtime:openclaw:agent:main:task:running-1",
            status: "in_progress",
          })],
          total: 1,
        });
        expect(tasks.items[0]).not.toHaveProperty("runtimeId");
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("keeps current query tables aligned to the latest device-state snapshot for one device", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot(snapshot);
        await store.upsertDeviceStateSnapshot({
          ...snapshot,
          agents: [snapshot.agents[0]],
          runtimes: [snapshot.runtimes[0]],
          tasks: [],
        });

        const fleet = await store.readRuntimeFleet();
        expect(fleet.summary).toEqual({ agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 0 });
        await expect(store.listRuntimeTasks()).resolves.toMatchObject({ items: [], total: 0 });
        await expect(store.readEntityCounts()).resolves.toEqual({
          agentSkillProbeSnapshots: 0,
          agents: 1,
          collectorIngestions: 2,
          devices: 1,
          runtimes: 1,
          tasks: 0,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("persists task type for conversation and scheduled task queries", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot({
          ...snapshot,
          tasks: [
            {
              ...snapshot.tasks[0],
              id: `${snapshot.agents[0].id}:task:conversation-1`,
              raw: { openclaw: { sessionId: "conversation-session", status: "success", statusSource: "session" } },
              status: "done",
              taskType: "conversation",
              title: "Conversation request",
            },
            {
              ...snapshot.tasks[0],
              id: `${snapshot.agents[0].id}:task:scheduled-1`,
              raw: { openclaw: { sessionId: "cron-session", status: "success", statusSource: "session" } },
              source: { kind: "openclaw", externalId: "cron:daily-summary" },
              status: "done",
              taskType: "scheduled",
              title: "Daily summary cron",
            },
          ],
        });

        const scheduled = await store.listRuntimeTasks({ taskType: "scheduled" });
        const conversation = await store.listRuntimeTasks({ taskType: "conversation" });

        expect(scheduled).toMatchObject({
          items: [expect.objectContaining({
            id: `${snapshot.agents[0].id}:task:scheduled-1`,
            raw: expect.objectContaining({
              openclaw: expect.objectContaining({ status: "success", statusSource: "session" }),
            }),
            status: "done",
            taskType: "scheduled",
          })],
          total: 1,
        });
        expect(conversation.items.map((item) => item.taskType)).toEqual(["conversation"]);
        expect(conversation.total).toBe(1);
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("stores latest read-only Agent Skill probe metadata", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = {
          targetAgentId: "fixture-mac:runtime:openclaw:agent:main",
          targetAgentName: "main",
          deviceId: "fixture-mac",
          runtimeId: "fixture-mac:runtime:openclaw",
          runtimeName: "OpenClaw Gateway",
          status: "succeeded" as const,
          observedAt: "2026-05-18T10:00:00.000Z",
          skills: [{
            name: "reviewer",
            rootPath: "/Users/example/.codex/skills/reviewer",
            entryPath: "/Users/example/.codex/skills/reviewer/SKILL.md",
            markdownFiles: [{
              name: "SKILL.md",
              path: "/Users/example/.codex/skills/reviewer/SKILL.md",
              relativePath: "SKILL.md",
            }],
            nonMarkdownFiles: [{
              name: "probe.sh",
              path: "/Users/example/.codex/skills/reviewer/scripts/probe.sh",
              relativePath: "scripts/probe.sh",
            }],
          }],
        };

        await store.upsertAgentSkillProbeSnapshot(snapshot);

        expect(await store.readAgentSkillProbeSnapshot(snapshot.targetAgentId)).toMatchObject({
          skills: [expect.objectContaining({ name: "reviewer" })],
          status: "succeeded",
          targetAgentId: snapshot.targetAgentId,
        });
        await expect(store.readEntityCounts()).resolves.toMatchObject({
          agentSkillProbeSnapshots: 1,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("searches and paginates tasks with stable current-model cursors", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot({
          ...snapshot,
          tasks: [0, 1, 2].map((index) => ({
            ...snapshot.tasks[0],
            id: `${snapshot.tasks[0].id}-${index}`,
            source: { externalId: `task-${index}` },
            title: `Cursor task ${index}`,
            lastSeenAt: `2026-05-21T10:0${index}:00.000Z`,
          })),
        });

        const search = await store.listRuntimeTasks({ search: "Cursor task" });
        const firstPage = await store.listRuntimeTasks({ limit: 2 });
        const secondPage = await store.listRuntimeTasks({ cursor: firstPage.nextCursor, limit: 2 });

        expect(search.total).toBe(3);
        expect(firstPage.items.map((item) => item.title)).toEqual(["Cursor task 2", "Cursor task 1"]);
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        expect(secondPage.items.map((item) => item.title)).toEqual(["Cursor task 0"]);
        expect(secondPage.nextCursor).toBeUndefined();
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });
});

function createFixtureDeviceState(): DeviceStateSnapshot {
  return createDeviceStateSnapshot({
    ...deviceStateFixture,
    device: deviceStateFixture.devices[0],
  });
}
