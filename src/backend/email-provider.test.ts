import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackendEmailProvider } from "./email-provider";

const mocks = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail }));
  return { createTransport, sendMail };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  mocks.createTransport.mockClear();
  mocks.sendMail.mockClear();
});

describe("backend email provider", () => {
  it("sends login codes through the configured SMTP account", async () => {
    process.env.LORUME_APP_MODE = "production";
    process.env.LORUME_EMAIL_PROVIDER = "smtp";
    process.env.LORUME_SMTP_HOST = "smtp.qiye.aliyun.com";
    process.env.LORUME_SMTP_PORT = "465";
    process.env.LORUME_SMTP_SECURE = "1";
    process.env.LORUME_SMTP_USER = "noreply@lorume.com";
    process.env.LORUME_SMTP_PASSWORD = "smtp-password";
    process.env.LORUME_EMAIL_FROM = "Lorume <noreply@lorume.com>";

    const provider = createBackendEmailProvider();
    await provider.sendLoginCode({ code: "246810", email: "zhangliang@gaoding.com" });

    expect(mocks.createTransport).toHaveBeenCalledWith({
      auth: {
        pass: "smtp-password",
        user: "noreply@lorume.com",
      },
      host: "smtp.qiye.aliyun.com",
      port: 465,
      secure: true,
    });
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "Lorume <noreply@lorume.com>",
      subject: "Lorume 登录验证码",
      text: expect.stringContaining("246810"),
      to: "zhangliang@gaoding.com",
    }));
  });

  it("sends organization invitations through the configured SMTP account", async () => {
    process.env.LORUME_APP_MODE = "production";
    process.env.LORUME_EMAIL_PROVIDER = "smtp";
    process.env.LORUME_SMTP_HOST = "smtp.qiye.aliyun.com";
    process.env.LORUME_SMTP_PORT = "465";
    process.env.LORUME_SMTP_SECURE = "1";
    process.env.LORUME_SMTP_USER = "noreply@lorume.com";
    process.env.LORUME_SMTP_PASSWORD = "smtp-password";
    process.env.LORUME_EMAIL_FROM = "Lorume <noreply@lorume.com>";

    const provider = createBackendEmailProvider();
    await provider.sendOrganizationInvitation({
      email: "member@gaoding.com",
      expiresAt: new Date("2026-05-19T10:00:00.000Z"),
      inviteUrl: "https://lorume.com/invite/invite-token",
      organizationName: "Lorume Team",
      role: "admin",
    });

    expect(mocks.createTransport).toHaveBeenCalledWith({
      auth: {
        pass: "smtp-password",
        user: "noreply@lorume.com",
      },
      host: "smtp.qiye.aliyun.com",
      port: 465,
      secure: true,
    });
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "Lorume <noreply@lorume.com>",
      subject: "Lorume Team 邀请你加入 Lorume",
      text: expect.stringContaining("https://lorume.com/invite/invite-token"),
      to: "member@gaoding.com",
    }));
  });

  it("fails loudly when production email provider is not configured", async () => {
    process.env.LORUME_APP_MODE = "production";
    delete process.env.LORUME_AUTH_DEBUG_CODES;
    delete process.env.LORUME_EMAIL_PROVIDER;

    const provider = createBackendEmailProvider();

    await expect(provider.sendLoginCode({
      code: "246810",
      email: "zhangliang@gaoding.com",
    })).rejects.toThrow("email_provider_not_configured");
    await expect(provider.sendOrganizationInvitation({
      email: "member@gaoding.com",
      expiresAt: new Date("2026-05-19T10:00:00.000Z"),
      inviteUrl: "https://lorume.com/invite/invite-token",
      organizationName: "Lorume Team",
      role: "member",
    })).rejects.toThrow("email_provider_not_configured");
  });

  it("prints login codes in development mode without requiring SMTP", async () => {
    process.env.LORUME_APP_MODE = "development";
    delete process.env.LORUME_AUTH_DEBUG_CODES;
    delete process.env.LORUME_EMAIL_PROVIDER;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const provider = createBackendEmailProvider();
    await provider.sendLoginCode({ code: "246810", email: "zhangliang@gaoding.com" });
    await provider.sendOrganizationInvitation({
      email: "member@gaoding.com",
      expiresAt: new Date("2026-05-19T10:00:00.000Z"),
      inviteUrl: "https://lorume.com/invite/invite-token",
      organizationName: "Lorume Team",
      role: "member",
    });

    expect(write).toHaveBeenCalledWith("Lorume login code for zhangliang@gaoding.com: 246810\n");
    expect(write).toHaveBeenCalledWith("Lorume invitation for member@gaoding.com: https://lorume.com/invite/invite-token\n");
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
});
