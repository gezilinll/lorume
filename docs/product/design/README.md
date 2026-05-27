# Lorume Design Specs

本目录是 Lorume 当前设计系统与页面体验的 source of truth。所有 UI 变更都应先判断涉及哪个设计维度，再更新对应规范和实现。

## Reading Order

设计或修改页面时按下面顺序阅读：

1. [principles.md](principles.md): 总体设计原则和取舍顺序。
2. [shadcn-ui-system.md](shadcn-ui-system.md): shadcn/ui setup, theme, generated component, and wrapper rules.
3. [surface-register.md](surface-register.md): 页面类型和视觉强度边界。
4. [visual-language.md](visual-language.md): shadcn/ui + Tailwind v4 视觉语言。
5. [tokens.md](tokens.md): 设计 token 组织方式。
6. 按需阅读字体、颜色、布局、组件、图标、交互、动效、文案、响应式和页面规范。
7. [review-and-harness.md](review-and-harness.md): 自我 Review 和 harness 规则。

## Spec Map

| Spec | Responsibility |
|---|---|
| [principles.md](principles.md) | 产品级设计原则、反模式、取舍顺序 |
| [shadcn-ui-system.md](shadcn-ui-system.md) | shadcn/ui setup, theme, generated component, and wrapper rules |
| [surface-register.md](surface-register.md) | Brand Surface、Identity Surface、Console Surface 的规则 |
| [visual-language.md](visual-language.md) | shadcn/ui + Tailwind v4 的视觉目标、构图、氛围和禁区 |
| [tokens.md](tokens.md) | token 分层、命名、修改规则和代码映射 |
| [typography.md](typography.md) | Sans、Mono 字体分工和排版规则 |
| [color.md](color.md) | 色彩系统、语义色、对比度和配色禁区 |
| [layout.md](layout.md) | 间距、栅格、面板、卡片、密度和溢出控制 |
| [components.md](components.md) | 当前组件族的视觉、状态和使用规则 |
| [icons-and-assets.md](icons-and-assets.md) | Logo、icon、低噪声装饰、图片和资产来源 |
| [interaction.md](interaction.md) | 交互状态、表单、反馈、键盘和错误处理 |
| [motion.md](motion.md) | 动效目的、时长、缓动和 reduced motion |
| [content-and-terminology.md](content-and-terminology.md) | 文案、术语、标签、错误信息和中英文边界 |
| [responsive-and-accessibility.md](responsive-and-accessibility.md) | 响应式、可访问性、长文本和边界状态 |
| [page-patterns.md](page-patterns.md) | 当前页面的页面级视觉和交互规则 |
| [taskflow-ui-redesign.md](taskflow-ui-redesign.md) | Taskflow 视觉大改版的落地边界、前置数据契约、spec/harness 更新和验收规则 |
| [runs-sidebar-filter-redesign.md](runs-sidebar-filter-redesign.md) | Runs 大屏间距、取消泳道隐藏、Sidebar 组织/账号菜单和筛选交互的落地规则 |
| [review-and-harness.md](review-and-harness.md) | 截图 Review、CSS/token Review 和测试责任 |

## Relationship To Product Specs

- [../ui-design.md](../ui-design.md) 定义产品对象、信息架构、用户动线和页面职责。
- 本目录定义视觉语言、设计系统、页面体验和 UI 自验规则。
- 页面 TinySpec 继续定义具体页面的数据、行为和验收标准。
- [../../../AGENTS.md](../../../AGENTS.md) 是 coding agent 操作指南，只保留设计工作的阅读顺序和执行规则。

## Update Rules

- 视觉规则变化先更新本目录，再更新代码。
- 新页面先登记到 [surface-register.md](surface-register.md) 和 [page-patterns.md](page-patterns.md)。
- 新组件先确认能否复用现有组件；确实需要新增时更新 [components.md](components.md) 和 token。
- 不把临时探索、设计过程、团队推进计划、个人偏好记录进本目录。
