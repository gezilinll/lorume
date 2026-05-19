interface PixelDecorationsProps {
  testId?: string;
  variant?: "auth" | "console" | "home";
}

/** Decorative ambient layer. It carries atmosphere only; no product meaning. */
export function PixelDecorations({
  testId,
  variant = "auth",
}: PixelDecorationsProps) {
  return (
    <div
      className={`pixel-decorations pixel-decorations--${variant}`}
      data-testid={testId}
      aria-hidden="true"
    >
      <span className="pixel-deco pixel-deco--dots pixel-deco--dots-left" />
      <span className="pixel-deco pixel-deco--dots pixel-deco--dots-right" />
      <span className="pixel-deco pixel-deco--trace pixel-deco--trace-blue" />
      <span className="pixel-deco pixel-deco--trace pixel-deco--trace-accent" />
    </div>
  );
}
