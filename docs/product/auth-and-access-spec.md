# Auth And Access Spec

版本：TinySpec v0.3

本规格定义 Lorume 组织、登录、成员、邀请、会话、设备 token 和组织安全审计的产品边界。它是当前权限实现的来源，不覆盖计费、SSO、LDAP 或复杂 RBAC。

## 目标

- 用户使用团队邮箱接收验证码登录，不设置密码。
- 登录后必须处在一个组织中，才能进入 Lorume Console。
- 组织可以由登录用户创建，也可以通过邀请链接加入。
- 组织内成员有最小角色：owner、admin、member。
- 组织邀请由系统邮件发送，受邀用户点击链接后使用受邀邮箱完成验证码登录并加入组织。
- Device Collector 使用设备 token 向 backend 上报数据；token 明文不入日志和列表，数据库保存哈希用于鉴权，并保存受保护加密密文用于 owner / admin 后续复制安装命令。
- Device token 一次只能绑定一台设备，首次成功使用后进入占用状态。
- 组织安全相关动作必须进入审计日志，覆盖邀请、登录、设备 token 和异常复用等事件。
- Runtime Fleet、Runs、组织设置等 Console 页面，以及任务中心、通知中心工具抽屉必须通过用户 session 访问。

## 非目标

- 不做个人账号密码登录。
- 不做 Google、GitHub、企业 SSO 或 LDAP。
- 不做计费、套餐、席位购买。
- 不做通用细粒度资源 ACL，例如单个 Runtime、单个 Agent、单条 Run 的授权。
- 不做跨组织共享数据。
- 不做审计日志报表、合规归档、外部 SIEM 对接、复杂检索或前端审计页面；当前只做安全事件写入和后端排查所需字段。
- 不在日志、fixture、文档或截图中保留验证码、session token、device token、邮件 API key。Device token 列表不能返回明文；owner / admin 可通过受保护的安装命令接口复制包含 token 的安装命令，用于重装 collector。

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

成员退出规则：

- active member / admin 可以主动退出组织，退出后组织成员关系转为 removed，不删除组织、设备、Runtime、Runs、Skill 或历史数据。
- owner 可以退出组织，但首版必须至少保留一个 active owner；唯一 owner 退出必须被拒绝。
- 所有权转让不在本规格内；唯一 owner 需要先通过后续所有权转让能力产生其他 owner 后才能退出。

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

Invitation 是加入组织的邮件凭证。

规则：

- owner / admin 可以邀请邮箱加入组织。
- 普通邀请只能预设 `member` 或 `admin` 角色；不允许通过邀请直接创建 `owner`。
- `owner` 只能通过后续单独的所有权转让流程产生，本规格不实现所有权转让。
- 邀请链接包含一次性 token，数据库只存 token 哈希。
- 邀请创建后由系统邮件发送，不依赖管理员手动复制链接。
- owner / admin 可以查看尚未完成加入的邀请记录，并对未接受邀请执行重发。
- owner / admin 创建邀请时可以选择过期时间：一天、一星期、一个月或永不过期。
- 重发邀请必须生成新的 invitation token 并发送新邮件；旧邀请应转为 `revoked`，避免多个有效链接长期并存。
- 重发邀请沿用原邀请的有效期策略；原邀请永不过期时，新邀请也永不过期。
- owner / admin 可以撤销未接受邀请，撤销后邀请链接不可再加入组织。
- 被邀请人点击链接后，直接进入受邀邮箱验证码流程。
- 邀请登录流程可以根据邀请 token 自动预填受邀邮箱，并自动发送验证码；页面展示仍只显示脱敏邮箱。
- 如果当前已登录邮箱与受邀邮箱不一致，前端应自动退出当前会话并发送受邀邮箱验证码，避免用户在错误身份下确认加入。
- 登录邮箱必须和邀请邮箱一致，才能接受邀请。
- 验证码校验成功后直接创建 Organization Member，邀请标记为已接受，并进入目标组织 Console，不再额外展示二次加入确认页。
- 邀请过期、已撤销、已接受、邮箱不匹配或 token 不存在时必须展示明确不可用原因。

### Device Token

Device Token 是设备侧 Collector 上报和连接健康通道的凭证。

