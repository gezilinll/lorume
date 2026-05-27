# Runtime Skill Probing Backend Design

版本：Review Draft v0  
状态：待用户 review 后落地  
范围：后端数据结构、collector / adapter 责任、OpenClaw 映射规则、存储、API、harness。前端展示不在本阶段实现范围内。

## 背景

现有 Skill probing spec 以 Agent 为探测单位：一个 Agent 对应一次 Skill metadata snapshot。真实 OpenClaw 数据分析后，Agent 级逐个探测会重复读取同一个 Runtime 下的 Skill 来源，并且不利于解释 Runtime 级能力与 Agent 可见能力的边界。

新的后端落地方向是：**探测发生在 Runtime 级，Skill snapshot 挂在 Runtime 上；Agent 只消费 Runtime snapshot 中按归属过滤出来的 agent-scope Skill。**

这不改变 Lorume 当前四对象模型：`Device -> Runtime -> Agent -> Task`。Skill 不是新的产品一等对象，只是 Runtime metadata snapshot 中的只读能力摘要。

## 目标

- Device 不处理 Skill 逻辑，也不展示 Device Skill。
- Runtime adapter 负责一次性探测当前 Runtime 的 Skill metadata。
- 后端存储 Runtime 级最新 Skill snapshot。
- 后端保留 agent-scope Skill 与 Agent 的归属关系，便于后续按 Agent 筛选展示。
- 对外产品字段保持最小必要模型，避免把 OpenClaw 的内部来源、可见性和诊断字段直接暴露成 Lorume 抽象。
- 支持 OpenClaw 当前真实数据，同时为后续其他 Runtime 保留通用抽象。

## 非目标

- 不做前端展示改造。
- 不在 Device 级展示 Skill 或探测能力。
- 不创建全局 Skill registry。
- 不提供 Skill 安装、编辑、发布、分配、同步、迁移或执行控制。
- 不存储或返回 Skill 文件内容、私密路径、token、完整日志、平台私有 payload。
- 不把 OpenClaw 的 `personal / workspace / bundled` 直接变成 Lorume 产品分层。
- 不使用 `modelVisible`、`commandVisible` 或 OpenClaw `active` 直接决定 Lorume 的 `scope`。

## 真实数据结论

基于远端真实设备 `gezilinll-claw` 的 OpenClaw Skill 数据，按本方案映射后得到：

| 指标 | 数量 |
|---|---:|
| Skill 总数 | 108 |
| runtime scope | 53 |
| agent scope | 55 |
| available | 66 |
| unavailable | 42 |
| builtIn | 51 |

真实数据中存在一些容易误判的字段：

- `active=false` 不等于不可用。它更接近“当前 agent/filter/入口是否激活或露出”的内部状态，不应直接映射为 Lorume `available=false`。
- `modelVisible` / `commandVisible` 是运行时或入口可见性的内部事实，不应参与产品级 `scope` 划分。
- `personal / workspace / bundled` 是 OpenClaw 内部来源，不应直接成为 Lorume 跨 Runtime 抽象。
- `clawhub`、`healthcheck`、`weather` 这类能力从真实数据和语义上应归为 runtime-scope Skill。

## 产品抽象

Lorume 只暴露两个 Skill scope：

| scope | 含义 |
|---|---|
| `runtime` | 属于 Runtime 或 Runtime adapter 的系统级能力，不归属某个具体 Agent。 |
| `agent` | 可被一个或多个 Agent 使用、覆盖、启用或筛选的能力。 |

Skill snapshot 附着在 Runtime 上。Agent 归属是 snapshot 内的索引字段，不是单独探测任务。

## 后端数据结构

后端归一化后的产品契约建议如下：

