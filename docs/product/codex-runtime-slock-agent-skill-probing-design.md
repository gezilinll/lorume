# Codex Runtime And Slock Agent Skill Probing Design

版本：Implementation Baseline v1
状态：后端 collector / adapter 已落地，前端展示待后续阶段实现。
范围：Codex Runtime Skill 与 Slock Agent Skill 的后端采集、归一化、数据结构、harness、真实设备验收边界。前端展示不在本阶段实现范围内。

## 背景

OpenClaw Skill probing 已经验证了一个核心规则：Skill 探测应发生在 Runtime 级，后端存储 Runtime Skill snapshot，Agent 视图通过 `agentIds` 从 Runtime snapshot 中过滤。

Codex + Slock 的真实数据补充了另一个边界：

- Codex 是设备上的执行 Runtime。
- Slock 是 channel / orchestration / Agent profile 来源，不是 Lorume Runtime。
- Slock profile 中的 `runtime` 字段决定 Slock Agent 依附的执行 Runtime；当前真实数据中这些 Agent 都是 `runtime=codex`。
- Codex 全局 Skill 属于 Codex Runtime；Slock Agent 工作区和 repo 内 Skill 属于具体 Slock Agent。

因此本阶段目标不是新增 Slock Runtime，而是让同一个 Codex Runtime Skill snapshot 同时包含：

- Codex Runtime 自身可用的 runtime-scope Skill。
- 依附于 Codex Runtime 的 Slock Agent 可见或拥有的 agent-scope Skill。

## 真实数据基线

基于远端真实设备 `gezilinll-claw` 的只读预采集，采样时间为 2026-05-27，临时采样目录为 `/tmp/lorume-slock-codex-precollect-20260527205407`。

### Runtime / Agent 基线

| 指标 | 结果 |
|---|---:|
| Codex Runtime | 1 |
| Slock profile 目录 | 12 |
| 可读 Slock profile | 11 |
| active 且在当前设备上的 Slock Agent | 8 |
| Slock profile runtime | 全部为 `codex` |
| Codex thread 总数 | 28 |
| Codex native/other thread | 12 |
| Slock-owned Codex thread | 13 |
| Multica-owned Codex thread | 3 |

这些数据说明：Slock Agent 是 Codex Runtime 下的 Agent，不是新的 Runtime；Slock-owned Codex thread 不应由 Codex adapter 入库为 Codex Task，仍由 Slock adapter 拥有 task/channel/status 事实。

### Skill 基线

| 来源 | 原始数量 | 合并展示数量 | scope | builtIn |
|---|---:|---:|---|---|
| Codex system skills | 5 | 5 | `runtime` | true |
| Codex personal skills | 17 | 17 | `runtime` | false |
| Codex plugin/cache skills | 16 | 16 | `runtime` | true |
| Slock agent root skills | 2 | 1 | `agent` | false |
| Slock repo `.agents/skills` | 77 | 46 | `agent` | false |
| Slock repo `.cursor/skills` | 2 | 2 | `agent` | false |

分析口径：

- Codex runtime-scope Skill 原始 38 条，展示仍为 38 条。
- Slock agent-scope Skill 原始 81 条，按同名同描述合并后为 49 条。
- 总展示行约 87 条。
- 当前 agent-scope Skill 主要归属 `PMO` 和 `Zyang-Senefactor` 两个 active Slock Agent。

## 产品建模结论

仍保持 Lorume 当前四对象模型：

```text
Device -> Runtime -> Agent -> Task
```

Skill 不是新的产品一等对象。Skill 是 Runtime metadata snapshot 中的只读能力摘要。

Codex + Slock 的产品归属为：

```text
Device gezilinll-claw
└── Runtime kind=codex
    ├── Agent source=codex local
    ├── Agent source=slock profile PMO
    ├── Agent source=slock profile Zyang-Senefactor
    └── RuntimeSkillSnapshot
        ├── runtime-scope Codex skills
        └── agent-scope Slock Agent skills with agentIds
```

Slock adapter 可以贡献 Codex Runtime 的 agent-scope Skill 事实，但产品层不因此生成 `Runtime.kind="slock"`。

## 目标

