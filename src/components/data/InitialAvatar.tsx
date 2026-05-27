import { cn } from "@/lib/utils";

export type AccentTone = "brand" | "blue" | "cyan" | "orange" | "green" | "pink" | "yellow" | "purple";

const accentTones: AccentTone[] = ["brand", "blue", "cyan", "orange", "green", "pink", "yellow", "purple"];

const softToneClass: Record<AccentTone, string> = {
  brand: "border-[var(--brand-border)] bg-[var(--brand-soft)] text-[var(--brand-foreground)]",
  blue: "border-[var(--blue-border)] bg-[var(--blue-soft)] text-[var(--blue-foreground)]",
  cyan: "border-[var(--cyan-border)] bg-[var(--cyan-soft)] text-[var(--cyan-foreground)]",
  green: "border-[var(--green-border)] bg-[var(--green-soft)] text-[var(--green-foreground)]",
  orange: "border-[var(--orange-border)] bg-[var(--orange-soft)] text-[var(--orange-foreground)]",
  pink: "border-[var(--pink-border)] bg-[var(--pink-soft)] text-[var(--pink-foreground)]",
  purple: "border-[var(--purple-border)] bg-[var(--purple-soft)] text-[var(--purple-foreground)]",
  yellow: "border-[var(--yellow-border)] bg-[var(--yellow-soft)] text-[var(--yellow-foreground)]",
};

const solidToneClass: Record<AccentTone, string> = {
  brand: "border-transparent bg-[linear-gradient(135deg,var(--brand),var(--brand-2))] text-white",
  blue: "border-transparent bg-[linear-gradient(135deg,var(--blue),var(--cyan))] text-white",
  cyan: "border-transparent bg-[linear-gradient(135deg,var(--cyan),var(--green))] text-white",
  green: "border-transparent bg-[linear-gradient(135deg,var(--green),var(--cyan))] text-white",
  orange: "border-transparent bg-[linear-gradient(135deg,var(--orange),var(--yellow))] text-white",
  pink: "border-transparent bg-[linear-gradient(135deg,var(--pink),var(--orange))] text-white",
  purple: "border-transparent bg-[linear-gradient(135deg,var(--purple),var(--brand))] text-white",
  yellow: "border-transparent bg-[linear-gradient(135deg,var(--yellow),var(--orange))] text-white",
};

const sizeClass = {
  sm: "size-7 rounded-full text-[10px]",
  md: "size-9 rounded-[13px] text-[11px]",
  lg: "size-10 rounded-[14px] text-xs",
} as const;

export function InitialAvatar({
  className,
  label,
  size = "sm",
  text,
  tone,
  variant = "soft",
}: {
  className?: string;
  label?: string;
  size?: keyof typeof sizeClass;
  text: string;
  tone?: AccentTone;
  variant?: "soft" | "solid";
}) {
  const resolvedTone = tone ?? accentToneFromText(text);
  return (
    <span
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border font-bold leading-none",
        sizeClass[size],
        variant === "solid" ? solidToneClass[resolvedTone] : softToneClass[resolvedTone],
        className,
      )}
    >
      {initialFromText(text)}
    </span>
  );
}

export function accentToneFromText(value: string): AccentTone {
  let hash = 0;
  for (const character of value.trim()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return accentTones[hash % accentTones.length];
}

export function initialFromText(value: string): string {
  const normalized = value.trim();
  return (normalized ? Array.from(normalized)[0] : "L").toUpperCase();
}
