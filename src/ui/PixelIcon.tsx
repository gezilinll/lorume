import type { ReactNode, SVGProps } from "react";

export type PixelIconName =
  | "activity"
  | "blocks"
  | "bot"
  | "branch"
  | "calendar"
  | "catalog"
  | "chart"
  | "chevron-down"
  | "chevron-left"
  | "chevron-up"
  | "close"
  | "cpu"
  | "health"
  | "heart"
  | "info"
  | "mail"
  | "monitor"
  | "paper-plane"
  | "play"
  | "reload"
  | "search"
  | "server"
  | "settings"
  | "shield"
  | "terminal"
  | "tool"
  | "users";

interface PixelIconProps extends SVGProps<SVGSVGElement> {
  name: PixelIconName;
  size?: number;
}

/** Shared product icon wrapper so product surfaces do not mix icon styles. */
export function PixelIcon({ className = "", name, size = 20, ...props }: PixelIconProps) {
  return (
    <svg
      aria-hidden={props["aria-label"] ? undefined : true}
      className={`pixel-icon${className ? ` ${className}` : ""}`}
      data-pixel-icon={name}
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {renderIcon(name)}
    </svg>
  );
}

function renderIcon(name: PixelIconName): ReactNode {
  switch (name) {
    case "activity":
      return <path d="M3 12h4l2.2-6 4.4 12L16 12h5" />;
    case "blocks":
      return (
        <>
          <rect height="6" rx="1.8" width="6" x="4" y="4" />
          <rect height="6" rx="1.8" width="6" x="14" y="4" />
          <rect height="6" rx="1.8" width="6" x="4" y="14" />
          <path d="M14 17h6M17 14v6" />
        </>
      );
    case "bot":
      return (
        <>
          <rect height="11" rx="3" width="14" x="5" y="8" />
          <path d="M12 5v3M9 13h.01M15 13h.01M9.5 16h5" />
        </>
      );
    case "branch":
      return (
        <>
          <circle cx="7" cy="6" r="2" />
          <circle cx="17" cy="18" r="2" />
          <circle cx="7" cy="18" r="2" />
          <path d="M7 8v8M9 6h3a5 5 0 0 1 5 5v5" />
        </>
      );
    case "calendar":
      return (
        <>
          <rect height="16" rx="3" width="16" x="4" y="5" />
          <path d="M8 3v4M16 3v4M4 10h16" />
        </>
      );
    case "catalog":
      return (
        <>
          <path d="M5 5.8A2.8 2.8 0 0 1 7.8 3H20v16H7.8A2.8 2.8 0 0 0 5 21.8z" />
          <path d="M5 6v15M9 7h7M9 11h6" />
        </>
      );
    case "chart":
      return (
        <>
          <path d="M4 19V5M4 19h16" />
          <path d="M8 15l3-3 3 2 4-6" />
          <path d="M18 8h-4M18 8v4" />
        </>
      );
    case "chevron-down":
      return <path d="m6 9 6 6 6-6" />;
    case "chevron-left":
      return <path d="m15 18-6-6 6-6" />;
    case "chevron-up":
      return <path d="m18 15-6-6-6 6" />;
    case "close":
      return <path d="M6 6l12 12M18 6 6 18" />;
    case "cpu":
      return (
        <>
          <rect height="10" rx="2" width="10" x="7" y="7" />
          <path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" />
        </>
      );
    case "health":
      return (
        <>
          <path d="M4 13h4l2-5 4 10 2-5h4" />
          <path d="M12 4a8 8 0 1 1-7.4 11" />
        </>
      );
    case "heart":
      return <path d="M20.5 8.8c0 5.1-8.5 9.7-8.5 9.7S3.5 13.9 3.5 8.8A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8.5 1.8Z" />;
    case "info":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10.8v5M12 7.8h.01" />
        </>
      );
    case "mail":
      return (
        <>
          <rect height="14" rx="3" width="18" x="3" y="5" />
          <path d="m4.5 7 7.5 6 7.5-6" />
        </>
      );
    case "monitor":
      return (
        <>
          <rect height="12" rx="2.5" width="18" x="3" y="4" />
          <path d="M8 20h8M12 16v4" />
        </>
      );
    case "paper-plane":
      return (
        <>
          <path d="M21 4 10.8 14.2" />
          <path d="m21 4-6.5 17-3.7-6.8L4 10.5z" />
        </>
      );
    case "play":
      return <path d="m8 5 11 7-11 7z" />;
    case "reload":
      return (
        <>
          <path d="M20 12a8 8 0 0 1-13.6 5.7" />
          <path d="M4 12A8 8 0 0 1 17.6 6.3" />
          <path d="M17 3v4h4M7 21v-4H3" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="6" />
          <path d="m16 16 4 4" />
        </>
      );
    case "server":
      return (
        <>
          <rect height="6" rx="2" width="16" x="4" y="5" />
          <rect height="6" rx="2" width="16" x="4" y="13" />
          <path d="M8 8h.01M8 16h.01M12 8h4M12 16h4" />
        </>
      );
    case "settings":
      return (
        <>
          <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
          <circle cx="12" cy="12" r="3.5" />
        </>
      );
    case "shield":
      return <path d="M12 3 19 6v5.5c0 4.1-2.8 7.8-7 9.5-4.2-1.7-7-5.4-7-9.5V6z" />;
    case "terminal":
      return (
        <>
          <path d="m5 7 5 5-5 5M12 18h7" />
          <rect height="16" rx="3" width="18" x="3" y="4" />
        </>
      );
    case "tool":
      return <path d="M14.5 5.5a4.8 4.8 0 0 0 4 6.8l-7.9 7.9a2.4 2.4 0 0 1-3.4-3.4l7.9-7.9a4.8 4.8 0 0 0-.6-3.4Z" />;
    case "users":
      return (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
          <path d="M15 6.5a3 3 0 0 1 0 5.8M17 17.5a5 5 0 0 1 3.5 1.5" />
        </>
      );
  }
  return null;
}
