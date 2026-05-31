import { Button } from "@/components/ui/button";
import { AuthPageShell } from "./AuthPageShell";
import { AuthOperationsPreview } from "./auth-preview";
import type { AuthInvitationPreview, AuthSessionContext } from "./auth-store";

interface InviteJoinPageProps {
  error?: string | null;
  onSkip: () => void;
  onSubmit: () => Promise<void>;
  preview?: AuthInvitationPreview | null;
  session: AuthSessionContext;
}

const roleLabels = {
  admin: "管理员",
  member: "成员",
  owner: "Owner",
};

export function InviteJoinPage({ error, onSkip, onSubmit, preview, session }: InviteJoinPageProps) {
  const organizationName = preview?.organizationName ?? "受邀组织";
  const roleLabel = preview?.role ? roleLabels[preview.role] : "成员";
  const maskedEmail = preview?.maskedEmail ?? "受邀邮箱";

  return (
    <AuthPageShell
      title="加入组织"
      subtitle={`你将加入 ${organizationName}，目标角色为 ${roleLabel}。请确认当前登录邮箱 ${session.user.email} 与受邀邮箱 ${maskedEmail} 一致。`}
      preview={<AuthOperationsPreview />}
      notice="邀请链接只决定加入哪个组织，真正的身份仍以邮箱验证码登录结果为准。"
    >
      <div className="grid gap-4">
        <Button type="button" onClick={() => void onSubmit()}>
          加入并进入
        </Button>
        <Button type="button" variant="secondary" onClick={onSkip}>
          暂不加入
        </Button>
      </div>
      {error ? (
        <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </AuthPageShell>
  );
}
