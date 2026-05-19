import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthLayout } from "./AuthLayout";
import { PixelBadge } from "./PixelBadge";
import { PixelButton } from "./PixelButton";
import { PixelField } from "./PixelField";
import { PixelLogo } from "./PixelLogo";
import { PixelPanel } from "./PixelPanel";
import { AuthOperationsPreview } from "../auth/auth-preview";

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
    const iconSource = readFileSync("src/ui/PixelIcon.tsx", "utf8");
    const decorationsSource = readFileSync("src/ui/PixelDecorations.tsx", "utf8");
    const styles = `${tokens}\n${appStyles}`;

    expect(tokens).toContain("--font-sans:");
    expect(tokens).toContain("--font-mono:");
    expect(tokens).toContain("--lorume-color-bg: #f7f9fb");
    expect(tokens).toContain("--lorume-color-action: #245bff");
    expect(tokens).toContain("--lorume-color-accent: #12a7a2");
    expect(tokens).toContain("--lorume-border-hairline: 1px solid var(--lorume-color-line)");
    expect(tokens).toContain("--lorume-radius-lg: 18px");
    expect(tokens).toContain("JetBrains Mono");
    expect(styles).toMatch(/\.pixel-button\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.auth-layout\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.auth-copy\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.auth-preview__metric\s*{[^}]*font-family:\s*var\(--font-mono\)/s);
    expect(styles).toMatch(/\.navItem\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.primaryButton\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.toolbarField select\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.metricCard strong\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.workCard strong\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).toMatch(/\.detailBlock p,\n\.detailBlock li\s*{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(styles).not.toContain("box-shadow: 7px 7px 0");
    expect(iconSource).not.toContain("pixelarticons");
    expect(iconSource).not.toContain("crispEdges");
    expect(decorationsSource).not.toContain("shapeRendering");
    expect(decorationsSource).not.toContain("PixelSprite");
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
    const buttonIcon = screen.getByTestId("pixel-button-icon").querySelector("svg");
    expect(buttonIcon).toHaveAttribute("data-pixel-icon", "paper-plane");
    expect(buttonIcon).not.toHaveAttribute("shape-rendering");
    expect(screen.getByText("在线")).toHaveClass("pixel-badge--success");
  });

  it("renders operational preview icons from the shared product icon system", () => {
    render(<AuthOperationsPreview />);

    expect(screen.getByLabelText("运营概览").querySelector('[data-pixel-icon="server"]')).toBeInTheDocument();
    expect(screen.getByLabelText("运营概览").querySelector('[data-pixel-icon="chart"]')).toBeInTheDocument();
    expect(screen.getByLabelText("运营概览").querySelector('[data-pixel-icon="shield"]')).toBeInTheDocument();
  });

  it("composes an auth layout with brand, content, preview, and notice regions", () => {
    render(
      <AuthLayout
        title="登录 Lorume"
        subtitle="使用团队邮箱接收验证码"
        preview={<div>Runtime Fleet</div>}
        notice="登录后可统一管理组织内 Device、Runtime、Agent 与工作看板。"
      >
        <PixelButton>继续</PixelButton>
      </AuthLayout>,
    );

    expect(screen.getByRole("banner")).toContainElement(screen.getByLabelText("Lorume"));
    expect(screen.queryByTestId("auth-pixel-decorations")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "登录 Lorume" })).toBeInTheDocument();
    expect(screen.getByText("Runtime Fleet")).toBeInTheDocument();
    expect(screen.getByText(/Device、Runtime、Agent/)).toBeInTheDocument();
  });
});
