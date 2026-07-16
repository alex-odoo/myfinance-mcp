import { config } from "./config";

/**
 * Fire-and-forget admin notification via Resend (same pattern as rteam.agency
 * lead alerts). Sends from the Resend-verified rteam.agency domain; the
 * feature is off unless RESEND_API_KEY is set. Never throws: a lost
 * notification must never fail a signup.
 */
export function notifySignup(email: string, method: string): void {
  if (!config.resendApiKey) return;
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
