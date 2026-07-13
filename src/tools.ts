import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, logEvent } from "./db";
import { convert, round2 } from "./fx";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./categories";
import type { TxType } from "./generated/prisma/enums";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const currencySchema = z
  .string()
  .length(3)
  .describe("3-letter ISO currency code (EUR, USD, UAH, AED, ...). Omit to use the user's base currency.");

const dateSchema = z
  .string()
  .regex(DATE_RE)
  .describe("Date as YYYY-MM-DD. Omit for today.");

const itemsSchema = z
  .array(
    z.object({
      name: z.string(),
      qty: z.number().optional(),
      price: z.number().optional().describe("Line price in the receipt's currency"),
    })
  )
  .describe("Receipt line items, when logging from a receipt photo.");

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

async function getUser(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Account not found. Reconnect the FinanceMCP connector.");
  return user;
}

function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

async function defaultAccount(userId: string) {
  return db.account.upsert({
    where: { userId_name: { userId, name: "Manual" } },
    update: {},
    create: { userId, name: "Manual", type: "manual" },
  });
}

interface LogInput {
  amount: number;
  currency?: string;
  category?: string;
  merchant?: string;
  note?: string;
  date?: string;
  items?: unknown;
}

async function logTransaction(userId: string, type: TxType, input: LogInput) {
  const user = await getUser(userId);
  const currency = (input.currency ?? user.baseCurrency).toUpperCase();
  const dateStr = input.date ?? todayIn(user.timezone);
  const occurredAt = parseDate(dateStr);
  const account = await defaultAccount(userId);

  const { converted, rate } = await convert(input.amount, currency, user.baseCurrency, occurredAt);

  const tx = await db.transaction.create({
    data: {
      userId,
      accountId: account.id,
      type,
      amount: input.amount,
      currency,
      amountBase: converted,
      fxRate: rate,
      categoryKey: input.category ?? "other",
      merchant: input.merchant,
      note: input.note,
      items: input.items ? (input.items as object) : undefined,
      occurredAt,
      source: input.items ? "receipt" : "manual",
    },
  });
  logEvent("logged", userId, { type, source: tx.source });
  return {
    id: tx.id,
    type,
    date: dateStr,
    amount: input.amount,
    currency,
    amount_base: converted,
    base_currency: user.baseCurrency,
    category: tx.categoryKey,
    merchant: tx.merchant ?? undefined,
  };
}

function periodRange(period?: string, from?: string, to?: string): { start: Date; end: Date; label: string } {
  if (from || to) {
    const start = parseDate(from ?? "1970-01-01");
    const end = to ? new Date(parseDate(to).getTime() + 86_400_000) : new Date();
    return { start, end, label: `${from ?? "..."} to ${to ?? "today"}` };
  }
  const p = period ?? new Date().toISOString().slice(0, 7);
  if (/^\d{4}$/.test(p)) {
    return { start: parseDate(`${p}-01-01`), end: parseDate(`${Number(p) + 1}-01-01`), label: p };
  }
  if (/^\d{4}-\d{2}$/.test(p)) {
    const [y, m] = p.split("-").map(Number);
    const next = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
    return { start: parseDate(`${p}-01`), end: parseDate(`${next}-01`), label: p };
  }
  throw new Error(`Invalid period "${p}". Use YYYY or YYYY-MM, or from/to dates.`);
}

