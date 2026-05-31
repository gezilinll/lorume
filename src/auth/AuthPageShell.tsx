import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { LorumeLogo } from "@/components/brand/LorumeLogo";
import { Button } from "@/components/ui/button";
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
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex h-20 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="/" className="rounded-lg outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20">
          <LorumeLogo className="text-lg" />
        </a>
        <Button variant="ghost" size="sm" asChild>
          <a href="/">返回首页</a>
        </Button>
      </header>
      <main className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:items-start">
        <Card className="mx-auto min-h-0 w-full max-w-md lg:min-h-[29rem]">
          <CardHeader>
            <CardTitle>
              <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{title}</h1>
            </CardTitle>
            <p className="border-b border-border pb-5 text-sm leading-6 text-muted-foreground">{subtitle}</p>
          </CardHeader>
          <CardContent className="grid gap-5">{children}</CardContent>
        </Card>
        {preview ? (
          <Card className="min-h-0 lg:min-h-[29rem]">
            <CardContent>{preview}</CardContent>
          </Card>
        ) : null}
      </main>
      {notice ? (
        <div className="mx-auto mt-4 flex w-[calc(100%-2rem)] max-w-3xl items-center gap-3 rounded-full border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm sm:w-full">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary" aria-hidden="true">
            <Info className="size-5" />
          </span>
          <span>{notice}</span>
        </div>
      ) : null}
      <footer className="flex min-h-16 items-center justify-center px-4 text-xs text-muted-foreground">
        © 2026 Lorume. All rights reserved.
      </footer>
    </div>
  );
}
