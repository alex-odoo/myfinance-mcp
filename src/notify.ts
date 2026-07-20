import { config } from "./config";
import { logEvent } from "./db";
import { SERVER_VERSION } from "./version";

/**
 * Fire-and-forget admin notifications on a genuine new-user signup. Two
 * independent channels, each off unless its own env is set; both are
 * best-effort and never throw, so a lost notification can never fail a signup.
 * Failures are retried once and land in logs + telemetry (2026-07-20: two
 * signups produced email but no Telegram alert and the old swallow-everything
 * code left zero evidence of why).
 */
export function notifySignup(email: string, method: string): void {
  void deliver("resend", () => sendResendEmail(email, method));
  void deliver("telegram", () => sendTelegram(email));
}

/** Run one channel: check the HTTP response, retry once, never throw. */
async function deliver(channel: string, send: () => Promise<Response> | null): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const pending = send();
      if (pending === null) return; // channel not configured
      const res = await pending;
      if (res.ok) return;
      const body = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`[notify] ${channel} attempt ${attempt} HTTP ${res.status}: ${redact(body)}`);
      logEvent("notify_failed", undefined, { channel, attempt, status: res.status });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[notify] ${channel} attempt ${attempt} error: ${redact(msg)}`);
      logEvent("notify_failed", undefined, { channel, attempt, status: 0 });
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 5000));
  }
}

/** Error text may echo the request URL; never let the bot token reach logs. */
function redact(s: string): string {
  return config.telegramBotToken ? s.replaceAll(config.telegramBotToken, "***") : s;
}

/** Email alert via Resend (from the verified sender domain). */
function sendResendEmail(email: string, method: string): Promise<Response> | null {
  if (!config.resendApiKey || !config.notifyEmail || !config.fromEmail) return null;
  return fetch("https://api.resend.com/emails", {
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
  });
}

/** Telegram alert (email + time + version) to the configured chat. */
function sendTelegram(email: string): Promise<Response> | null {
  if (!config.telegramBotToken || !config.telegramChatId) return null;
  const text =
    `<b>MyFinance MCP · New user</b>\n` +
    `Email: ${escapeHtml(email)}\n` +
    `Time: ${new Date().toISOString()}\n` +
    `Version: ${SERVER_VERSION}`;
  return fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
