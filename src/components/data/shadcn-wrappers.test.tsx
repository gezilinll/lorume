import { render, screen } from "@testing-library/react";
import { Server } from "lucide-react";
import { describe, expect, it } from "vitest";
import { LorumeLogo } from "@/components/brand/LorumeLogo";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./EmptyState";
import { MetricCard } from "./MetricCard";
import { StatusBadge } from "./StatusBadge";
import { PageHeader } from "../layout/PageHeader";

describe("shadcn app wrappers", () => {
  it("renders logo, page headers, semantic badges, metrics, and empty states", () => {
    render(
      <>
        <LorumeLogo />
        <PageHeader
          eyebrow="控制台"
          title="运行时"
          description={
            <>
              查看 <a href="/runtime">Runtime Fleet</a>
            </>
          }
          actions={<Button type="button">刷新</Button>}
        />
        <StatusBadge tone="success">在线</StatusBadge>
        <MetricCard icon={<Server aria-hidden="true" />} label="设备" value="4" />
        <EmptyState
          title="暂无任务"
          description={
            <>
              当前筛选条件下没有<a href="/runs">会话任务</a>。
            </>
          }
        />
      </>,
    );

    expect(screen.getByLabelText("Lorume")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "运行时", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("控制台")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runtime Fleet" })).toBeInTheDocument();
    expect(screen.getByText("在线")).toBeInTheDocument();
    expect(screen.getByText("设备")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "暂无任务" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "会话任务" })).toBeInTheDocument();
  });
});
