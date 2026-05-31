import { Activity, ArrowRight, Bell, Bot, CalendarClock, ClipboardList, KeyRound, Layers3, MessageSquareText, RadioTower, Server, Settings2, ShieldCheck } from "lucide-react";

import { LorumeLogo } from "@/components/brand/LorumeLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const capabilityCards = [
  {
    description: "按 Device、Runtime、Agent 组织运行资产，查看采集健康、在线状态和最近活动。",
    href: "/runtime",
    icon: Server,
    tone: "bg-primary/10 text-primary",
    title: "Runtime Fleet",
  },
  {
    description: "以会话 Task 为中心查看工作项状态、Channel、用户消息和 Agent 回复。",
    href: "/runs",
    icon: MessageSquareText,
    tone: "bg-[var(--cyan-soft)] text-[var(--cyan-foreground)]",
    title: "Runs",
  },
  {
    description: "汇总 Runtime 上报的定时定义，查看计划、下次运行和多次执行历史。",
    href: "/scheduled-tasks",
    icon: CalendarClock,
    tone: "bg-[var(--orange-soft)] text-[var(--orange-foreground)]",
    title: "定时任务",
  },
  {
    description: "聚合 Runtime 与 Agent 上报的 Skill 元数据，按 Scope、来源、状态和归属筛选。",
    href: "/skills",
    icon: Layers3,
    tone: "bg-[var(--purple-soft)] text-[var(--purple-foreground)]",
    title: "Skill 仓库",
  },
  {
    description: "管理当前组织上下文、成员邀请、设备 token 和 collector 安装入口。",
    href: "/settings",
    icon: Settings2,
    tone: "bg-[var(--green-soft)] text-[var(--green-foreground)]",
    title: "组织设置",
  },
] as const;

const operatingSignals = [
  { icon: RadioTower, label: "设备采集", value: "同步 Device / Runtime / Agent / Task / Schedule" },
  { icon: Bot, label: "Skill 仓库", value: "只读汇总 Runtime 与 Agent Skill 元数据" },
  { icon: ClipboardList, label: "异步任务", value: "查看 Operation 状态和 Job 明细" },
  { icon: Bell, label: "通知线程", value: "跟踪采集、同步和恢复提醒" },
] as const;

const platformBadges = ["OpenClaw", "Slock", "Codex", "DingTalk", "Postgres backend"] as const;

export function HomePage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <LorumeLogo />
        <nav aria-label="首页导航" className="flex items-center justify-end">
          <Button variant="outline" size="sm" asChild>
            <a href="/login">登录</a>
          </Button>
        </nav>
      </header>

      <section className="mx-auto grid w-full max-w-7xl gap-10 px-4 pb-12 pt-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_28rem] lg:px-8 lg:pb-16 lg:pt-14" aria-labelledby="home-title">
        <div className="flex flex-col justify-center gap-7">
          <div className="flex flex-wrap gap-2" aria-label="当前接入能力">
            {platformBadges.map((badge) => (
              <Badge variant="secondary" key={badge}>
                {badge}
              </Badge>
            ))}
          </div>

          <div className="space-y-5">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">Agent Network Control Plane</p>
            <h1 className="max-w-4xl text-4xl font-semibold leading-tight text-balance sm:text-5xl lg:text-6xl" id="home-title">
              Lorume 把分散的 Agent 变成可运营的工作网络。
            </h1>
            <p className="max-w-3xl text-base leading-8 text-muted-foreground sm:text-lg">
              Lorume 是面向生产环境的人机协作控制面，聚合运行设备、Runtime、Agent、会话任务、组织访问、异步状态和通知线程，让团队看清 Agent Network 正在怎样工作。
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button size="lg" asChild>
              <a href="/runtime">
                进入控制台
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          </div>
        </div>

        <Card className="self-stretch border-border/70 bg-card/80 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-5 text-primary" aria-hidden="true" />
              当前控制面
            </CardTitle>
            <CardDescription>已落地的采集、查询、访问和状态可见性。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {operatingSignals.map((signal) => {
              const Icon = signal.icon;
              return (
                <div className="flex gap-3 rounded-lg border border-border/70 bg-background/70 p-3" key={signal.label}>
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">{signal.label}</p>
                    <p className="text-sm leading-6 text-muted-foreground">{signal.value}</p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </section>

      <section aria-label="当前已实现能力" className="border-t bg-muted/30">
        <div className="mx-auto grid w-full max-w-7xl items-stretch gap-4 px-4 py-12 sm:px-6 sm:grid-cols-2 lg:grid-cols-3 lg:px-8 xl:grid-cols-5">
          {capabilityCards.map((capability) => {
            const Icon = capability.icon;
            return (
              <Card className="flex h-full border-border/70 bg-card" key={capability.title}>
                <CardHeader className="flex-1">
                  <div className={`mb-2 flex size-10 items-center justify-center rounded-lg ${capability.tone}`} aria-hidden="true">
                    <Icon className="size-5" />
                  </div>
                  <CardTitle>{capability.title}</CardTitle>
                  <CardDescription className="line-clamp-3">{capability.description}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto">
                  <Button variant="outline" size="sm" asChild>
                    <a href={capability.href}>
                      打开 {capability.title}
                      <ArrowRight aria-hidden="true" />
                    </a>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-12 sm:px-6 md:grid-cols-2 lg:px-8">
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
              组织边界
            </CardTitle>
            <CardDescription>邮箱验证码登录、组织成员关系、邀请和设备 token 已进入同一访问模型。</CardDescription>
          </CardHeader>
        </Card>
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" aria-hidden="true" />
              生产化后端
            </CardTitle>
            <CardDescription>Standalone backend、Postgres 查询 API、Docker / Nginx 部署形态和设备 WebSocket 心跳已具备基础闭环。</CardDescription>
          </CardHeader>
        </Card>
      </section>
    </main>
  );
}
