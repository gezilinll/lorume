import type { CSSProperties, PointerEvent, ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";

export function DetailSurface({
  bodyClassName,
  bodyTestId,
  children,
  className,
  depth,
  depthIntensity,
  description,
  footer,
  layout,
  meta,
  onOpenChange,
  open,
  surface = "detail",
  title,
}: {
  bodyClassName?: string;
  bodyTestId?: string;
  children: ReactNode;
  className?: string;
  depth?: string;
  depthIntensity?: string;
  description?: ReactNode;
  footer?: ReactNode;
  layout?: string;
  meta?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  surface?: string;
  title: ReactNode;
}) {
  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (depthIntensity !== "modal-3d") return;
    const plane = event.currentTarget.querySelector<HTMLElement>('[data-depth-plane="true"]');
    if (!plane) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = event.clientX - (rect.left + rect.width / 2);
    const relativeY = event.clientY - (rect.top + rect.height / 2);
    const rotateX = Math.max(-2.5, Math.min(2.5, -relativeY * 0.0125));
    const rotateY = Math.max(-2.5, Math.min(2.5, relativeX * 0.0125));
    event.currentTarget.style.setProperty("--detail-rotate-x", `${rotateX}deg`);
    event.currentTarget.style.setProperty("--detail-rotate-y", `${rotateY}deg`);
    event.currentTarget.style.setProperty("--detail-scale", "1.008");
    plane.style.transform =
      `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.008, 1.008, 1)`;
  }

  function handlePointerLeave(event: PointerEvent<HTMLDivElement>) {
    if (depthIntensity !== "modal-3d") return;
    const plane = event.currentTarget.querySelector<HTMLElement>('[data-depth-plane="true"]');
    event.currentTarget.style.setProperty("--detail-rotate-x", "0deg");
    event.currentTarget.style.setProperty("--detail-rotate-y", "0deg");
    event.currentTarget.style.setProperty("--detail-scale", "1");
    if (plane) {
      plane.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)";
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[calc(100svh-2rem)] gap-0 overflow-visible rounded-none border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-2xl data-open:!animate-none data-closed:!animate-none data-open:scale-100 motion-reduce:transform-none motion-reduce:transition-none",
          className,
        )}
        data-depth={depth}
        data-depth-intensity={depthIntensity}
        data-intensity="focus"
        data-layout={layout}
        data-surface={surface}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        showCloseButton={false}
        style={depthIntensity === "modal-3d" ? {
          "--detail-rotate-x": "0deg",
          "--detail-rotate-y": "0deg",
          "--detail-scale": "1",
        } as CSSProperties : undefined}
      >
        <div
          className="relative overflow-hidden rounded-[var(--radius)] border border-border bg-popover shadow-[0_30px_100px_rgba(15,23,42,0.22)] transition-[box-shadow,transform] duration-150 ease-out will-change-transform"
          data-depth-plane={depthIntensity === "modal-3d" ? "true" : undefined}
          style={depthIntensity === "modal-3d" ? {
            transform: "perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)",
            transformStyle: "preserve-3d",
          } as CSSProperties : undefined}
        >
          <DialogClose asChild>
            <Button
              variant="ghost"
              className="absolute right-2 top-2 z-20"
              size="icon-sm"
            >
              <XIcon aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
          <DialogHeader className="border-b border-border px-5 py-4 pr-12">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">任务详情</DialogDescription>}
            {meta ? <div className="flex flex-wrap items-center gap-1.5 pt-1">{meta}</div> : null}
          </DialogHeader>
          <ScrollArea className="max-h-[calc(100svh-12rem)]">
            <div className={cn("space-y-4 px-5 py-4", bodyClassName)} data-testid={bodyTestId}>{children}</div>
          </ScrollArea>
          {footer ? <div className="border-t border-border px-5 py-3">{footer}</div> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DetailSection({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title: ReactNode;
}) {
  return (
    <section className={cn("space-y-2", className)}>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <div className="break-words text-sm leading-6 text-muted-foreground">{children}</div>
    </section>
  );
}