export function registerFinanceTools(server: McpServer, userId: string): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check for the FinanceMCP connection.",
      inputSchema: {},
    },
    async () => {
      const user = await getUser(userId);
      return text({ ok: true, server: "financemcp", version: "0.2.0-m1", user: user.email, time: new Date().toISOString() });
    }
  );

  server.registerTool(
    "log_expense",
    {
      title: "Log expense",
      description:
        "Record spending. Use for any purchase, bill, or receipt photo. Negative amount = refund to the same category.",
      inputSchema: {
        amount: z.number().describe("Amount spent in the original currency. Negative = refund."),
        currency: currencySchema.optional(),
        category: z.enum(EXPENSE_CATEGORIES).optional().describe("Omit only if nothing fits; defaults to 'other'."),
        merchant: z.string().optional().describe("Store/service name, e.g. 'Silpo', 'Netflix'."),
        note: z.string().optional(),
        date: dateSchema.optional(),
        items: itemsSchema.optional(),
      },
    },
    async (input) => text(await logTransaction(userId, "expense", input as LogInput))
  );

  server.registerTool(
    "log_income",
    {
      title: "Log income",
      description: "Record incoming money: salary, client payment, gift.",
      inputSchema: {
        amount: z.number().positive().describe("Amount received in the original currency."),
        currency: currencySchema.optional(),
        category: z.enum(INCOME_CATEGORIES).optional().describe("Defaults to 'other'."),
        merchant: z.string().optional().describe("Payer / source, e.g. client or employer name."),
        note: z.string().optional(),
        date: dateSchema.optional(),
      },
    },
    async (input) => text(await logTransaction(userId, "income", input as LogInput))
  );

  server.registerTool(
    "get_summary",
    {
      title: "Spending summary",
      description:
        "Totals for a period, computed server-side in the user's base currency. Answers 'how much did I spend on X in July'.",
      inputSchema: {
        period: z.string().optional().describe("YYYY-MM or YYYY. Defaults to the current month."),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        group_by: z.enum(["category", "merchant", "month"]).optional().describe("Default: category."),
      },
    },
    async ({ period, from, to, group_by }) => {
      const user = await getUser(userId);
      const range = periodRange(period, from, to);
      const rows = await db.transaction.findMany({
        where: { userId, occurredAt: { gte: range.start, lt: range.end }, type: { not: "transfer" } },
        select: { type: true, amountBase: true, categoryKey: true, merchant: true, occurredAt: true },
      });
      const expenses = rows.filter((r) => r.type === "expense");
      const income = rows.filter((r) => r.type === "income");
      const totalExpense = round2(expenses.reduce((s, r) => s + Number(r.amountBase), 0));
      const totalIncome = round2(income.reduce((s, r) => s + Number(r.amountBase), 0));

      const key = (r: (typeof rows)[number]) =>
        group_by === "merchant"
          ? (r.merchant ?? "(no merchant)")
          : group_by === "month"
            ? r.occurredAt.toISOString().slice(0, 7)
            : (r.categoryKey ?? "other");
      const groups = new Map<string, number>();
      for (const r of expenses) groups.set(key(r), (groups.get(key(r)) ?? 0) + Number(r.amountBase));

      logEvent("summary_run", userId, { period: range.label });
      return text({
        period: range.label,
        base_currency: user.baseCurrency,
        total_expense: totalExpense,
        total_income: totalIncome,
        net: round2(totalIncome - totalExpense),
        transactions: rows.length,
        expense_by: group_by ?? "category",
        groups: [...groups.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => ({
            key: k,
            total: round2(v),
            share_pct: totalExpense > 0 ? round2((v / totalExpense) * 100) : 0,
          })),
      });
    }
  );

  server.registerTool(
    "get_transactions",
    {
      title: "List transactions",
      description: "Find records: 'what was that 40 eur charge', recent spending, by category or merchant.",
      inputSchema: {
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        category: z.string().optional(),
        merchant: z.string().optional().describe("Substring match, case-insensitive."),
        query: z.string().optional().describe("Searches note and merchant."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ from, to, category, merchant, query, limit }) => {
      const user = await getUser(userId);
      const txs = await db.transaction.findMany({
        where: {
          userId,
          ...(from || to
            ? { occurredAt: { ...(from ? { gte: parseDate(from) } : {}), ...(to ? { lt: new Date(parseDate(to).getTime() + 86_400_000) } : {}) } }
            : {}),
          ...(category ? { categoryKey: category } : {}),
          ...(merchant ? { merchant: { contains: merchant, mode: "insensitive" as const } } : {}),
          ...(query
            ? {
                OR: [
                  { note: { contains: query, mode: "insensitive" as const } },
                  { merchant: { contains: query, mode: "insensitive" as const } },
                ],
              }
            : {}),
        },
        orderBy: { occurredAt: "desc" },
        take: limit ?? 20,
      });
      return text({
        base_currency: user.baseCurrency,
        count: txs.length,
        transactions: txs.map((t) => ({
          id: t.id,
          date: t.occurredAt.toISOString().slice(0, 10),
          type: t.type,
          amount: Number(t.amount),
          currency: t.currency,
          amount_base: Number(t.amountBase),
          category: t.categoryKey,
          merchant: t.merchant ?? undefined,
          note: t.note ?? undefined,
          source: t.source,
        })),
      });
    }
  );

  server.registerTool(
    "update_transaction",
    {
      title: "Update transaction",
      description: "Fix a logged record: wrong category, amount, merchant, or date.",
      inputSchema: {
        id: z.string().uuid(),
        amount: z.number().optional(),
        currency: currencySchema.optional(),
        category: z.enum([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]).optional(),
        merchant: z.string().optional(),
        note: z.string().optional(),
        date: dateSchema.optional(),
      },
    },
    async ({ id, amount, currency, category, merchant, note, date }) => {
      const user = await getUser(userId);
      const existing = await db.transaction.findFirst({ where: { id, userId } });
      if (!existing) throw new Error("Transaction not found.");

      const newAmount = amount ?? Number(existing.amount);
      const newCurrency = (currency ?? existing.currency).toUpperCase();
      const newDate = date ? parseDate(date) : existing.occurredAt;
      const needsFx =
        amount !== undefined || currency !== undefined || date !== undefined;
      const fx = needsFx
        ? await convert(newAmount, newCurrency, user.baseCurrency, newDate)
        : { converted: Number(existing.amountBase), rate: Number(existing.fxRate) };

      const tx = await db.transaction.update({
        where: { id },
        data: {
          amount: newAmount,
          currency: newCurrency,
          occurredAt: newDate,
          amountBase: fx.converted,
          fxRate: fx.rate,
          ...(category ? { categoryKey: category } : {}),
          ...(merchant !== undefined ? { merchant } : {}),
          ...(note !== undefined ? { note } : {}),
        },
      });
      return text({ updated: true, id: tx.id, amount_base: Number(tx.amountBase), category: tx.categoryKey });
    }
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Delete transaction",
      description: "Remove a wrongly logged record.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const res = await db.transaction.deleteMany({ where: { id, userId } });
      if (res.count === 0) throw new Error("Transaction not found.");
      return text({ deleted: true, id });
    }
  );

  server.registerTool(
    "get_trends",
    {
      title: "Monthly trends",
      description: "Month-over-month expense/income dynamics, optionally for one category.",
      inputSchema: {
        months: z.number().int().min(2).max(24).optional().describe("How many months back. Default 6."),
        category: z.enum(EXPENSE_CATEGORIES).optional(),
      },
    },
    async ({ months, category }) => {
      const user = await getUser(userId);
      const n = months ?? 6;
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1));
      const rows = await db.transaction.findMany({
        where: {
          userId,
          occurredAt: { gte: start },
          type: { not: "transfer" },
          ...(category ? { categoryKey: category, type: "expense" } : {}),
        },
        select: { type: true, amountBase: true, occurredAt: true },
      });
      const buckets = new Map<string, { expense: number; income: number }>();
      for (let i = 0; i < n; i++) {
        const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
        buckets.set(d.toISOString().slice(0, 7), { expense: 0, income: 0 });
      }
      for (const r of rows) {
        const b = buckets.get(r.occurredAt.toISOString().slice(0, 7));
        if (!b) continue;
        if (r.type === "expense") b.expense += Number(r.amountBase);
        else b.income += Number(r.amountBase);
      }
      const series = [...buckets.entries()].map(([month, v], i, arr) => {
        const prev = i > 0 ? arr[i - 1]![1].expense : null;
        return {
          month,
          expense: round2(v.expense),
          income: round2(v.income),
          expense_change_pct: prev && prev > 0 ? round2(((v.expense - prev) / prev) * 100) : null,
        };
      });
      return text({ base_currency: user.baseCurrency, category: category ?? "all", months: series });
    }
  );

  server.registerTool(
    "set_budget",
    {
      title: "Set budget",
      description: "Monthly spending cap, overall or per category, in the user's base currency.",
      inputSchema: {
        amount: z.number().positive(),
        category: z.enum(EXPENSE_CATEGORIES).optional().describe("Omit for the overall monthly budget."),
      },
    },
    async ({ amount, category }) => {
      const user = await getUser(userId);
      const key = category ?? "overall";
      await db.budget.upsert({
        where: { userId_categoryKey: { userId, categoryKey: key } },
        update: { amount },
        create: { userId, categoryKey: key, amount },
      });
      return text({ ok: true, budget: key, amount, currency: user.baseCurrency });
    }
  );

  server.registerTool(
    "get_budget_progress",
    {
      title: "Budget progress",
      description: "Current month: spent vs cap for every budget.",
      inputSchema: {},
    },
    async () => {
      const user = await getUser(userId);
      const budgets = await db.budget.findMany({ where: { userId } });
      if (budgets.length === 0) return text({ budgets: [], hint: "No budgets set. Use set_budget." });
      const range = periodRange(undefined);
      const rows = await db.transaction.findMany({
        where: { userId, type: "expense", occurredAt: { gte: range.start, lt: range.end } },
        select: { amountBase: true, categoryKey: true },
      });
      const total = rows.reduce((s, r) => s + Number(r.amountBase), 0);
      const byCat = new Map<string, number>();
      for (const r of rows) byCat.set(r.categoryKey ?? "other", (byCat.get(r.categoryKey ?? "other") ?? 0) + Number(r.amountBase));
      return text({
        month: range.label,
        base_currency: user.baseCurrency,
        budgets: budgets.map((b) => {
          const spent = b.categoryKey === "overall" ? total : (byCat.get(b.categoryKey) ?? 0);
          const cap = Number(b.amount);
          return {
            budget: b.categoryKey ?? "overall",
            cap,
            spent: round2(spent),
            left: round2(cap - spent),
            used_pct: round2((spent / cap) * 100),
            over: spent > cap,
          };
        }),
      });
    }
  );

  server.registerTool(
    "get_settings",
    {
      title: "Get settings",
      description: "Base currency and timezone.",
      inputSchema: {},
    },
    async () => {
      const user = await getUser(userId);
      return text({ email: user.email, base_currency: user.baseCurrency, timezone: user.timezone });
    }
  );

  server.registerTool(
    "update_settings",
    {
      title: "Update settings",
      description:
        "Change base currency (recomputes all historical stats at each transaction's original date rate) or timezone.",
      inputSchema: {
        base_currency: currencySchema.optional(),
        timezone: z.string().optional().describe("IANA timezone, e.g. Europe/Kyiv, Asia/Dubai."),
      },
    },
    async ({ base_currency, timezone }) => {
      const user = await getUser(userId);
      if (timezone) {
        try {
          new Intl.DateTimeFormat("en", { timeZone: timezone });
        } catch {
          throw new Error(`Unknown timezone "${timezone}".`);
        }
      }
      const newBase = base_currency?.toUpperCase();
      if (newBase && newBase !== user.baseCurrency) {
        const txs = await db.transaction.findMany({ where: { userId } });
        for (const t of txs) {
          const fx = await convert(Number(t.amount), t.currency, newBase, t.occurredAt);
          await db.transaction.update({
            where: { id: t.id },
            data: { amountBase: fx.converted, fxRate: fx.rate },
          });
        }
      }
      const updated = await db.user.update({
        where: { id: userId },
        data: { ...(newBase ? { baseCurrency: newBase } : {}), ...(timezone ? { timezone } : {}) },
      });
      return text({ ok: true, base_currency: updated.baseCurrency, timezone: updated.timezone });
    }
  );

  server.registerTool(
    "export_transactions",
    {
      title: "Export CSV",
      description: "All transactions as CSV (GDPR portability).",
      inputSchema: { from: dateSchema.optional(), to: dateSchema.optional() },
    },
    async ({ from, to }) => {
      const user = await getUser(userId);
      const txs = await db.transaction.findMany({
        where: {
          userId,
          ...(from || to
            ? { occurredAt: { ...(from ? { gte: parseDate(from) } : {}), ...(to ? { lt: new Date(parseDate(to).getTime() + 86_400_000) } : {}) } }
            : {}),
        },
        orderBy: { occurredAt: "asc" },
      });
      const esc = (v: unknown) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      };
      const header = "date,type,amount,currency,amount_base,base_currency,category,merchant,note,source";
      const lines = txs.map((t) =>
        [
          t.occurredAt.toISOString().slice(0, 10),
          t.type,
          Number(t.amount),
          t.currency,
          Number(t.amountBase),
          user.baseCurrency,
          t.categoryKey ?? "",
          esc(t.merchant),
          esc(t.note),
          t.source,
        ].join(",")
      );
      return { content: [{ type: "text" as const, text: [header, ...lines].join("\n") }] };
    }
  );

  server.registerTool(
    "delete_account",
    {
      title: "Delete account",
      description: "Erase the account and ALL financial data permanently (GDPR). Requires confirm='DELETE'.",
      inputSchema: { confirm: z.literal("DELETE") },
    },
    async () => {
      await db.oauthAccessToken.deleteMany({ where: { userId } });
      await db.oauthRefreshToken.deleteMany({ where: { userId } });
      await db.oauthCode.deleteMany({ where: { userId } });
      await db.user.delete({ where: { id: userId } });
      logEvent("account_deleted");
      return text({ deleted: true, note: "All data erased. The connector is now disconnected." });
    }
  );
}