规则：

- token 由 owner / admin 创建。
- token 明文不直接入库；数据库存储 token 哈希、短 prefix 和加密密文。哈希用于设备鉴权，prefix 用于识别排查，加密密文只用于 owner / admin 复制安装命令。
- token 状态只保留 `pending`、`occupied`、`revoked`、`expired`。
- `pending` 表示 token 已创建但尚未被设备成功使用。
- `occupied` 表示 token 已被某台设备首次成功使用，并绑定到该 `deviceId`。
- `revoked` 表示管理员主动撤销，立即不可用。
- `expired` 表示 token 超过过期时间，自动不可用。
- 如果创建 token 时指定了 `deviceId`，首次上报必须匹配该 `deviceId`。
- 如果创建 token 时未指定 `deviceId`，首次成功上报的设备占用该 token。
- `occupied` token 只能继续用于同一台设备；其他设备复用必须被拒绝并写入审计日志。
- token 轮换不引入单独状态；创建新的 `pending` token 后，将旧 token 置为 `revoked`。
- Collector 上报 `device_state` 和设备 WebSocket 连接健康通道都使用 device token。
- 如果 backend 开启 device token 校验，缺失、过期或撤销的 token 必须被拒绝。

### Organization Audit Event

Organization Audit Event 是组织安全和权限变更的追加式记录。

规则：

- 审计日志只记录安全、身份、权限和设备接入相关事件，不记录业务消息正文、Skill 正文、验证码明文、token 明文或外部平台密钥。
- 审计事件必须归属组织；登录类事件在用户尚未进入组织前可以只归属用户，接受邀请后再写入组织事件。
- 审计日志用于管理员排查和安全回溯，不作为计费依据。

首批事件：

- `invitation.sent`：记录操作者、受邀邮箱脱敏值、目标角色和邀请过期时间。
- `invitation.accepted`：记录接受者、组织和角色。
- `invitation.rejected`：记录过期、撤销、邮箱不匹配、已接受或 token 无效等原因。
- `organization.member_left`：记录主动退出组织的用户和原角色。
- `device_token.created`：记录操作者、目标 `deviceId`、token prefix 和过期时间。
- `device_token.occupied`：记录 token prefix 和首次绑定的 `deviceId`。
- `device_token.reuse_rejected`：记录 token prefix、已绑定 `deviceId` 和异常 `deviceId`。
- `device_token.revoked`：记录操作者、token prefix 和撤销原因。
- `auth.login_succeeded` / `auth.login_failed`：记录用户邮箱脱敏值、时间和失败原因。
- `auth.logout`：记录用户和时间。

## API 边界

Auth API：

- `POST /api/auth/email-code`：发送邮箱验证码。
- `POST /api/auth/login`：校验验证码并创建 session。
- `POST /api/auth/logout`：撤销当前 session。
- `GET /api/me`：读取当前用户、组织和角色。

Organization API：

- `POST /api/organizations`：创建组织。
- `GET /api/organizations`：读取当前用户组织列表。
- `POST /api/organizations/:organizationId/leave`：当前用户退出组织；active member / admin 可直接退出，owner 退出时必须至少保留一个 active owner，否则返回 `organization_last_owner_cannot_leave`。
- `GET /api/organizations/:organizationId/members`：列出组织成员，只有 owner / admin 可用。
- `POST /api/organizations/:organizationId/invitations`：创建邀请并发送邮件，只有 owner / admin 可用，目标角色只能是 `member` 或 `admin`，`expiresIn` 支持 `1d`、`7d`、`30d`、`never`。
- `GET /api/organizations/:organizationId/invitations`：列出组织邀请记录，只有 owner / admin 可用；前端默认展示尚未接受的记录用于查看状态和重发。
- `POST /api/organizations/:organizationId/invitations/:invitationId/resend`：为未接受邀请生成新 token 并重发邮件，旧邀请转为撤销；已接受邀请不能重发。
- `POST /api/organizations/:organizationId/invitations/:invitationId/revoke`：撤销未接受邀请，只有 owner / admin 可用；已接受邀请不能撤销。
- `GET /api/invitations/:token/preview`：读取邀请预览，用于邀请登录页展示组织名、目标角色、脱敏邮箱和可用状态；可返回完整邮箱给受保护的验证码请求流程使用，但页面文案不得展示完整邮箱。
- `POST /api/invitations/:token/accept`：接受邀请。