- Codex Runtime Skill snapshot 能反映 Codex 全局 Skill 与 Slock Agent Skill。
- `scope` 仍只有 `runtime` / `agent`。
- `scope="runtime"` 的 Skill 不记录 Agent 归属。
- `scope="agent"` 的 Skill 必须记录一个或多个 Lorume `agentIds`，方便后续 Agent 详情和筛选展示。
- Codex-owned、Slock-owned、Multica-owned 的会话归属规则保持不变。
- 后端与 collector 只采集 metadata，不采集完整 Skill 文件内容。
- 落地后能通过真实设备 `gezilinll-claw` 观测 snapshot 数量、scope、agent 归属和耗时。

## 非目标

- 不创建 Slock Runtime。
- 不创建全局 Skill registry。
- 不提供 Skill 安装、编辑、发布、分配、同步、迁移或执行控制。
- 不把 Slock channel、Codex session 或 Skill 文件变成新的产品一等实体。
- 不把 Codex `.tmp` marketplace、临时 clone、sessions、logs、vendor import 候选目录纳入产品 Skill。
- 不读取或上传 token、完整本地路径、完整 Skill 文件正文、完整 Slock profile、完整 Codex JSONL。
- 不在前端新增 Skill 管理页面或 `/skills` route。

## 数据结构

沿用 Runtime Skill probing 的最小产品契约：

```ts
type SkillScope = "runtime" | "agent";

interface RuntimeSkillSnapshot {
  runtimeId: string;
  runtimeKind: string;
  status: "unknown" | "succeeded" | "unsupported" | "failed";
  observedAt?: string;
  summary: RuntimeSkillSummary;
  skills: SkillDisplayRow[];
}

interface RuntimeSkillSummary {
  total: number;
  runtimeScopeCount: number;
  agentScopeCount: number;
  availableCount: number;
  unavailableCount: number;
  builtInCount: number;
}

interface SkillDisplayRow {
  name: string;
  description: string;
  scope: SkillScope;
  available: boolean;
  builtIn: boolean;
  agentIds: string[];
}
```

字段规则：

- `name`：Skill 目录名或 Runtime 提供的稳定 name。
- `description`：仅取 Skill metadata/header 中的短描述；没有则为空字符串。
- `scope`：只允许 `runtime` 或 `agent`。
- `available`：当前 Runtime snapshot 视角下可用。
- `builtIn`：系统自带能力。
- `agentIds`：仅 `scope="agent"` 使用；`scope="runtime"` 必须为 `[]`。

实现内部后续可以保留以下诊断字段，但产品 API 默认不暴露：

- `sourceKind`
- `sourcePathHash`
- `parseError`
- `duplicateKey`
- `sourceAdapter`
- `rawCount`

## Scope Mapping

### Codex Runtime Skill

Codex 全局 Skill 归入 `scope="runtime"`：

| 本地来源 | scope | builtIn | available |
|---|---|---:|---:|
| `~/.codex/skills/.system/<name>/SKILL.md` | `runtime` | true | true |
| `~/.codex/skills/<name>/SKILL.md` | `runtime` | false | true |
| `~/.codex/plugins/cache/<provider>/<plugin>/<version>/skills/<name>/SKILL.md` | `runtime` | true | true |

排除规则：

- 不扫 `~/.codex/.tmp`。
- 不扫 `~/.codex/sessions`。
- 不扫 `~/.codex/log`。
- 不扫 `~/.codex/vendor_imports`。
- 不扫 marketplace clone 或尚未安装/启用的候选 skill。

理由：这些目录会包含未安装、临时、历史或缓存候选，直接纳入会把不可用能力误报为当前 Codex Runtime Skill。

### Slock Agent Skill

Slock Agent 工作区 Skill 归入 `scope="agent"`，并写入对应 Lorume Agent id：

| 本地来源 | scope | builtIn | agentIds |
|---|---|---:|---|
| `~/.slock/agents/<agentId>/.agents/skills/<name>/SKILL.md` | `agent` | false | 当前 Slock Agent |
| `~/.slock/agents/<agentId>/repos/**/.agents/skills/<name>/SKILL.md` | `agent` | false | 当前 Slock Agent |
| `~/.slock/agents/<agentId>/repos/**/.cursor/skills/<name>/SKILL.md` | `agent` | false | 当前 Slock Agent |

Slock Task 采集仍只使用同时满足以下条件的 profile：

