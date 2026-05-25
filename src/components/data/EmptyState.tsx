import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

export function EmptyState({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="max-w-md text-sm text-muted-foreground">{description}</div>
        {action}
      </CardContent>
    </Card>
  );
}
