import { readFileSync } from "node:fs";

export const DASHBOARD_URI = "ui://myfinancemcp/dashboard";
export const DASHBOARD_MIME = "text/html;profile=mcp-app";

export const DASHBOARD_HTML = readFileSync(new URL("./ui/dashboard.html", import.meta.url), "utf8");

/** Tool _meta linking to the dashboard (nested form per ext-apps 2026-01-26 + deprecated flat key for older hosts). */
export const DASHBOARD_TOOL_META = {
  ui: { resourceUri: DASHBOARD_URI },
  "ui/resourceUri": DASHBOARD_URI,
};
