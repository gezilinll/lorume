export function PixelLogo() {
  return (
    <div className="pixel-logo" aria-label="Lorume">
      <span className="pixel-logo__mark" data-testid="pixel-logo-mark" aria-hidden="true">
        <svg
          className="pixel-logo__svg"
          data-logo-mark="lorume-neural-lumen"
          data-logo-version="lorume-v1"
          viewBox="0 0 64 64"
          focusable="false"
        >
          <rect width="64" height="64" rx="18" fill="#111827" />
          <path d="M24 18v28h18" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="47" cy="17" r="5" fill="#0f9f9a" />
        </svg>
      </span>
      <span className="pixel-logo__wordmark">Lorume</span>
    </div>
  );
}
