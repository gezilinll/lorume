#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SOURCE_CLASSES = [
  "root_config",
  "agents",
  "sessions_index",
  "session_records",
  "trajectory_events",
  "trajectory_paths",
  "dingtalk_messages",
  "dingtalk_targets",
  "sqlite_task_runs",
  "delivery_queues",
  "logs",
  "unknown",
];

const ARTIFACTS = {
  manifest: ["files.csv", "source-classes.csv", "parse-errors.csv"],
  "raw-jsonl": [
    "root-config.jsonl",
    "agents.jsonl",
    "sessions-index.jsonl",
    "session-records.jsonl",
    "trajectory-events.jsonl",
    "trajectory-paths.jsonl",
    "trajectory-runs.jsonl",
    "dingtalk-messages.jsonl",
    "dingtalk-targets.jsonl",
    "sqlite-task-runs.jsonl",
    "logs.jsonl",
  ],
  flattened: [
    "root-config.csv",
    "agents.csv",
    "sessions-index.csv",
    "session-records.csv",
    "trajectory-events.csv",
    "trajectory-paths.csv",
    "trajectory-runs.csv",
    "dingtalk-messages.csv",
    "dingtalk-targets.csv",
    "sqlite-task-runs.csv",
    "logs.csv",
  ],
  analysis: [
    "field-dictionary.csv",
    "field-coverage.csv",
    "join-candidates.csv",
    "task-evidence-candidates.csv",
    "agent-evidence-candidates.csv",
    "source-summary.json",
  ],
};

const MAX_CSV_CELL_CHARS = 2000;

const CSV_HEADERS = {
  "manifest/files.csv": ["relativePath", "sizeBytes", "mtimeIso", "extension", "sourceClass", "parseStatus"],
  "manifest/source-classes.csv": ["sourceClass", "fileCount", "totalBytes", "known"],
  "manifest/parse-errors.csv": ["sourceFile", "sourceClass", "sourceLine", "code", "message"],
  "flattened/agents.csv": ["sourceFile", "sourceLine", "agentExternalId", "recordKind"],
  "flattened/root-config.csv": ["sourceFile", "sourceLine", "recordKind"],
  "flattened/sessions-index.csv": ["sourceFile", "sourceLine", "agentExternalId", "recordKind"],
  "flattened/session-records.csv": ["sourceFile", "sourceLine", "agentExternalId", "recordKind"],
  "flattened/trajectory-events.csv": ["sourceFile", "sourceLine", "agentExternalId", "recordKind"],
  "flattened/trajectory-paths.csv": ["sourceFile", "sourceLine", "agentExternalId", "recordKind", "traceSchema", "schemaVersion", "sessionId", "runtimeFile"],
  "flattened/trajectory-runs.csv": [
    "runId",
    "sessionId",
    "sessionKey",
    "agentExternalId",
    "fileAgentExternalId",
    "messageId",
    "conversationId",
    "senderId",
    "senderName",
    "startedAt",
    "endedAt",
    "lastEventAt",
    "finalStatus",
    "endedStatus",
    "didSendViaMessagingTool",
    "hasPromptSubmitted",
    "hasPromptText",
    "hasPromptTruncated",
    "hasMessagesSnapshot",
    "hasRuntimeContext",
    "userMessageCandidateCount",
    "assistantTextCount",
    "toolCallCount",
    "errorText",
  ],
  "flattened/dingtalk-messages.csv": ["sourceFile", "sourceLine", "agentExternalId", "recordKind"],
  "flattened/dingtalk-targets.csv": ["sourceFile", "sourceLine", "agentExternalId", "recordKind"],
  "flattened/sqlite-task-runs.csv": ["sourceFile", "tableName", "rowNumber"],
  "flattened/logs.csv": ["sourceFile", "sourceLine", "recordKind"],
  "analysis/field-dictionary.csv": ["sourceClass", "fieldPath", "recordCount", "nonEmptyCount", "exampleType", "exampleSourceFile"],
  "analysis/field-coverage.csv": ["sourceClass", "fieldPath", "recordCount", "nonEmptyCount", "coveragePercent"],
  "analysis/join-candidates.csv": [
    "leftSource",
    "leftField",
    "rightSource",
    "rightField",
    "leftNonEmpty",
    "rightNonEmpty",
    "matchedCount",
    "leftUniqueCount",
    "rightUniqueCount",
    "matchRate",
    "cardinality",
    "safeForTaskIdentity",
  ],
  "analysis/task-evidence-candidates.csv": [
    "candidateId",
    "agentExternalId",
    "taskType",
    "sourceRunId",
    "sourceSessionId",
    "sourceSessionKey",
    "sourceMessageId",
    "channelKind",
    "conversationId",
    "hasUserMessage",
    "userMessageSource",
    "hasCreator",
    "creatorSource",
    "hasConversationTitle",
    "conversationTitleSource",
    "hasAgentReply",
    "agentReplySource",
    "rawStatus",
    "statusSource",
    "hasError",
    "errorSource",
    "admissionRecommendation",
    "dropReason",
  ],
  "analysis/agent-evidence-candidates.csv": [
    "agentExternalId",
    "sourceFile",
    "hasName",
    "nameSource",
    "hasConfig",
    "hasStatus",
    "sessionCount",
    "trajectoryRunCount",
    "taskCandidateCount",
  ],
};

