import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { LorumeLogo } from "@/components/brand/LorumeLogo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AuthPageShellProps {
  children: ReactNode;
  notice?: ReactNode;
  preview?: ReactNode;
  subtitle: string;
  title: string;
}

export function AuthPageShell({ children, notice, preview, subtitle, title }: AuthPageShellProps) {
  return (
    <div className="auth-layout">
      <header className="auth-layout__header">
        <LorumeLogo />
      </header>
      <main className="auth-layout__main">
        <Card className="auth-page-shell__card auth-layout__card auth-layout__login-card mx-auto w-full max-w-md">
          <CardHeader>
            <CardTitle>
              <h1 className="auth-layout__title">{title}</h1>
            </CardTitle>
            <p className="auth-layout__subtitle">{subtitle}</p>
          </CardHeader>
          <CardContent className="auth-page-shell__card-content auth-layout__content">{children}</CardContent>
        </Card>
        {preview ? (
          <Card className="auth-page-shell__card auth-layout__card auth-layout__preview">
            <CardContent className="auth-page-shell__card-content">{preview}</CardContent>
          </Card>
        ) : null}
      </main>
      {notice ? (
        <div className="auth-layout__notice">
          <span className="auth-layout__noticeIcon" aria-hidden="true">
            <Info className="size-5" />
          </span>
          <span>{notice}</span>
        </div>
      ) : null}
      <footer className="auth-layout__footer">© 2026 Lorume. All rights reserved.</footer>
    </div>
  );
}
