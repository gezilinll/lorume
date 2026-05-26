# Interaction

Lorume 交互优先让用户知道当前状态、下一步动作和操作结果。

## Required States

所有交互组件至少考虑：

- Default
- Hover
- Focus-visible
- Active
- Disabled
- Loading
- Error
- Success 或 completed

不一定每个组件都需要复杂视觉，但状态不能缺失到用户无法判断。

## Forms

- 表单有明确 label、输入示例、错误提示和 loading 状态。
- 邮箱验证码登录需要表达验证码已发送、过期、重发、错误和成功。
- 邀请链接需要表达有效、过期、邮箱不匹配、已加入组织。

## Navigation

- 导航只展示已实现页面。
- 当前页面状态要明确。
- 深链路由可直接访问，未登录时进入登录流程。
- 登录后返回用户原本要访问的页面。

## Filtering

- 筛选项名称使用用户理解的业务语言。
- Runtime 和 Channel 保持分离。
- `全部` 可以用于选项值，label 负责说明字段含义。
- 时间筛选优先使用 shadcn Calendar 的 Date Picker Range 形态；需要支持自定义范围、清除和点击外部关闭，不在紧凑筛选弹窗里拆成两个独立时间输入。

## Feedback

- 用户触发刷新、登录、发送验证码等动作后必须有即时反馈。
- 后端当前无法获取的数据应显示用户可理解的 `异常`、`不支持采集` 等语义，不显示技术解释；Runtime Fleet 资产状态不展示 `未知`。前端不能为后端未提供的执行关联关系合成状态。
- 能自动恢复的错误优先提供重试；危险操作优先提供撤销或明确确认。

## Keyboard

- 表单、按钮、选择器、时间弹窗和导航需要可键盘操作。
- Focus ring 必须可见，不能被 reset 或 overflow 裁掉。
