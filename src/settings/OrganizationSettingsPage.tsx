import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AuthDeviceTokenStatus,
  AuthDeviceTokenSummary,
  AuthInvitationSummary,
  AuthInvitableMemberRole,
  AuthMemberRole,
  AuthOrganizationMembership,
  AuthSessionContext,
} from "../auth/auth-store";
import { InitialAvatar } from "@/components/data/InitialAvatar";
import { StatusBadge } from "@/components/data/StatusBadge";
import { useConsoleWorkbar, useHasConsoleWorkbar } from "@/components/layout/ConsoleWorkbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface OrganizationSettingsPageProps {
  organization?: AuthOrganizationMembership;
  session?: AuthSessionContext;
}

const roleLabels: Record<AuthMemberRole, string> = {
  admin: "管理员",
  member: "成员",
  owner: "Owner",
};

/** Organization settings entry for member visibility and invitation link creation. */
export function OrganizationSettingsPage({ organization: activeOrganization, session }: OrganizationSettingsPageProps) {
  const organization = activeOrganization ?? session?.organizations[0];
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AuthInvitableMemberRole>("member");
  const [inviteNotice, setInviteNotice] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [deviceToken, setDeviceToken] = useState("");
  const [deviceTokens, setDeviceTokens] = useState<AuthDeviceTokenSummary[]>([]);
  const [invitations, setInvitations] = useState<AuthInvitationSummary[]>([]);
  const [installCommand, setInstallCommand] = useState("");
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [deviceErrorMessage, setDeviceErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreatingDeviceToken, setIsCreatingDeviceToken] = useState(false);
  const [resendingInvitationId, setResendingInvitationId] = useState("");
  const hasConsoleWorkbar = useHasConsoleWorkbar();

  const canManage = useMemo(() => organization?.role === "owner" || organization?.role === "admin", [organization]);
  const pendingInvitations = useMemo(() => invitations.filter((invitation) => invitation.status !== "accepted"), [invitations]);

  useEffect(() => {
    if (!organization || !canManage) {
      setDeviceTokens([]);
      setInvitations([]);
      return;
    }
    let isMounted = true;
    void loadOrganizationSettingsData(organization.organizationId).then(({ deviceTokens: nextDeviceTokens, invitations: nextInvitations }) => {
      if (!isMounted) return;
      setDeviceTokens(nextDeviceTokens);
      setInvitations(nextInvitations);
    }).catch((error) => {
      if (isMounted) setDeviceErrorMessage(error instanceof Error ? error.message : "组织安全数据加载失败");
    });
    return () => {
      isMounted = false;
    };
  }, [canManage, organization?.organizationId]);

  useConsoleWorkbar({
    meta: organization ? (
      <>
        <span>{organization.name}</span>
        <span>{roleLabels[organization.role]}</span>
      </>
    ) : "请选择组织",
    title: "组织设置",
  }, [organization?.name, organization?.role]);

  async function createInvitation() {
    if (!organization) return;
    setIsSubmitting(true);
    setErrorMessage("");
    setInviteNotice("");
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(organization.organizationId)}/invitations`, {
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `邀请创建失败: HTTP ${response.status}`);
      }
      setInviteNotice(`邀请邮件已发送至 ${maskEmail(inviteEmail)}`);
      setInviteEmail("");
      await refreshOrganizationSettingsData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "邀请创建失败");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resendInvitation(invitation: AuthInvitationSummary) {
    if (!organization) return;
    setResendingInvitationId(invitation.id);
    setErrorMessage("");
    setInviteNotice("");
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(organization.organizationId)}/invitations/${encodeURIComponent(invitation.id)}/resend`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `邀请重发失败: HTTP ${response.status}`);
      }
      setInviteNotice(`邀请已重新发送至 ${maskEmail(invitation.email)}`);
      await refreshOrganizationSettingsData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "邀请重发失败");
    } finally {
      setResendingInvitationId("");
    }
  }

  async function createDeviceInstallCommand() {
    if (!organization) return;
    setIsCreatingDeviceToken(true);
    setDeviceErrorMessage("");
    setDeviceToken("");
    setInstallCommand("");
    setCopiedInstallCommand(false);
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(organization.organizationId)}/device-tokens`, {
        body: JSON.stringify({ deviceId: deviceId.trim(), name: deviceId.trim() }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `设备 token 创建失败: HTTP ${response.status}`);
      }
      const token = typeof payload?.deviceToken?.token === "string" ? payload.deviceToken.token : "";
      const registeredDeviceId = typeof payload?.deviceToken?.deviceId === "string" ? payload.deviceToken.deviceId : deviceId.trim();
      if (!token) throw new Error("设备 token 创建失败");
      setDeviceToken(token);
      setDeviceTokens((tokens) => [
        stripPlaintextDeviceToken(payload.deviceToken as AuthDeviceTokenSummary & { token?: string }),
        ...tokens.filter((item) => item.id !== payload.deviceToken.id),
      ]);
      setInstallCommand(buildInstallCommand({
        deviceId: registeredDeviceId,
        origin: window.location.origin,
        token,
      }));
      await refreshOrganizationSettingsData();
    } catch (error) {
      setDeviceErrorMessage(error instanceof Error ? error.message : "设备 token 创建失败");
    } finally {
      setIsCreatingDeviceToken(false);
    }
  }

  async function revokeDeviceToken(tokenId: string) {
    if (!organization) return;
    setDeviceErrorMessage("");
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(organization.organizationId)}/device-tokens/${encodeURIComponent(tokenId)}/revoke`, {
        body: JSON.stringify({ reason: "manual" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `设备 token 撤销失败: HTTP ${response.status}`);
      }
      if (payload?.deviceToken) {
        setDeviceTokens((tokens) => tokens.map((item) => item.id === tokenId ? payload.deviceToken : item));
      }
      await refreshOrganizationSettingsData();
    } catch (error) {
      setDeviceErrorMessage(error instanceof Error ? error.message : "设备 token 撤销失败");
    }
  }

  async function refreshOrganizationSettingsData() {
    if (!organization || !canManage) return;
    const data = await loadOrganizationSettingsData(organization.organizationId);
    setDeviceTokens(data.deviceTokens);
    setInvitations(data.invitations);
  }

  async function copyInstallCommand() {
    if (!installCommand) return;
    try {
      await navigator.clipboard?.writeText(installCommand);
      setCopiedInstallCommand(true);
    } catch {
      setCopiedInstallCommand(false);
    }
  }

  if (!organization) {
    return (
      <div className="space-y-6">
        {hasConsoleWorkbar ? null : (
          <>
            <h1 className="sr-only">组织设置</h1>
            <p className="sr-only">请选择组织后管理成员与权限。</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {hasConsoleWorkbar ? null : <h1 className="sr-only">组织设置</h1>}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Card className="self-start">
          <CardHeader>
            <CardTitle>组织概览</CardTitle>
            <CardDescription>当前 Console 使用的组织上下文。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <SummaryItem label="组织名称" value={organization.name} />
            <SummaryItem label="Slug" value={organization.slug} />
            <SummaryItem label="当前角色" value={<StatusBadge tone={canManage ? "success" : "neutral"}>{roleLabels[organization.role]}</StatusBadge>} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>设备 Token</CardTitle>
            <CardDescription>一个 token 只能绑定一台设备，首次上报后变为占用。</CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="device-id">Token 名称</FieldLabel>
                  <Input
                    id="device-id"
                    value={deviceId}
                    onChange={(event) => setDeviceId(event.target.value)}
                    placeholder="gezilinll-claw"
                  />
                  <FieldDescription>用于识别这条安装 token，安装命令会作为默认 device id 传给 collector。</FieldDescription>
                </Field>
                <Button
                  className="w-fit"
                  type="button"
                  disabled={isCreatingDeviceToken || !deviceId.trim()}
                  onClick={() => void createDeviceInstallCommand()}
                >
                  生成安装命令
                </Button>
                {deviceTokens.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Token 列表</p>
                    <div className="overflow-hidden rounded-lg border">
                      <Table aria-label="设备 Token 列表">
                        <TableHeader>
                          <TableRow>
                            <TableHead>名称</TableHead>
                            <TableHead>设备</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {deviceTokens.map((token) => (
                            <TableRow key={token.id}>
                              <TableCell>
                                <div className="min-w-0">
                                  <p className="truncate font-medium">{token.name}</p>
                                  <p className="truncate text-xs text-muted-foreground">{token.tokenPrefix}</p>
                                </div>
                              </TableCell>
                              <TableCell className="text-muted-foreground">{token.deviceId || "待绑定"}</TableCell>
                              <TableCell>
                                <StatusBadge tone={deviceTokenStatusTone(token.status)}>{deviceTokenStatusLabel(token.status)}</StatusBadge>
                              </TableCell>
                              <TableCell>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  type="button"
                                  disabled={token.status === "revoked" || token.status === "expired"}
                                  onClick={() => void revokeDeviceToken(token.id)}
                                >
                                  撤销
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : null}
                {deviceErrorMessage ? (
                  <Alert variant="destructive">
                    <AlertTitle>设备 token 创建失败</AlertTitle>
                    <AlertDescription>{deviceErrorMessage}</AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            ) : (
              <p className="text-sm text-muted-foreground">当前角色不能注册设备。</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>成员与邀请</CardTitle>
            <CardDescription>查看当前成员身份，并向新成员发送一次性邀请邮件。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Table aria-label="组织成员">
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-3">
                      <InitialAvatar
                        text={session?.user.email ?? "当前用户"}
                        tone="pink"
                        variant="solid"
                      />
                      <span className="min-w-0 truncate font-medium">{session?.user.email ?? "当前用户"}</span>
                    </div>
                  </TableCell>
                  <TableCell>{roleLabels[organization.role]}</TableCell>
                  <TableCell>
                    <StatusBadge tone="info">当前登录成员</StatusBadge>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            {canManage ? (
              <FieldGroup>
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
                  <Field>
                    <FieldLabel htmlFor="invite-email">邮箱</FieldLabel>
                    <Input
                      id="invite-email"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                      placeholder="name@company.com"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="invite-role">角色</FieldLabel>
                    <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as AuthInvitableMemberRole)}>
                      <SelectTrigger id="invite-role" aria-label="角色" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">成员</SelectItem>
                        <SelectItem value="admin">管理员</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Button
                  className="w-fit"
                  type="button"
                  disabled={isSubmitting || !inviteEmail.trim()}
                  onClick={() => void createInvitation()}
                >
                  发送邀请邮件
                </Button>
                {inviteNotice ? (
                  <Alert>
                    <AlertTitle>邀请已发送</AlertTitle>
                    <AlertDescription>{inviteNotice}</AlertDescription>
                  </Alert>
                ) : null}
                {errorMessage ? (
                  <Alert variant="destructive">
                    <AlertTitle>邀请操作失败</AlertTitle>
                    <AlertDescription>{errorMessage}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="space-y-2 border-t pt-4">
                  <div>
                    <p className="text-sm font-medium">待加入邀请</p>
                    <p className="text-xs text-muted-foreground">展示尚未完成加入的邀请，可重新发送邮件。</p>
                  </div>
                  {pendingInvitations.length > 0 ? (
                    <div className="overflow-hidden rounded-lg border">
                      <Table aria-label="待加入邀请">
                        <TableHeader>
                          <TableRow>
                            <TableHead>邮箱</TableHead>
                            <TableHead>角色</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>过期时间</TableHead>
                            <TableHead>操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {pendingInvitations.map((invitation) => (
                            <TableRow key={invitation.id}>
                              <TableCell className="font-medium">{invitation.email}</TableCell>
                              <TableCell>{roleLabels[invitation.role]}</TableCell>
                              <TableCell>
                                <StatusBadge tone={invitationStatusTone(invitation.status)}>{invitationStatusLabel(invitation.status)}</StatusBadge>
                              </TableCell>
                              <TableCell className="text-muted-foreground">{formatDateTime(invitation.expiresAt)}</TableCell>
                              <TableCell>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  type="button"
                                  disabled={resendingInvitationId === invitation.id}
                                  onClick={() => void resendInvitation(invitation)}
                                >
                                  重发
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">暂无待加入邀请。</p>
                  )}
                </div>
              </FieldGroup>
            ) : (
              <p className="text-sm text-muted-foreground">当前角色不能发送邀请邮件。</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>安装命令</CardTitle>
            <CardDescription>复制当前创建结果，明文 token 不会被再次返回。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {installCommand ? (
              <>
                <Field>
                  <FieldLabel htmlFor="device-token">Device token</FieldLabel>
                  <Input
                    id="device-token"
                    aria-label="Device token"
                    readOnly
                    value={deviceToken}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </Field>
                <div className="space-y-2">
                  <p className="text-sm font-medium">安装命令</p>
                  <p className="text-sm text-muted-foreground">使用 install-device-collector 安装脚本注册目标设备。</p>
                  <pre
                    aria-label="安装命令"
                    className="overflow-x-auto rounded-lg border bg-muted/50 p-3 text-xs leading-relaxed text-foreground"
                  >
                    <code className="whitespace-pre">{installCommand}</code>
                  </pre>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" type="button" onClick={() => void copyInstallCommand()}>
                    复制安装命令
                  </Button>
                  {copiedInstallCommand ? <span className="text-sm text-muted-foreground">已复制</span> : null}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">输入 Token 名称后生成一行安装命令。</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

async function loadOrganizationSettingsData(organizationId: string): Promise<{
  deviceTokens: AuthDeviceTokenSummary[];
  invitations: AuthInvitationSummary[];
}> {
  const [deviceTokensResponse, invitationsResponse] = await Promise.all([
    fetch(`/api/organizations/${encodeURIComponent(organizationId)}/device-tokens`),
    fetch(`/api/organizations/${encodeURIComponent(organizationId)}/invitations`),
  ]);
  if (!deviceTokensResponse.ok) throw new Error(`设备 token 列表加载失败: HTTP ${deviceTokensResponse.status}`);
  if (!invitationsResponse.ok) throw new Error(`邀请列表加载失败: HTTP ${invitationsResponse.status}`);
  const deviceTokensPayload = await deviceTokensResponse.json().catch(() => ({}));
  const invitationsPayload = await invitationsResponse.json().catch(() => ({}));
  return {
    deviceTokens: Array.isArray(deviceTokensPayload?.deviceTokens) ? deviceTokensPayload.deviceTokens.map(stripPlaintextDeviceToken) : [],
    invitations: Array.isArray(invitationsPayload?.invitations) ? invitationsPayload.invitations : [],
  };
}

function stripPlaintextDeviceToken(token: AuthDeviceTokenSummary & { token?: string }): AuthDeviceTokenSummary {
  const { token: _token, ...summary } = token;
  return summary;
}

function deviceTokenStatusLabel(status: AuthDeviceTokenStatus): string {
  if (status === "pending") return "待绑定";
  if (status === "occupied") return "已占用";
  if (status === "revoked") return "已撤销";
  return "已过期";
}

function deviceTokenStatusTone(status: AuthDeviceTokenStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "pending") return "warning";
  if (status === "occupied") return "success";
  if (status === "revoked") return "danger";
  return "neutral";
}

function invitationStatusLabel(status: AuthInvitationSummary["status"]): string {
  if (status === "available") return "待接受";
  if (status === "expired") return "已过期";
  if (status === "revoked") return "已撤销";
  return "已加入";
}

function invitationStatusTone(status: AuthInvitationSummary["status"]): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "available") return "warning";
  if (status === "expired") return "neutral";
  if (status === "revoked") return "danger";
  return "success";
}

function formatDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function SummaryItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-[var(--surface-soft)] p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function buildInstallCommand(input: { deviceId: string; origin: string; token: string }): string {
  const installerUrl = `${input.origin}/api/device-collector/install.sh`;
  return [
    `curl -fsSL ${shellQuote(installerUrl)} | bash -s --`,
    "--server-url",
    shellQuote(input.origin),
    "--device-id",
    shellQuote(input.deviceId),
    "--device-token",
    shellQuote(input.token),
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  if (!domain) return email.trim();
  return `${local.slice(0, 1)}***@${domain}`;
}