Device token API：

- `POST /api/organizations/:organizationId/device-tokens`：创建设备 token，只有 owner / admin 可用，输入名称为 `Token 名称`；响应返回 token 摘要、一次性明文 token 和包含明文 token 的安装命令，初始状态为 `pending`。
- `GET /api/organizations/:organizationId/device-tokens`：列出设备 token 摘要，只返回名称、token id、device id、token prefix、状态、创建时间、首次占用时间、最近使用时间、过期时间和是否可复制安装命令，不能返回明文 token。
- `GET /api/organizations/:organizationId/device-tokens/:tokenId/install-command`：读取某个 token 的安装命令，只有 owner / admin 可用；接口从加密密文解出 token 并返回完整命令，`revoked`、`expired` 或缺少密文的旧 token 不能复制。
- `POST /api/organizations/:organizationId/device-tokens/:tokenId/revoke`：撤销设备 token，只有 owner / admin 可用。
- `POST /api/device-state-snapshots`：Collector 上报 `DeviceStateSnapshot`，使用 device token。
- `GET /api/device-control/ws`：设备连接健康通道，使用 device token。
- `GET /api/device-collector/install.sh` 和 `GET /api/device-collector/files/:fileName`：公开无密钥 installer 与设备包下载入口；鉴权边界在 device token 创建 API 和组织设置页面。

Audit API：

- `GET /api/organizations/:organizationId/audit-events`：列出当前组织审计事件，只有 owner / admin 可用；首版可以只支持时间倒序分页和事件类型筛选。该 API 用于后台排查和后续治理能力，不作为当前组织设置页的前端展示模块。
- 审计事件写入由 auth、invitation、device token 和 collector 鉴权路径内部触发，不提供客户端任意写入 API。

Runtime / Runs 读取 API：

- Console 读取类 API 必须有有效 session。
- 读取 API 按用户所属组织做最小隔离，不在 React 页面里推导权限。

## 邮件发送

邮箱验证码和组织邀请通过可替换的 Email Provider 发送。当前生产实现支持 SMTP 邮箱账号，适配阿里企业邮箱等企业邮箱服务；Sender / Resend 类 HTTP 邮件服务仍属于同一 Provider 边界的可替换实现。SMTP 密码、API key 或客户端安全密码只允许通过环境变量注入。

实现要求：

- 本地测试使用 fake provider，不发真实邮件。
- 开发环境可以输出一次性调试码，但该能力必须由显式环境变量开启。
- 生产环境没有邮件 provider 配置时，发送验证码接口必须失败并给出可排查错误。
- 生产环境没有邮件 provider 配置时，创建邮件邀请必须失败并给出可排查错误，不能静默退化为只生成链接。
- SMTP Provider 使用 `LORUME_EMAIL_PROVIDER=smtp` 开启，读取 `LORUME_SMTP_HOST`、`LORUME_SMTP_PORT`、`LORUME_SMTP_SECURE`、`LORUME_SMTP_USER`、`LORUME_SMTP_PASSWORD` 和 `LORUME_EMAIL_FROM`。
- 发信账号应使用专用系统邮箱，例如 `noreply@lorume.com`；不要使用个人邮箱或管理员邮箱作为验证码发件账号。
- 邀请邮件只包含组织名、目标角色、邀请入口链接和过期说明，不包含 device token、验证码或内部调试信息。
- 邀请入口链接格式为 `/invite/:token`。
- 用户打开邀请链接后，页面可以自动触发验证码发送，但必须避免重复刷新造成多次发送；前端需用页面状态或后端限流保护自动发送。

## UI 规则

