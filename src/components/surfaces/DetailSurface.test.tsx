import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailSection, DetailSurface } from "./DetailSurface";

describe("DetailSurface", () => {
  it("renders an accessible focused detail dialog", () => {
    render(
      <DetailSurface
        description="进行中 · DingTalk"
        meta={<span>进行中</span>}
        onOpenChange={vi.fn()}
        open
        title="任务详情"
      >
        <DetailSection title="任务上下文">
          <p>承接 Agent: main</p>
        </DetailSection>
      </DetailSurface>,
    );

    const dialog = screen.getByRole("dialog", { name: "任务详情" });
    expect(dialog).toHaveAttribute("data-surface", "detail");
    expect(dialog).toHaveAttribute("data-intensity", "focus");
    expect(dialog).toHaveClass("motion-reduce:transform-none");
    expect(document.querySelector("[data-slot='dialog-overlay']")).toHaveClass("backdrop-blur-[2px]");
    expect(screen.getByText("任务详情").closest("[data-slot='dialog-title']")).toHaveClass("leading-6");
    expect(screen.getByText("进行中 · DingTalk")).toBeInTheDocument();
    expect(screen.getByText("任务上下文")).toBeInTheDocument();
    expect(screen.getByText("承接 Agent: main")).toBeInTheDocument();
  });

  it("keeps modal depth centered and uses a restrained pointer-driven 3D range", () => {
    render(
      <DetailSurface
        depth="modal-3d"
        depthIntensity="modal-3d"
        onOpenChange={vi.fn()}
        open
        title="任务详情"
      >
        <DetailSection title="用户消息">Inspect handoff</DetailSection>
      </DetailSurface>,
    );

    const dialog = screen.getByRole("dialog", { name: "任务详情" });
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 400,
      left: 100,
      right: 700,
      top: 100,
      width: 600,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });

    const plane = dialog.querySelector('[data-depth-plane="true"]');
    expect(plane).toBeInstanceOf(HTMLElement);
    expect(plane).toHaveStyle({ transformStyle: "preserve-3d" });
    expect(plane).toContainElement(screen.getByRole("button", { name: /close/i }));

    fireEvent.pointerMove(dialog, { clientX: 1000, clientY: 500 });

    expect(dialog.style.getPropertyValue("--detail-rotate-x")).toBe("-4deg");
    expect(dialog.style.getPropertyValue("--detail-rotate-y")).toBe("4deg");
    expect(dialog.style.getPropertyValue("--detail-scale")).toBe("1.01");
    expect((plane as HTMLElement).style.transform).toContain("rotateX(-4deg)");
    expect((plane as HTMLElement).style.transform).toContain("rotateY(4deg)");
  });
});
