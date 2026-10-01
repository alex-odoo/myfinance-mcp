import { config } from "../config";
import { mailConfigured } from "../mail";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The client a sign-in page is for: its self-chosen name and where the code goes. */
export interface LoginClient {
  name?: string;
  redirectUri?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Redirect hosts of the AI clients we know (and their subdomains).
const KNOWN_CLIENT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"];
const THIS_DEVICE = "an app on this device";

/**
 * client_name is whatever an anonymous registration chose ("Claude" costs
 * nothing), so the page also names the host that receives the authorization
 * code, and flags hosts that are not a known AI client.
 */
function destination(redirectUri: string): { label: string; unknownHost?: string } {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { label: redirectUri, unknownHost: redirectUri };
  }
  // Custom schemes (cursor://, vscode://) and loopback hand the code to a local app.
  if (url.protocol !== "http:" && url.protocol !== "https:") return { label: THIS_DEVICE };
  if (LOOPBACK_HOSTS.has(url.hostname)) return { label: THIS_DEVICE };
  const host = url.hostname;
  const known = KNOWN_CLIENT_HOSTS.some((k) => host === k || host.endsWith(`.${k}`));
  return { label: host, unknownHost: known ? undefined : host };
}

/** "al•••@example.com": enough for the owner to recognise, not a full address on screen. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = email.slice(0, at);
  return `${local.slice(0, local.length > 3 ? 2 : 1)}•••${email.slice(at)}`;
}

/** Where the code goes, for the sign-in email: the host, or "an app on this device". */
export function destinationLabel(client?: LoginClient): string | undefined {
  return client?.redirectUri ? destination(client.redirectUri).label : undefined;
}

export function loginPage(requestId: string, client?: LoginClient, error?: string): string {
  const emailForm = requestId && mailConfigured()
    ? `<form method="post" action="/login/email">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <label for="code-email">Email</label>
    <input id="code-email" name="email" type="email" autocomplete="email" maxlength="254" required>
    <button type="submit">Email me a sign-in code</button>
    <p class="hint">New here? The same code creates your account.</p>
  </form>`
    : "";
  const passwordForm = requestId
    ? `<form method="post" action="/login">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>`
    : "";
  // Only the operator account has a password: with email codes on, its form
  // stays folded away instead of reading as the way in for everyone.
  const body = emailForm
    ? `${emailForm}
  <details class="pw"><summary>Sign in with a password</summary>${passwordForm}</details>`
    : passwordForm;
  return page(requestId, client, error, body);
}

/** Second step of email sign-in: enter the code, or ask for a new one. */
export function codePage(requestId: string, client: LoginClient | undefined, email: string, error?: string): string {
  const id = escapeHtml(requestId);
  return page(
    requestId,
    client,
    error,
    `<p>We sent an 8-digit code to <b>${escapeHtml(maskEmail(email))}</b>. It expires in 10 minutes.</p>
  <form method="post" action="/login/email/verify">
    <input type="hidden" name="request_id" value="${id}">
    <label for="code">Sign-in code</label>
    <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required autofocus>
    <button type="submit">Sign in</button>
  </form>
  <form method="post" action="/login/email">
    <input type="hidden" name="request_id" value="${id}">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <button type="submit" class="link">Send a new code</button>
  </form>
  <p class="hint"><a href="/login?request_id=${id}">Use a different email</a></p>`,
    false
  );
}

function page(requestId: string, client: LoginClient | undefined, error: string | undefined, body: string, withGoogle = true): string {
  const app = client?.name ? escapeHtml(client.name) : "your AI client";
  const dest = client?.redirectUri ? destination(client.redirectUri) : undefined;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MyFinance MCP - Sign in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #f5f6f8; margin: 0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 12px; padding: 32px; width: 320px;
          box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #555; font-size: 14px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #333; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 8px;
          font-size: 15px; box-sizing: border-box; }
  button { width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 8px;
           background: #111; color: #fff; font-size: 15px; cursor: pointer; }
  .error { background: #fdecec; color: #b3261e; border-radius: 8px; padding: 10px;
           font-size: 13px; margin-bottom: 8px; }
  .dest { margin-top: -14px; }
  .warn { background: #fff4e5; color: #8a4b00; border-radius: 8px; padding: 10px;
          font-size: 13px; margin-bottom: 16px; }
  .google { display: flex; align-items: center; justify-content: center; gap: 10px;
            width: 100%; padding: 10px; border: 1px solid #dadce0; border-radius: 8px;
            background: #fff; color: #3c4043; font-size: 15px; font-weight: 500;
            text-decoration: none; box-sizing: border-box; }
  .google:hover { background: #f8f9fa; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 16px 0 4px;
             color: #999; font-size: 12px; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #e5e5e5; }
  .hint { font-size: 12px; color: #777; margin: 10px 0 0; }
  .hint a { color: #555; }
  .pw { margin-top: 18px; font-size: 13px; color: #555; }
  .pw summary { cursor: pointer; }
  button.link { background: none; color: #555; padding: 0; margin-top: 14px; width: auto;
                font-size: 13px; text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <h1>MyFinance MCP</h1>
  <p>Sign in to connect ${app} to your finances.</p>
  ${dest ? `<p class="dest">After sign-in you return to <b>${escapeHtml(dest.label)}</b>.</p>` : ""}
  ${
    dest?.unknownHost
      ? `<div class="warn">${escapeHtml(dest.unknownHost)} is not an AI client we recognise. Continue only if you started this connection yourself.</div>`
      : ""
  }
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  ${
    withGoogle && requestId && config.googleClientId && config.googleClientSecret
      ? `<a class="google" href="/auth/google?request_id=${escapeHtml(requestId)}">
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Continue with Google
  </a>
  <div class="divider"><span>or</span></div>`
      : ""
  }
  ${body}
</div>
</body>
</html>`;
}