- 登录、验证码、创建组织、邀请加入页面使用 shadcn/ui、Tailwind CSS v4 和 `b1FS9kEKH` preset 定义的当前视觉系统：语义 token、冷白/冰蓝背景、现代品牌标识、hairline 边界、低噪声网格和清晰表单层级。
- Console 页面使用同一 token 系统，但优先保证 Runtime Fleet、Runs、组织设置，以及任务中心、通知中心工具抽屉的数据扫描效率。
- 品牌标题、按钮、状态短标签、说明文字和表单均以 Sans 为主；Mono 只用于短技术标签、时间戳和数字，不作为身份页装饰字体。
- 身份页和 Console 的图标使用 `lucide-react` 并通过 shadcn primitives 或 app-owned wrappers 组合；表单输入、按钮、运营概览、导航、刷新、搜索、时间选择和页脚装饰不得使用零散图标体系。
- 不回退复古像素边框、厚黑线、高饱和黄色侧栏、错位阴影、像素 sprite 或装饰性调试文案。
- 登录页的 `/api/me` 匿名会话探测返回 `401` 或 `404` 属于正常未登录状态，不能直接把 `Not Found`、接口错误或调试字段暴露在页面上；其他后端故障仍应展示可读错误，避免把真实服务异常吞掉。
- Auth API 错误必须使用稳定 `error` code，并通过共享错误字典维护用户可读 `message`。前端遇到只有 code 的响应时，也必须映射成可读提示，不能把 `invalid_or_expired_code` 等技术字符串直接展示给用户。
- 组织设置页顶部用组织概览横跨内容区，展示组织名称、slug、当前角色、成员数、待加入邀请数、设备 token 数和已绑定数量，避免空白占位。
- 组织设置页中“成员与邀请”和“设备 Token”并列展示在组织概览下方；不单独展示审计卡片或安装命令卡片。
- 组织设置页生成安装命令时只在“设备 Token”卡片内展示本次安装命令，并提供复制按钮。
- 组织设置页的邀请入口应是“发送邀请”，而不是“创建邀请链接”。发送成功后展示发送状态和受邀邮箱脱敏值，不默认暴露可复制链接。
- 组织设置页发送邀请时支持选择过期时间：一天、一星期、一个月或永不过期。
- 组织设置页应展示待加入邀请记录，包括邮箱、角色、状态、过期时间、重发和撤销操作；已接受邀请不作为待加入记录展示。
- 邀请页登录前可以展示组织名、目标角色、邀请状态和脱敏邮箱；不得展示完整邮箱、邀请 token、邀请创建人内部信息。
- 邀请页未登录时可以自动预填受邀邮箱并自动发送验证码；用户只需填写验证码。已登录但邮箱不匹配时，自动退出当前会话并切换到受邀邮箱验证码流程。
- 邀请页验证码通过后直接加入组织并进入 Console，不再展示单独的“加入组织”确认页。
- 设备 token 管理应以列表呈现 token 摘要。名称列第一行展示 token 名称，第二行展示 `token_id`；设备列展示已绑定设备名，未绑定时展示待绑定，已撤销/过期且无绑定设备时展示已撤销/已过期；安装命令列提供复制完整安装命令按钮；操作列保留撤销。列表不展示明文 token。
- 组织设置页创建设备 token 的输入统一命名为“Token 名称”，用于识别该安装 token；当前安装命令会继续把该值作为默认 `--device-id` 传给 collector。
- 组织概览中提供退出组织入口；唯一 owner 的退出按钮必须禁用，并展示“唯一 Owner 不能退出组织。”。
- owner / admin 可以撤销 token；member 只能看到自己无权管理设备 token 的说明。

## Runtime Profiles

Lorume 前后端共享三个稳定运行模式，避免把 auth 规则散落到页面条件里：

- `production`：默认线上模式。Console 和 Runtime 读取 API 必须要求有效 session 与组织上下文；匿名或组织缺失时前端回到公开首页/登录流程，后端返回 `401`。
- `development`：开发者本地联调模式。权限规则仍与 production 一致，但验证码可以在本地后端日志中输出，便于开发者完成真实登录链路。
- `agent`：自动化验收和本地代理开发模式。只用于本地 harness 或 coding agent 自测，可注入本地 session 进入已验收 Console 页面；不得作为线上默认值，也不得绕过生产后端的 session 校验。

前端使用 `VITE_LORUME_APP_MODE` 配置运行模式；后端使用 `LORUME_APP_MODE`。本地 `npm run dev` 与 `npm run dev:backend` 在未覆盖环境变量时使用 `development`，Playwright Console harness 显式覆盖为 `agent`，生产构建/启动不设置时回到 `production`。

