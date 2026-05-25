import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AuthPageShell } from "./AuthPageShell";
import { AuthOperationsPreview } from "./auth-preview";

interface CreateOrganizationPageProps {
  error?: string | null;
  onSubmit: (input: { name: string; slug: string }) => Promise<void>;
}

export function CreateOrganizationPage({ error, onSubmit }: CreateOrganizationPageProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const suggestedSlug = useMemo(() => slugify(name), [name]);
  const effectiveSlug = slug || suggestedSlug;

  return (
    <AuthPageShell
      title="创建组织"
      subtitle="先创建一个组织空间，再注册设备、分配成员并管理 Agent 运行资产。"
      preview={<AuthOperationsPreview />}
      notice="组织是 Lorume 权限、邀请、设备 token 与运行资产的管理边界。"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setIsSubmitting(true);
          void onSubmit({ name, slug: effectiveSlug }).finally(() => setIsSubmitting(false));
        }}
      >
        <Field>
          <FieldLabel htmlFor="organization-name">组织名称</FieldLabel>
          <Input
            id="organization-name"
            name="organization-name"
            placeholder="例如：增长工程组"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="organization-slug">组织标识</FieldLabel>
          <Input
            id="organization-slug"
            name="organization-slug"
            placeholder="growth-eng"
            value={effectiveSlug}
            onChange={(event) => setSlug(event.currentTarget.value)}
            required
          />
        </Field>
        <Button className="w-full" type="submit" disabled={isSubmitting}>
          创建并进入
        </Button>
      </form>
      {error ? (
        <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </AuthPageShell>
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
