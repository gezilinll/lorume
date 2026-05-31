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
      if (url === "/api/organizations/org_1/audit-events?limit=20") return jsonResponse({ auditEvents: [] });
      expect(url).toBe("/api/organizations/org_1/invitations");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ email: "teammate@lorume.com", role: "member" });
      return jsonResponse({ invitation: { email: "teammate@lorume.com", role: "member" } }, 201);
    }) as unknown as typeof fetch;

    render(<OrganizationSettingsPage session={sessionWithRole("admin")} />);

    expect(screen.getByRole("heading", { name: "组织设置" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "组织成员" })).toBeInTheDocument();
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
      if (url === "/api/organizations/org_1/audit-events?limit=20") return jsonResponse({ auditEvents: [] });
      expect(url).toBe("/api/organizations/org_1/device-tokens");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ deviceId: "fixture-mac", name: "fixture-mac" });
      createdToken = {
        deviceId: "fixture-mac",
        id: "devtok_1",
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
      }, 201);
    }) as unknown as typeof fetch;

    render(<OrganizationSettingsPage session={sessionWithRole("admin")} />);

    await user.type(screen.getByLabelText("Device ID"), "fixture-mac");
    await user.click(screen.getByRole("button", { name: "生成安装命令" }));

    const tokenInput = await screen.findByLabelText("Device token");
    expect((tokenInput as HTMLInputElement).value).toBe("agt_device_secret_123");
    const installCommand = screen.getByLabelText("安装命令");
    expect(installCommand).toHaveTextContent(`${window.location.origin}/api/device-collector/install.sh`);
    expect(installCommand).toHaveTextContent("--device-token 'agt_device_secret_123'");
    expect(installCommand).toHaveTextContent("--device-id 'fixture-mac'");
    expect(installCommand).not.toHaveTextContent("--device-name");
    expect(screen.getByText(/install-device-collector/)).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "设备 Token 列表" })).toBeInTheDocument();
    expect(screen.getByText("待绑定")).toBeInTheDocument();
  });

  it("lists and revokes device tokens for organization admins", async () => {
    const user = userEvent.setup();
    let status = "occupied";
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url === "/api/organizations/org_1/device-tokens") {
        return jsonResponse({
          deviceTokens: [{
            deviceId: "fixture-mac",
            id: "devtok_1",
            name: "Fixture collector",
            organizationId: "org_1",
            status,
            tokenPrefix: "agt_device_s",
          }],
        });
      }
      if (url === "/api/organizations/org_1/audit-events?limit=20") {
        return jsonResponse({ auditEvents: [{ createdAt: "2026-05-31T08:00:00.000Z", eventType: "device_token.created", id: "aud_1", metadata: {} }] });
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
    expect(screen.getByText("已占用")).toBeInTheDocument();
    expect(screen.getByText("创建设备 Token")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "撤销" }));

    expect(await screen.findByText("已撤销")).toBeInTheDocument();
  });

  it("hides invitation creation from regular members", () => {
    render(<OrganizationSettingsPage session={sessionWithRole("member")} />);

    expect(screen.getByText("当前角色不能发送邀请邮件。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送邀请邮件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成安装命令" })).not.toBeInTheDocument();
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
