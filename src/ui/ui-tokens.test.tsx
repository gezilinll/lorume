import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PixelBadge } from "./PixelBadge";
import { PixelButton } from "./PixelButton";
import { PixelField } from "./PixelField";
import { PixelLogo } from "./PixelLogo";
import { PixelPanel } from "./PixelPanel";
import { AuthOperationsPreview } from "../auth/auth-preview";
import { AuthPageShell } from "../auth/AuthPageShell";

describe("Glacier Premium Precision UI primitives", () => {
  it("renders the pixel logo with an accessible brand label", () => {
    render(<PixelLogo />);

    expect(screen.getByLabelText("Lorume")).toBeInTheDocument();
    expect(screen.getByText("Lorume")).toHaveClass("pixel-logo__wordmark");
    const mark = screen.getByTestId("pixel-logo-mark").querySelector("svg");
    expect(mark).toHaveClass("pixel-logo__svg");
    expect(mark).toHaveAttribute("data-logo-mark", "lorume-neural-lumen");
    expect(mark).toHaveAttribute("data-logo-version", "lorume-v1");
  });

  it("keeps the browser tab metadata aligned with the shared brand mark", () => {
    const favicon = readFileSync("public/favicon.svg", "utf8");
    const indexHtml = readFileSync("index.html", "utf8");

    expect(favicon).toContain('data-logo-mark="lorume-neural-lumen"');
    expect(favicon).toContain('data-logo-version="lorume-v1"');
    expect(indexHtml).toContain("<title>Lorume</title>");
  });

  it("defines the current sans, mono, color, radius, border, and shadow roles", () => {
    const tokens = readFileSync("src/ui/tokens.css", "utf8");
    const appStyles = readFileSync("src/styles.css", "utf8");
    const styles = `${tokens}\n${appStyles}`;

    expect(tokens).toContain("--font-sans:");
    expect(tokens).toContain("--font-mono:");
    expect(tokens).toContain("--lorume-color-bg: #f8fafc");
    expect(tokens).toContain("--lorume-color-action: #2563eb");
    expect(tokens).toContain("--lorume-color-accent: #0f9f9a");
    expect(tokens).toContain("--lorume-border-hairline: 1px solid var(--lorume-color-line)");
    expect(tokens).toContain("--lorume-radius-lg: 18px");
    expect(tokens).toContain("JetBrains Mono");
    expect(styles).toMatch(/\.pixel-button\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.auth-layout\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.auth-copy\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.auth-preview__metric\s*{[^}]*font-family:\s*var\(--font-mono\)/s);
    expect(styles).toMatch(/\.navItem\s*{[^}]*font-family:\s*var\(--font-mono\)/s);
    expect(styles).toMatch(/\.primaryButton\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.toolbarField select\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.metricCard strong\s*{[^}]*font-family:\s*var\(--font-mono\)/s);
    expect(styles).toMatch(/\.workCard strong\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.detailBlock p,\n\.detailBlock li\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.badge\s*{[^}]*color:\s*var\(--lorume-color-muted\)/s);
    expect(styles).toMatch(/\.statusBadge\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.searchBox input:focus\s*{[^}]*box-shadow:\s*none/s);
    expect(styles).not.toContain("box-shadow: 7px 7px 0");
  });

  it("renders buttons, badges, panels, and fields with token classes", () => {
    render(
      <PixelPanel title="登录">
        <PixelField icon="mail" label="邮箱" name="email" placeholder="name@company.com" />
        <PixelButton type="button" icon="paper-plane">
          发送验证码
        </PixelButton>
        <PixelBadge tone="success">在线</PixelBadge>
      </PixelPanel>,
    );

    expect(screen.getByRole("group", { name: "登录" })).toHaveClass("pixel-panel");
    expect(screen.getByRole("group", { name: "登录" })).toHaveAttribute("data-panel-style", "precision-surface");
    expect(screen.getByLabelText("邮箱")).toHaveAttribute("name", "email");
    expect(screen.getByLabelText("邮箱").parentElement?.querySelector('[data-pixel-icon="mail"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送验证码" })).toHaveClass("pixel-button");
    expect(screen.getByTestId("pixel-button-icon").querySelector("svg")).toHaveAttribute("data-pixel-icon", "paper-plane");
    expect(screen.getByText("在线")).toHaveClass("pixel-badge--success");
  });

  it("renders operational preview without legacy pixel icons", () => {
    const { container } = render(<AuthOperationsPreview />);

    expect(screen.getByLabelText("运营概览")).toBeInTheDocument();
    expect(screen.getByText("在线")).toBeInTheDocument();
    expect(screen.getByText("工作中")).toBeInTheDocument();
    expect(screen.getByText("健康")).toBeInTheDocument();
    expect(container.querySelectorAll(".auth-preview__status")).toHaveLength(3);
    expect(container.querySelector("[data-pixel-icon]")).not.toBeInTheDocument();
  });

  it("composes an auth layout with brand, content, preview, and notice regions", () => {
    const { container } = render(
      <AuthPageShell
        title="登录 Lorume"
        subtitle="使用团队邮箱接收验证码"
        preview={<div>Runtime Fleet</div>}
        notice="登录后可统一管理组织内 Device、Runtime、Agent 与会话任务。"
      >
        <PixelButton>继续</PixelButton>
      </AuthPageShell>,
    );

    expect(screen.getByRole("banner")).toContainElement(screen.getByLabelText("Lorume"));
    expect(container.querySelector(".auth-page-shell__card")).toBeInTheDocument();
    expect(container.querySelector(".auth-page-shell__card-content")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-pixel-decorations")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "登录 Lorume" })).toBeInTheDocument();
    expect(screen.getByText("Runtime Fleet")).toBeInTheDocument();
    expect(screen.getByText(/Device、Runtime、Agent/)).toBeInTheDocument();
  });
});
