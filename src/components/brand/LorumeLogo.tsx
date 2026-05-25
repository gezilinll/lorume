import { cn } from "@/lib/utils";

export function LorumeLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold tracking-tight", className)} aria-label="Lorume">
      <span className="flex size-8 items-center justify-center" aria-hidden="true">
        <svg
          className="size-8 text-foreground"
          data-logo-mark="lorume-neural-lumen"
          data-logo-version="lorume-v1"
          viewBox="0 0 64 64"
          focusable="false"
        >
          <rect width="64" height="64" rx="18" fill="currentColor" />
          <path
            d="M24 18v28h18"
            fill="none"
            stroke="var(--background)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="47" cy="17" r="5" fill="var(--primary)" />
        </svg>
      </span>
      <span>Lorume</span>
    </div>
  );
}
