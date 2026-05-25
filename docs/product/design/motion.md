# Motion

动效服务状态理解和品牌节奏，不做炫技。

## Motion Roles

- Brand Surface: 可使用轻量进入、产品预览层级和按钮反馈等品牌动效。
- Identity Surface: 可使用输入反馈、验证码发送反馈、邀请状态转换。
- Console Surface: 只使用帮助理解状态变化的动效。

## Timing

- 微交互：100 到 180ms。
- 常规状态变化：180 到 300ms。
- 页面级进入：300 到 500ms。

超过 500ms 的动效必须有明确价值。

## Easing

- UI 状态变化使用 ease-out 或接近的自然缓动。
- 避免弹性、夸张 bounce 和持续晃动。

## Performance

- 优先动画 opacity 和 transform。
- 不随意动画 width、height、top、left、margin 等布局属性。
- 动效不能导致列表、看板或详情面板重排抖动。
- Runs 任务卡使用 card-16-like spotlight hover，强度必须低于品牌展示页，且只能帮助识别可点击对象。任务卡 hover 参数以 `translateY(-1px)`、`0 10px 24px rgba(15, 23, 42, 0.075)` 和局部 `76px` primary glow 为上限；channel pill 不得被 hover 容器裁切。
- DetailSurface 可使用 pointer-driven 3D 浮层，但 3D 应作用在内部可视卡片层，不作用在 Radix DialogContent 定位层。详情卡旋转上限为 `6deg`，缩放上限为 `1.015`，使用 `perspective(1000px)`，不做夸张旋转或从右下角进入的位移动画。
- Utility drawer、Dialog、Popover 的进入退出保持短促，不使用背景 blur 或大幅位移。

## Reduced Motion

尊重 `prefers-reduced-motion`。减少动效时仍要保留状态反馈。
