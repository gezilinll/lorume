import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pill } from "./Pill";
import { StatusBadge } from "./StatusBadge";

describe("Pill", () => {
  function pillByText(text: string) {
    const pill = screen.getByText(text).closest("[data-pill-kind]");
    expect(pill).not.toBeNull();
    return pill as HTMLElement;
  }

  it("renders a compact semantic pill with stable data attributes", () => {
    render(
      <Pill kind="status" tone="success" title="在线">
        在线
      </Pill>,
    );

    const pill = pillByText("在线");
    expect(pill).toHaveAttribute("data-pill-kind", "status");
    expect(pill).toHaveAttribute("data-pill-tone", "success");
    expect(pill).toHaveClass("h-6");
    expect(pill).toHaveClass("leading-4");
    expect(pill).toHaveClass("whitespace-nowrap");
    expect(pill).toHaveClass("truncate");
  });

  it("supports icon content without changing the semantic label", () => {
    render(
      <Pill
        icon={<span aria-hidden="true">i</span>}
        kind="channel"
        tone="info"
      >
        DingTalk
      </Pill>,
    );

    const pill = pillByText("DingTalk");
    expect(pill).toHaveAttribute("data-pill-kind", "channel");
    expect(pill).toHaveAttribute("data-pill-tone", "info");
  });

  it("keeps StatusBadge compatible while delegating to Pill", () => {
    render(<StatusBadge tone="info">同步中</StatusBadge>);

    const badge = pillByText("同步中");
    expect(badge).toHaveAttribute("data-pill-kind", "status");
    expect(badge).toHaveAttribute("data-pill-tone", "info");
  });
});
