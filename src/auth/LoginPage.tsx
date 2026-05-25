import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CardDescription } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AuthPageShell } from "./AuthPageShell";
import { AuthOperationsPreview } from "./auth-preview";

interface LoginPageProps {
  error?: string | null;
  onSubmit: (email: string) => Promise<void>;
}

export function LoginPage({ error, onSubmit }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <AuthPageShell
      title="登录 Lorume"
      subtitle="使用团队邮箱接收验证码，进入组织内的 Device、Runtime、Agent 与会话任务。"
      preview={<AuthOperationsPreview />}
      notice="登录后可统一管理组织内 Device、Runtime、Agent 与会话任务。"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setIsSubmitting(true);
          void onSubmit(email).finally(() => setIsSubmitting(false));
        }}
      >
        <Field>
          <FieldLabel htmlFor="email">邮箱</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@company.com"
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </Field>
        <Button className="w-full" type="submit" disabled={isSubmitting}>
          发送验证码
        </Button>
      </form>
      <AuthError error={error} />
      <CardDescription className="auth-copy">
        未加入组织？请联系管理员发送邀请链接。
      </CardDescription>
    </AuthPageShell>
  );
}

function AuthError({ error }: { error?: string | null }) {
  return error ? <p className="auth-error" role="alert">{error}</p> : null;
}