- profile 可读。
- profile `status` / `state` 为 `active`。
- profile `runtime` 是 Lorume 已实现 Runtime kind；当前为 `codex`。
- profile 主机信息为空或匹配当前 Device hostname / id。
- 本地存在对应 `~/.slock/agents/<agentId>` 工作区。

Slock Skill inventory 还会额外扫描本地存在 Skill 文件的 Slock workspace。若该 workspace 不是当前 daemon active profile，但本地有 `.agents/skills`、repo `.agents/skills` 或 repo `.cursor/skills`，collector 会在 Codex Runtime 下创建一个 `collectionStatus="offline"` 的 Slock Agent 归属行，并将这些 Skill 写入该 Agent 的 `agentIds`。这个 fallback 只用于 Skill inventory，不扩大 Task 采集范围。

## Agent Ownership

Slock Agent 的 Lorume id 继续使用现有规则：

```text
${runtimeId}:agent:slock:${sanitizeId(profile.id)}
```

对每条 Slock agent-scope Skill：

- 优先找到 `agentId` 所属 Slock profile。
- 通过 profile runtime 生成或复用 Codex Runtime id；Skill-only 本地 workspace fallback 使用 Codex Runtime。
- 通过 Runtime id + Slock profile id 生成 Lorume Agent id。
- 将该 Lorume Agent id 写入 `SkillDisplayRow.agentIds`。

同一个 Skill 被多个 Slock Agent 拥有时，合并为一条展示行并聚合 `agentIds`。

## Snapshot Composition

Codex Runtime 的 Skill snapshot 是按 Runtime 聚合的结果，而不是某一个 adapter 独占的结果。

| 贡献方 | 贡献内容 | Runtime id |
|---|---|---|
| Codex adapter | Codex runtime-scope Skill | `${deviceId}:runtime:codex` |
| Slock adapter | Slock Agent 的 agent-scope Skill，前提是 profile runtime 为 `codex` | `${deviceId}:runtime:codex` |

Collector 合并规则：

1. 各 adapter 只读产生 Skill rows。
2. Collector 按 `runtimeId` 聚合 rows。
3. 同一个 `runtimeId` 的多个贡献方合并为一个 Runtime Skill snapshot。
4. 聚合时重新计算 summary。
5. 如果某个贡献方失败，不应覆盖另一个贡献方已成功产生的 rows；应把失败写入 diagnostics。

`mergeRuntimeCollections` 必须保持按 `runtimeId` 合并 rows 与 summary，避免 Codex adapter 和 Slock adapter 互相覆盖。

## Dedup Rules

去重只在同一个 Runtime snapshot 内发生。

当前 collector 对 Codex/Slock 文件型 Skill 使用同一组产品可见 key：

```text
scope + normalizedName + normalizedDescription
```

同 key 多条记录时：

- 合并 `agentIds`。
- `available=true` 只要任一 active owning Agent 可用即可为 true。
- `builtIn=true` 只要任一合并来源为系统自带即可为 true。
- `scope="runtime"` 的行固定输出 `agentIds=[]`。

OpenClaw CLI 返回的 Skill 继续沿用 OpenClaw adapter 的既有按 name 合并规则。

同名但描述或来源不同的 Skill 不强行合并。例如 `commit` 在真实数据里存在不同描述和不同来源，应保留多行，避免误把不同项目规则折叠成一个能力。

## Description Parsing

Skill 描述只从 `SKILL.md` 的 metadata/header 或首段短文本提取。

规则：

1. 优先读取 frontmatter / metadata 中的 `description`。
2. 没有 `description` 时，读取第一个非空、非标题、非 metadata 的短段落。
3. 描述做空白折叠。
4. 描述长度限制为 180 个字符。
5. 不把完整 `SKILL.md` 正文上传后端。
6. 解析失败时返回空描述，并写入 diagnostics。

## Availability Rules

Codex runtime-scope Skill：

- 位于允许目录。
- `SKILL.md` 可读。
- `name` 可归一化。
- 未命中排除目录。
- 满足以上条件则 `available=true`。

Slock agent-scope Skill：

- 所属 profile active。
- 所属 profile runtime 为已支持 Runtime kind。
- 所属 profile 匹配当前 Device。
- `SKILL.md` 可读。
- 满足以上条件则 `available=true`。

如果未来 Slock 或 Codex 暴露更明确的 disabled / allowlist / dependency missing 证据，应先更新 spec 和 harness，再引入更细判断。

