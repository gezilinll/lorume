import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AuthPageShell } from "./AuthPageShell";
import { AuthOperationsPreview } from "./auth-preview";

interface VerifyCodePageProps {
  backLabel?: string;
  displayEmail?: string;
  email: string;
  error?: string | null;
  notice?: string;
  onBack: () => void;
  onSubmit: (code: string) => Promise<void>;
  submitLabel?: string;
}

export function VerifyCodePage({
  backLabel = "换个邮箱",
  displayEmail,
  email,
  error,
  notice = "验证通过后会自动进入控制台；若账号还没有组织，需要先创建或加入组织。",
  onBack,
  onSubmit,
  submitLabel = "进入控制台",
}: VerifyCodePageProps) {
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <AuthPageShell
      title="输入验证码"
      subtitle={`验证码已发送到 ${displayEmail ?? email}，10 分钟内有效。`}
      preview={<AuthOperationsPreview />}
      notice={notice}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setIsSubmitting(true);
          void onSubmit(code).finally(() => setIsSubmitting(false));
        }}
      >
        <Field>
          <FieldLabel htmlFor="code">验证码</FieldLabel>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="6 位验证码"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
            required
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {submitLabel}
          </Button>
          <Button type="button" variant="secondary" onClick={onBack}>
            {backLabel}
          </Button>
        </div>
      </form>
      {error ? (
        <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </AuthPageShell>
  );
}
