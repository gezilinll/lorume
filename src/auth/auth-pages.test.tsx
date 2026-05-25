import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

const originalFetch = globalThis.fetch;
const originalPath = window.location.pathname;

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.history.pushState({}, "", originalPath);
  vi.restoreAllMocks();
});

describe("auth pages", () => {
  it("guards the console behind email-code login", async () => {
    window.history.pushState({}, "", "/runtime");
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      requests.push(url);
      if (url.endsWith("/api/me")) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    const { container } = render(<App runtimeMode="production" />);

    expect(await screen.findByRole("heading", { name: "登录 Lorume" })).toBeInTheDocument();
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
    expect(screen.queryByTestId("auth-pixel-decorations")).not.toBeInTheDocument();
    expect(container.querySelector("[data-pixel-icon]")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "运行资产" })).not.toBeInTheDocument();
    expect(requests).toEqual(["/api/me"]);
  });

  it("keeps agent mode local and still renders the complete Console shell", () => {
    window.history.pushState({}, "", "/runtime");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({ error: "unexpected request" }, 500));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<App runtimeMode="agent" />);

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换组织" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开个人入口" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/me", expect.anything());
  });

  it("does not poll authenticated utility counts in agent mode", async () => {
    window.history.pushState({}, "", "/runtime");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({ error: "unexpected request" }, 500));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<App runtimeMode="agent" />);

    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([input]) => input.toString().includes("/api/runtime-fleet"))).toBe(true);
    });

    const requestedUrls = fetchSpy.mock.calls.map(([input]) => input.toString());
    expect(requestedUrls).not.toEqual(expect.arrayContaining([
      expect.stringContaining("/api/operations"),
      expect.stringContaining("/api/notifications"),
    ]));
  });

  it("does not surface anonymous session probe errors on the login page", async () => {
    window.history.pushState({}, "", "/login");
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.endsWith("/api/me")) {
        return jsonResponse({ error: "Not Found" }, 404);
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    expect(await screen.findByRole("heading", { name: "登录 Lorume" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Not Found")).not.toBeInTheDocument();
  });

  it("surfaces unexpected session probe errors instead of hiding backend failures", async () => {
    window.history.pushState({}, "", "/login");
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.endsWith("/api/me")) {
        return jsonResponse({ error: "backend_unavailable", message: "后端暂不可用，请稍后重试。" }, 503);
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    expect(await screen.findByRole("heading", { name: "登录 Lorume" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("后端暂不可用，请稍后重试。");
  });

  it("requests an email code and signs in with the verification code", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/login");
    const requests: Array<{ body: unknown; url: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/api/me")) return jsonResponse({ error: "unauthorized" }, 401);
      if (url.endsWith("/api/auth/email-code")) return jsonResponse({ ok: true, email: "zhangliang@gaoding.com" }, 202);
      if (url.endsWith("/api/auth/login")) {
        return jsonResponse(sessionResponse({
          organizations: [{ organizationId: "org_1", id: "mem_1", name: "Lorume Team", role: "owner", slug: "lorume" }],
        }));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    await user.type(await screen.findByLabelText("邮箱"), "ZHANGLIANG@GAODING.COM");
    await user.click(screen.getByRole("button", { name: /发送验证码/ }));
    expect(await screen.findByRole("heading", { name: "输入验证码" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("验证码"), "246810");
    await user.click(screen.getByRole("button", { name: "进入控制台" }));

    expect(await screen.findByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(requests).toContainEqual({
      url: "/api/auth/email-code",
      body: { email: "zhangliang@gaoding.com" },
    });
    expect(requests).toContainEqual({
      url: "/api/auth/login",
      body: { code: "246810", email: "zhangliang@gaoding.com" },
    });
  });

  it("maps auth error codes to readable verification messages", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/login");
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.endsWith("/api/me")) return jsonResponse({ error: "unauthorized" }, 401);
      if (url.endsWith("/api/auth/email-code")) return jsonResponse({ ok: true, email: "zhangliang@gaoding.com" }, 202);
      if (url.endsWith("/api/auth/login")) return jsonResponse({ error: "invalid_or_expired_code" }, 401);
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    await user.type(await screen.findByLabelText("邮箱"), "zhangliang@gaoding.com");
    await user.click(screen.getByRole("button", { name: /发送验证码/ }));
    await user.type(await screen.findByLabelText("验证码"), "12321");
    await user.click(screen.getByRole("button", { name: "进入控制台" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("验证码无效或已过期，请重新获取验证码。");
    expect(screen.queryByText("invalid_or_expired_code")).not.toBeInTheDocument();
  });

  it("maps login service gateway failures to a readable message", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/login");
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.endsWith("/api/me")) return jsonResponse({ error: "unauthorized" }, 401);
      if (url.endsWith("/api/auth/email-code")) {
        return new Response("", { status: 502, statusText: "Bad Gateway" });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    await user.type(await screen.findByLabelText("邮箱"), "zhangliang@gaoding.com");
    await user.click(screen.getByRole("button", { name: /发送验证码/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("登录服务暂时不可用，请稍后重试。");
    expect(screen.queryByText("Bad Gateway")).not.toBeInTheDocument();
  });

  it("asks a signed-in user without organizations to create one", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/runtime");
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.endsWith("/api/me")) return jsonResponse(sessionResponse({ organizations: [] }));
      if (url.endsWith("/api/organizations")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ name: "增长工程组", slug: "growth-eng" });
        return jsonResponse({ organizations: [{ organizationId: "org_1", id: "mem_1", name: "增长工程组", role: "owner", slug: "growth-eng" }] }, 201);
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    expect(await screen.findByRole("heading", { name: "创建组织" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "运营概览" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("组织名称"), "增长工程组");
    await user.clear(screen.getByLabelText("组织标识"));
    await user.type(screen.getByLabelText("组织标识"), "growth-eng");
    await user.click(screen.getByRole("button", { name: "创建并进入" }));

    expect(await screen.findByRole("heading", { name: "运行资产" })).toBeInTheDocument();
  });

  it("accepts an invitation link after the invited email signs in", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/invite/invitation-token-1");
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.endsWith("/api/me")) return jsonResponse(sessionResponse({ organizations: [] }));
      if (url.endsWith("/api/invitations/invitation-token-1/accept")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ organization: { organizationId: "org_2", id: "mem_2", name: "受邀组织", role: "member", slug: "invited" } });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    expect(await screen.findByRole("heading", { name: "加入组织" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "运营概览" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加入并进入" }));

    expect(await screen.findByRole("heading", { name: "运行资产" })).toBeInTheDocument();
  });

  it("logs out and returns to the login page", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/runtime");
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.endsWith("/api/me")) {
        return jsonResponse(sessionResponse({
          organizations: [{ organizationId: "org_1", id: "mem_1", name: "Lorume Team", role: "owner", slug: "lorume" }],
        }));
      }
      if (url.endsWith("/api/auth/logout")) return new Response(null, { status: 204 });
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="production" />);

    expect(await screen.findByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开个人入口" }));
    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "登录 Lorume" })).toBeInTheDocument();
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sessionResponse(options: { organizations: unknown[] }) {
  return {
    id: "ses_1",
    organizations: options.organizations,
    user: {
      createdAt: "2026-05-12T10:00:00.000Z",
      email: "zhangliang@gaoding.com",
      id: "usr_1",
      updatedAt: "2026-05-12T10:00:00.000Z",
    },
  };
}
