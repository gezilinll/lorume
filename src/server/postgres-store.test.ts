import { describe, expect, it } from "vitest";
import deviceStateFixture from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { createPostgresAuthStore } from "../auth/auth-store";
import { createDeviceStateSnapshot, type DeviceStateSnapshot } from "../runtime/runtime-model";
import { createRuntimeTaskBatches } from "../runtime/runtime-task-sync";
import { createTemporaryPostgresDatabase, runDatabaseSchemaScript, shouldRunPostgresTests } from "../test/postgres";
import { createPostgresStore } from "./postgres-store";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("Postgres runtime store", () => {
  it("upserts device-state snapshots into current Device Runtime Agent Task tables", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();

        const result = await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        const batchResult = await store.upsertRuntimeTaskBatch(createFixtureTaskBatch(snapshot));

        expect(result).toEqual({
          counts: { agents: 1, devices: 1, runtimes: 1, tasks: 0 },
          deviceId: "fixture-mac",
          snapshotType: "device_state",
        });
        expect(batchResult).toMatchObject({
          acked: [
            { id: "fixture-mac:runtime:openclaw:agent:main:task:running-1", hash: expect.any(String) },
            { id: "fixture-mac:runtime:openclaw:agent:main:task:todo-1", hash: expect.any(String) },
          ],
          deviceId: "fixture-mac",
        });
        expect(await store.readEntityCounts()).toEqual({
          agentSkillProbeSnapshots: 0,
          agents: 1,
          collectorIngestions: 2,
          devices: 1,
          runtimeSkillProbeSnapshots: 0,
          runtimeScheduleProbeSnapshots: 0,
          runtimes: 1,
          tasks: 2,
        });
        await expect(store.listCollectorIngestions("fixture-mac")).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({
            counts: { agents: 1, devices: 1, runtimes: 1, tasks: 0 },
            deviceId: "fixture-mac",
            collectedAt: expect.any(Date),
            receivedAt: expect.any(Date),
            snapshotType: "device_state",
            status: "succeeded",
          }),
          expect.objectContaining({
            counts: { batches: 1, removedTasks: 0, tasks: 2 },
            deviceId: "fixture-mac",
            snapshotType: "task_batch",
            status: "succeeded",
          }),
        ]));
        await expect(store.readDeviceCollectionHealth("fixture-mac")).resolves.toMatchObject({
          checks: [expect.objectContaining({ id: "device_state", message: "采集正常", status: "healthy" })],
          deviceId: "fixture-mac",
          status: "healthy",
          summary: "设备状态采集正常",
        });

        const fleet = await store.readRuntimeFleet();
        expect(fleet.summary).toEqual({ agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 2 });
        expect(fleet).not.toHaveProperty("tasks");
        expect(fleet.taskSummary.byAgentId["fixture-mac:runtime:openclaw:agent:main"]).toMatchObject({
          in_progress: 1,
          todo: 1,
          total: 2,
        });
        expect(fleet.taskSummary.byRuntimeId["fixture-mac:runtime:openclaw"]).toMatchObject({
          in_progress: 1,
          todo: 1,
          total: 2,
        });
        expect(fleet.taskSummary.byDeviceId["fixture-mac"]).toMatchObject({
          in_progress: 1,
          todo: 1,
          total: 2,
        });
        expect(fleet.taskSummary.lastActiveAtByAgentId?.["fixture-mac:runtime:openclaw:agent:main"]).toBe("2026-05-21T10:00:00.000Z");
        expect(fleet.taskSummary.lastActiveAtByRuntimeId?.["fixture-mac:runtime:openclaw"]).toBe("2026-05-21T10:00:00.000Z");
        expect(fleet.taskSummary.lastActiveAtByDeviceId?.["fixture-mac"]).toBe("2026-05-21T10:00:00.000Z");
        expect(fleet.runtimes[0]).not.toHaveProperty("endpoint");
        expect(fleet.runtimes[0]).not.toHaveProperty("capabilities");
        expect(fleet.runtimes[0]).not.toHaveProperty("sourceRefs");
        expect(fleet.agents[0]).not.toHaveProperty("origin");
        expect(fleet.agents[0]).not.toHaveProperty("load");
        expect(fleet.agents[0]).not.toHaveProperty("sourceRefs");

        const tasks = await store.listRuntimeTasks({ channelKind: "dingtalk", status: "in_progress" });
        expect(tasks).toMatchObject({
          facets: {
            channels: [{ count: 1, kind: "dingtalk", label: "DingTalk" }],
          },
          items: [expect.objectContaining({
            agentId: "fixture-mac:runtime:openclaw:agent:main",
            id: "fixture-mac:runtime:openclaw:agent:main:task:running-1",
            status: "in_progress",
          })],
          summary: {
            byStatus: expect.objectContaining({
              in_progress: 1,
              todo: 1,
              total: 2,
            }),
            total: 2,
          },
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

  it("keeps cancelled Tasks queryable while excluding them from board-visible Runs scope", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        const cancelledTask = {
          ...snapshot.tasks[0],
          id: `${snapshot.agents[0].id}:task:cancelled-1`,
          status: "cancelled" as const,
          updatedAt: "2026-05-21T11:00:00.000Z",
          userMessage: "Cancelled task",
        };
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...snapshot,
          tasks: [...snapshot.tasks, cancelledTask],
        }));

        const allTasks = await store.listRuntimeTasks({ channelKind: "dingtalk" });
        const visibleTasks = await store.listRuntimeTasks({ channelKind: "dingtalk", statusScope: "board-visible" });
        const directCancelled = await store.listRuntimeTasks({ status: "cancelled" });

        expect(allTasks.total).toBe(3);
        expect(allTasks.summary.byStatus).toMatchObject({ cancelled: 1, total: 3 });
        expect(allTasks.facets.channels).toEqual([{ count: 3, kind: "dingtalk", label: "DingTalk" }]);
        expect(visibleTasks.total).toBe(2);
        expect(visibleTasks.summary.byStatus).toMatchObject({ cancelled: 0, total: 2 });
        expect(visibleTasks.facets.channels).toEqual([{ count: 2, kind: "dingtalk", label: "DingTalk" }]);
        expect(directCancelled).toMatchObject({
          items: [expect.objectContaining({ id: cancelledTask.id, status: "cancelled" })],
          total: 1,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("filters Runtime Tasks by multiple selected channels", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        const webChatTask = {
          ...snapshot.tasks[0],
          channel: { kind: "webchat" as const },
          id: `${snapshot.agents[0].id}:task:webchat-1`,
          userMessage: "Web chat task",
        };
        const slockTask = {
          ...snapshot.tasks[0],
          channel: { kind: "slock" as const },
          id: `${snapshot.agents[0].id}:task:slock-1`,
          userMessage: "Slock task",
        };
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...snapshot,
          tasks: [snapshot.tasks[0], webChatTask, slockTask],
        }));

        const selectedChannels = await store.listRuntimeTasks({ channelKinds: ["dingtalk", "webchat"] } as any);

        expect(selectedChannels.items.map((item) => item.id).sort()).toEqual([
          snapshot.tasks[0].id,
          webChatTask.id,
        ].sort());
        expect(selectedChannels.total).toBe(2);
        expect(selectedChannels.facets.channels).toEqual([
          { count: 1, kind: "dingtalk", label: "DingTalk" },
          { count: 1, kind: "slock", label: "Slock" },
          { count: 1, kind: "webchat", label: "Web Chat" },
        ]);
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("keeps metadata aligned without deleting already acknowledged Tasks", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch(snapshot));
        await store.upsertDeviceStateSnapshot({
          ...snapshot,
          agents: [snapshot.agents[0]],
          runtimes: [snapshot.runtimes[0]],
          tasks: [],
        });

        const fleet = await store.readRuntimeFleet();
        expect(fleet.summary).toEqual({ agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 2 });
        await expect(store.listRuntimeTasks()).resolves.toMatchObject({ total: 2 });
        await expect(store.readEntityCounts()).resolves.toEqual({
          agentSkillProbeSnapshots: 0,
          agents: 1,
          collectorIngestions: 3,
          devices: 1,
          runtimeSkillProbeSnapshots: 0,
          runtimeScheduleProbeSnapshots: 0,
          runtimes: 1,
          tasks: 2,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("marks agents omitted from a present runtime snapshot invisible", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        const omittedAgent = {
          ...snapshot.agents[0],
          id: `${snapshot.runtimes[0].id}:agent:omitted`,
          lastSeenAt: "2026-05-22T00:00:00.000Z",
          name: "omitted-agent",
        };

        await store.upsertDeviceStateSnapshot({
          ...snapshot,
          agents: [snapshot.agents[0], omittedAgent],
          tasks: [],
        });
        await store.upsertDeviceStateSnapshot({
          ...snapshot,
          agents: [snapshot.agents[0]],
          collectedAt: "2026-05-22T00:05:00.000Z",
          tasks: [],
        });

        const fleet = await store.readRuntimeFleet();
        expect(fleet.summary).toMatchObject({ agentCount: 2 });
        expect(fleet.agents.find((agent) => agent.id === omittedAgent.id)).toMatchObject({
          collectionStatus: "invisible",
          lastSeenAt: "2026-05-22T00:00:00.000Z",
          name: "omitted-agent",
        });
        expect(fleet.agents.find((agent) => agent.id === snapshot.agents[0].id)).toMatchObject({
          collectionStatus: "online",
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("keeps existing runtime metadata when a later snapshot covers a different adapter", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch(snapshot));
        await store.upsertDeviceStateSnapshot(createSlockMetadataSnapshot(snapshot));

        const fleet = await store.readRuntimeFleet();
        expect(fleet.summary).toEqual({ agentCount: 2, deviceCount: 1, runtimeCount: 2, taskCount: 2 });
        expect(fleet.runtimes.map((runtime) => runtime.kind).sort()).toEqual(["codex", "openclaw"]);
        await expect(store.readEntityCounts()).resolves.toMatchObject({
          agents: 2,
          runtimes: 2,
          tasks: 2,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("soft tombstones removed task ids and restores them when they reappear", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        const removedTaskId = snapshot.tasks[0].id;
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch(snapshot));

        const removalResult = await store.upsertRuntimeTaskBatch({
          schemaVersion: "device-state-v3",
          deviceId: snapshot.device.id,
          collectedAt: "2026-05-22T00:10:00.000Z",
          batchId: "remove-one-task",
          batchIndex: 0,
          batchCount: 1,
          tasks: [],
          removedTaskIds: [removedTaskId],
        });

        expect(removalResult).toMatchObject({
          batchId: "remove-one-task",
          counts: { batches: 1, removedTasks: 1, tasks: 0 },
          removed: [{ id: removedTaskId }],
        });
        await expect(store.listRuntimeTasks()).resolves.toMatchObject({ total: 1 });
        expect((await store.readRuntimeFleet()).summary.taskCount).toBe(1);
        await expect(store.readEntityCounts()).resolves.toMatchObject({ tasks: 2 });

        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...snapshot,
          tasks: [snapshot.tasks[0]],
        }));

        await expect(store.listRuntimeTasks()).resolves.toMatchObject({ total: 2 });
        expect((await store.readRuntimeFleet()).summary.taskCount).toBe(2);
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
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...snapshot,
          tasks: [
            {
              ...snapshot.tasks[0],
              id: `${snapshot.agents[0].id}:task:conversation-1`,
              raw: { openclaw: { sessionId: "conversation-session", status: "success", statusSource: "session" } },
              status: "done",
              taskType: "conversation",
              userMessage: "Conversation request",
            },
            {
              ...snapshot.tasks[0],
              id: `${snapshot.agents[0].id}:task:scheduled-1`,
              raw: { openclaw: { sessionId: "cron-session", status: "success", statusSource: "session" } },
              status: "done",
              taskType: "scheduled",
              userMessage: "Daily summary cron",
            },
          ],
        }));

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
      runDatabaseSchemaScript(database.url);
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

  it("stores latest read-only Runtime Skill probe metadata", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        await store.upsertDeviceStateSnapshot({ ...createFixtureDeviceState(), tasks: [] });
        const snapshot = {
          deviceId: "fixture-mac",
          runtimeId: "fixture-mac:runtime:openclaw",
          runtimeKind: "openclaw",
          status: "succeeded" as const,
          observedAt: "2026-05-27T08:00:00.000Z",
          skills: [{
            name: "weather",
            description: "Weather lookup",
            scope: "runtime" as const,
            available: true,
            builtIn: true,
            agentIds: ["should-not-survive"],
          }, {
            name: "argus-cost-provider-auth-refresh",
            description: "Refresh cost provider auth",
            scope: "agent" as const,
            available: true,
            builtIn: false,
            agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
          }],
        };

        await store.upsertRuntimeSkillProbeSnapshot(snapshot);

        expect(await store.readRuntimeSkillProbeSnapshot(snapshot.runtimeId)).toMatchObject({
          runtimeId: snapshot.runtimeId,
          status: "succeeded",
          summary: {
            total: 2,
            runtimeScopeCount: 1,
            agentScopeCount: 1,
            availableCount: 2,
            unavailableCount: 0,
            builtInCount: 1,
          },
          skills: [
            expect.objectContaining({ name: "argus-cost-provider-auth-refresh", scope: "agent" }),
            expect.objectContaining({ name: "weather", scope: "runtime", agentIds: [] }),
          ],
        });
        await expect(store.readEntityCounts()).resolves.toMatchObject({
          runtimeSkillProbeSnapshots: 1,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("stores Runtime schedule probes and groups scheduled Task execution history", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeScheduleProbeSnapshot({
          deviceId: "fixture-mac",
          runtimeId: "fixture-mac:runtime:openclaw",
          runtimeKind: "openclaw",
          status: "succeeded",
          observedAt: "2026-05-29T08:00:00.000Z",
          schedules: [{
            sourceId: "daily-report",
            name: "Daily report",
            agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
            enabled: true,
            expression: "0 9 * * *",
            timezone: "Asia/Shanghai",
            nextRunAt: "2026-05-30T01:00:00.000Z",
            lastRunAt: "2026-05-29T01:00:00.000Z",
          }],
        });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...snapshot,
          tasks: [{
            ...snapshot.tasks[0],
            id: `${snapshot.agents[0].id}:task:scheduled-daily-report-run-1`,
            raw: {
              openclaw: {
                scheduleId: "daily-report",
                scheduleName: "Daily report",
                sessionKey: "agent:main:cron:daily-report:run:run-1",
                status: "success",
                statusSource: "trajectory",
              },
            } as any,
            status: "done",
            taskType: "scheduled",
            updatedAt: "2026-05-29T01:05:00.000Z",
            userMessage: "[cron:daily-report Daily report] Generate summary",
          }],
        }));

        const groups = await store.listRuntimeScheduledTasks();
        const executions = await store.listRuntimeScheduledTaskExecutions(groups.items[0].scheduleKey);

        expect(groups).toMatchObject({
          items: [{
            agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
            agentNames: ["main"],
            enabled: true,
            executionCount: 1,
            expression: "0 9 * * *",
            latestExecutionAt: "2026-05-29T01:05:00.000Z",
            latestStatus: "done",
            name: "Daily report",
            nextRunAt: "2026-05-30T01:00:00.000Z",
            runtimeId: "fixture-mac:runtime:openclaw",
            runtimeKind: "openclaw",
            runtimeName: "OpenClaw Gateway",
            scheduleKey: "fixture-mac:runtime:openclaw:schedule:daily-report",
            sourceId: "daily-report",
            timezone: "Asia/Shanghai",
          }],
          summary: {
            disabledCount: 0,
            enabledCount: 1,
            total: 1,
          },
          total: 1,
        });
        expect(groups.items[0].summary.byStatus).toMatchObject({ done: 1, total: 1 });
        expect(executions).toMatchObject({
          items: [expect.objectContaining({
            id: `${snapshot.agents[0].id}:task:scheduled-daily-report-run-1`,
            status: "done",
            taskType: "scheduled",
          })],
          total: 1,
        });
        await expect(store.readEntityCounts()).resolves.toMatchObject({
          runtimeScheduleProbeSnapshots: 1,
          tasks: 1,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("keeps Runtime scheduled task groups scoped by organization", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("scheduled-scope@example.com");
        const firstOrganization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Scheduled Org A",
          slug: "scheduled-org-a",
        });
        const secondOrganization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Scheduled Org B",
          slug: "scheduled-org-b",
        });
        const orgA = createFixtureDeviceStateForDeviceId("fixture-mac");
        const orgB = createFixtureDeviceStateForDeviceId("other-mac");
        await store.upsertDeviceStateSnapshot({ ...orgA, tasks: [] }, { organizationId: firstOrganization.id });
        await store.upsertDeviceStateSnapshot({ ...orgB, tasks: [] }, { organizationId: secondOrganization.id });
        await store.upsertRuntimeScheduleProbeSnapshot({
          deviceId: orgA.device.id,
          runtimeId: orgA.runtimes[0].id,
          runtimeKind: "openclaw",
          status: "succeeded",
          observedAt: "2026-05-29T08:00:00.000Z",
          schedules: [{
            sourceId: "daily-report-a",
            name: "Org A daily",
            agentIds: [orgA.agents[0].id],
            enabled: true,
          }],
        });
        await store.upsertRuntimeScheduleProbeSnapshot({
          deviceId: orgB.device.id,
          runtimeId: orgB.runtimes[0].id,
          runtimeKind: "openclaw",
          status: "succeeded",
          observedAt: "2026-05-29T08:00:00.000Z",
          schedules: [{
            sourceId: "daily-report-b",
            name: "Org B daily",
            agentIds: [orgB.agents[0].id],
            enabled: true,
          }],
        });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...orgA,
          tasks: [{
            ...orgA.tasks[0],
            id: `${orgA.agents[0].id}:task:scheduled-daily-report-a-run-1`,
            agentId: orgA.agents[0].id,
            raw: { openclaw: { scheduleId: "daily-report-a", status: "success", statusSource: "trajectory" } } as any,
            status: "done",
            taskType: "scheduled",
            userMessage: "[cron:daily-report-a Org A daily] Generate summary",
          }],
        }), { organizationId: firstOrganization.id });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...orgB,
          tasks: [{
            ...orgB.tasks[0],
            id: `${orgB.agents[0].id}:task:scheduled-daily-report-b-run-1`,
            agentId: orgB.agents[0].id,
            raw: { openclaw: { scheduleId: "daily-report-b", status: "success", statusSource: "trajectory" } } as any,
            status: "done",
            taskType: "scheduled",
            userMessage: "[cron:daily-report-b Org B daily] Generate summary",
          }],
        }), { organizationId: secondOrganization.id });

        const scopedA = await store.listRuntimeScheduledTasks({ organizationId: firstOrganization.id });
        const scopedB = await store.listRuntimeScheduledTasks({ organizationId: secondOrganization.id });
        const all = await store.listRuntimeScheduledTasks();
        const wrongOrgExecutions = await store.listRuntimeScheduledTaskExecutions(scopedA.items[0].scheduleKey, {
          organizationId: secondOrganization.id,
        });

        expect(scopedA.items.map((item) => item.name)).toEqual(["Org A daily"]);
        expect(scopedB.items.map((item) => item.name)).toEqual(["Org B daily"]);
        expect(all.total).toBe(2);
        expect(wrongOrgExecutions.total).toBe(0);
      } finally {
        await store.close();
        await authStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("searches and paginates tasks with stable current-model cursors", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresStore({ connectionString: database.url });
      try {
        const snapshot = createFixtureDeviceState();
        await store.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] });
        await store.upsertRuntimeTaskBatch(createFixtureTaskBatch({
          ...snapshot,
          tasks: [0, 1, 2].map((index) => ({
            ...snapshot.tasks[0],
            id: `${snapshot.tasks[0].id}-${index}`,
            raw: { openclaw: { messageId: `task-${index}` } },
            userMessage: `Cursor task ${index}`,
            updatedAt: `2026-05-21T10:0${index}:00.000Z`,
          })),
        }));

        const search = await store.listRuntimeTasks({ search: "Cursor task" });
        const firstPage = await store.listRuntimeTasks({ limit: 2 });
        const secondPage = await store.listRuntimeTasks({ cursor: firstPage.nextCursor, limit: 2 });

        expect(search.total).toBe(3);
        expect(firstPage.items.map((item) => item.userMessage)).toEqual(["Cursor task 2", "Cursor task 1"]);
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        expect(secondPage.items.map((item) => item.userMessage)).toEqual(["Cursor task 0"]);
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

