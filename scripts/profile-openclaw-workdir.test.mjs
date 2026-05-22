import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenClaw workdir profiler", () => {
  it("exports manifest, flattened source tables, and evidence analysis without printing raw message text", async () => {
    const { root, out } = await createFixtureOpenClawWorkdir();

    const result = await runProfiler(root, out);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("openclaw-profiler: ok");
    expect(result.stdout).not.toContain("请查模型调用次数");

    await expect(stat(path.join(out, "manifest", "files.csv"))).resolves.toBeTruthy();
    await expect(stat(path.join(out, "raw-jsonl", "trajectory-runs.jsonl"))).resolves.toBeTruthy();
    await expect(stat(path.join(out, "flattened", "trajectory-runs.csv"))).resolves.toBeTruthy();
    await expect(stat(path.join(out, "analysis", "task-evidence-candidates.csv"))).resolves.toBeTruthy();

    const files = await readCsv(path.join(out, "manifest", "files.csv"));
    expect(files.some((row) => row.relativePath === "misc.bin" && row.sourceClass === "unknown")).toBe(true);
    expect(files.some((row) => row.relativePath.endsWith("abc.trajectory.jsonl") && row.sourceClass === "trajectory_events")).toBe(true);
    expect(files.some((row) => row.relativePath.endsWith("abc.trajectory-path.json") && row.sourceClass === "trajectory_paths")).toBe(true);

    const runs = await readCsv(path.join(out, "flattened", "trajectory-runs.csv"));
    expect(runs).toMatchObject([
      expect.objectContaining({
        runId: "run-1",
        sessionKey: "agent:main:dingtalk:group:cid-1",
        messageId: "msg-1",
        hasMessagesSnapshot: "true",
        hasRuntimeContext: "true",
        assistantTextCount: "1",
      }),
    ]);

    const taskCandidates = await readCsv(path.join(out, "analysis", "task-evidence-candidates.csv"));
    expect(taskCandidates).toMatchObject([
      expect.objectContaining({
        sourceRunId: "run-1",
        agentExternalId: "main",
        taskType: "conversation",
        sourceMessageId: "msg-1",
        channelKind: "dingtalk",
        hasUserMessage: "true",
        userMessageSource: "dingtalk_message_exact",
        hasConversationTitle: "true",
        hasAgentReply: "true",
        admissionRecommendation: "admit",
      }),
    ]);

    const agentCandidates = await readCsv(path.join(out, "analysis", "agent-evidence-candidates.csv"));
    expect(agentCandidates.map((row) => row.agentExternalId)).toEqual(["main"]);

    const summary = JSON.parse(await readFile(path.join(out, "analysis", "source-summary.json"), "utf8"));
    expect(summary.recordCounts.trajectory_runs).toBe(1);
    expect(summary.recordCounts.trajectory_paths).toBe(1);
    expect(summary.unknownFileCount).toBe(1);
  });

  it("refuses to write profiling output inside the OpenClaw root", async () => {
    const { root } = await createFixtureOpenClawWorkdir();

    const result = await runProfiler(root, path.join(root, "profile-output"));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--out must not be inside --root");
  });

  it("handles large log files without spreading parsed rows onto the call stack", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lorume-openclaw-profile-large-log-"));
    const root = path.join(parent, ".openclaw");
    const out = path.join(parent, "profile");
    await mkdir(path.join(root, "logs"), { recursive: true });
    await writeFile(path.join(root, "openclaw.json"), JSON.stringify({ version: "fixture" }));
    await writeFile(
      path.join(root, "logs", "openclaw.log"),
      Array.from({ length: 120_000 }, (_, index) => `line ${index} runId=run-${index % 3}`).join("\n"),
    );

    const result = await runProfiler(root, out);

    expect(result.status).toBe(0);
    const summary = JSON.parse(await readFile(path.join(out, "analysis", "source-summary.json"), "utf8"));
    expect(summary.recordCounts.logs).toBe(1);
    const logs = await readCsv(path.join(out, "flattened", "logs.csv"));
    expect(logs).toMatchObject([
      expect.objectContaining({
        lineCount: "120000",
        runIdCount: "120000",
      }),
    ]);
  }, 20_000);

  it("caps oversized CSV cells while preserving lossless JSONL output", async () => {
    const { root, out } = await createFixtureOpenClawWorkdir();
    const sessionsRoot = path.join(root, "agents", "main", "sessions");
    await writeFile(path.join(sessionsRoot, "huge-error.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-huge",
        sessionKey: "agent:main:dingtalk:group:cid-1",
        ts: "2026-05-23T01:01:00.000Z",
      }),
      JSON.stringify({
        type: "trace.artifacts",
        runId: "run-huge",
        sessionKey: "agent:main:dingtalk:group:cid-1",
        ts: "2026-05-23T01:01:01.000Z",
        data: { finalStatus: "error", error: "x".repeat(10_000) },
      }),
    ].join("\n"));

    const result = await runProfiler(root, out);

    expect(result.status).toBe(0);
    const trajectoryCsv = await readFile(path.join(out, "flattened", "trajectory-runs.csv"), "utf8");
    const trajectoryJsonl = await readFile(path.join(out, "raw-jsonl", "trajectory-runs.jsonl"), "utf8");
    expect(trajectoryCsv).toContain("[truncated:10000]");
    expect(trajectoryJsonl).toContain("x".repeat(10_000));
  });
});

