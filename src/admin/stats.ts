import { db } from "../db";
import { config } from "../config";
import { EVENT_RETENTION_DAYS } from "../telemetry";
import { otherSignIn } from "../users";

/**
 * The operator overview behind /admin: who signed up, which AI client they
 * came from, how much they stored and which tools they use. Counts only,
 * never amounts, merchants or notes (blind-logs rule). Activity comes from
 * telemetry, so it covers the event retention window (90 days); records,
 * accounts and sign-up dates are durable.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Activity can reach back only as far as telemetry keeps its events. */
export const ACTIVITY_WINDOW_DAYS = EVENT_RETENTION_DAYS;
const SIGNUP_WEEKS = 12;
const TOP_TOOLS_PER_USER = 5;

export interface AdminUserRow {
  email: string;
  /** The operator's own accounts: listed, but left out of every total. */
  operator: boolean;
  joined: Date;
  method: "google" | "email" | "password";
  baseCurrency: string;
  timezone: string;
  /** The AI client of the sign-up ("Claude @ claude.ai"); null before 0.16.0. */
  signupClient: string | null;
  /** Email summary choice, null = never chosen. */
  digest: string | null;
  /** Client families seen at connect ("Claude", "ChatGPT / Codex", ...). */
  clients: string[];
  /** Raw clientInfo names behind those families. */
  clientNames: string[];
  records: number;
  recordsBySource: Record<string, number>;
  lastRecordAt: Date | null;
  accounts: number;
  budgets: number;
  banks: Array<{ provider: string; status: string }>;
  calls: number;
  errors: number;
  activeDays: number;
  lastCallAt: Date | null;
  topTools: Array<{ tool: string; calls: number }>;
}

export interface AdminStats {
  generatedAt: Date;
  windowDays: number;
  totals: {
    users: number;
    new7: number;
    new30: number;
    active7: number;
    active30: number;
    withRecords: number;
    records: number;
    deletedAccounts: number;
  };
  funnel: Array<{ label: string; count: number }>;
  clients: Array<{ family: string; users: number }>;
  signupsByWeek: Array<{ weekStart: string; count: number }>;
  tools: Array<{ tool: string; calls30: number; users30: number; errors30: number; calls90: number }>;
  errors: Array<{ tool: string; error: string; count: number; users: number }>;
  users: AdminUserRow[];
}

/** clientInfo.name is free text from the client; group the ones we know. */
export function clientFamily(name: string): string {
  if (/claude|anthropic/i.test(name)) return "Claude";
  if (/openai|chatgpt|codex/i.test(name)) return "ChatGPT / Codex";
  if (/cursor/i.test(name)) return "Cursor";
  if (/vscode|copilot/i.test(name)) return "VS Code";
  return "Other";
}

