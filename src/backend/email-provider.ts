import nodemailer from "nodemailer";
import { resolveLorumeAppMode } from "../app-mode";
import type { AuthEmailProvider } from "../auth/auth-http-api";

/** Create the production email provider used by email-code login. */
export function createBackendEmailProvider(): AuthEmailProvider {
  return {
    async sendLoginCode({ code, email }) {
      const appMode = resolveLorumeAppMode(process.env.LORUME_APP_MODE);
      if (appMode === "development" || process.env.LORUME_AUTH_DEBUG_CODES === "1") {
        process.stdout.write(`Lorume login code for ${email}: ${code}\n`);
        return;
      }

      if (process.env.LORUME_EMAIL_PROVIDER === "smtp") {
        await sendSmtpLoginCode({ code, email });
        return;
      }

      throw new Error("email_provider_not_configured");
    },
  };
}

async function sendSmtpLoginCode(input: { code: string; email: string }): Promise<void> {
  const host = readRequiredEnv("LORUME_SMTP_HOST");
  const port = Number(readRequiredEnv("LORUME_SMTP_PORT"));
  const user = readRequiredEnv("LORUME_SMTP_USER");
  const pass = readRequiredEnv("LORUME_SMTP_PASSWORD");
  const from = process.env.LORUME_EMAIL_FROM || `Lorume <${user}>`;
  const secure = readBooleanEnv("LORUME_SMTP_SECURE", port === 465);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("LORUME_SMTP_PORT must be a positive integer");
  }

  const transporter = nodemailer.createTransport({
    auth: { pass, user },
    host,
    port,
    secure,
  });

  await transporter.sendMail({
    from,
    to: input.email,
    subject: "Lorume 登录验证码",
    text: `你的 Lorume 登录验证码是 ${input.code}，10 分钟内有效。若不是你本人操作，可以忽略这封邮件。`,
    html: [
      "<p>你的 Lorume 登录验证码是：</p>",
      `<p><strong style="font-size: 24px; letter-spacing: 4px;">${escapeHtml(input.code)}</strong></p>`,
      "<p>验证码 10 分钟内有效。若不是你本人操作，可以忽略这封邮件。</p>",
    ].join(""),
  });
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
