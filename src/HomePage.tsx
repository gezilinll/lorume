import { PixelIcon, type PixelIconName } from "./ui/PixelIcon";
import { PixelLogo } from "./ui/PixelLogo";

const platformTags = ["OpenClaw", "Multica", "Slock", "Codex", "DingTalk"];

const overviewStats = [
  { detail: "Device / Runtime / Agent", label: "资产对象", value: "5 类" },
  { detail: "最近 24 小时成功率", label: "Runs 健康度", value: "96.3%" },
  { detail: "需要人工确认", label: "待处理任务", value: "2" },
  { detail: "未读与恢复通知", label: "通知线程", value: "5" },
] as const;

const networkLayers = [
  { items: ["Device", "Runtime", "Agent"], title: "运行资产层" },
  { items: ["DingTalk", "Slack", "Telegram"], title: "工作状态层" },
  { items: ["Operations", "Notifications", "Access"], title: "治理编排层" },
] as const;

const consoleCards: Array<{ detail: string; icon: PixelIconName; title: string }> = [
  { detail: "设备、Runtime、Agent 的采集状态、归属关系和最近活动。", icon: "server", title: "Runtime Fleet" },
  { detail: "任务上下文优先的会话任务视图，不暴露原始 payload。", icon: "chart", title: "Runs" },
  { detail: "组织成员、邀请链接和角色边界。", icon: "shield", title: "组织设置" },
];

export function HomePage() {
  return (
    <main className="homePage">
      <header className="homeHeader">
        <PixelLogo />
        <nav aria-label="首页导航" className="homeNav">
          <a href="/login">登录</a>
          <a href="/runs">查看看板</a>
        </nav>
      </header>

      <section className="homeHero" aria-labelledby="home-title">
        <div className="homeHero__copy">
          <p className="homeEyebrow">Agent Network Control Plane</p>
          <h1 className="homeTitle" id="home-title">
            把分散的 Agent 变成可运营的工作网络。
          </h1>
          <p className="homeLead">
            Lorume 统一管理组织里的 Device、Runtime、Agent、Channel 与工作项状态，让 OpenClaw、Multica、Slock、Codex 等运行资产进入同一个可观测、可治理、可复用的控制面。
          </p>
          <div className="homeActions">
            <a className="homeButton homeButton--primary" href="/login">
              开始使用
              <span aria-hidden="true">-&gt;</span>
            </a>
            <a className="homeButton homeButton--secondary" href="/runs">
              查看看板
            </a>
          </div>
          <div className="homePlatformTags" aria-label="当前接入对象">
            {platformTags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
          <section className="homeHeroStats" aria-label="运营总览">
            {overviewStats.map((stat) => (
              <div className="homeHeroStat" key={stat.label}>
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
                <small>{stat.detail}</small>
              </div>
            ))}
          </section>
        </div>

        <section className="homeNetwork" aria-label="Agent 网络结构预览">
          <div className="homeNetwork__header">
            <span>CONTROL SURFACE</span>
            <strong>Live product surface</strong>
          </div>
          <div className="homeNetwork__canvas">
            {networkLayers.map((layer) => (
              <div className="homeNetworkLayer" key={layer.title}>
                <h2>{layer.title}</h2>
                <div>
                  {layer.items.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="homeNetwork__footer">
            <span>可观测</span>
            <span>可治理</span>
            <span>可复用</span>
          </div>
        </section>
      </section>

      <section className="homeConsole" aria-label="Lorume 控制台预览">
        <div className="homeConsole__bar">
          <span>Lorume Console</span>
          <span>Live preview</span>
        </div>
        <div className="homeConsole__body">
          <nav className="homeConsole__menu" aria-label="预览导航">
            <strong>Runtime</strong>
            <span>Runs</span>
            <span>Settings</span>
          </nav>
          <div className="homeConsole__content">
            <div className="homeConsole__stats">
              <MetricCard value="5" label="在线 Runtime" />
              <MetricCard value="17" label="可用 Agent" />
              <MetricCard value="883" label="工作项快照" />
            </div>
            <div className="homeConsole__lanes">
              <LanePreview title="待处理" count="42" cards={["同步成本数据", "新增日报口径"]} />
              <LanePreview title="处理中" count="6" cards={["修复记录异常", "反馈聚类"]} />
              <LanePreview title="需关注" count="3" cards={["心跳延迟", "状态待确认"]} />
            </div>
          </div>
        </div>
      </section>

      <section className="homeOpsGrid" aria-label="当前能力">
        {consoleCards.map((card) => (
          <article className="homeOpsCard" key={card.title}>
            <span className="homeOpsCard__icon" aria-hidden="true">
              <PixelIcon name={card.icon} size={20} />
            </span>
            <h2>{card.title}</h2>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="homeMetric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function LanePreview({ cards, count, title }: { cards: string[]; count: string; title: string }) {
  return (
    <section className="homeLane" aria-label={title}>
      <header>
        <span>{title}</span>
        <strong>{count}</strong>
      </header>
      {cards.map((card) => (
        <article key={card}>
          <PixelIcon name="bot" size={16} />
          <span>{card}</span>
        </article>
      ))}
    </section>
  );
}