## Security And Privacy

采集过程必须遵守：

- 不上传真实本地绝对路径。
- 不上传 token、API key、session token、Slock auth header、device token。
- 不上传完整 process args。
- 不上传完整 Slock profile。
- 不上传完整 Codex thread/session JSONL。
- 不上传完整 Skill 文件正文。
- diagnostics 只保留计数、错误 code 和脱敏 source kind。

允许在本地 adapter 内部短暂使用：

- `~/.codex` 下的允许目录。
- `~/.slock/agents/<agentId>` 下的允许目录。
- Slock profile 的 id、name、runtime、status、hostname 匹配事实。

## Performance Rules

真实预采集里，Slock + Codex 只读结构采样约 13 秒；Skill inventory 文件扫描量可控。落地时仍需要限制扫描范围：

- Codex skill 根目录只扫白名单。
- Slock agent 只扫 active profile 对应工作区。
- repo 内扫描使用固定最大深度并跳过大型目录。
- 跳过 `.git`、`node_modules`、logs、sessions、大型构建产物目录。
- 单个 collector run 内 Skill snapshot JSON 目标应保持在百 KB 级以内。
- Skill probing 不应影响 Task batch ACK 逻辑。

当前数据量不需要像 Task 一样分批上报；如果真实 snapshot 超过后端请求体限制或稳定超过 1 MB，再单独设计 Skill snapshot 分片。

## Implementation Baseline

当前后端落地内容：

- `docs/product/agent-skill-probing-spec.md` 记录 Codex/Slock 映射规则。
- Codex adapter 扫描当前安装的 Codex Skill 白名单目录，输出 runtime-scope rows。
- Slock adapter 仅对 active、local、supported runtime 的 profile 扫描 Agent 工作区和 repo Skill，输出 agent-scope rows。
- Collector 按 `runtimeId` 合并多个 adapter 对同一 Runtime 的 Skill snapshot 贡献，并重新计算 summary。
- 后端 store/API 继续使用现有 Runtime Skill snapshot 表和接口。
- CLI fixture test 覆盖 Codex runtime-scope、Slock agent-scope、`agentIds`、排除临时目录、以及同一 Codex Runtime 下多 adapter 合并。

## Harness And Acceptance

当前已覆盖或后续验收使用的 harness：

| Harness | 证明内容 |
|---|---|
| `src/cli/lorume-cli.test.ts` | Codex whitelist 目录、Slock active local profile、repo skill 归属、临时目录排除、同一 Codex Runtime 下多 adapter 合并。 |
| `src/runtime/runtime-skill-probe.test.ts` | Runtime Skill snapshot 归一化、scope、builtIn、available、agentIds。 |
| `src/runtime/device-collector-script.test.ts` | collector 采集和上报链路不破坏既有 metadata / task batch 通道。 |
| `src/server/runtime-http-api-skill-probe.test.ts` | Runtime Skill snapshot 上报和读取接口。 |
| `src/server/db-schema.test.ts` | Runtime Skill snapshot schema 未被破坏。 |
| production smoke | 不写生产数据；只读验证 health/readiness 和可选 Runtime Skill read path。 |

真实设备验收必须额外确认：

- Codex Runtime snapshot 存在。
- `runtimeScopeCount` 接近真实 Codex global Skill 数量。
- `agentScopeCount` 包含 Slock Agent Skill。
- `scope="runtime"` 的 rows `agentIds=[]`。
- `scope="agent"` 的 rows 至少包含 PMO 和 Zyang-Senefactor 的 Lorume Agent id。
- 没有生成 `Runtime.kind="slock"`。
- Codex Task adapter 仍跳过 Slock-owned thread。
- collector 日志无 token、无完整路径、无完整 Skill 正文。

## Deferred Questions

- Agent-scope Skill 是否要在后端读接口中保留同名不同描述的多行。当前建议保留。
- `.cursor/skills` 是否长期纳入 Slock Agent Skill。当前真实数据中它与 `.agents/skills` 并存，建议先纳入，但标记为 adapter 内部 source，不暴露到产品字段。
- 是否将 inactive Slock Agent 的历史 skill 作为 unavailable 行展示。当前建议不展示，避免把不可操作能力混入当前能力列表。
- 是否需要把 Codex personal Skill 标为 builtIn=false。当前建议是 false，因为它来自用户/本机安装。
