import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export type InteractiveSurfaceIntensity = "none" | "subtle" | "lift" | "focus";
export type InteractiveSurfaceDepthIntensity = "none" | "subtle-3d" | "modal-3d";

const intensityClass: Record<InteractiveSurfaceIntensity, string> = {
  none: "",
  subtle: "hover:border-foreground/20 hover:bg-muted/40",
  lift:
    "hover:-translate-y-0.5 hover:rotate-x-[0.7deg] hover:shadow-[0_14px_32px_rgba(15,23,42,0.08)] hover:border-foreground/20",
  focus: "shadow-[0_18px_48px_rgba(15,23,42,0.12)]",
};

const depthIntensityClass: Record<InteractiveSurfaceDepthIntensity, string> = {
  none: "",
  "subtle-3d":
    "perspective-[1000px] hover:translate-y-[-3px] hover:rotate-x-[1.2deg] hover:rotate-y-[-0.8deg] hover:shadow-[0_18px_45px_rgba(15,23,42,0.10)]",
  "modal-3d":
    "perspective-[1200px] translate-y-[-2px] rotate-x-[0.4deg] shadow-[0_36px_120px_rgba(15,23,42,0.22)]",
};

export const InteractiveSurface = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & {
    depth?: string;
    depthIntensity?: InteractiveSurfaceDepthIntensity;
    intensity?: InteractiveSurfaceIntensity;
  }
>(function InteractiveSurface({ className, depth, depthIntensity = "none", intensity = "subtle", ...props }, ref) {
  return (
    <div
      data-depth={depth}
      data-depth-intensity={depthIntensity}
      data-intensity={intensity}
      data-surface="interactive"
      ref={ref}
      className={cn(
        "min-w-0 rounded-[var(--radius)] border border-border bg-card text-card-foreground outline-none transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out transform-gpu focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none",
        intensityClass[intensity],
        depthIntensityClass[depthIntensity],
        className,
      )}
      {...props}
    />
  );
});
