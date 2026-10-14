import { escapeHtml } from "../oauth/login";
import { SERVER_VERSION } from "../version";
import type { AdminStats, AdminUserRow } from "./stats";

const DAY_MS = 24 * 60 * 60 * 1000;

const e = (value: string | number) => escapeHtml(String(value));
const fmt = (n: number) => n.toLocaleString("en-US", { useGrouping: true });
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const day = (d: Date) => d.toISOString().slice(0, 10);
const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Calendar days in UTC, the same days the hover stamp shows. */
function ago(d: Date | null, now: Date): string {
  if (!d) return "-";
  const utcDay = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const days = Math.round((utcDay(now) - utcDay(d)) / DAY_MS);
  const label = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
  return `<span title="${e(stamp(d))}">${label}</span>`;
}

const STYLE = `
:root { --bg: #f5f6f8; --card: #fff; --ink: #16181d; --muted: #6b7079; --line: #e6e8ec;
        --bar: #2f6f4f; --bar-soft: #dcebe2; --warn: #b3261e; --chip: #f0f1f4; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111317; --card: #1a1d23; --ink: #e8eaee; --muted: #9aa0aa; --line: #2a2e36;
          --bar: #5cb486; --bar-soft: #23382d; --warn: #ff8a80; --chip: #252932; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
       font: 14px/1.45 -apple-system, system-ui, "Segoe UI", sans-serif; }
main { max-width: 1680px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 20px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 15px; margin: 0 0 12px; }
.meta { color: var(--muted); font-size: 13px; }
header form { margin-left: auto; }
button, .btn { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line);
               background: var(--card); color: var(--ink); cursor: pointer; text-decoration: none; display: inline-block; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.kpi .n { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi .l { color: var(--muted); font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 16px; }
.bars { display: grid; gap: 8px; }
.bar { display: grid; grid-template-columns: minmax(0, 42%) minmax(40px, 1fr) auto; gap: 10px; align-items: center; }
.bar .track { background: var(--bar-soft); border-radius: 4px; height: 10px; overflow: hidden; }
.bar .fill { background: var(--bar); height: 100%; }
.bar .v { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; min-width: 64px; text-align: right; }
.weeks { display: flex; align-items: flex-end; gap: 6px; height: 120px; padding-top: 16px; }
.week { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 4px; }
.week .col { width: 100%; background: var(--bar); border-radius: 3px 3px 0 0; min-height: 1px; }
.week .c { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.week .d { font-size: 10px; color: var(--muted); white-space: nowrap; min-height: 14px; }
.section { margin-bottom: 16px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.op td { color: var(--muted); }
.chip { display: inline-block; background: var(--chip); border-radius: 6px; padding: 1px 6px; margin: 0 4px 2px 0; font-size: 12px; }
.err { color: var(--warn); }
.tools { white-space: normal; min-width: 220px; }
.sub { display: block; color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); }
footer { color: var(--muted); font-size: 12px; margin-top: 8px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${e(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Signed-out view: one way in, Google, for the allowlisted addresses. */
export function adminSignInPage(error?: string): string {
  return shell(
    "MyFinance Admin",
    `<main style="max-width:360px;padding-top:15vh">
  <div class="card">
    <h1>MyFinance Admin</h1>
    <p class="meta">Operator overview. Sign in with an allowed Google account.</p>
    ${error ? `<p class="err">${e(error)}</p>` : ""}
    <p><a class="btn" href="/admin/login">Continue with Google</a></p>
  </div>
</main>`
  );
}

function bars(items: Array<{ label: string; value: number; note?: string }>, max: number): string {
  if (!items.length) return `<p class="empty">No data yet.</p>`;
  return `<div class="bars">${items
    .map(
      (i) => `<div class="bar"><span>${e(i.label)}</span>
  <div class="track"><div class="fill" style="width:${max > 0 ? Math.max(1, pct(i.value, max)) : 0}%"></div></div>
  <span class="v">${fmt(i.value)}${i.note ? ` · ${e(i.note)}` : ""}</span></div>`
    )
    .join("")}</div>`;
}

function userRow(u: AdminUserRow, now: Date): string {
  const sources = Object.entries(u.recordsBySource)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} ${fmt(n)}`)
    .join(", ");
  const clients = u.clients.length
    ? u.clients.map((c) => `<span class="chip">${e(c)}</span>`).join("")
    : `<span class="empty">-</span>`;
  const banks = u.banks.length
    ? u.banks.map((b) => `<span class="chip${b.status === "active" ? "" : " err"}">${e(b.provider)}${b.status === "active" ? "" : ` (${e(b.status)})`}</span>`).join("")
    : `<span class="empty">-</span>`;
  const tools = u.topTools.length
    ? u.topTools.map((t) => `<span class="chip">${e(t.tool)} ${fmt(t.calls)}</span>`).join("")
    : `<span class="empty">-</span>`;
  return `<tr${u.operator ? ` class="op"` : ""}>
  <td>${e(u.email)}${u.operator ? ` <span class="chip">operator</span>` : ""}
    <span class="sub">${e(u.method)} · ${e(u.baseCurrency)} · ${e(u.timezone)}</span></td>
  <td title="${e(stamp(u.joined))}">${e(day(u.joined))}</td>
  <td title="${e(u.clientNames.join(", "))}">${clients}</td>
  <td>${ago(u.lastCallAt, now)}</td>
  <td class="num">${fmt(u.activeDays)}</td>
  <td class="num">${fmt(u.calls)}${u.errors ? ` <span class="err" title="failed calls">(${fmt(u.errors)})</span>` : ""}</td>
  <td class="num" title="${e(sources)}">${fmt(u.records)}</td>
  <td>${ago(u.lastRecordAt, now)}</td>
  <td class="num">${fmt(u.accounts)} / ${fmt(u.budgets)}</td>
  <td>${banks}</td>
  <td class="tools">${tools}</td>
</tr>`;
}