main().catch((error) => {
  console.error(`openclaw-profiler: ${error.message}`);
  if (process.env.LORUME_OPENCLAW_PROFILE_DEBUG_STACK === "1" && error?.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.out) failUsage("--root and --out are required");
  const root = resolveUserPath(args.root);
  const out = resolveUserPath(args.out);
  await assertRootAndOutput(root, out);
  await createArtifactDirs(out);

  const parseErrors = [];
  const files = await walkFiles(root);
  const manifestRows = files.map((file) => ({
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    mtimeIso: file.mtimeIso,
    extension: file.extension,
    sourceClass: classifySource(file.relativePath),
    parseStatus: "pending",
  }));

  const grouped = groupFilesBySource(manifestRows);
  const parsed = await parseSources(root, manifestRows, parseErrors);
  const trajectoryRuns = buildTrajectoryRuns(parsed.trajectoryEvents, parsed.sessionRecords);
  const taskEvidenceCandidates = buildTaskEvidenceCandidates(trajectoryRuns, parsed.dingtalkMessages, parsed.dingtalkTargets);
  const agentEvidenceCandidates = buildAgentEvidenceCandidates(parsed.agentRows, parsed.sessionsIndex, trajectoryRuns, taskEvidenceCandidates);
  const allSourceRows = {
    agents: parsed.agentRows,
    sessions_index: parsed.sessionsIndex,
    session_records: parsed.sessionRecords,
    trajectory_events: parsed.trajectoryEvents,
    trajectory_paths: parsed.trajectoryPaths,
    trajectory_runs: trajectoryRuns,
    root_config: parsed.rootConfigRows,
    dingtalk_messages: parsed.dingtalkMessages,
    dingtalk_targets: parsed.dingtalkTargets,
    sqlite_task_runs: parsed.sqliteRows,
    logs: parsed.logRows,
  };
  const fieldDictionary = buildFieldDictionary(allSourceRows);
  const fieldCoverage = buildFieldCoverage(fieldDictionary);
  const joinCandidates = buildJoinCandidates(allSourceRows);

  for (const row of manifestRows) {
    row.parseStatus = row.sourceClass === "unknown" || row.sourceClass === "delivery_queues" ? "not_parsed" : "parsed";
  }

  const sourceClassRows = SOURCE_CLASSES.map((sourceClass) => {
    const rows = grouped.get(sourceClass) || [];
    return {
      sourceClass,
      fileCount: rows.length,
      totalBytes: rows.reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0),
      known: sourceClass === "unknown" ? "false" : "true",
    };
  });
  const sourceSummary = {
    root,
    generatedAt: new Date().toISOString(),
    sourceClasses: Object.fromEntries(sourceClassRows.map((row) => [row.sourceClass, {
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      known: row.known === "true",
    }])),
    recordCounts: {
      agents: parsed.agentRows.length,
      sessions_index: parsed.sessionsIndex.length,
      session_records: parsed.sessionRecords.length,
      trajectory_events: parsed.trajectoryEvents.length,
      trajectory_paths: parsed.trajectoryPaths.length,
      trajectory_runs: trajectoryRuns.length,
      root_config: parsed.rootConfigRows.length,
      dingtalk_messages: parsed.dingtalkMessages.length,
      dingtalk_targets: parsed.dingtalkTargets.length,
      sqlite_task_runs: parsed.sqliteRows.length,
      logs: parsed.logRows.length,
      task_evidence_candidates: taskEvidenceCandidates.length,
      agent_evidence_candidates: agentEvidenceCandidates.length,
    },
    parseErrors,
    unknownFileCount: (grouped.get("unknown") || []).length,
    unknownTotalBytes: (grouped.get("unknown") || []).reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0),
  };

  await writeAllArtifacts(out, {
    agentEvidenceCandidates,
    agentRows: parsed.agentRows,
    dingtalkMessages: parsed.dingtalkMessages,
    dingtalkTargets: parsed.dingtalkTargets,
    fieldCoverage,
    fieldDictionary,
    joinCandidates,
    logRows: parsed.logRows,
    manifestRows,
    parseErrors,
    rootConfigRows: parsed.rootConfigRows,
    sessionRecords: parsed.sessionRecords,
    sessionsIndex: parsed.sessionsIndex,
    sourceClassRows,
    sourceSummary,
    sqliteRows: parsed.sqliteRows,
    taskEvidenceCandidates,
    trajectoryEvents: parsed.trajectoryEvents,
    trajectoryPaths: parsed.trajectoryPaths,
    trajectoryRuns,
  });

  console.log(`openclaw-profiler: ok root=${root} out=${out} files=${manifestRows.length} trajectoryRuns=${trajectoryRuns.length}`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root" || arg === "--out") {
      parsed[arg.slice(2)] = args[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (String(value).startsWith("~/")) return path.resolve(os.homedir(), String(value).slice(2));
  return path.resolve(String(value));
}

async function assertRootAndOutput(root, out) {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    failUsage(`--root does not exist: ${root}`);
  }
  if (!rootStat.isDirectory()) failUsage(`--root is not a directory: ${root}`);
  const relative = path.relative(root, out);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    failUsage("--out must not be inside --root");
  }
}

function failUsage(message) {
  console.error(`openclaw-profiler: ${message}`);
  process.exit(2);
}

async function createArtifactDirs(out) {
  for (const dir of Object.keys(ARTIFACTS)) {
    await mkdir(path.join(out, dir), { recursive: true });
  }
}

