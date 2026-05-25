import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

describe("shadcn/ui foundation", () => {
  it("renders generated components through the configured import alias", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>shadcn ready</CardTitle>
        </CardHeader>
        <CardContent>
          <Badge>preset b1FS9kEKH</Badge>
          <Input aria-label="Smoke input" defaultValue="Lorume" />
          <Button type="button">Continue</Button>
        </CardContent>
      </Card>,
    );

    expect(screen.getByText("shadcn ready")).toBeInTheDocument();
    expect(screen.getByText("preset b1FS9kEKH")).toBeInTheDocument();
    expect(screen.getByLabelText("Smoke input")).toHaveValue("Lorume");
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });
});