/** Monday 00:00 UTC of the week holding `d`, as YYYY-MM-DD. */
function weekStart(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

interface CallMeta {
  tool?: unknown;
  error?: unknown;
  err?: unknown;
  client?: unknown;
}

/**
 * Every tool_call and client_init event of the window is read and summed
 * here, not in SQL: Prisma cannot group by a JSON field or count distinct
 * days, and raw SQL is kept for what Prisma cannot do at all. At about
 * 1,000 events per 90 days (October 2026) that is a few hundred KB per load;
 * past roughly 100,000 events in the window, move this to a recorded
 * $queryRaw aggregate. adminStats() below caches the result for a minute.
 */
export async function computeAdminStats(now = new Date()): Promise<AdminStats> {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * DAY_MS);
  const [users, txGroups, accountGroups, budgetGroups, banks, events, deletedAccounts] = await Promise.all([
    db.user.findMany({
      select: {
        id: true,
        email: true,
        googleSub: true,
        passwordHash: true,
        createdAt: true,
        baseCurrency: true,
        timezone: true,
        signupClient: true,
        digest: true,
      },
    }),
    db.transaction.groupBy({ by: ["userId", "source"], _count: { _all: true }, _max: { createdAt: true } }),
    db.account.groupBy({ by: ["userId"], _count: { _all: true } }),
    db.budget.groupBy({ by: ["userId"], _count: { _all: true } }),
    db.bankConnection.findMany({ select: { userId: true, provider: true, status: true } }),
    db.event.findMany({
      where: { type: { in: ["tool_call", "client_init"] }, userId: { not: null }, createdAt: { gte: since } },
      select: { userId: true, type: true, meta: true, createdAt: true },
    }),
    db.event.count({ where: { type: "account_deleted" } }),
  ]);

  const operatorEmails = new Set([config.userEmail, ...config.adminEmails].filter(Boolean));
  const t7 = now.getTime() - 7 * DAY_MS;
  const t30 = now.getTime() - 30 * DAY_MS;

  const rows = new Map<string, AdminUserRow>();
  for (const u of users) {
    rows.set(u.id, {
      email: u.email,
      operator: operatorEmails.has(u.email.toLowerCase()),
      joined: u.createdAt,
      method: otherSignIn(u) ?? "email",
      baseCurrency: u.baseCurrency,
      timezone: u.timezone,
      signupClient: u.signupClient,
      digest: u.digest,
      clients: [],
      clientNames: [],
      records: 0,
      recordsBySource: {},
      lastRecordAt: null,
      accounts: 0,
      budgets: 0,
      banks: [],
      calls: 0,
      errors: 0,
      activeDays: 0,
      lastCallAt: null,
      topTools: [],
    });
  }
  for (const g of txGroups) {
    const row = rows.get(g.userId);
    if (!row) continue;
    row.records += g._count._all;
    row.recordsBySource[g.source] = g._count._all;
    const last = g._max.createdAt;
    if (last && (!row.lastRecordAt || last > row.lastRecordAt)) row.lastRecordAt = last;
  }
  for (const g of accountGroups) {
    const row = rows.get(g.userId);
    if (row) row.accounts = g._count._all;
  }
  for (const g of budgetGroups) {
    const row = rows.get(g.userId);
    if (row) row.budgets = g._count._all;
  }
  for (const b of banks) rows.get(b.userId)?.banks.push({ provider: b.provider, status: b.status });

  // Per-user activity and the tool table (external users only).
  const days = new Map<string, Set<string>>();
  const toolsByUser = new Map<string, Map<string, number>>();
  const toolTable = new Map<string, { calls30: number; users30: Set<string>; errors30: number; calls90: number }>();
  const errorTable = new Map<string, { tool: string; error: string; count: number; users: Set<string> }>();
  for (const e of events) {
    const row = rows.get(e.userId!);
    if (!row) continue;
    const meta = (e.meta ?? {}) as CallMeta;
    if (e.type === "client_init") {
      const name = typeof meta.client === "string" ? meta.client : "unknown";
      if (!row.clientNames.includes(name)) row.clientNames.push(name);
      const family = clientFamily(name);
      if (!row.clients.includes(family)) row.clients.push(family);
      continue;
    }
    const tool = typeof meta.tool === "string" ? meta.tool : "unknown";
    const failed = meta.error === true;
    const at = e.createdAt;
    row.calls++;
    if (failed) row.errors++;
    if (!row.lastCallAt || at > row.lastCallAt) row.lastCallAt = at;
    const userDays = days.get(e.userId!) ?? new Set<string>();
    userDays.add(at.toISOString().slice(0, 10));
    days.set(e.userId!, userDays);
    const perTool = toolsByUser.get(e.userId!) ?? new Map<string, number>();
    perTool.set(tool, (perTool.get(tool) ?? 0) + 1);
    toolsByUser.set(e.userId!, perTool);

    if (row.operator) continue;
    const entry = toolTable.get(tool) ?? { calls30: 0, users30: new Set<string>(), errors30: 0, calls90: 0 };
    entry.calls90++;
    if (at.getTime() >= t30) {
      entry.calls30++;
      entry.users30.add(e.userId!);
      if (failed) {
        entry.errors30++;
        const errorClass = typeof meta.err === "string" ? meta.err : "unknown";
        const key = `${tool}\u0000${errorClass}`;
        const err = errorTable.get(key) ?? { tool, error: errorClass, count: 0, users: new Set<string>() };
        err.count++;
        err.users.add(e.userId!);
        errorTable.set(key, err);
      }
    }
    toolTable.set(tool, entry);
  }
  for (const [userId, row] of rows) {
    row.activeDays = days.get(userId)?.size ?? 0;
    row.topTools = [...(toolsByUser.get(userId) ?? [])]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TOOLS_PER_USER)
      .map(([tool, calls]) => ({ tool, calls }));
  }

  const all = [...rows.values()].sort((a, b) => b.joined.getTime() - a.joined.getTime());
  const external = all.filter((r) => !r.operator);
  const activeSince = (t: number) => external.filter((r) => r.lastCallAt && r.lastCallAt.getTime() >= t).length;
  const saved = (r: AdminUserRow) => r.records > 0 || r.accounts > 0;
  // Each stage is a subset of the one before, so the bars read as conversion.
  // Saving data counts as using a tool even when the calls are older than
  // the activity window.
  const used = external.filter((r) => r.calls > 0 || saved(r));
  const savedData = used.filter(saved);
  const cameBack = savedData.filter((r) => r.activeDays >= 2);
  const stillActive = cameBack.filter((r) => r.lastCallAt && r.lastCallAt.getTime() >= t7);

  const clientUsers = new Map<string, number>();
  for (const r of external) for (const f of r.clients) clientUsers.set(f, (clientUsers.get(f) ?? 0) + 1);

  // Weeks with no signups still get a row: a gap is the point of the chart.
  const weeks = new Map<string, number>();
  for (let i = SIGNUP_WEEKS - 1; i >= 0; i--) weeks.set(weekStart(new Date(now.getTime() - i * 7 * DAY_MS)), 0);
  for (const r of external) {
    const w = weekStart(r.joined);
    if (weeks.has(w)) weeks.set(w, weeks.get(w)! + 1);
  }

  return {
    generatedAt: now,
    windowDays: ACTIVITY_WINDOW_DAYS,
    totals: {
      users: external.length,
      new7: external.filter((r) => r.joined.getTime() >= t7).length,
      new30: external.filter((r) => r.joined.getTime() >= t30).length,
      active7: activeSince(t7),
      active30: activeSince(t30),
      withRecords: external.filter((r) => r.records > 0).length,
      records: external.reduce((sum, r) => sum + r.records, 0),
      deletedAccounts,
    },
    funnel: [
      { label: "Signed up", count: external.length },
      { label: "Used a tool", count: used.length },
      { label: "Saved data", count: savedData.length },
      { label: "Came back on another day", count: cameBack.length },
      { label: "Still active, last 7 days", count: stillActive.length },
    ],
    clients: [...clientUsers].sort((a, b) => b[1] - a[1]).map(([family, n]) => ({ family, users: n })),
    signupsByWeek: [...weeks].map(([w, count]) => ({ weekStart: w, count })),
    tools: [...toolTable]
      .map(([tool, t]) => ({ tool, calls30: t.calls30, users30: t.users30.size, errors30: t.errors30, calls90: t.calls90 }))
      .sort((a, b) => b.calls30 - a.calls30 || b.calls90 - a.calls90),
    errors: [...errorTable.values()]
      .map((e) => ({ tool: e.tool, error: e.error, count: e.count, users: e.users.size }))
      .sort((a, b) => b.count - a.count),
    users: all,
  };
}

const CACHE_MS = 60 * 1000;
let cached: { stats: AdminStats; at: number } | null = null;
let pending: Promise<AdminStats> | null = null;

/** computeAdminStats, cached for a minute; concurrent loads share one computation. */
export function adminStats(): Promise<AdminStats> {
  if (cached && Date.now() - cached.at <= CACHE_MS) return Promise.resolve(cached.stats);
  pending ??= computeAdminStats()
    .then((stats) => {
      cached = { stats, at: Date.now() };
      return stats;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