async function walkFiles(root) {
  const files = [];
  async function walk(absDir) {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(abs);
      const relativePath = normalizePath(path.relative(root, abs));
      files.push({
        abs,
        extension: path.extname(entry.name).toLowerCase(),
        mtimeIso: fileStat.mtime.toISOString(),
        relativePath,
        sizeBytes: fileStat.size,
      });
    }
  }
  await walk(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function classifySource(relativePath) {
  const rel = normalizePath(relativePath);
  const base = path.posix.basename(rel);
  if (rel === "openclaw.json" || (!rel.includes("/") && /\.(json|jsonc)$/i.test(rel))) return "root_config";
  if (/\/sessions\/dingtalk-state\/messages\.context.*\.json$/i.test(rel)) return "dingtalk_messages";
  if (/\/sessions\/dingtalk-state\/targets\.directory.*\.json$/i.test(rel)) return "dingtalk_targets";
  if (/\/sessions\/sessions\.json$/i.test(rel)) return "sessions_index";
  if (/\/sessions\/.*\.trajectory\.jsonl$/i.test(rel)) return "trajectory_events";
  if (/\/sessions\/.*\.trajectory-path\.json$/i.test(rel)) return "trajectory_paths";
  if (/\/sessions\/.*\.jsonl$/i.test(rel)) return "session_records";
  if (/(^|\/)(delivery|queue|delivery-queue|queues?)(\/|\.|$)/i.test(rel)) return "delivery_queues";
  if (/\.log$/i.test(rel) || /(^|\/)logs?\//i.test(rel)) return "logs";
  if (/\.(sqlite|sqlite3|db)$/i.test(rel) && /(^|\/)tasks?(\/|$)/i.test(rel)) return "sqlite_task_runs";
  if (/^agents\/[^/]+\/(?:agent|config|status|settings)\.(json|jsonc)$/i.test(rel)) return "agents";
  if (base === "agent.json" || base === "config.json") return "agents";
  return "unknown";
}

function groupFilesBySource(manifestRows) {
  const grouped = new Map();
  for (const row of manifestRows) {
    if (!grouped.has(row.sourceClass)) grouped.set(row.sourceClass, []);
    grouped.get(row.sourceClass).push(row);
  }
  return grouped;
}

async function parseSources(root, manifestRows, parseErrors) {
  const parsed = {
    agentRows: [],
    dingtalkMessages: [],
    dingtalkTargets: [],
    logRows: [],
    rootConfigRows: [],
    sessionRecords: [],
    sessionsIndex: [],
    sqliteRows: [],
    trajectoryEvents: [],
    trajectoryPaths: [],
  };
  for (const file of manifestRows) {
    const abs = path.join(root, file.relativePath);
    if (file.sourceClass === "root_config") {
      pushRows(parsed.rootConfigRows, await parseJsonRecords(abs, file, parseErrors, "root_config"));
    } else if (file.sourceClass === "agents") {
      pushRows(parsed.agentRows, await parseJsonRecords(abs, file, parseErrors, "agent_config"));
    } else if (file.sourceClass === "sessions_index") {
      pushRows(parsed.sessionsIndex, await parseJsonRecords(abs, file, parseErrors, "session_index"));
    } else if (file.sourceClass === "session_records") {
      pushRows(parsed.sessionRecords, await parseJsonlRecords(abs, file, parseErrors, "session_record"));
    } else if (file.sourceClass === "trajectory_events") {
      pushRows(parsed.trajectoryEvents, await parseJsonlRecords(abs, file, parseErrors, "trajectory_event"));
    } else if (file.sourceClass === "trajectory_paths") {
      pushRows(parsed.trajectoryPaths, await parseJsonRecords(abs, file, parseErrors, "trajectory_path"));
    } else if (file.sourceClass === "dingtalk_messages") {
      pushRows(parsed.dingtalkMessages, await parseJsonRecords(abs, file, parseErrors, "dingtalk_message"));
    } else if (file.sourceClass === "dingtalk_targets") {
      pushRows(parsed.dingtalkTargets, await parseJsonRecords(abs, file, parseErrors, "dingtalk_target"));
    } else if (file.sourceClass === "sqlite_task_runs") {
      pushRows(parsed.sqliteRows, parseSqliteRows(abs, file, parseErrors));
    } else if (file.sourceClass === "logs") {
      pushRows(parsed.logRows, await parseLogRows(abs, file, parseErrors));
    }
  }
  return parsed;
}

function pushRows(target, rows) {
  for (const row of rows) target.push(row);
}

async function parseJsonRecords(abs, file, parseErrors, recordKind) {
  try {
    const data = JSON.parse(await readFile(abs, "utf8"));
    const records = normalizeJsonRecords(data);
    return records.map((record, index) => enrichRecord(record, {
      agentExternalId: agentFromPath(file.relativePath) || record.agentId || record.id || "",
      recordKind,
      sourceFile: file.relativePath,
      sourceLine: index + 1,
    }));
  } catch (error) {
    parseErrors.push(parseError(file, "", "json_parse_failed", error.message));
    return [];
  }
}

async function parseJsonlRecords(abs, file, parseErrors, recordKind) {
  let text = "";
  try {
    text = await readFile(abs, "utf8");
  } catch (error) {
    parseErrors.push(parseError(file, "", "read_failed", error.message));
    return [];
  }
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      rows.push(enrichRecord(record, {
        agentExternalId: agentFromPath(file.relativePath) || record.agentId || record.data?.agentId || "",
        recordKind,
        sourceFile: file.relativePath,
        sourceLine: index + 1,
      }));
    } catch (error) {
      parseErrors.push(parseError(file, index + 1, "jsonl_parse_failed", error.message));
    }
  }
  return rows;
}

async function parseLogRows(abs, file, parseErrors) {
  try {
    const lines = (await readFile(abs, "utf8")).split(/\r?\n/).filter(Boolean);
    let messageIdCount = 0;
    let runIdCount = 0;
    for (const line of lines) {
      const stableIds = extractStableIds(line);
      if (stableIds.messageId) messageIdCount += 1;
      if (stableIds.runId) runIdCount += 1;
    }
    return [{
      lineCount: lines.length,
      messageIdCount,
      recordKind: "log_line",
      sourceFile: file.relativePath,
      sourceLine: "",
      runIdCount,
    }];
  } catch (error) {
    parseErrors.push(parseError(file, "", "log_read_failed", error.message));
    return [];
  }
}

function parseSqliteRows(abs, file, parseErrors) {
  const python = spawnSync("python3", ["-c", `
import json, sqlite3, sys
db = sys.argv[1]
try:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    cur = conn.execute("select name from sqlite_master where type='table' order by name")
    for table, in cur.fetchall():
        rows = conn.execute(f'select * from "{table}"').fetchall()
        cols = [d[0] for d in conn.execute(f'select * from "{table}" limit 0').description]
        for idx, row in enumerate(rows, 1):
            print(json.dumps({"tableName": table, "rowNumber": idx, **dict(zip(cols, row))}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({"__error__": str(error)}, ensure_ascii=False))
    sys.exit(3)
`, abs], { encoding: "utf8" });
  if (python.status !== 0) {
    parseErrors.push(parseError(file, "", "sqlite_parse_failed", python.stderr || python.stdout || "sqlite parse failed"));
    return [];
  }
  return python.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const row = parseJsonMaybe(line);
    if (!row || row.__error__) {
      parseErrors.push(parseError(file, "", "sqlite_parse_failed", row?.__error__ || "sqlite parse failed"));
      return [];
    }
    return [enrichRecord(row, { sourceFile: file.relativePath, sourceLine: "", recordKind: "sqlite_row" })];
  });
}

function normalizeJsonRecords(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.sessions)) return data.sessions;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.targets)) return data.targets;
  if (Array.isArray(data?.records)) return data.records;
  if (data?.records && typeof data.records === "object") {
    return Object.entries(data.records).map(([recordKey, record]) => ({
      recordKey,
      ...(record && typeof record === "object" ? record : { value: record }),
    }));
  }
  const targetRows = [];
  for (const [containerKey, targetKind] of [["groups", "group"], ["directs", "direct"], ["direct", "direct"], ["targets", "target"]]) {
    if (data?.[containerKey] && typeof data[containerKey] === "object" && !Array.isArray(data[containerKey])) {
      for (const [recordKey, record] of Object.entries(data[containerKey])) {
        targetRows.push({
          recordKey,
          targetKind,
          ...(record && typeof record === "object" ? record : { value: record }),
        });
      }
    }
  }
  if (targetRows.length) return targetRows;
  if (data && typeof data === "object") return [data];
  return [];
}

function enrichRecord(record, metadata) {
  return {
    ...metadata,
    ...(record && typeof record === "object" ? record : { value: record }),
  };
}

function parseError(file, sourceLine, code, message) {
  return {
    code,
    message: String(message || "").slice(0, 500),
    sourceClass: file.sourceClass,
    sourceFile: file.relativePath,
    sourceLine,
  };
}

