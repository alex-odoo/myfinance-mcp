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
<title>FinanceMCP - Sign in</title>
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
</style>
</head>
<body>
<div class="card">
  <h1>FinanceMCP</h1>
  <p>Sign in to connect ${app} to your finances.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
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
