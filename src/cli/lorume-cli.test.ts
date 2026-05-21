import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "scripts", "lorume.mjs");
const fixturePath = path.join(repoRoot, "fixtures", "runtime", "collector-snapshot.sample.json");

describe("lorume CLI", () => {
  it("prints deterministic JSON for local device identity", () => {
    const output = runCli([
      "device",
      "identify",
      "--json",
      "--device-id",
      "test-device",
    ]);

    expect(output.command).toBe("device.identify");
    expect(output.device).toMatchObject({
      architecture: process.arch,
      hostname: expect.any(String),
      id: "test-device",
      os: process.platform,
    });
    expect(output.device).not.toHaveProperty("name");
    expect(output.device).not.toHaveProperty("status");
    expect(output.device).not.toHaveProperty("connectionMode");
    expect(output.device.lastSeenAt).toEqual(expect.any(String));
    expect(output.observedAt).toEqual(expect.any(String));
  });

  it("lists normalized runtimes and agents from a collector-compatible snapshot", () => {
    const output = runCli(["runtime", "list", "--json", "--snapshot", fixturePath]);

    expect(output.command).toBe("runtime.list");
    expect(output.device.id).toBe("fixture-mac");
    expect(output.runtimes.map((runtime: { kind: string }) => runtime.kind)).toContain("openclaw");
    expect(output.agents.map((agent: { name: string }) => agent.name)).toContain("tester");
  });

  it("collects inventory through the Lorume CLI contract", () => {
    const output = runCli(["collect", "inventory", "--json", "--snapshot", fixturePath]);

    expect(output.command).toBe("collect.inventory");
    expect(output.device.id).toBe("fixture-mac");
    expect(output.collector).toMatchObject({ status: "online" });
    expect(output.runtimes.map((runtime: { deviceId: string }) => runtime.deviceId)).toEqual(["fixture-mac", "fixture-mac"]);
    expect(output.agents.map((agent: { runtimeId: string }) => agent.runtimeId)).toContain("fixture-mac:slock:slock-daemon");
  });

  it("collects locally detected CLI runtimes through the Lorume CLI contract", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-runtime-"));
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "codex"), "#!/bin/sh\nprintf 'codex 1.2.3\\n'\n");
    writeExecutable(path.join(binDir, "openclaw"), "#!/bin/sh\nexit 127\n");
    writeExecutable(path.join(binDir, "multica"), "#!/bin/sh\nexit 127\n");
    writeExecutable(path.join(binDir, "claude"), "#!/bin/sh\nexit 127\n");

    const output = runCli([
      "collect",
      "inventory",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "codex",
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      },
    });

    expect(output.command).toBe("collect.inventory");
    expect(output.device.id).toBe("test-device");
    expect(output.runtimes).toContainEqual(expect.objectContaining({
      deviceId: "test-device",
      kind: "codex",
      name: "Codex CLI",
      status: "online",
      version: "codex 1.2.3",
    }));
  });

  it("collects OpenClaw-only device state without invoking disabled adapters", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-"));
    const binDir = path.join(root, "bin");
    const disabledCallsPath = path.join(root, "disabled-adapter-called");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "openclaw"), `#!/bin/sh
if [ "$1" = "health" ]; then
  printf '{"ok":true,"agents":[{"agentId":"main"}],"channels":{"dingtalk":{"enabled":true}}}\\n'
  exit 0
fi
if [ "$1" = "status" ]; then
  printf '{"gateway":{"reachable":true,"url":"local","self":{"version":"openclaw 1.0.0"}},"agents":{"agents":[{"agentId":"main","sessions":{"count":2}}]}}\\n'
  exit 0
fi
printf '{}\\n'
`);
    for (const command of ["multica", "slock", "codex", "claude"]) {
      writeExecutable(path.join(binDir, command), `#!/bin/sh
printf '${command}\\n' >> ${JSON.stringify(disabledCallsPath)}
exit 91
`);
    }

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.command).toBe("collect.device-state");
    expect(output.runtimes.map((runtime: { kind: string }) => runtime.kind)).toEqual(["openclaw"]);
    expect(output.agents.map((agent: { name: string }) => agent.name)).toEqual(["main"]);
    expect(output.tasks).toEqual([]);
    expect(output.runtimes[0]).not.toHaveProperty("capabilities");
    expect(output.runtimes[0]).not.toHaveProperty("endpoint");
    expect(output.runtimes[0]).not.toHaveProperty("sourceRefs");
    expect(output.agents[0]).not.toHaveProperty("origin");
    expect(output.agents[0]).not.toHaveProperty("sourceRefs");
    expect(output.agents[0]).not.toHaveProperty("load");
    expect(existsSync(disabledCallsPath)).toBe(false);
  });

  it("keeps legacy inventory collection OpenClaw-only by default", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-inventory-openclaw-"));
    const binDir = path.join(root, "bin");
    const disabledCallsPath = path.join(root, "disabled-adapter-called");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "openclaw"), `#!/bin/sh
if [ "$1" = "health" ]; then
  printf '{"ok":true,"agents":[{"agentId":"main"}]}\\n'
  exit 0
fi
if [ "$1" = "status" ]; then
  printf '{"gateway":{"reachable":true,"url":"local","self":{"version":"openclaw 1.0.0"}},"agents":{"agents":[{"agentId":"main"}]}}\\n'
  exit 0
fi
printf '{}\\n'
`);
    for (const command of ["multica", "slock", "codex", "claude"]) {
      writeExecutable(path.join(binDir, command), `#!/bin/sh
printf '${command}\\n' >> ${JSON.stringify(disabledCallsPath)}
exit 91
`);
    }

    const output = runCli([
      "collect",
      "inventory",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        PATH: binDir,
      },
    });

    expect(output.command).toBe("collect.inventory");
    expect(output.runtimes.map((runtime: { kind: string }) => runtime.kind)).toEqual(["openclaw"]);
    expect(output.agents.map((agent: { name: string }) => agent.name)).toEqual(["main"]);
    expect(existsSync(disabledCallsPath)).toBe(false);
  });

  it("collects work-state through the Lorume CLI contract", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-work-state-"));
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "openclaw"), "#!/bin/sh\nexit 127\n");
    writeExecutable(path.join(binDir, "multica"), "#!/bin/sh\nexit 127\n");
    writeExecutable(path.join(binDir, "slock"), "#!/bin/sh\nexit 127\n");

    const output = runCli([
      "collect",
      "work-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        SLOCK_SERVER_URL: "http://127.0.0.1:9",
      },
    });

    expect(output).toMatchObject({
      command: "collect.work-state",
      deviceId: "test-device",
      workItems: [],
      conversations: [],
      executions: [],
    });
    expect(output.capabilities).toEqual(expect.any(Array));
    expect(output.observedAt).toEqual(expect.any(String));
  });

  it("probes read-only Agent Skill metadata from explicit local roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-skill-"));
    const skillRoot = path.join(root, "review-assistant");
    mkdirSync(path.join(skillRoot, "references"), { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "# Review assistant");
    writeFileSync(path.join(skillRoot, "references", "guide.md"), "# Guide");
    writeFileSync(path.join(skillRoot, "config.json"), "{\"safe\":true}");

    const output = runCli([
      "agent",
      "skill-probe",
      "--json",
      "--agent-id",
      "agent-1",
      "--runtime-id",
      "runtime-1",
      "--device-id",
      "device-1",
      "--skill-root",
      skillRoot,
    ]);

    expect(output.command).toBe("agent.skill-probe");
    expect(output.status).toBe("succeeded");
    expect(output.targetAgentId).toBe("agent-1");
    expect(output.skills).toHaveLength(1);
    expect(output.skills[0]).toMatchObject({
      name: "review-assistant",
      entryPath: path.join(skillRoot, "SKILL.md"),
    });
    expect(output.skills[0].markdownFiles.map((file: { relativePath: string }) => file.relativePath)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
    expect(output.skills[0].nonMarkdownFiles.map((file: { relativePath: string }) => file.relativePath)).toEqual([
      "config.json",
    ]);
  });

  it("checks connector status only from an authorized backend context", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lorume-cli-context-"));
    const contextPath = path.join(dir, "context.json");
    writeFileSync(contextPath, JSON.stringify({
      connectors: [
        { deviceId: "device-a", id: "connector-a", status: "online" },
      ],
    }));

    const output = runCli(["connector", "status", "--json", "--context", contextPath, "--target", "connector-a"]);

    expect(output).toMatchObject({
      command: "connector.status",
      connector: { deviceId: "device-a", id: "connector-a", status: "online" },
    });
  });

  it("copies an explicit file inside allowed roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-copy-"));
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "nested", "destination.txt");
    writeFileSync(source, "hello from lorume cli");

    const output = runCli([
      "files",
      "copy",
      "--json",
      "--from",
      source,
      "--to",
      destination,
      "--allow-root",
      root,
    ]);

    expect(output).toMatchObject({ command: "files.copy", status: "copied" });
    expect(readFileSync(destination, "utf8")).toBe("hello from lorume cli");
  });

  it("delegates collector uninstall to the installer capability", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-collector-"));
    const fakeInstaller = path.join(root, "install-device-collector.sh");
    const callsPath = path.join(root, "calls.jsonl");
    writeExecutable(fakeInstaller, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}
`);

    const output = runCli([
      "collector",
      "uninstall",
      "--json",
      "--install-dir",
      path.join(root, "collector"),
    ], {
      env: { LORUME_COLLECTOR_INSTALLER_PATH: fakeInstaller },
    });

    expect(output).toMatchObject({ command: "collector.uninstall", status: "succeeded" });
    expect(readFileSync(callsPath, "utf8")).toContain(`--install-dir ${path.join(root, "collector")} --uninstall`);
  });

  it("delegates collector stop to the installer capability", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-collector-"));
    const fakeInstaller = path.join(root, "install-device-collector.sh");
    const callsPath = path.join(root, "calls.jsonl");
    writeExecutable(fakeInstaller, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}
`);

    const output = runCli([
      "collector",
      "stop",
      "--json",
      "--install-dir",
      path.join(root, "collector"),
    ], {
      env: { LORUME_COLLECTOR_INSTALLER_PATH: fakeInstaller },
    });

    expect(output).toMatchObject({ command: "collector.stop", status: "succeeded" });
    expect(readFileSync(callsPath, "utf8")).toContain(`--install-dir ${path.join(root, "collector")} --stop`);
  });

  it("refuses path traversal outside allowed roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-safe-"));
    const outside = mkdtempSync(path.join(tmpdir(), "lorume-cli-outside-"));
    const source = path.join(root, "source.txt");
    writeFileSync(source, "do not leak");

    const result = spawnCli([
      "files",
      "copy",
      "--json",
      "--from",
      source,
      "--to",
      path.join(outside, "..", path.basename(outside), "destination.txt"),
      "--allow-root",
      root,
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "unsafe_path",
    });
    expect(existsSync(path.join(outside, "destination.txt"))).toBe(false);
  });

  it("returns a JSON error for unsupported commands", () => {
    const result = spawnCli(["unknown", "thing", "--json"]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "unsupported_command",
    });
  });
});

function runCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Record<string, any> {
  return JSON.parse(execFileSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  }));
}

function spawnCli(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr.trim() };
}

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}
