import { config } from "../config";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function loginPage(requestId: string, clientName?: string, error?: string): string {
  const app = clientName ? escapeHtml(clientName) : "your AI client";
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
  .google { display: flex; align-items: center; justify-content: center; gap: 10px;
            width: 100%; padding: 10px; border: 1px solid #dadce0; border-radius: 8px;
            background: #fff; color: #3c4043; font-size: 15px; font-weight: 500;
            text-decoration: none; box-sizing: border-box; }
  .google:hover { background: #f8f9fa; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 16px 0 4px;
             color: #999; font-size: 12px; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #e5e5e5; }
</style>
</head>
<body>
<div class="card">
  <h1>MyFinance MCP</h1>
  <p>Sign in to connect ${app} to your finances.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  ${
    requestId && config.googleClientId && config.googleClientSecret
      ? `<a class="google" href="/auth/google?request_id=${escapeHtml(requestId)}">
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Continue with Google
  </a>
  <div class="divider"><span>or</span></div>`
      : ""
  }
  ${
    requestId
      ? `<form method="post" action="/login">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>`
      : ""
  }
</div>
</body>
</html>`;
}