function buildTrajectoryRuns(trajectoryEvents, sessionRecords) {
  const sessionDetailsByFile = new Map();
  for (const record of sessionRecords) {
    const key = normalizePath(record.sourceFile || "");
    const details = sessionDetailsByFile.get(key) || { assistantTextCount: 0, toolCallCount: 0, userMessageCandidateCount: 0 };
    const role = record.role || record.message?.role || record.data?.role;
    if (role === "user" && cleanText(textFromContent(record.content ?? record.message?.content ?? record.data?.content))) details.userMessageCandidateCount += 1;
    if (role === "assistant" && cleanText(textFromContent(record.content ?? record.message?.content ?? record.data?.content))) details.assistantTextCount += 1;
    details.toolCallCount += extractToolCalls(record).length;
    sessionDetailsByFile.set(key, details);
  }

  const runMap = new Map();
  for (const event of trajectoryEvents) {
    const runId = String(event.runId || event.run_id || event.data?.runId || event.data?.run_id || event.sessionId || path.basename(event.sourceFile || "", ".trajectory.jsonl"));
    if (!runId) continue;
    const current = runMap.get(runId) || {
      runId,
      sourceFile: event.sourceFile,
      sessionKey: firstString(event.sessionKey, event.session_key, event.data?.sessionKey, event.data?.session_key),
      agentExternalId: firstString(event.agentExternalId, event.data?.agentId, event.agentId),
      fileAgentExternalId: agentFromPath(event.sourceFile),
      didSendViaMessagingTool: false,
      hasMessagesSnapshot: false,
      hasPromptSubmitted: false,
      hasPromptText: false,
      hasPromptTruncated: false,
      hasRuntimeContext: false,
      assistantTextCount: 0,
      toolCallCount: 0,
      userMessageCandidateCount: 0,
    };
    current.sessionKey ||= firstString(event.sessionKey, event.session_key, event.data?.sessionKey, event.data?.session_key);
    current.agentExternalId ||= firstString(event.data?.agentId, event.agentId);
    current.lastEventAt = latestIso(current.lastEventAt, toIso(event.ts || event.timestamp));
    const runtimeContext = extractRuntimeContext(event);
    applyRuntimeContext(current, runtimeContext);

    if (event.type === "session.started") {
      current.startedAt ||= toIso(event.ts || event.timestamp);
      current.sessionFile = normalizePath(event.data?.sessionFile || event.data?.session_file || current.sessionFile || "");
      current.sessionId ||= firstString(event.sessionId, event.data?.sessionId, event.data?.session_id);
    } else if (event.type === "prompt.submitted") {
      current.hasPromptSubmitted = true;
      current.hasPromptTruncated = Boolean(event.data?.truncated || current.hasPromptTruncated);
      const prompt = cleanText(extractPrompt(event.data));
      if (prompt) current.hasPromptText = true;
      current.userMessageCandidateCount += countUserMessages(event.data?.messages);
    } else if (event.type === "model.completed") {
      const snapshot = event.data?.messagesSnapshot || event.data?.messages_snapshot;
      current.hasMessagesSnapshot = Array.isArray(snapshot) || Boolean(current.hasMessagesSnapshot);
      current.userMessageCandidateCount += countUserMessages(snapshot);
      current.assistantTextCount += Array.isArray(event.data?.assistantTexts) ? event.data.assistantTexts.filter(Boolean).length : 0;
      current.errorText ||= firstString(event.data?.promptErrorSource, event.data?.error);
    } else if (event.type === "trace.artifacts") {
      const data = event.data || {};
      current.finalStatus ||= firstString(data.finalStatus, data.final_status);
      current.didSendViaMessagingTool = Boolean(data.didSendViaMessagingTool || data.did_send_via_messaging_tool || current.didSendViaMessagingTool);
      current.assistantTextCount += Array.isArray(data.assistantTexts) ? data.assistantTexts.filter(Boolean).length : 0;
      current.errorText ||= firstString(data.promptErrorSource, data.error);
    } else if (event.type === "session.ended") {
      current.endedAt ||= toIso(event.ts || event.timestamp);
      current.endedStatus ||= firstString(event.data?.status, event.status);
    }
    current.toolCallCount += extractToolCalls(event).length;
    runMap.set(runId, current);
  }

  for (const run of runMap.values()) {
    const sessionFile = relativizeOpenClawSessionFile(run.sessionFile);
    const sessionDetails = sessionDetailsByFile.get(sessionFile);
    if (sessionDetails) {
      run.userMessageCandidateCount += sessionDetails.userMessageCandidateCount;
      run.assistantTextCount ||= sessionDetails.assistantTextCount;
      run.toolCallCount += sessionDetails.toolCallCount;
    }
    run.agentExternalId ||= openClawAgentIdFromSessionKey(run.sessionKey) || run.fileAgentExternalId;
    run.hasRuntimeContext = Boolean(run.hasRuntimeContext || run.messageId || run.senderId || run.conversationId);
  }
  return Array.from(runMap.values()).sort((left, right) => String(left.runId).localeCompare(String(right.runId)));
}

