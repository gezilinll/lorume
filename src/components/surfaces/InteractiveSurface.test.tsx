import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InteractiveSurface } from "./InteractiveSurface";

describe("InteractiveSurface", () => {
  it("marks clickable surfaces with stable interaction attributes", () => {
    render(
      <InteractiveSurface
        aria-label="任务卡片"
        depth="task-card"
        depthIntensity="subtle-3d"
        intensity="lift"
        role="button"
      >
        Execute OpenClaw run
      </InteractiveSurface>,
    );

    const surface = screen.getByRole("button", { name: "任务卡片" });
    expect(surface).toHaveAttribute("data-surface", "interactive");
    expect(surface).toHaveAttribute("data-intensity", "lift");
    expect(surface).toHaveAttribute("data-depth", "task-card");
    expect(surface).toHaveAttribute("data-depth-intensity", "subtle-3d");
    expect(surface.className).toContain("hover:translate-y-[-3px]");
    expect(surface.className).toContain("hover:rotate-x-[1.2deg]");
    expect(surface.className).toContain("hover:rotate-y-[-0.8deg]");
    expect(surface).toHaveClass("motion-reduce:transform-none");
    expect(surface).toHaveClass("motion-reduce:transition-none");
  });

  it("keeps non-lift surfaces flat while preserving focus affordance", () => {
    render(
      <InteractiveSurface aria-label="资产行" intensity="none" role="button">
        fixture-device
      </InteractiveSurface>,
    );

    const surface = screen.getByRole("button", { name: "资产行" });
    expect(surface).toHaveAttribute("data-intensity", "none");
    expect(surface).toHaveClass("focus-visible:ring-2");
  });
});
