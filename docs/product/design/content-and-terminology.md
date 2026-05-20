# Content And Terminology

Lorume 文案应像生产工具：准确、短、可操作。不要把调试信息、平台实现细节或英文解释性句子暴露给用户。

## Core Terms

| Term | Rule |
|---|---|
| Device | 设备 |
| Runtime | Runtime，不翻译为运行时平台 |
| Agent | Agent |
| Channel | Channel 或渠道 |
| Work Item | 工作项 |
| Runs / Work Board | 工作看板 |
| Catalog | 对象目录 |
| Last Seen / Last Sync | 最近同步 |

Runtime 是 OpenClaw、Multica、Slock、Codex、Claude Code 等运行来源。Channel 是 DingTalk、Telegram、Slack 或默认渠道等用户触点。二者不能混用。

## Action Labels

按钮使用动词加对象：

- `发送验证码`
- `刷新看板`
- `加入组织`
- `创建组织`

避免：

- `确认`
- `提交`
- `操作`
- `下一步`

除非上下文已经唯一。

## Error Writing

错误信息包含：

1. 发生了什么。
2. 为什么用户需要关心。
3. 用户可以做什么。

不要显示堆栈、SQL、raw API response、adapter evidence 或英文 debug 文案。

## Unknown And Unsupported

- Runtime Fleet 的 Device / Runtime / Agent 状态不使用 `未知`；采集失败、adapter 异常或关键结构不可用时统一展示 `异常`。
- `未知`: 只可用于非资产状态字段，例如某个可选业务字段确实尚未取得且不会影响安全或状态判定。
- `不支持采集`: 当前平台或 adapter 不能提供该字段。
- `未关联执行`: 工作项真实存在，但没有可关联的执行记录。
- `名称待补全`: 只用于确实知道对象类型但无法取得名称的情况。

## Language

- 界面中文优先。
- 产品专有名词如 Runtime、Agent、Channel 可以保留英文。
- 英文句子只用于命令、代码、技术值或品牌短句，不用于普通说明。