async function createFixtureOpenClawWorkdir() {
  const parent = await mkdtemp(path.join(tmpdir(), "lorume-openclaw-profile-test-"));
  const root = path.join(parent, ".openclaw");
  const out = path.join(parent, "profile");
  const sessionsRoot = path.join(root, "agents", "main", "sessions");
  const dingtalkRoot = path.join(sessionsRoot, "dingtalk-state");
  await mkdir(dingtalkRoot, { recursive: true });

  await writeFile(path.join(root, "openclaw.json"), JSON.stringify({ version: "fixture", agents: [{ id: "main", name: "Main Agent" }] }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "should-not-be-agent" }));
  await writeFile(path.join(root, "agents", "main", "agent.json"), JSON.stringify({ agentId: "main", name: "Main Agent" }));
  await writeFile(path.join(root, "misc.bin"), "unknown");
  await writeFile(path.join(sessionsRoot, "sessions.json"), JSON.stringify({
    sessions: [{
      sessionId: "sess-1",
      sessionKey: "agent:main:dingtalk:group:cid-1",
      status: "active",
      sessionFile: path.join(sessionsRoot, "abc.session.jsonl"),
    }],
  }));
  await writeFile(path.join(sessionsRoot, "abc.session.jsonl"), [
    JSON.stringify({ role: "user", content: "请查模型调用次数", sessionId: "sess-1" }),
    JSON.stringify({ role: "assistant", content: "查询完成", sessionId: "sess-1" }),
  ].join("\n"));
  await writeFile(path.join(sessionsRoot, "abc.trajectory.jsonl"), [
    JSON.stringify({
      type: "session.started",
      runId: "run-1",
      sessionKey: "agent:main:dingtalk:group:cid-1",
      ts: "2026-05-23T01:00:00.000Z",
      data: { sessionFile: path.join(sessionsRoot, "abc.session.jsonl") },
    }),
    JSON.stringify({
      type: "prompt.submitted",
      runId: "run-1",
      sessionKey: "agent:main:dingtalk:group:cid-1",
      ts: "2026-05-23T01:00:01.000Z",
      data: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "请查模型调用次数" },
            { type: "custom_message", content: { "openclaw.runtime-context": { message_id: "msg-1", sender: "张良", sender_id: "user-1", chat_id: "cid-1" } } },
          ],
        }],
      },
    }),
    JSON.stringify({
      type: "model.completed",
      runId: "run-1",
      sessionKey: "agent:main:dingtalk:group:cid-1",
      ts: "2026-05-23T01:00:02.000Z",
      data: {
        messagesSnapshot: [{
          role: "user",
          content: [
            { type: "text", text: "请查模型调用次数" },
            { type: "custom_message", content: { "openclaw.runtime-context": { message_id: "msg-1", sender: "张良", sender_id: "user-1", chat_id: "cid-1" } } },
          ],
        }],
      },
    }),
    JSON.stringify({
      type: "trace.artifacts",
      runId: "run-1",
      sessionKey: "agent:main:dingtalk:group:cid-1",
      ts: "2026-05-23T01:00:03.000Z",
      data: { finalStatus: "success", assistantTexts: ["查询完成"], didSendViaMessagingTool: true },
    }),
    JSON.stringify({
      type: "session.ended",
      runId: "run-1",
      sessionKey: "agent:main:dingtalk:group:cid-1",
      ts: "2026-05-23T01:00:04.000Z",
      data: { status: "success" },
    }),
  ].join("\n"));
  await writeFile(path.join(sessionsRoot, "abc.trajectory-path.json"), JSON.stringify({
    traceSchema: "fixture",
    schemaVersion: 1,
    sessionId: "sess-1",
    runtimeFile: path.join(sessionsRoot, "abc.trajectory.jsonl"),
  }));
  await writeFile(path.join(dingtalkRoot, "messages.context.json"), JSON.stringify({
    version: 1,
    records: {
      "msg-1": { msgId: "msg-1", conversationId: "cid-1", direction: "inbound", text: "请查模型调用次数", senderName: "张良", senderId: "user-1", createdAt: "2026-05-23T01:00:00.500Z" },
    },
  }));
  await writeFile(path.join(dingtalkRoot, "targets.directory.json"), JSON.stringify({
    groups: {
      "cid-1": { conversationId: "cid-1", currentTitle: "日常工作提醒助手", lastSeenAt: "2026-05-23T01:00:00.000Z" },
    },
  }));

  return { out, root };
}

function runProfiler(root, out) {
  const child = spawn(process.execPath, ["scripts/profile-openclaw-workdir.mjs", "--root", root, "--out", out], {
    cwd: process.cwd(),
    env: process.env,
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

async function readCsv(filePath) {
  const text = await readFile(filePath, "utf8");
  const rows = parseCsv(text);
  const [headers, ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ""])));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        value += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((entry) => entry.length > 1 || entry[0]);
}
