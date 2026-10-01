import { config } from "./config";

/** Sign-in mail needs the Resend key and the verified sender address. */
export function mailConfigured(): boolean {
  return !!config.resendApiKey && !!config.fromEmail;
}

/**
 * One transactional email via Resend, plain text. False when mail is not
 * configured or the send failed; the caller decides what the user sees.
 * Status codes only in logs: the address and the body stay out (blind logs).
 */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  if (!mailConfigured()) return false;
  try {
    const res = await fetch(`${config.resendApiBase}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `MyFinance MCP <${config.fromEmail}>`, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[mail] resend HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error("[mail] resend failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}
