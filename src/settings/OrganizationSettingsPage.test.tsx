import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthMemberRole, AuthSessionContext } from "../auth/auth-store";
import { OrganizationSettingsPage } from "./OrganizationSettingsPage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OrganizationSettingsPage", () => {
  it("does not show invitation controls before an organization is selected", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<OrganizationSettingsPage />);

    expect(screen.getByRole("heading", { name: "组织设置" })).toBeInTheDocument();
    expect(screen.getByText("请选择组织后管理成员与权限。")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends an invitation email for organization admins", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url === "/api/organizations/org_1/device-tokens") return jsonResponse({ deviceTokens: [] });
      if (url === "/api/organizations/org_1/invitations" && init?.method !== "POST") return jsonResponse({ invitations: [] });
      if (url === "/api/organizations/org_1/members") return jsonResponse({ members: [memberSummary()] });
      expect(url).toBe("/api/organizations/org_1/invitations");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ email: "teammate@lorume.com", expiresIn: "7d", role: "member" });
      return jsonResponse({ invitation: { email: "teammate@lorume.com", role: "member" } }, 201);
    }) as unknown as typeof fetch;

    render(<OrganizationSettingsPage session={sessionWithRole("admin")} />);

    expect(screen.getByRole("heading", { name: "组织设置" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "组织成员" })).toBeInTheDocument();
    expect(screen.getByText("成员数")).toBeInTheDocument();
    expect(screen.getAllByText("待加入邀请").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "发送邀请邮件" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("邮箱"), "teammate@lorume.com");
    await user.click(screen.getByRole("button", { name: "发送邀请邮件" }));

    expect(await screen.findByText("邀请已发送")).toBeInTheDocument();
    expect(screen.getByText("邀请邮件已发送至 t***@lorume.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("邀请链接")).not.toBeInTheDocument();
  });

  it("creates a device token and one-line install command for organization admins", async () => {
    const user = userEvent.setup();
    let createdToken: unknown = null;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url === "/api/organizations/org_1/device-tokens" && init?.method !== "POST") {
        return jsonResponse({ deviceTokens: createdToken ? [createdToken] : [] });
      }
      if (url === "/api/organizations/org_1/invitations") return jsonResponse({ invitations: [] });
      if (url === "/api/organizations/org_1/members") return jsonResponse({ members: [memberSummary()] });
      expect(url).toBe("/api/organizations/org_1/device-tokens");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ name: "fixture-mac" });
      createdToken = {
        deviceId: null,
        id: "devtok_4a2e65d7-1111-4444-8888-21f5d4aaf301",
        name: "fixture-mac",
        organizationId: "org_1",
        status: "pending",
        tokenPrefix: "agt_device_s",
      };
      return jsonResponse({
        deviceToken: {
          ...(createdToken as Record<string, unknown>),
          token: "agt_device_secret_123",
        },
        installCommand: "curl -fsSL 'http://localhost/api/device-collector/install.sh' | bash -s -- --server-url 'http://localhost' --device-id 'fixture-mac' --device-token 'agt_device_secret_123'",
      }, 201);
    }) as unknown as typeof fetch;

    render(<OrganizationSettingsPage session={sessionWithRole("admin")} />);

    await user.type(screen.getByLabelText("Token 名称"), "fixture-mac");
    await user.click(screen.getByRole("button", { name: "生成安装命令" }));

    const installCommand = await screen.findByLabelText("本次安装命令");
    expect(installCommand).toHaveTextContent("http://localhost/api/device-collector/install.sh");
    expect(installCommand).toHaveTextContent("--device-token 'agt_device_secret_123'");
    expect(installCommand).toHaveTextContent("--device-id 'fixture-mac'");
    expect(installCommand).not.toHaveTextContent("--device-name");
    expect(await screen.findByRole("table", { name: "设备 Token 列表" })).toBeInTheDocument();
    expect(screen.getByText("待绑定")).toBeInTheDocument();
    expect(screen.getByText("devtok_4a2e65d7-1111-4444-8888-21f5d4aaf301")).toBeInTheDocument();
  });

  it("lists and revokes device tokens for organization admins", async () => {
    const user = userEvent.setup();
    let status = "occupied";
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url === "/api/organizations/org_1/device-tokens") {
        return jsonResponse({
          deviceTokens: [{
            canCopyInstallCommand: true,
            deviceId: "fixture-mac",
            id: "devtok_1",
            name: "Fixture collector",
            organizationId: "org_1",
            status,
            tokenPrefix: "agt_device_s",
          }],
        });
      }
      if (url === "/api/organizations/org_1/invitations") return jsonResponse({ invitations: [] });
      if (url === "/api/organizations/org_1/members") return jsonResponse({ members: [memberSummary()] });
      if (url === "/api/organizations/org_1/device-tokens/devtok_1/install-command") {
        return jsonResponse({ installCommand: "curl -fsSL 'http://localhost/api/device-collector/install.sh' | bash -s -- --device-token 'agt_device_secret_123'" });
      }
      expect(url).toBe("/api/organizations/org_1/device-tokens/devtok_1/revoke");
      expect(init?.method).toBe("POST");
      status = "revoked";
      return jsonResponse({
        deviceToken: {
          deviceId: "fixture-mac",
          id: "devtok_1",
          name: "Fixture collector",
          organizationId: "org_1",
          status: "revoked",
          tokenPrefix: "agt_device_s",
        },
      });
    }) as unknown as typeof fetch;

    render(<OrganizationSettingsPage session={sessionWithRole("admin")} />);

    expect(await screen.findByText("Fixture collector")).toBeInTheDocument();
    expect(screen.getByText("devtok_1")).toBeInTheDocument();
    expect(screen.getByText("fixture-mac")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "安装命令" })).toBeInTheDocument();
    expect(screen.queryByText("最近审计")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "复制安装命令" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("agt_device_secret_123"));
    await user.click(screen.getByRole("button", { name: "撤销" }));

    expect(await screen.findByRole("button", { name: "撤销" })).toBeDisabled();
    expect(await screen.findByText("已撤销")).toBeInTheDocument();
    expect(screen.queryByText("fixture-mac")).not.toBeInTheDocument();
  });

  it("lists pending invitations and can resend invitation email", async () => {
    const user = userEvent.setup();
    let resent = false;
    let revoked = false;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url === "/api/organizations/org_1/device-tokens") return jsonResponse({ deviceTokens: [] });
      if (url === "/api/organizations/org_1/members") return jsonResponse({ members: [memberSummary()] });
      if (url === "/api/organizations/org_1/invitations") {
        return jsonResponse({
          invitations: [{
            createdAt: "2026-05-31T08:00:00.000Z",
            email: "teammate@lorume.com",
            expiresAt: "2026-06-07T08:00:00.000Z",
            id: "inv_1",
            organizationId: "org_1",
            role: "admin",
            status: "available",
          }],
        });
      }
      if (url === "/api/organizations/org_1/invitations/inv_1/revoke") {
        expect(init?.method).toBe("POST");
        revoked = true;
        return jsonResponse({
          invitation: {
            createdAt: "2026-05-31T08:00:00.000Z",
            email: "teammate@lorume.com",
            expiresAt: "2026-06-07T08:00:00.000Z",
            id: "inv_1",
            organizationId: "org_1",
            role: "admin",
            status: "revoked",
          },
        });
      }
      expect(url).toBe("/api/organizations/org_1/invitations/inv_1/resend");
      expect(init?.method).toBe("POST");
      resent = true;
      return jsonResponse({
        invitation: {
          createdAt: "2026-05-31T08:05:00.000Z",
          email: "teammate@lorume.com",
          expiresAt: "2026-06-07T08:05:00.000Z",
          id: "inv_2",
          organizationId: "org_1",
          role: "admin",
          status: "available",
        },
      });
    }) as unknown as typeof fetch;

    render(<OrganizationSettingsPage session={sessionWithRole("admin")} />);

    expect(await screen.findByRole("table", { name: "待加入邀请" })).toBeInTheDocument();
    expect(screen.getByText("teammate@lorume.com")).toBeInTheDocument();
    expect(screen.getByText("待接受")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重发" }));

    expect(resent).toBe(true);
    expect(await screen.findByText("邀请已重新发送至 t***@lorume.com")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "撤销邀请" }));
    expect(revoked).toBe(true);
  });

  it("hides invitation creation from regular members", () => {
    render(<OrganizationSettingsPage session={sessionWithRole("member")} />);

    expect(screen.getByText("当前角色不能发送邀请邮件。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送邀请邮件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成安装命令" })).not.toBeInTheDocument();
  });

  it("lets a non-owner member leave the current organization", async () => {
    const user = userEvent.setup();
    const leaveOrganization = vi.fn(async () => {});
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<OrganizationSettingsPage session={sessionWithRole("member")} onLeaveOrganization={leaveOrganization} />);

    await user.click(screen.getByRole("button", { name: "退出组织" }));

    expect(window.confirm).toHaveBeenCalledWith("确定退出当前组织？退出后需要重新邀请才能加入。");
    expect(leaveOrganization).toHaveBeenCalledWith("org_1");
  });

  it("prevents the only owner from leaving the current organization", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url === "/api/organizations/org_1/device-tokens") return jsonResponse({ deviceTokens: [] });
      if (url === "/api/organizations/org_1/invitations") return jsonResponse({ invitations: [] });
      if (url === "/api/organizations/org_1/members") return jsonResponse({ members: [memberSummary("owner")] });
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<OrganizationSettingsPage session={sessionWithRole("owner")} onLeaveOrganization={vi.fn()} />);

    expect(await screen.findByText("唯一 Owner 不能退出组织。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出组织" })).toBeDisabled();
  });
});

function sessionWithRole(role: AuthMemberRole): AuthSessionContext {
  return {
    id: "session_1",
    organizations: [
      {
        id: "membership_1",
        name: "Lorume",
        organizationId: "org_1",
        role,
        slug: "lorume",
      },
    ],
    user: {
      createdAt: new Date("2026-05-17T08:00:00.000Z"),
      email: "owner@lorume.com",
      id: "user_1",
      updatedAt: new Date("2026-05-17T08:00:00.000Z"),
    },
  };
}

function memberSummary(role: AuthMemberRole = "admin") {
  return {
    email: "owner@lorume.com",
    id: "membership_1",
    joinedAt: "2026-05-17T08:00:00.000Z",
    role,
    status: "active",
    userId: "user_1",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
