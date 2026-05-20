import type { ReactElement, SVGProps } from "react";

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

/** Legacy entry name; rendered icons are modern low-noise line symbols. */
export function PixelIcon({ className = "", name, size = 20, ...props }: PixelIconProps) {
  return (
    <svg
      aria-hidden={props["aria-label"] ? undefined : true}
      className={`pixel-icon${className ? ` ${className}` : ""}`}
      data-pixel-icon={name}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {iconPaths[name]}
    </svg>
  );
}

const iconPaths: Record<PixelIconName, ReactElement> = {
  activity: <path d="M4 12h4l2.2-6 3.6 12L16 12h4" />,
  blocks: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1.6" />
      <rect x="14" y="4" width="6" height="6" rx="1.6" />
      <rect x="4" y="14" width="6" height="6" rx="1.6" />
      <rect x="14" y="14" width="6" height="6" rx="1.6" />
    </>
  ),
  bot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="4" />
      <path d="M12 8V5" />
      <path d="M9.5 13h.01M14.5 13h.01" />
      <path d="M9.5 16.5h5" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
      <path d="M7 8v8M9 6h3.5A4.5 4.5 0 0 1 17 10.5V16" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </>
  ),
  catalog: (
    <>
      <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21.5z" />
      <path d="M5 5.5v16M9 7h6M9 11h6" />
    </>
  ),
  chart: (
    <>
      <path d="M4 19V5M4 19h16" />
      <path d="m7 15 3-3 3 2 4-6" />
      <path d="M17 8h-4M17 8v4" />
    </>
  ),
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-up": <path d="m18 15-6-6-6 6" />,
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </>
  ),
  health: (
    <>
      <path d="M12 21s7-3.8 7-10V6l-7-3-7 3v5c0 6.2 7 10 7 10Z" />
      <path d="m9 12 2 2 4-5" />
    </>
  ),
  heart: <path d="M19.5 6.5a4.4 4.4 0 0 0-6.2 0L12 7.8l-1.3-1.3a4.4 4.4 0 1 0-6.2 6.2L12 20l7.5-7.3a4.4 4.4 0 0 0 0-6.2Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6M12 7.5h.01" />
    </>
  ),
  mail: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="3" />
      <path d="m5 8 7 5 7-5" />
    </>
  ),
  monitor: (
    <>
      <rect x="4" y="5" width="16" height="12" rx="2.5" />
      <path d="M9 21h6M12 17v4" />
    </>
  ),
  "paper-plane": (
    <>
      <path d="m21 4-8.5 16-2.4-7.1L3 10.5z" />
      <path d="m10.1 12.9 5.2-5.2" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7z" />,
  reload: (
    <>
      <path d="M20 12a8 8 0 1 1-2.35-5.65" />
      <path d="M20 5v5h-5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="5" width="16" height="5" rx="2" />
      <rect x="4" y="14" width="16" height="5" rx="2" />
      <path d="M8 7.5h.01M8 16.5h.01M12 10v4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M4.8 4.8l1.4 1.4M17.8 17.8l1.4 1.4M3 12h2M19 12h2M4.8 19.2l1.4-1.4M17.8 6.2l1.4-1.4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 21s7-3.8 7-10V6l-7-3-7 3v5c0 6.2 7 10 7 10Z" />
    </>
  ),
  terminal: (
    <>
      <path d="m5 7 5 5-5 5M12 17h7" />
    </>
  ),
  tool: (
    <>
      <path d="M14.5 5.5a4.5 4.5 0 0 0 4 6.9l-6.1 6.1a2.2 2.2 0 0 1-3.1-3.1l6.1-6.1a4.5 4.5 0 0 0-.9-3.8Z" />
    </>
  ),
  users: (
    <>
      <path d="M16 19c0-2.2-1.8-4-4-4H8c-2.2 0-4 1.8-4 4" />
      <circle cx="10" cy="8" r="4" />
      <path d="M20 19c0-1.8-1-3.1-2.5-3.7M16 4.3a3.5 3.5 0 0 1 0 7.4" />
    </>
  ),
};