## Harness

后端：

- crypto 测试必须证明验证码、session、invitation token 和 device token 可通过哈希校验；需要后续复制安装命令的 device token secret 必须通过可恢复加密保存，且不会以明文入库。
- store 测试必须覆盖 User -> Organization -> Member -> Invitation -> Session -> Device Token 的核心链路，并覆盖成员退出组织和唯一 owner 退出拒绝。
- store 测试必须覆盖 device token 从 `pending` 到 `occupied`、跨设备复用拒绝、撤销和过期。
- store 测试必须覆盖 invitation 只允许 `member` / `admin`，拒绝 `owner`。
- store 测试必须覆盖审计事件写入，且不包含 token 明文或验证码明文。
- HTTP API 测试必须覆盖发送验证码、登录、`/api/me`、创建组织、退出组织、发送邀请邮件、邀请过期选项、邀请列表、邀请重发、邀请撤销、邀请预览、接受邀请、device token 安装命令复制和 logout。
- Runtime 读取 API 在开启 session 校验时必须拒绝匿名请求。
- Collector / control 在开启 device token 校验时必须拒绝无效 token。
- Collector / control 测试必须覆盖 `occupied` token 只能被已绑定设备继续使用。

前端：

- 登录页、验证码页、创建组织页和邀请加入页必须有组件测试。
- 邀请页测试必须覆盖邀请预览、脱敏邮箱展示、自动发送验证码、邮箱不匹配时自动切换到受邀邮箱验证码流程、过期/撤销/已接受状态和接受成功后切换到目标组织。
- 组织设置页测试必须覆盖发送邀请邮件、邀请过期选项、待加入邀请记录、邀请重发、邀请撤销、拒绝 owner 邀请、设备 token 列表、安装命令复制、撤销和不同角色的管理权限。
- 组织设置页测试必须覆盖成员退出组织、唯一 owner 退出禁用和设备 token 撤销后的列表展示。
- Console 必须被 `/api/me` gate 保护。
- shadcn auth component tests and behavior-focused tests must cover the modern logo, base form/button/badge/token usage, and identity page structure so later pages do not bypass shared shadcn tokens or generated primitives.
- 登录页组件测试必须覆盖初始匿名 `/api/me` 探测 `401` / `404` 不显示错误，同时覆盖非匿名后端故障不被吞掉。
- Playwright Console harness 可以通过 `VITE_LORUME_APP_MODE=agent` 进入已验收页面，专注验证 Runtime Fleet 和 Runs 的布局与交互；Auth 流程由独立组件 harness 覆盖。受保护业务页面需要真实登录串联时，使用单独的 auth-backed Playwright harness，并确保它走正式 API 和组织上下文。
- 已验收的 Runtime Fleet 和 Runs 交互不得因 auth 和视觉改造回退。

## 验收标准

- 未登录用户访问 Console 时进入登录流程。
- 使用邮箱验证码可以登录。
- 无组织用户登录后进入创建组织流程。
- 有待接受邀请的用户可以在登录后通过邀请链接加入组织。
- 管理员发送邀请后，系统通过邮件发送邀请链接；普通邀请不能预设 owner。
- 管理员可以在组织设置页查看待加入邀请并重发或撤销邮件；重发后旧邀请链接不可继续使用，撤销后邀请链接不可加入组织。
- 邀请链接打开后，未登录用户看到组织名、目标角色、脱敏邮箱和可用状态，并使用自动预填的受邀邮箱完成验证码登录。
- 登录用户可以查看 Console；logout 后不能继续访问 Console API。
- 设备 token 明文不入列表、不入日志；历史 token 可由 owner / admin 通过受保护接口复制完整安装命令，接口必须从加密密文恢复 token。
- 设备 token 初始为 `pending`，首次成功上报后变为 `occupied` 并绑定一台设备。
- `occupied` token 被其他设备复用时必须拒绝，且写入审计日志。
- 撤销或过期 token 无法上报。
- 邀请、登录和设备 token 安全事件应进入后端审计日志；当前组织设置页不展示审计日志。
- Auth/access 规则变化必须同步更新本 spec、对应后端/前端实现和 auth harness。
