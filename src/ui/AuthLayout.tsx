import type { ReactNode } from "react";
import { PixelIcon } from "./PixelIcon";
import { PixelLogo } from "./PixelLogo";
import { PixelPanel } from "./PixelPanel";

interface AuthLayoutProps {
  children: ReactNode;
  notice?: ReactNode;
  preview?: ReactNode;
  subtitle: string;
  title: string;
}

export function AuthLayout({ children, notice, preview, subtitle, title }: AuthLayoutProps) {
  return (
    <div className="auth-layout">
      <header className="auth-layout__header">
        <PixelLogo />
        <div className="auth-layout__language">
          <span aria-hidden="true">◎</span>
          简体中文
          <span>UTC+8</span>
        </div>
      </header>
      <main className="auth-layout__main">
        <PixelPanel className="auth-layout__card auth-layout__login-card">
          <h1 className="auth-layout__title">{title}</h1>
          <p className="auth-layout__subtitle">{subtitle}</p>
          <div className="auth-layout__content">{children}</div>
        </PixelPanel>
        {preview ? <PixelPanel className="auth-layout__card auth-layout__preview">{preview}</PixelPanel> : null}
      </main>
      {notice ? (
        <div className="auth-layout__notice">
          <span className="auth-layout__noticeIcon" aria-hidden="true">
            <PixelIcon name="info" size={22} />
          </span>
          <span>{notice}</span>
        </div>
      ) : null}
      <footer className="auth-layout__footer">
        © 2026 Lorume. All rights reserved.
      </footer>
    </div>
  );
}