function buildTaskEvidenceCandidates(runs, dingtalkMessages, dingtalkTargets) {
  const inboundMessages = dingtalkMessages.filter((message) => (message.direction || message.data?.direction) === "inbound");
  const inboundByMessageId = new Map();
  const inboundByConversation = new Map();
  for (const message of inboundMessages) {
    const msgId = firstString(message.msgId, message.messageId, message.message_id, message.id);
    if (msgId) inboundByMessageId.set(msgId, message);
    const conversationId = firstString(message.conversationId, message.chatId, message.chat_id, message.conversation_id);
    if (conversationId) {
      if (!inboundByConversation.has(conversationId)) inboundByConversation.set(conversationId, []);
      inboundByConversation.get(conversationId).push(message);
    }
  }
  const targetByConversationId = new Map(dingtalkTargets.map((target) => [firstString(target.conversationId, target.chatId, target.chat_id), target]).filter(([key]) => key));

  return runs.map((run) => {
    const parsed = parseSessionKey(run.sessionKey);
    const taskType = parsed.taskType || (String(run.sessionKey || "").includes(":cron") ? "scheduled" : "");
    const channelKind = parsed.channelKind || "";
    const exactMessage = run.messageId ? inboundByMessageId.get(run.messageId) : null;
    const conversationMessages = run.conversationId ? inboundByConversation.get(run.conversationId) || [] : [];
    let userMessageSource = "none";
    if (channelKind === "dingtalk" && exactMessage) userMessageSource = "dingtalk_message_exact";
    else if (channelKind === "dingtalk" && run.hasMessagesSnapshot && run.hasRuntimeContext && run.userMessageCandidateCount > 0 && run.messageId && run.conversationId) userMessageSource = "messages_snapshot_run_bound";
    else if (channelKind === "dingtalk" && conversationMessages.length === 1) userMessageSource = "dingtalk_unique_conversation";
    else if (taskType === "scheduled" && run.hasPromptText) userMessageSource = "scheduled_prompt";

    const hasUserMessage = userMessageSource !== "none";
    const hasAgentReply = Number(run.assistantTextCount || 0) > 0;
    const hasError = Boolean(run.errorText);
    const rawStatus = firstString(run.finalStatus, run.endedStatus, run.hasPromptSubmitted ? "running" : "");
    const unsupported = taskType !== "conversation" && taskType !== "scheduled";
    const missingAgent = !run.agentExternalId;
    const dropReason = unsupported
      ? "unsupported_task_type"
      : missingAgent
        ? "missing_agent_link"
        : !hasUserMessage
          ? (channelKind === "dingtalk" && conversationMessages.length > 1 ? "ambiguous_message_join" : "missing_user_message")
          : "";
    const admissionRecommendation = dropReason
      ? "drop"
      : (!hasAgentReply && !hasError && normalizeStatus(rawStatus) === "done")
        ? "admit_with_warning"
        : "admit";
    const target = run.conversationId ? targetByConversationId.get(run.conversationId) : null;
    return {
      admissionRecommendation,
      agentExternalId: run.agentExternalId || "",
      candidateId: run.runId,
      channelKind,
      conversationId: run.conversationId || "",
      conversationTitleSource: target ? "dingtalk_target" : "",
      creatorSource: run.senderId || run.senderName ? "runtime_context" : exactMessage ? "dingtalk_message" : "",
      dropReason,
      errorSource: hasError ? "trajectory" : "",
      hasAgentReply: String(hasAgentReply),
      hasConversationTitle: String(Boolean(target)),
      hasCreator: String(Boolean(run.senderId || run.senderName || exactMessage)),
      hasError: String(hasError),
      hasUserMessage: String(hasUserMessage),
      rawStatus,
      sourceMessageId: run.messageId || "",
      sourceRunId: run.runId,
      sourceSessionId: run.sessionId || "",
      sourceSessionKey: run.sessionKey || "",
      statusSource: rawStatus ? "trajectory" : "",
      taskType,
      userMessageSource,
      agentReplySource: hasAgentReply ? "trajectory" : "",
    };
  });
}

function buildAgentEvidenceCandidates(agentRows, sessionsIndex, runs, taskCandidates) {
  const agentIds = new Set();
  for (const row of agentRows) {
    const id = firstString(row.agentExternalId, row.agentId, row.id, row.name);
    if (id) agentIds.add(id);
  }
  for (const run of runs) {
    if (run.agentExternalId) agentIds.add(run.agentExternalId);
  }
  return Array.from(agentIds).sort().map((agentExternalId) => {
    const config = agentRows.find((row) => firstString(row.agentExternalId, row.agentId, row.id, row.name) === agentExternalId);
    return {
      agentExternalId,
      hasConfig: String(Boolean(config)),
      hasName: String(Boolean(config?.name || config?.id || agentExternalId)),
      hasStatus: String(Boolean(config?.status || config?.state)),
      nameSource: config?.name ? "agent_config" : "agent_id",
      sessionCount: sessionsIndex.filter((row) => openClawAgentIdFromSessionKey(row.sessionKey) === agentExternalId || row.agentExternalId === agentExternalId).length,
      sourceFile: config?.sourceFile || "",
      taskCandidateCount: taskCandidates.filter((candidate) => candidate.agentExternalId === agentExternalId).length,
      trajectoryRunCount: runs.filter((run) => run.agentExternalId === agentExternalId).length,
    };
  });
}

function buildFieldDictionary(sourceRowsByClass) {
  const rows = [];
  for (const [sourceClass, sourceRows] of Object.entries(sourceRowsByClass)) {
    const stats = new Map();
    for (const row of sourceRows) {
      const fieldValues = normalizedFieldValues(row);
      for (const [fieldPath, value] of fieldValues.entries()) {
        if (!stats.has(fieldPath)) {
          stats.set(fieldPath, { exampleSourceFile: "", exampleType: "", nonEmptyCount: 0 });
        }
        const entry = stats.get(fieldPath);
        if (value !== undefined && value !== null && String(value) !== "") {
          entry.nonEmptyCount += 1;
          entry.exampleType ||= Array.isArray(value) ? "array" : typeof value;
          entry.exampleSourceFile ||= row.sourceFile || "";
        }
      }
    }
    for (const [fieldPath, entry] of stats.entries()) {
      rows.push({
        sourceClass,
        fieldPath,
        recordCount: sourceRows.length,
        nonEmptyCount: entry.nonEmptyCount,
        exampleType: entry.exampleType,
        exampleSourceFile: entry.exampleSourceFile,
      });
    }
  }
  return rows.sort((left, right) => `${left.sourceClass}:${left.fieldPath}`.localeCompare(`${right.sourceClass}:${right.fieldPath}`));
}

function normalizedFieldValues(value) {
  const fields = new Map();
  collectNormalizedFieldValues(value, "", fields, 0);
  return fields;
}

function collectNormalizedFieldValues(value, prefix, fields, depth) {
  if (!prefix && (value === null || typeof value !== "object")) return;
  if (depth > 20) {
    fields.set(`${prefix}.__maxDepth`, "truncated");
    return;
  }
  if (value === undefined || value === null || typeof value !== "object") {
    if (prefix && !fields.has(prefix)) fields.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    if (prefix && !fields.has(prefix)) fields.set(prefix, `array:${value.length}`);
    for (const entry of value.slice(0, 20)) {
      collectNormalizedFieldValues(entry, prefix ? `${prefix}.[]` : "[]", fields, depth + 1);
    }
    if (value.length > 20) fields.set(`${prefix}.__truncatedArray`, value.length);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectNormalizedFieldValues(entry, prefix ? `${prefix}.${key}` : key, fields, depth + 1);
  }
}

function buildFieldCoverage(fieldDictionary) {
  return fieldDictionary.map((row) => ({
    sourceClass: row.sourceClass,
    fieldPath: row.fieldPath,
    recordCount: row.recordCount,
    nonEmptyCount: row.nonEmptyCount,
    coveragePercent: row.recordCount ? ((Number(row.nonEmptyCount) / Number(row.recordCount)) * 100).toFixed(2) : "0.00",
  })).sort((left, right) => {
    if (left.sourceClass !== right.sourceClass) return left.sourceClass.localeCompare(right.sourceClass);
    const coverage = Number(right.coveragePercent) - Number(left.coveragePercent);
    return coverage || left.fieldPath.localeCompare(right.fieldPath);
  });
}

