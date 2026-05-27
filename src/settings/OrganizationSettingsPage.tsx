import { useMemo, useState, type ReactNode } from "react";
import type { AuthMemberRole, AuthOrganizationMembership, AuthSessionContext } from "../auth/auth-store";
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
  const [inviteRole, setInviteRole] = useState<AuthMemberRole>("member");
  const [inviteLink, setInviteLink] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [deviceToken, setDeviceToken] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [copiedInviteLink, setCopiedInviteLink] = useState(false);
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [deviceErrorMessage, setDeviceErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreatingDeviceToken, setIsCreatingDeviceToken] = useState(false);
  const hasConsoleWorkbar = useHasConsoleWorkbar();

  const canManage = useMemo(() => organization?.role === "owner" || organization?.role === "admin", [organization]);

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
    setInviteLink("");
    setCopiedInviteLink(false);
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
      const token = typeof payload?.invitation?.token === "string" ? payload.invitation.token : "";
      setInviteLink(token ? `${window.location.origin}/invite/${encodeURIComponent(token)}` : "邀请已创建");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "邀请创建失败");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard?.writeText(inviteLink);
      setCopiedInviteLink(true);
    } catch {
      setCopiedInviteLink(false);
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
      setInstallCommand(buildInstallCommand({
        deviceId: registeredDeviceId,
        origin: window.location.origin,
        token,
      }));
    } catch (error) {
      setDeviceErrorMessage(error instanceof Error ? error.message : "设备 token 创建失败");
    } finally {
      setIsCreatingDeviceToken(false);
    }
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
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>组织概览</CardTitle>
            <CardDescription>当前 Console 使用的组织上下文。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <SummaryItem label="组织名称" value={organization.name} />
            <SummaryItem label="Slug" value={organization.slug} />
            <SummaryItem label="当前角色" value={<StatusBadge tone={canManage ? "success" : "neutral"}>{roleLabels[organization.role]}</StatusBadge>} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>设备 Token</CardTitle>
            <CardDescription>管理员创建后只在本次页面状态中显示明文 token。</CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="device-id">Device ID</FieldLabel>
                  <Input
                    id="device-id"
                    value={deviceId}
                    onChange={(event) => setDeviceId(event.target.value)}
                    placeholder="fixture-mac"
                  />
                  <FieldDescription>使用稳定、可读的本机设备标识。</FieldDescription>
                </Field>
                <Button
                  className="w-fit"
                  type="button"
                  disabled={isCreatingDeviceToken || !deviceId.trim()}
                  onClick={() => void createDeviceInstallCommand()}
                >
                  生成安装命令
                </Button>
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>成员与邀请</CardTitle>
            <CardDescription>查看当前成员身份，并为新成员生成一次性邀请链接。</CardDescription>
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
                    <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as AuthMemberRole)}>
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
                  创建邀请链接
                </Button>
                {inviteLink ? (
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="invite-link">邀请链接</FieldLabel>
                      <Input
                        id="invite-link"
                        aria-label="邀请链接"
                        readOnly
                        value={inviteLink}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" type="button" onClick={() => void copyInviteLink()}>
                        复制邀请链接
                      </Button>
                      {copiedInviteLink ? <span className="text-sm text-muted-foreground">已复制</span> : null}
                    </div>
                  </FieldGroup>
                ) : null}
                {errorMessage ? (
                  <Alert variant="destructive">
                    <AlertTitle>邀请创建失败</AlertTitle>
                    <AlertDescription>{errorMessage}</AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            ) : (
              <p className="text-sm text-muted-foreground">当前角色不能创建邀请链接。</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>安装命令</CardTitle>
            <CardDescription>生成后复制到目标设备执行 Collector 安装。</CardDescription>
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
              <p className="text-sm text-muted-foreground">输入 Device ID 后生成一行安装命令。</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
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
