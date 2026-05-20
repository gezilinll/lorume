# Auth And Access Spec

版本：TinySpec v0.1

本规格定义 Lorume 组织、登录、成员、邀请、会话和设备 token 的产品边界。它是当前权限实现的来源，不覆盖计费、SSO、复杂 RBAC 或审计报表。

## 目标

- 用户使用团队邮箱接收验证码登录，不设置密码。
- 登录后必须处在一个组织中，才能进入 Lorume Console。
- 组织可以由登录用户创建，也可以通过邀请链接加入。
- 组织内成员有最小角色：owner、admin、member。
- Device Collector 使用设备 token 向 backend 上报数据；token 只保存哈希，不明文入库。
- Runtime Fleet、Runs、组织设置等 Console 页面，以及任务中心、通知中心工具抽屉必须通过用户 session 访问。

## 非目标

- 不做个人账号密码登录。
- 不做 Google、GitHub、企业 SSO 或 LDAP。
- 不做计费、套餐、席位购买。
- 不做通用细粒度资源 ACL，例如单个 Runtime、单个 Agent、单条 Run 的授权。
- 不做跨组织共享数据。
- 不在日志、fixture、文档或截图中保留验证码、session token、device token、邮件 API key。Device token 只允许在管理员创建后的一次性响应和当前受保护页面状态中明文出现，页面刷新后不能从后端再次读取明文。

## 对象模型

### User

User 是一个邮箱身份。邮箱是登录和邀请匹配的唯一稳定标识。

字段：

- `id`：内部 ID。
- `email`：登录邮箱，大小写不敏感存储和匹配。
- `displayName`：展示名，可为空。
- `createdAt` / `updatedAt`：创建和更新时间。

### Organization

Organization 是数据和成员权限边界。Runtime、Agent、Run、Device 后续都应归属到某个组织。

字段：

- `id`：内部 ID。
- `name`：组织名称。
- `slug`：可读唯一标识，用于 URL 或管理展示。
- `createdByUserId`：创建人。
- `createdAt` / `updatedAt`：创建和更新时间。

### Organization Member

Organization Member 表示用户在组织内的角色。

角色：

- `owner`：组织所有者，可管理成员、邀请和设备 token。
- `admin`：管理员，可邀请成员和管理设备 token。
- `member`：普通成员，可查看 Console 和工作数据。

当前组织基础角色只做三档。owner 和 admin 可执行组织管理动作；member 默认读取组织内 Console 数据。Skill 资源级编辑、发布、分配、同步和权限管理通过 Skill governance 模块追加控制。

### Email Login Code

Email Login Code 是一次性登录验证码。

规则：

- 验证码只发送到目标邮箱。
- 数据库存储验证码哈希、过期时间、消费时间和尝试次数。
- 验证成功后创建或复用 User。
- 验证码过期、已消费或尝试次数超限时必须拒绝。

### Session

Session 是浏览器登录态。

规则：

- session token 只通过 HTTP-only cookie 返回。
- 数据库存储 session token 哈希，不存明文。
- logout 后 session 立即失效。
- `/api/me` 返回当前用户和可访问组织列表。

### Organization Invitation

Invitation 是加入组织的链接凭证。

规则：

- owner / admin 可以邀请邮箱加入组织。
- 邀请链接包含一次性 token，数据库只存 token 哈希。
- 被邀请人点击链接后，如果未登录，先完成邮箱验证码登录。
- 登录邮箱必须和邀请邮箱一致，才能接受邀请。
- 接受后创建 Organization Member，邀请标记为已接受。

### Device Token

Device Token 是设备侧 Collector 上报和连接健康通道的凭证。

规则：

- token 由 owner / admin 创建。
- token 明文只在创建时返回一次。
- 数据库存储 token 哈希和短 prefix，用于识别与排查。
- Collector 上报 inventory / work-state 和设备 WebSocket 连接健康通道都使用 device token。
- 如果 backend 开启 device token 校验，缺失、过期或撤销的 token 必须被拒绝。

## API 边界

Auth API：

- `POST /api/auth/email-code`：发送邮箱验证码。
- `POST /api/auth/login`：校验验证码并创建 session。
- `POST /api/auth/logout`：撤销当前 session。
- `GET /api/me`：读取当前用户、组织和角色。

Organization API：

- `POST /api/organizations`：创建组织。
- `GET /api/organizations`：读取当前用户组织列表。
- `POST /api/organizations/:organizationId/invitations`：创建邀请。
- `POST /api/invitations/:token/accept`：接受邀请。

Device token API：

- `POST /api/organizations/:organizationId/device-tokens`：创建设备 token，当前已实现，只有 owner / admin 可用，响应只在本次返回明文 token。
- `GET /api/organizations/:organizationId/device-tokens`：列出设备 token 摘要，当前未实现，后续只能返回名称、device id、token prefix、创建时间、撤销状态等摘要，不能返回明文 token。
- `POST /api/device-snapshots`：Collector 上报 inventory，使用 device token。
- `POST /api/runtime-work-state-snapshots`：Collector 上报 work-state，使用 device token。
- `GET /api/device-control/ws`：设备连接健康通道，使用 device token。
- `GET /api/device-collector/install.sh` 和 `GET /api/device-collector/files/:fileName`：公开无密钥 installer 与设备包下载入口；鉴权边界在 device token 创建 API 和组织设置页面。

Runtime / Runs 读取 API：

- Console 读取类 API 必须有有效 session。
- 读取 API 按用户所属组织做最小隔离，不在 React 页面里推导权限。

## 邮件发送

邮箱验证码通过可替换的 Email Provider 发送。当前生产实现支持 SMTP 邮箱账号，适配阿里企业邮箱等企业邮箱服务；Sender / Resend 类 HTTP 邮件服务仍属于同一 Provider 边界的可替换实现。SMTP 密码、API key 或客户端安全密码只允许通过环境变量注入。