export function adminDashboardPage(stats: AdminStats, signedInAs: string): string {
  const now = stats.generatedAt;
  const t = stats.totals;
  const kpis: Array<[string, string]> = [
    [fmt(t.users), "Users"],
    [`${fmt(t.new7)} / ${fmt(t.new30)}`, "New, 7 / 30 days"],
    [`${fmt(t.active7)} / ${fmt(t.active30)}`, "Active, 7 / 30 days"],
    [fmt(t.withRecords), "Have records"],
    [fmt(t.records), "Records stored"],
    [fmt(t.deletedAccounts), "Deleted accounts, all time"],
  ];
  const signedUp = stats.funnel[0]?.count ?? 0;
  const weekMax = Math.max(1, ...stats.signupsByWeek.map((w) => w.count));
  const clientMax = Math.max(0, ...stats.clients.map((c) => c.users));

  const toolsTable = stats.tools.length
    ? `<table><thead><tr><th>Tool</th><th class="num">Calls 30d</th><th class="num">Users 30d</th><th class="num">Failed 30d</th><th class="num">Calls ${stats.windowDays}d</th></tr></thead><tbody>${stats.tools
        .map(
          (r) => `<tr><td>${e(r.tool)}</td><td class="num">${fmt(r.calls30)}</td><td class="num">${fmt(r.users30)}</td><td class="num${r.errors30 ? " err" : ""}">${fmt(r.errors30)}</td><td class="num">${fmt(r.calls90)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="empty">No tool calls in the window.</p>`;
  const errorsTable = stats.errors.length
    ? `<table><thead><tr><th>Tool</th><th>Error class</th><th class="num">Count</th><th class="num">Users</th></tr></thead><tbody>${stats.errors
        .map((r) => `<tr><td>${e(r.tool)}</td><td>${e(r.error)}</td><td class="num">${fmt(r.count)}</td><td class="num">${fmt(r.users)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="empty">No failed calls in the last 30 days.</p>`;

  return shell(
    "MyFinance Admin",
    `<main>
<header>
  <h1>MyFinance Admin</h1>
  <span class="meta">${e(stamp(now))} · v${e(SERVER_VERSION)} · ${e(signedInAs)}</span>
  <form method="post" action="/admin/logout"><button type="submit">Sign out</button></form>
</header>

<div class="kpis">${kpis.map(([n, l]) => `<div class="card kpi"><div class="n">${n}</div><div class="l">${e(l)}</div></div>`).join("")}</div>

<div class="grid">
  <div class="card"><h2>Funnel</h2>${bars(
    stats.funnel.map((f) => ({ label: f.label, value: f.count, note: `${pct(f.count, signedUp)}%` })),
    signedUp
  )}</div>
  <div class="card"><h2>AI clients (users)</h2>${bars(
    stats.clients.map((c) => ({ label: c.family, value: c.users })),
    clientMax
  )}</div>
  <div class="card"><h2>Sign-ups per week</h2><div class="weeks">${stats.signupsByWeek
    .map(
      (w, i, all) => `<div class="week" title="Week of ${e(w.weekStart)}: ${fmt(w.count)}"><span class="c">${w.count ? fmt(w.count) : ""}</span><div class="col" style="height:${pct(w.count, weekMax)}%"></div><span class="d">${(all.length - 1 - i) % 2 === 0 ? e(w.weekStart.slice(5)) : ""}</span></div>`
    )
    .join("")}</div></div>
</div>

<div class="card section"><h2>Users (${fmt(stats.users.length)})</h2><div class="scroll"><table>
<thead><tr><th>User</th><th>Joined</th><th>Client</th><th>Last call</th><th class="num">Active days</th><th class="num">Calls ${stats.windowDays}d</th><th class="num">Records</th><th>Last record</th><th class="num">Accounts / budgets</th><th>Bank</th><th>Top tools, ${stats.windowDays}d</th></tr></thead>
<tbody>${stats.users.map((u) => userRow(u, now)).join("")}</tbody>
</table></div></div>

<div class="grid">
  <div class="card"><h2>Tools</h2><div class="scroll">${toolsTable}</div></div>
  <div class="card"><h2>Failed calls, 30 days</h2><div class="scroll">${errorsTable}</div></div>
</div>

<footer>Counts only: amounts, merchants and notes never reach this page. Activity (calls, active days, clients, tools) comes from usage events, kept ${stats.windowDays} days. Totals, funnel, clients, tools and failures leave out operator accounts; the users table lists them greyed out. Last record includes daily bank syncs, last call is the user's own activity.</footer>
</main>`
  );
}
