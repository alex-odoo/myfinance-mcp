import { config } from "./config";
import { SERVER_VERSION } from "./version";

/**
 * Fire-and-forget admin notifications on a genuine new-user signup. Two
 * independent channels, each off unless its own env is set; both are
 * best-effort and never throw, so a lost notification can never fail a signup.
 */
export function notifySignup(email: string, method: string): void {
  notifyResendEmail(email, method);
  notifyTelegram(email);
}

/** Email alert via Resend (from the verified rteam.agency sender domain). */
function notifyResendEmail(email: string, method: string): void {
  if (!config.resendApiKey || !config.notifyEmail || !config.fromEmail) return;
  void fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `MyFinance MCP <${config.fromEmail}>`,
      to: [config.notifyEmail],
      subject: `[MyFinance MCP] New user - ${email}`,
      text: `New user registered\n\nEmail: ${email}\nMethod: ${method}\nTime: ${new Date().toISOString()}\n`,
    }),
  }).catch(() => {
    /* swallow: notification is best-effort */
  });
}

/** Telegram alert (email + time + version) to the configured chat. */
function notifyTelegram(email: string): void {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const text =
    `<b>MyFinance MCP · New user</b>\n` +
    `Email: ${escapeHtml(email)}\n` +
    `Time: ${new Date().toISOString()}\n` +
    `Version: ${SERVER_VERSION}`;
  void fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  }).catch(() => {
    /* swallow: notification is best-effort */
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