function buildJoinCandidates(sourceRowsByClass) {
  const candidateFields = ["agentExternalId", "agentId", "sessionId", "sessionKey", "runId", "messageId", "msgId", "conversationId", "chatId", "senderId", "threadId", "taskId"];
  const sources = Object.entries(sourceRowsByClass).map(([source, rows]) => ({
    source,
    fields: Object.fromEntries(candidateFields.map((field) => [field, collectValues(rows, field)]).filter(([, values]) => values.length)),
  }));
  const candidates = [];
  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const left = sources[leftIndex];
      const right = sources[rightIndex];
      for (const [leftField, leftValues] of Object.entries(left.fields)) {
        for (const [rightField, rightValues] of Object.entries(right.fields)) {
          if (!compatibleJoinFields(leftField, rightField)) continue;
          const analysis = analyzeJoin(leftValues, rightValues);
          candidates.push({
            cardinality: analysis.cardinality,
            leftField,
            leftNonEmpty: leftValues.length,
            leftSource: left.source,
            leftUniqueCount: analysis.leftUniqueCount,
            matchedCount: analysis.matchedCount,
            matchRate: leftValues.length ? (analysis.matchedCount / leftValues.length * 100).toFixed(2) : "0.00",
            rightField,
            rightNonEmpty: rightValues.length,
            rightSource: right.source,
            rightUniqueCount: analysis.rightUniqueCount,
            safeForTaskIdentity: String(isSafeJoin(leftField, rightField, analysis.cardinality)),
          });
        }
      }
    }
  }
  return candidates.sort((left, right) => `${left.leftSource}:${left.leftField}:${left.rightSource}:${left.rightField}`.localeCompare(`${right.leftSource}:${right.leftField}:${right.rightSource}:${right.rightField}`));
}

function collectValues(rows, field) {
  const values = [];
  for (const row of rows) {
    const value = row[field] ?? row.data?.[field] ?? row.message?.[field];
    if (value !== undefined && value !== null && String(value) !== "") values.push(String(value));
  }
  return values;
}

function compatibleJoinFields(left, right) {
  const groups = [
    ["agentExternalId", "agentId"],
    ["sessionId"],
    ["sessionKey"],
    ["runId"],
    ["messageId", "msgId"],
    ["conversationId", "chatId"],
    ["senderId"],
    ["threadId"],
    ["taskId"],
  ];
  return groups.some((group) => group.includes(left) && group.includes(right));
}

function analyzeJoin(leftValues, rightValues) {
  const leftCounts = countByValue(leftValues);
  const rightCounts = countByValue(rightValues);
  const matchedValues = Array.from(leftCounts.keys()).filter((value) => rightCounts.has(value));
  const matchedCount = leftValues.filter((value) => rightCounts.has(value)).length;
  if (!matchedValues.length) return { cardinality: "no_match", leftUniqueCount: leftCounts.size, matchedCount, rightUniqueCount: rightCounts.size };
  const leftMany = matchedValues.some((value) => leftCounts.get(value) > 1);
  const rightMany = matchedValues.some((value) => rightCounts.get(value) > 1);
  const cardinality = leftMany && rightMany ? "many_to_many" : leftMany ? "many_to_one" : rightMany ? "one_to_many" : "one_to_one";
  return { cardinality, leftUniqueCount: leftCounts.size, matchedCount, rightUniqueCount: rightCounts.size };
}

function isSafeJoin(leftField, rightField, cardinality) {
  const messageJoin = compatibleJoinFields(leftField, rightField) && [leftField, rightField].some((field) => field === "messageId" || field === "msgId");
  return messageJoin && (cardinality === "one_to_one" || cardinality === "many_to_one");
}

