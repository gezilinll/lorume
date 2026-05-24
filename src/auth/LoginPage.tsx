import { useState } from "react";
import { AuthLayout } from "../ui/AuthLayout";
import { PixelButton } from "../ui/PixelButton";
import { PixelField } from "../ui/PixelField";
import { AuthOperationsPreview } from "./auth-preview";

interface LoginPageProps {
  error?: string | null;
  onSubmit: (email: string) => Promise<void>;
}

export function LoginPage({ error, onSubmit }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <AuthLayout
      title="登录 Lorume"
      subtitle="使用团队邮箱接收验证码，进入组织内的 Device、Runtime、Agent 与会话任务。"
      preview={<AuthOperationsPreview />}
      notice="登录后可统一管理组织内 Device、Runtime、Agent 与会话任务。"
    >
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          setIsSubmitting(true);
          void onSubmit(email).finally(() => setIsSubmitting(false));
        }}
      >
        <PixelField
          icon="mail"
          label="邮箱"
          name="email"
          placeholder="name@company.com"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          required
        />
        <PixelButton icon="paper-plane" type="submit" disabled={isSubmitting}>
          发送验证码
        </PixelButton>
      </form>
      <AuthError error={error} />
      <p className="auth-copy">
        未加入组织？请联系管理员发送邀请链接。
      </p>
    </AuthLayout>
  );
}

function AuthError({ error }: { error?: string | null }) {
  return error ? <p className="auth-error" role="alert">{error}</p> : null;
}