```ts
type SkillScope = "runtime" | "agent";

type RuntimeSkillProbeStatus =
  | "unknown"
  | "succeeded"
  | "unsupported"
  | "failed";

interface RuntimeSkillSnapshot {
  runtimeId: string;
  runtimeKind: string;
  status: RuntimeSkillProbeStatus;
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

- `name`：稳定展示名。优先使用 adapter 归一化后的 skill name；缺失时使用可读 fallback。
- `description`：短说明。缺失时返回空字符串，不从文件内容生成摘要。
- `scope`：只允许 `runtime` 或 `agent`。
- `available`：表示当前 Runtime 视角下可用，不等同于 OpenClaw `active`。
- `builtIn`：表示系统自带能力。
- `agentIds`：仅对 `scope="agent"` 有意义，记录当前拥有或可见该 Skill 的 Agent id 列表。`scope="runtime"` 时必须为 `[]`。

## 字段映射规则

### scope 映射

OpenClaw adapter 内部可以保留来源字段，但产品层只输出 `runtime` / `agent`：

| OpenClaw 来源 | Lorume scope |
|---|---|
| `openclaw-bundled` 或 `bundled=true` | `runtime` |
| `openclaw-extra` | `runtime` |
| `openclaw-workspace` | `agent` |
| `agents-skills-personal` | `agent` |
| `agents-skills-project` | `agent` |
| 未知来源 | adapter 先进入 diagnostics，不应猜测为新的产品 scope |

已知示例：

| name | scope | 说明 |
|---|---|---|
| `clawhub` | `runtime` | OpenClaw 系统/Runtime 能力。 |
| `healthcheck` | `runtime` | 健康检查类 Runtime 能力。 |
| `weather` | `runtime` | Runtime 自带或系统提供能力。 |
| `argus-cost-provider-auth-refresh` | `agent` | 非系统自带，按 Agent 来源归类。 |
| `share-files` | `agent` | 工作区/Agent 相关能力。 |

### available 映射

`available` 使用最小可解释规则：

```ts
available =
  raw.eligible === true &&
  raw.disabled !== true &&
  raw.blockedByAllowlist !== true &&
  missingCount(raw.missing) === 0;