function createFixtureDeviceStateForDeviceId(deviceId: string): DeviceStateSnapshot {
  const snapshot = createFixtureDeviceState();
  const raw = JSON.parse(JSON.stringify(snapshot).replaceAll(snapshot.device.id, deviceId));
  return createDeviceStateSnapshot({
    ...raw,
    device: {
      ...raw.device,
      hostname: deviceId,
    },
  });
}

function createFixtureTaskBatch(snapshot: DeviceStateSnapshot) {
  const batch = createRuntimeTaskBatches(snapshot.tasks, {
    batchMaxBytes: 1_000_000,
    batchMaxTasks: 1_000,
    collectedAt: snapshot.collectedAt,
    deviceId: snapshot.device.id,
  })[0];
  if (!batch) throw new Error("fixture task batch should not be empty");
  return batch;
}

function createSlockMetadataSnapshot(snapshot: DeviceStateSnapshot): DeviceStateSnapshot {
  return createDeviceStateSnapshot({
    collectedAt: "2026-05-23T14:30:00.000Z",
    device: snapshot.device,
    runtimes: [{
      collectionStatus: "online",
      deviceId: snapshot.device.id,
      id: `${snapshot.device.id}:runtime:codex`,
      kind: "codex",
      lastSeenAt: "2026-05-23T14:30:00.000Z",
      name: "Codex",
    }],
    agents: [{
      collectionStatus: "online",
      id: `${snapshot.device.id}:runtime:codex:agent:slock:agent-local-1`,
      lastSeenAt: "2026-05-23T14:30:00.000Z",
      name: "大卷Bot",
      runtimeId: `${snapshot.device.id}:runtime:codex`,
    }],
    tasks: [],
  });
}
