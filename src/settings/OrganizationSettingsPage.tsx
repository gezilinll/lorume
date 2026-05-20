import { useMemo, useState } from "react";
import type { AuthMemberRole, AuthSessionContext } from "../auth/auth-store";
import { PixelIcon } from "../ui/PixelIcon";

interface OrganizationSettingsPageProps {
  session?: AuthSessionContext;
}

const roleLabels: Record<AuthMemberRole, string> = {
  admin: "管理员",
  member: "成员",
  owner: "Owner",
};

/** Organization settings entry for member visibility and invitation link creation. */
export function OrganizationSettingsPage({ session }: OrganizationSettingsPageProps) {
  const organization = session?.organizations[0];
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

  const canManage = useMemo(() => organization?.role === "owner" || organization?.role === "admin", [organization]);

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
      <section className="workspace">
        <header className="pageHeader">
          <div>
            <p className="eyebrow">Organization</p>
            <h1>组织设置</h1>
            <p className="pageSubtitle">请选择组织后管理成员与权限。</p>
          </div>
        </header>
      </section>
    );
  }

  return (
    <section className="workspace">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Organization</p>
          <h1>组织设置</h1>
          <p className="pageSubtitle">管理当前组织的成员身份、邀请链接和权限入口。</p>
        </div>
      </header>

      <section className="metricGrid" aria-label="组织概览">
        <Metric label="组织" value={1} tone="blue" />
        <Metric label="当前角色" value={roleLabels[organization.role]} tone="green" />
      </section>

      <section className="resourceCenterGrid">
        <section className="tablePanel" aria-label="组织成员">
          <div className="runtimePanelHeader">
            <div>
              <h2>{organization.name}</h2>
              <p>{organization.slug}</p>
            </div>
            <PixelIcon name="settings" size={18} />
          </div>
          <div className="resourceList">
            <article className="resourceListItem">
              <strong>{session.user.email}</strong>
              <span>{roleLabels[organization.role]}</span>
              <small>当前登录成员</small>
            </article>
          </div>
        </section>

        <aside className="detailPanel resourceDetailPanel" aria-label="邀请成员">
          <div className="detailHeader">
            <div>
              <p className="eyebrow">Invite</p>
              <h2>邀请成员</h2>
            </div>
          </div>
          {canManage ? (
            <div className="skillForm">
              <label className="toolbarField">
                <span className="controlLabel">邮箱</span>
                <input
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="name@company.com"
                />
              </label>
              <label className="toolbarField">
                <span className="controlLabel">角色</span>
                <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as AuthMemberRole)}>
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
              </label>
              <button
                className="primaryButton"
                type="button"
                disabled={isSubmitting || !inviteEmail.trim()}
                onClick={() => void createInvitation()}
              >
                创建邀请链接
              </button>
              {inviteLink ? (
                <div className="inviteLinkBlock">
                  <label className="toolbarField inviteLinkControl">
                    <span className="controlLabel">邀请链接</span>
                    <input
                      aria-label="邀请链接"
                      className="inviteLinkInput"
                      readOnly
                      value={inviteLink}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </label>
                  <button className="secondaryButton compactButton" type="button" onClick={() => void copyInviteLink()}>
                    复制邀请链接
                  </button>
                  {copiedInviteLink ? <span className="skillStatusInline">已复制</span> : null}
                </div>
              ) : null}
              {errorMessage ? <p className="skillErrorMessage">{errorMessage}</p> : null}
            </div>
          ) : (
            <p>当前角色不能创建邀请链接。</p>
          )}
        </aside>
      </section>

      <section className="tablePanel deviceRegistrationPanel" aria-label="设备注册">
        <div className="runtimePanelHeader">
          <div>
            <p className="eyebrow">Device</p>
            <h2>设备注册</h2>
          </div>
          <PixelIcon name="terminal" size={18} />
        </div>
        {canManage ? (
          <div className="skillForm">
            <div className="deviceRegistrationGrid">
              <label className="toolbarField">
                <span className="controlLabel">Device ID</span>
                <input
                  value={deviceId}
                  onChange={(event) => setDeviceId(event.target.value)}
                  placeholder="fixture-mac"
                />
              </label>
            </div>
            <button
              className="primaryButton"
              type="button"
              disabled={isCreatingDeviceToken || !deviceId.trim()}
              onClick={() => void createDeviceInstallCommand()}
            >
              生成安装命令
            </button>
            {installCommand ? (
              <div className="installCommandBlock">
                <label className="toolbarField installCommandControl">
                  <span className="controlLabel">Device token</span>
                  <input
                    aria-label="Device token"
                    className="inviteLinkInput"
                    readOnly
                    value={deviceToken}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <label className="toolbarField installCommandControl">
                  <span className="controlLabel">安装命令</span>
                  <textarea
                    aria-label="安装命令"
                    className="installCommandInput"
                    readOnly
                    rows={3}
                    value={installCommand}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <div className="deviceRegistrationActions">
                  <button className="secondaryButton compactButton" type="button" onClick={() => void copyInstallCommand()}>
                    复制安装命令
                  </button>
                  {copiedInstallCommand ? <span className="skillStatusInline">已复制</span> : null}
                </div>
              </div>
            ) : null}
            {deviceErrorMessage ? <p className="skillErrorMessage">{deviceErrorMessage}</p> : null}
          </div>
        ) : (
          <p>当前角色不能注册设备。</p>
        )}
      </section>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className={`metricCard metric${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
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