```

规则说明：

- `blockedByAgentFilter` 不影响 `available`，只影响 `agentIds` 归属。
- OpenClaw `active=false` 不直接映射为 `available=false`。
- `modelVisible` / `commandVisible` 不参与 `available` 判断。
- 如果 adapter 无法证明 `eligible`，应返回 `available=false` 并把原因放在 diagnostics，而不是在产品字段里新增状态。

### builtIn 映射

```ts
builtIn = raw.bundled === true || raw.source === "openclaw-bundled";
```

`personal`、`workspace`、`project` 等来源默认不是 built-in。

### agentIds 映射

Runtime adapter 在同一次探测中枚举 Runtime 下的 Agent，并为 agent-scope Skill 建立归属：

- 对每个 Agent 获取其可见 Skill 列表。
- 按稳定 key / name 去重合并到 Runtime snapshot。
- 若 `scope="agent"` 且该 Agent 视角下未被 allowlist 或 agent filter 阻断，则把该 Agent 的 Lorume `agent.id` 写入 `agentIds`。
- 若当前没有 Agent 拥有某个 agent-scope Skill，保留 `agentIds: []`，表示 Runtime 可发现该 Skill，但当前没有 Agent 归属。
- `scope="runtime"` 永远为 `agentIds: []`。

## Runtime 级探测流程

后端和 collector 的责任边界如下：

1. Collector 按当前设备上报周期运行。
2. Runtime adapter 识别可探测的 Runtime，例如 OpenClaw。
3. Adapter 在 Runtime 内执行一次 Skill metadata 探测。
4. Adapter 同步枚举该 Runtime 下的 Agent，并建立 agent-scope Skill 到 Agent 的归属索引。
5. Collector 将归一化后的 Runtime Skill snapshot 上报后端。
6. 后端只存储最新 snapshot 和必要 raw diagnostics，不触发远端命令。
7. 查询 API 返回归一化后的 Runtime snapshot；后续 Agent 视图可以由后端按 `agentIds` 过滤。

## OpenClaw Adapter 落地规则

OpenClaw adapter 的目标不是复刻 OpenClaw 内部模型，而是把 OpenClaw 当前可读 metadata 归一化为 Lorume Runtime Skill snapshot。

建议实现步骤：

1. 确认 Runtime 可用性与 OpenClaw 命令入口。
2. 枚举 Runtime 下的 Agent。
3. 对 Runtime 执行 Skill metadata list。
4. 对每个 Agent 执行 Agent 视角的 Skill metadata list。
5. 将原始来源映射为 `scope`。
6. 使用 `eligible / disabled / blockedByAllowlist / missing` 计算 `available`。
7. 使用 `bundled / source` 计算 `builtIn`。
8. 用 Agent 视角结果生成 `agentIds`。
9. 对同名 Skill 去重，保留最稳定、最可解释的一条产品记录。
10. 将无法归类或缺关键字段的数据写入 diagnostics，不扩展产品字段。

## 存储建议

新增 Runtime 级 snapshot 存储，不复用 Agent 级表语义：

```sql
runtime_skill_probe_snapshots (
  id uuid primary key,
  device_id text not null,
  runtime_id text not null,
  runtime_kind text not null,
  status text not null,
  observed_at timestamptz,
  summary jsonb not null,
  skills jsonb not null,
  diagnostics jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

索引建议：

- `(runtime_id, updated_at desc)`：读取 Runtime 最新 snapshot。
- `(device_id, updated_at desc)`：排查设备上报情况。
- `(status, updated_at desc)`：排查失败/unsupported 状态。

`raw` 只用于 adapter 诊断和后续映射修正，不进入产品 API 默认返回。

## API 建议

新增 Runtime 级 API：

| API | 说明 |
|---|---|
| `POST /api/runtime-skill-probe-snapshots` | Collector 上报 Runtime 级 Skill snapshot。 |
| `GET /api/runtimes/:runtimeId/skill-probe` | 返回 Runtime 最新 Skill snapshot；没有数据时返回 `unknown`。 |

兼容策略：

- 现有 `GET /api/agents/:agentId/skill-probe` 和 `POST /api/agent-skill-probe-snapshots` 不在本阶段直接删除。
- 后端先新增 Runtime 级能力，待前端迁移后再决定 Agent 级 API 是降级为兼容过滤器还是正式废弃。
- 如果需要兼容 Agent 查询，后端可通过 `agentId -> runtimeId -> RuntimeSkillSnapshot.skills.agentIds` 过滤出 Agent 视角结果，但仍不重新触发 Agent 级探测。

## Harness 与验收

后端落地后需要覆盖以下 harness：

- `agent-skill-probe` 或新 `runtime-skill-probe` 纯逻辑测试：验证 scope、available、builtIn、agentIds 映射。
- OpenClaw fixture 测试：覆盖 `clawhub / healthcheck / weather` 为 runtime-scope，`argus-cost-provider-auth-refresh` 为 agent-scope 且 `active=false` 不等于 unavailable。
- DB schema 测试：验证新增表、索引和 JSON 字段存在。
- Postgres store 测试：验证 upsert 最新 Runtime snapshot、读取 unknown、读取 succeeded/failed/unsupported。
- HTTP API 测试：验证 collector 上报、认证/设备 token 边界、GET runtime snapshot。
- Collector script 测试：验证 collector 不直接读 Skill 文件内容，只通过 adapter 产物上报 metadata。
- 回归测试：确保现有 Runtime Fleet / Runs / backend harness 不受影响。

后端阶段完成标准：

- Runtime 级 snapshot 可以被真实 collector 上报并被后端读取。
- OpenClaw 真实数据能按本方案映射出稳定 summary。
- `scope` 只有 `runtime / agent`。
- Device 不产生 Skill 字段。
- 产品 API 不暴露 OpenClaw 内部 `personal / workspace / bundled / modelVisible / commandVisible / active` 作为顶层字段。
- 旧 Agent 级接口在前端迁移前不被破坏。

## 后续落地顺序

用户 review 通过后，建议按以下顺序只落地后端：

1. 更新正式 spec：把 Runtime 级 snapshot 和 Agent 归属规则合并进 `docs/product/agent-skill-probing-spec.md`。
2. 新增/调整 TypeScript 归一化模型与 mapper。
3. 增加 OpenClaw Skill fixture 和 mapper 单测。
4. 增加 DB schema 与 store。
5. 增加 Runtime 级 ingest/read API。
6. 调整 collector / OpenClaw adapter 输出 Runtime Skill snapshot。
7. 跑后端 focused harness，再跑全量 repo harness。
8. 远端真实设备 `gezilinll-claw` 做一次只读采集验证。

前端展示、Runtime Fleet Skill 面板和 Agent Skill 筛选展示在后续单独阶段处理。

## 待 Review 决策点

- 是否接受新增 `runtime_skill_probe_snapshots` 表，而不是复用旧 Agent 级 snapshot 表。
- 是否接受 `GET /api/runtimes/:runtimeId/skill-probe` 作为新的主读接口。
- 是否接受 `agentIds: []` 表示“可发现但当前没有 Agent 归属”的 agent-scope Skill。
- 是否接受 `active=false` 不影响 `available` 的规则。
- 是否接受旧 Agent 级接口先保留兼容，等前端迁移后再清理。