function countByValue(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

async function writeAllArtifacts(out, data) {
  await writeCsv(path.join(out, "manifest", "files.csv"), data.manifestRows, CSV_HEADERS["manifest/files.csv"]);
  await writeCsv(path.join(out, "manifest", "source-classes.csv"), data.sourceClassRows, CSV_HEADERS["manifest/source-classes.csv"]);
  await writeCsv(path.join(out, "manifest", "parse-errors.csv"), data.parseErrors, CSV_HEADERS["manifest/parse-errors.csv"]);

  await writeJsonl(path.join(out, "raw-jsonl", "root-config.jsonl"), data.rootConfigRows);
  await writeJsonl(path.join(out, "raw-jsonl", "agents.jsonl"), data.agentRows);
  await writeJsonl(path.join(out, "raw-jsonl", "sessions-index.jsonl"), data.sessionsIndex);
  await writeJsonl(path.join(out, "raw-jsonl", "session-records.jsonl"), data.sessionRecords);
  await writeJsonl(path.join(out, "raw-jsonl", "trajectory-events.jsonl"), data.trajectoryEvents);
  await writeJsonl(path.join(out, "raw-jsonl", "trajectory-paths.jsonl"), data.trajectoryPaths);
  await writeJsonl(path.join(out, "raw-jsonl", "trajectory-runs.jsonl"), data.trajectoryRuns);
  await writeJsonl(path.join(out, "raw-jsonl", "dingtalk-messages.jsonl"), data.dingtalkMessages);
  await writeJsonl(path.join(out, "raw-jsonl", "dingtalk-targets.jsonl"), data.dingtalkTargets);
  await writeJsonl(path.join(out, "raw-jsonl", "sqlite-task-runs.jsonl"), data.sqliteRows);
  await writeJsonl(path.join(out, "raw-jsonl", "logs.jsonl"), data.logRows);

  await writeCsv(path.join(out, "flattened", "root-config.csv"), compactRowsForCsv(data.rootConfigRows), CSV_HEADERS["flattened/root-config.csv"]);
  await writeCsv(path.join(out, "flattened", "agents.csv"), compactRowsForCsv(data.agentRows), CSV_HEADERS["flattened/agents.csv"]);
  await writeCsv(path.join(out, "flattened", "sessions-index.csv"), compactRowsForCsv(data.sessionsIndex), CSV_HEADERS["flattened/sessions-index.csv"]);
  await writeCsv(path.join(out, "flattened", "session-records.csv"), compactRowsForCsv(data.sessionRecords), CSV_HEADERS["flattened/session-records.csv"]);
  await writeCsv(path.join(out, "flattened", "trajectory-events.csv"), compactRowsForCsv(data.trajectoryEvents), CSV_HEADERS["flattened/trajectory-events.csv"]);
  await writeCsv(path.join(out, "flattened", "trajectory-paths.csv"), compactRowsForCsv(data.trajectoryPaths), CSV_HEADERS["flattened/trajectory-paths.csv"]);
  await writeCsv(path.join(out, "flattened", "trajectory-runs.csv"), compactTrajectoryRunsForCsv(data.trajectoryRuns), CSV_HEADERS["flattened/trajectory-runs.csv"]);
  await writeCsv(path.join(out, "flattened", "dingtalk-messages.csv"), compactRowsForCsv(data.dingtalkMessages), CSV_HEADERS["flattened/dingtalk-messages.csv"]);
  await writeCsv(path.join(out, "flattened", "dingtalk-targets.csv"), compactRowsForCsv(data.dingtalkTargets), CSV_HEADERS["flattened/dingtalk-targets.csv"]);
  await writeCsv(path.join(out, "flattened", "sqlite-task-runs.csv"), compactRowsForCsv(data.sqliteRows), CSV_HEADERS["flattened/sqlite-task-runs.csv"]);
  await writeCsv(path.join(out, "flattened", "logs.csv"), compactRowsForCsv(data.logRows), CSV_HEADERS["flattened/logs.csv"]);

  await writeCsv(path.join(out, "analysis", "field-dictionary.csv"), data.fieldDictionary, CSV_HEADERS["analysis/field-dictionary.csv"]);
  await writeCsv(path.join(out, "analysis", "field-coverage.csv"), data.fieldCoverage, CSV_HEADERS["analysis/field-coverage.csv"]);
  await writeCsv(path.join(out, "analysis", "join-candidates.csv"), data.joinCandidates, CSV_HEADERS["analysis/join-candidates.csv"]);
  await writeCsv(path.join(out, "analysis", "task-evidence-candidates.csv"), data.taskEvidenceCandidates, CSV_HEADERS["analysis/task-evidence-candidates.csv"]);
  await writeCsv(path.join(out, "analysis", "agent-evidence-candidates.csv"), data.agentEvidenceCandidates, CSV_HEADERS["analysis/agent-evidence-candidates.csv"]);
  await writeFile(path.join(out, "analysis", "source-summary.json"), `${JSON.stringify(data.sourceSummary, null, 2)}\n`);

  for (const [dir, filenames] of Object.entries(ARTIFACTS)) {
    for (const filename of filenames) {
      const abs = path.join(out, dir, filename);
      if (!existsSync(abs)) {
        const key = `${dir}/${filename}`;
        if (filename.endsWith(".csv")) await writeCsv(abs, [], CSV_HEADERS[key] || []);
        else if (filename.endsWith(".jsonl")) await writeJsonl(abs, []);
        else if (filename.endsWith(".json")) await writeFile(abs, "{}\n");
      }
    }
  }
}

async function writeJsonl(filePath, rows) {
  const handle = await open(filePath, "w");
  try {
    for (const row of rows) {
      await handle.write(`${JSON.stringify(row)}\n`);
    }
  } finally {
    await handle.close();
  }
}

async function writeCsv(filePath, rows, preferredHeaders = []) {
  const headerSet = new Set(preferredHeaders);
  for (const row of rows) {
    for (const key of Object.keys(row)) headerSet.add(key);
  }
  const headers = Array.from(headerSet).sort((left, right) => {
    const leftIndex = preferredHeaders.indexOf(left);
    const rightIndex = preferredHeaders.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex >= 0 ? leftIndex : 9999) - (rightIndex >= 0 ? rightIndex : 9999);
    return left.localeCompare(right);
  });
  const handle = await open(filePath, "w");
  try {
    await handle.write(`${headers.map(csvCell).join(",")}\n`);
    for (const row of rows) {
      await handle.write(`${headers.map((header) => csvCell(row[header])).join(",")}\n`);
    }
  } finally {
    await handle.close();
  }
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (text.length > MAX_CSV_CELL_CHARS) {
    text = `${text.slice(0, MAX_CSV_CELL_CHARS)}...[truncated:${text.length}]`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function compactRowsForCsv(rows) {
  return rows.map((row) => {
    const content = row.content ?? row.message?.content ?? row.data?.content;
    const messages = row.messages ?? row.data?.messages;
    const messagesSnapshot = row.messagesSnapshot ?? row.data?.messagesSnapshot ?? row.data?.messages_snapshot;
    const assistantTexts = row.assistantTexts ?? row.data?.assistantTexts;
    const runtimeContext = findRuntimeContext(row.data?.runtimeContext || row.data?.runtime_context || row.data?.context || row.data?.messages || row.data?.messagesSnapshot || row.content);
    return {
      sourceFile: row.sourceFile || "",
      sourceLine: row.sourceLine || "",
      agentExternalId: row.agentExternalId || row.agentId || row.data?.agentId || "",
      recordKind: row.recordKind || "",
      type: row.type || row.data?.type || "",
      role: row.role || row.message?.role || row.data?.role || "",
      runId: row.runId || row.run_id || row.data?.runId || row.data?.run_id || "",
      sessionId: row.sessionId || row.session_id || row.data?.sessionId || row.data?.session_id || "",
      sessionKey: row.sessionKey || row.session_key || row.data?.sessionKey || row.data?.session_key || "",
      messageId: row.messageId || row.message_id || row.msgId || row.msg_id || row.data?.messageId || row.data?.message_id || "",
      conversationId: row.conversationId || row.conversation_id || row.chatId || row.chat_id || "",
      senderId: row.senderId || row.sender_id || row.userId || row.user_id || "",
      senderNamePresent: String(Boolean(row.senderName || row.sender_name || row.sender || row.userName || row.user_name)),
      direction: row.direction || "",
      status: row.status || row.data?.status || row.finalStatus || row.data?.finalStatus || "",
      ts: row.ts || row.timestamp || "",
      hasContent: String(Boolean(content)),
      contentTextLength: cleanText(textFromContent(content)).length,
      messagesCount: Array.isArray(messages) ? messages.length : "",
      messagesSnapshotCount: Array.isArray(messagesSnapshot) ? messagesSnapshot.length : "",
      assistantTextCount: Array.isArray(assistantTexts) ? assistantTexts.length : "",
      hasRuntimeContext: String(Boolean(runtimeContext)),
      topLevelKeys: Object.keys(row).sort().join("|"),
      lineCount: row.lineCount || "",
      runIdCount: row.runIdCount || "",
      messageIdCount: row.messageIdCount || "",
      tableName: row.tableName || "",
      rowNumber: row.rowNumber || "",
    };
  });
}

function compactTrajectoryRunsForCsv(rows) {
  return rows.map((row) => ({
    runId: row.runId || "",
    sessionId: row.sessionId || "",
    sessionKey: row.sessionKey || "",
    agentExternalId: row.agentExternalId || "",
    fileAgentExternalId: row.fileAgentExternalId || "",
    messageId: row.messageId || "",
    conversationId: row.conversationId || "",
    senderId: row.senderId || "",
    senderName: row.senderName || "",
    startedAt: row.startedAt || "",
    endedAt: row.endedAt || "",
    lastEventAt: row.lastEventAt || "",
    finalStatus: row.finalStatus || "",
    endedStatus: row.endedStatus || "",
    didSendViaMessagingTool: String(Boolean(row.didSendViaMessagingTool)),
    hasPromptSubmitted: String(Boolean(row.hasPromptSubmitted)),
    hasPromptText: String(Boolean(row.hasPromptText)),
    hasPromptTruncated: String(Boolean(row.hasPromptTruncated)),
    hasMessagesSnapshot: String(Boolean(row.hasMessagesSnapshot)),
    hasRuntimeContext: String(Boolean(row.hasRuntimeContext)),
    userMessageCandidateCount: row.userMessageCandidateCount || 0,
    assistantTextCount: row.assistantTextCount || 0,
    toolCallCount: row.toolCallCount || 0,
    errorText: row.errorText || "",
  }));
}

function flatten(value, prefix = "", output = {}) {
  if (value === undefined) return output;
  if (value === null || typeof value !== "object") {
    if (prefix) output[prefix] = value;
    return output;
  }
  if (Array.isArray(value)) {
    if (!value.length && prefix) output[prefix] = "";
    value.forEach((entry, index) => flatten(entry, prefix ? `${prefix}.${index}` : String(index), output));
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    flatten(entry, nextPrefix, output);
  }
  return output;
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function agentFromPath(relativePath) {
  return /^agents\/([^/]+)/.exec(normalizePath(relativePath))?.[1] || "";
}

function parseSessionKey(sessionKey) {
  const raw = String(sessionKey || "");
  const agentMatch = /^agent:([^:]+):([^:]+)(?::(.+))?$/.exec(raw);
  const body = agentMatch ? `${agentMatch[2]}${agentMatch[3] ? `:${agentMatch[3]}` : ""}` : raw;
  const dingtalk = /^dingtalk:(group|direct):(.+)$/.exec(body);
  if (dingtalk) return { agentExternalId: agentMatch?.[1] || "", channelKind: "dingtalk", conversationId: dingtalk[2], taskType: "conversation" };
  const webchat = /^webchat:(.+)$/.exec(body);
  if (webchat) return { agentExternalId: agentMatch?.[1] || "", channelKind: "webchat", conversationId: webchat[1], taskType: "conversation" };
  const cron = /^cron(?::(.+))?$/.exec(body);
  if (cron) return { agentExternalId: agentMatch?.[1] || "", channelKind: "", conversationId: cron[1] || "", taskType: "scheduled" };
  return { agentExternalId: agentMatch?.[1] || "", channelKind: "", conversationId: "", taskType: "" };
}

function openClawAgentIdFromSessionKey(sessionKey) {
  return parseSessionKey(sessionKey).agentExternalId;
}

function extractRuntimeContext(event) {
  const data = event?.data || {};
  return findRuntimeContext(data.runtimeContext || data.runtime_context || data.context || data.prompt || data.messages || data.messagesSnapshot || event.content || event);
}

function findRuntimeContext(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRuntimeContext(entry);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (value["openclaw.runtime-context"]) return value["openclaw.runtime-context"];
    if (value.message_id || value.messageId || value.msgId || value.sender || value.sender_id || value.chat_id || value.group_subject) return value;
    for (const nested of Object.values(value)) {
      const found = findRuntimeContext(nested);
      if (found) return found;
    }
    return null;
  }
  const text = String(value);
  const candidates = [
    text.match(/Conversation info[^\n]*:\s*```json\s*([\s\S]*?)```/i)?.[1],
    text.match(/<conversation-metadata>\s*([\s\S]*?)<\/conversation-metadata>/i)?.[1],
    text.match(/Conversation metadata:\s*(\{[\s\S]*?\})(?:\n\n|$)/i)?.[1],
  ].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = parseJsonMaybe(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function applyRuntimeContext(run, context) {
  if (!context || typeof context !== "object") return;
  run.hasRuntimeContext = true;
  run.messageId ||= firstString(context.message_id, context.messageId, context.msgId, context.msg_id);
  run.senderId ||= firstString(context.sender_id, context.senderId, context.user_id, context.userId);
  run.senderName ||= firstString(context.sender, context.sender_name, context.senderName, context.user_name, context.userName);
  run.conversationId ||= firstString(context.chat_id, context.chatId, context.conversation_id, context.conversationId);
  run.conversationLabel ||= firstString(context.conversation_label, context.conversationLabel);
  run.groupSubject ||= firstString(context.group_subject, context.groupSubject);
  if (!run.sessionKey && context.group_channel) run.sessionKey = String(context.group_channel);
}

function countUserMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => {
    const role = message.role || message.message?.role || message.data?.role;
    return role === "user" && cleanText(textFromContent(message.content ?? message.message?.content ?? message.text));
  }).length;
}

function extractPrompt(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.prompt === "string") return data.prompt;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if ((message.role || message.message?.role) !== "user") continue;
    const text = textFromContent(message.content ?? message.message?.content ?? message.text);
    if (text.trim()) return text;
  }
  return "";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "custom_message") return "";
      return firstString(part?.text, part?.content);
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") return firstString(content.text, content.content);
  return "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/Conversation metadata:[\s\S]*?(?:\n\n|$)/i, "")
    .replace(/<conversation-metadata>[\s\S]*?<\/conversation-metadata>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractToolCalls(record) {
  const calls = [];
  if (record.toolCall) calls.push(record.toolCall);
  if (record.data?.toolCall) calls.push(record.data.toolCall);
  if (Array.isArray(record.tool_calls)) calls.push(...record.tool_calls);
  if (Array.isArray(record.message?.tool_calls)) calls.push(...record.message.tool_calls);
  if (Array.isArray(record.data?.tool_calls)) calls.push(...record.data.tool_calls);
  return calls.filter(Boolean);
}

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  if (["success", "succeeded", "completed", "done"].includes(status)) return "done";
  if (["failed", "error", "timed_out", "timeout", "lost"].includes(status)) return "failed";
  if (["running", "active", "in_progress"].includes(status)) return "in_progress";
  return status || "unknown";
}

function extractStableIds(line) {
  return {
    messageId: line.match(/(?:messageId|message_id|msgId)["=: ]+([A-Za-z0-9._:+-]+)/)?.[1] || "",
    runId: line.match(/(?:runId|run_id)["=: ]+([A-Za-z0-9._:+-]+)/)?.[1] || "",
  };
}

function relativizeOpenClawSessionFile(sessionFile) {
  const normalized = normalizePath(sessionFile);
  const marker = "/agents/";
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function firstString(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== "") return String(value);
  }
  return "";
}

function latestIso(left, right) {
  if (!left) return right || "";
  if (!right) return left || "";
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function toIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function parseJsonMaybe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
