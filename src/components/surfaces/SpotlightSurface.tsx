import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export const SpotlightSurface = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & {
    spotlight?: string;
  }
>(function SpotlightSurface({ children, className, onPointerEnter, onPointerLeave, onPointerMove, spotlight = "surface", style, ...props }, ref) {
  function handlePointerEnter(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.style.boxShadow = "0 10px 24px rgba(15, 23, 42, 0.075)";
    onPointerEnter?.(event);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--spotlight-x", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--spotlight-y", `${event.clientY - rect.top}px`);
    onPointerMove?.(event);
  }

  function handlePointerLeave(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.style.setProperty("--spotlight-x", "50%");
    event.currentTarget.style.setProperty("--spotlight-y", "50%");
    event.currentTarget.style.boxShadow = "";
    onPointerLeave?.(event);
  }

  return (
    <div
      data-spotlight={spotlight}
      data-surface="spotlight-card"
      ref={ref}
      style={{
        "--spotlight-x": "50%",
        "--spotlight-y": "50%",
        ...style,
      } as CSSProperties}
      className={cn(
        "group/spotlight relative min-w-0 overflow-hidden rounded-[var(--radius)] border border-border bg-card text-card-foreground outline-none transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out transform-gpu hover:-translate-y-px hover:border-primary/25 hover:[box-shadow:0_10px_24px_rgba(15,23,42,0.075)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none",
        className,
      )}
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      {...props}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover/spotlight:opacity-70 motion-reduce:hidden"
        data-spotlight-blob="true"
        style={{
          background:
            "radial-gradient(76px circle at var(--spotlight-x) var(--spotlight-y), color-mix(in oklch, var(--primary) 18%, transparent), transparent 72%)",
        }}
      />
      <div className="relative z-10 min-w-0">{children}</div>
    </div>
  );
});