实现要求：

- 本地测试使用 fake provider，不发真实邮件。
- 开发环境可以输出一次性调试码，但该能力必须由显式环境变量开启。
- 生产环境没有邮件 provider 配置时，发送验证码接口必须失败并给出可排查错误。
- SMTP Provider 使用 `LORUME_EMAIL_PROVIDER=smtp` 开启，读取 `LORUME_SMTP_HOST`、`LORUME_SMTP_PORT`、`LORUME_SMTP_SECURE`、`LORUME_SMTP_USER`、`LORUME_SMTP_PASSWORD` 和 `LORUME_EMAIL_FROM`。
- 发信账号应使用专用系统邮箱，例如 `noreply@lorume.com`；不要使用个人邮箱或管理员邮箱作为验证码发件账号。

## UI 规则

- 登录、验证码、创建组织、邀请加入页面使用 Glacier Premium Precision 视觉语言：冷白/冰蓝背景、现代品牌标识、hairline 边界、低噪声网格和清晰表单层级。
- Console 页面使用同一 token 系统，但优先保证 Runtime Fleet、Runs、组织设置，以及任务中心、通知中心工具抽屉的数据扫描效率。
- 品牌标题、按钮、状态短标签、说明文字和表单均以 Sans 为主；Mono 只用于短技术标签、时间戳和数字，不作为身份页装饰字体。
- 身份页和 Console 的图标都通过共享 `PixelIcon` 入口渲染；该入口名称为历史兼容，实际图标应为现代低噪声线性图标。表单输入、按钮、运营概览、导航、刷新、搜索、时间选择和页脚装饰不得使用零散图标体系。
- 不回退复古像素边框、厚黑线、高饱和黄色侧栏、错位阴影、像素 sprite 或装饰性调试文案。
- 登录页的 `/api/me` 匿名会话探测返回 `401` 或 `404` 属于正常未登录状态，不能直接把 `Not Found`、接口错误或调试字段暴露在页面上；其他后端故障仍应展示可读错误，避免把真实服务异常吞掉。
- Auth API 错误必须使用稳定 `error` code，并通过共享错误字典维护用户可读 `message`。前端遇到只有 code 的响应时，也必须映射成可读提示，不能把 `invalid_or_expired_code` 等技术字符串直接展示给用户。
- 组织设置页生成安装命令时可以显示 device token 和包含 token 的命令，但只显示当前创建结果，不提供历史明文 token 查询。

## Runtime Profiles

Lorume 前后端共享三个稳定运行模式，避免把 auth 规则散落到页面条件里：

- `production`：默认线上模式。Console 和 Runtime 读取 API 必须要求有效 session 与组织上下文；匿名或组织缺失时前端回到公开首页/登录流程，后端返回 `401`。
- `development`：开发者本地联调模式。权限规则仍与 production 一致，但验证码可以在本地后端日志中输出，便于开发者完成真实登录链路。
- `agent`：自动化验收和本地代理开发模式。只用于本地 harness 或 coding agent 自测，可注入本地 session 进入已验收 Console 页面；不得作为线上默认值，也不得绕过生产后端的 session 校验。

`disabled` 仅作为旧 harness 环境值的兼容别名解析为 `agent`，新文档、脚本和测试应使用 `agent`。

前端使用 `VITE_LORUME_APP_MODE` 配置运行模式，并兼容读取旧 `VITE_LORUME_AUTH_MODE`；后端使用 `LORUME_APP_MODE`，并兼容读取旧 `LORUME_AUTH_MODE`。本地 `npm run dev` 与 `npm run dev:backend` 在未覆盖环境变量时使用 `development`，Playwright Console harness 显式覆盖为 `agent`，生产构建/启动不设置时回到 `production`。

## Harness

后端：

- crypto 测试必须证明验证码、session、invitation token 和 device token 只可通过哈希校验。
- store 测试必须覆盖 User -> Organization -> Member -> Invitation -> Session -> Device Token 的核心链路。
- HTTP API 测试必须覆盖发送验证码、登录、`/api/me`、创建组织、邀请、接受邀请和 logout。
- Runtime 读取 API 在开启 session 校验时必须拒绝匿名请求。
- Collector / control 在开启 device token 校验时必须拒绝无效 token。

前端：

- 登录页、验证码页、创建组织页和邀请加入页必须有组件测试。
- Console 必须被 `/api/me` gate 保护。
- Glacier Premium Precision 组件测试必须覆盖现代 logo、基础面板/button/badge/token 类名和身份页结构，防止后续页面绕开共享 token。
- 登录页组件测试必须覆盖初始匿名 `/api/me` 探测 `401` / `404` 不显示错误，同时覆盖非匿名后端故障不被吞掉。
- Playwright Console harness 可以通过 `VITE_LORUME_AUTH_MODE=agent` 进入已验收页面，专注验证 Runtime Fleet 和 Runs 的布局与交互；Auth 流程由独立组件 harness 覆盖。受保护业务页面需要真实登录串联时，使用单独的 auth-backed Playwright harness，并确保它走正式 API 和组织上下文。
- 已验收的 Runtime Fleet 和 Runs 交互不得因 auth 和视觉改造回退。

## 验收标准

- 未登录用户访问 Console 时进入登录流程。
- 使用邮箱验证码可以登录。
- 无组织用户登录后进入创建组织流程。
- 有待接受邀请的用户可以在登录后通过邀请链接加入组织。
- 登录用户可以查看 Console；logout 后不能继续访问 Console API。
- 设备 token 明文不入库，失效 token 无法上报。
- 所有新规则进入 spec、AGENTS 和 harness；没有过程性 mockup 或临时调研文件残留。
