import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, logEvent } from "./db";
import { convert, round2 } from "./fx";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./categories";
import { resolveAccount, computeBalance, ACCOUNT_TYPES } from "./accounts";
import { SERVER_VERSION } from "./version";
import { DASHBOARD_TOOL_META } from "./ui";
import type { TxType } from "./generated/prisma/enums";

const ALL_CATEGORIES = new Set<string>([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]);

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

interface LogInput {
  amount: number;
  currency?: string;
  category?: string;
  merchant?: string;
  note?: string;
  date?: string;
  items?: unknown;
  account?: string;
}

async function logTransaction(userId: string, type: TxType, input: LogInput) {
  const user = await getUser(userId);
  const account = await resolveAccount(userId, input.account);
  const currency = (input.currency ?? account.currency ?? user.baseCurrency).toUpperCase();
  const dateStr = input.date ?? todayIn(user.timezone);
  const occurredAt = parseDate(dateStr);

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
      return text({ ok: true, server: "financemcp", version: SERVER_VERSION, user: user.email, time: new Date().toISOString() });
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
        account: z.string().optional().describe("Account name (see get_accounts). Default: Manual."),
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
        account: z.string().optional().describe("Account name (see get_accounts). Default: Manual."),
      },
    },
    async (input) => text(await logTransaction(userId, "income", input as LogInput))
  );

  server.registerTool(
    "create_account",
    {
      title: "Create account",
      description:
        "Add a money account: bank, card, cash, or investment (brokerage). Transfers between own accounts are then tracked without counting as spending.",
      inputSchema: {
        name: z.string().min(1).max(40).describe("Short name, e.g. 'Revolut', 'Mono black', 'IBKR'."),
        type: z.enum(ACCOUNT_TYPES).describe("cash | bank | card | investment"),
        currency: currencySchema.describe("Main currency of this account."),
      },
    },
    async ({ name, type, currency }) => {
      const existing = await db.account.findMany({ where: { userId } });
      if (existing.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Account "${name}" already exists.`);
      }
      const acc = await db.account.create({
        data: { userId, name, type, currency: currency.toUpperCase() },
      });
      return text({ ok: true, account: acc.name, type: acc.type, currency: acc.currency });
    }
  );

  server.registerTool(
    "get_accounts",
    {
      _meta: DASHBOARD_TOOL_META,
      title: "Accounts & net worth",
      description:
        "All accounts with computed balances (latest snapshot + tracked flows) and total net worth in the base currency.",
      inputSchema: {},
    },
    async () => {
      const user = await getUser(userId);
      const accounts = await db.account.findMany({ where: { userId }, orderBy: { name: "asc" } });
      const today = parseDate(todayIn(user.timezone));
      const out = [];
      let netWorth = 0;
      for (const a of accounts) {
        const b = await computeBalance(a);
        const { converted } = await convert(b.balance, b.currency, user.baseCurrency, today);
        netWorth += converted;
        out.push({
          name: a.name,
          type: a.type,
          currency: b.currency,
          balance: b.balance,
          balance_base: converted,
          anchored_at: b.anchoredAt,
        });
      }
      return text({
        base_currency: user.baseCurrency,
        net_worth: round2(netWorth),
        accounts: out,
        hint: out.some((a) => !a.anchored_at)
          ? "Accounts without a snapshot show tracked flows only. Anchor real balances with log_balance."
          : undefined,
      });
    }
  );

  server.registerTool(
    "log_transfer",
    {
      title: "Log transfer",
      description:
        "Move money between OWN accounts: card to brokerage, cash withdrawal, currency exchange. Never counted as spending or income.",
      inputSchema: {
        amount: z.number().positive().describe("Amount leaving the source account."),
        currency: currencySchema.optional().describe("Default: source account currency."),
        from_account: z.string(),
        to_account: z.string(),
        received_amount: z.number().positive().optional().describe("Amount arriving, for cross-currency transfers."),
        received_currency: currencySchema.optional(),
        note: z.string().optional(),
        date: dateSchema.optional(),
      },
    },
    async ({ amount, currency, from_account, to_account, received_amount, received_currency, note, date }) => {
      const user = await getUser(userId);
      const from = await resolveAccount(userId, from_account);
      const to = await resolveAccount(userId, to_account);
      if (from.id === to.id) throw new Error("from_account and to_account must differ.");
      const cur = (currency ?? from.currency ?? user.baseCurrency).toUpperCase();
      const dateStr = date ?? todayIn(user.timezone);
      const occurredAt = parseDate(dateStr);
      const fx = await convert(amount, cur, user.baseCurrency, occurredAt);
      const tx = await db.transaction.create({
        data: {
          userId,
          accountId: from.id,
          type: "transfer",
          amount,
          currency: cur,
          amountBase: fx.converted,
          fxRate: fx.rate,
          note,
          occurredAt,
          counterAccountId: to.id,
          counterAmount: received_amount,
          counterCurrency: received_currency?.toUpperCase() ?? (received_amount ? (to.currency ?? undefined) : undefined),
        },
      });
      logEvent("logged", userId, { type: "transfer" });
      return text({
        id: tx.id,
        transfer: `${from.name} -> ${to.name}`,
        date: dateStr,
        sent: { amount, currency: cur },
        received: received_amount ? { amount: received_amount, currency: tx.counterCurrency } : undefined,
      });
    }
  );

  server.registerTool(
    "log_balance",
    {
      title: "Log balance snapshot",
      description:
        "Anchor an account's REAL balance at end of a date (from the bank app). Balances are then snapshot + later flows.",
      inputSchema: {
        account: z.string(),
        amount: z.number().describe("Actual balance shown by the bank/broker."),
        currency: currencySchema.optional().describe("Default: account currency."),
        date: dateSchema.optional().describe("Balance as of end of this date. Default: today."),
      },
    },
    async ({ account, amount, currency, date }) => {
      const user = await getUser(userId);
      const acc = await resolveAccount(userId, account);
      const cur = (currency ?? acc.currency ?? user.baseCurrency).toUpperCase();
      const asOf = parseDate(date ?? todayIn(user.timezone));
      if (!acc.currency) await db.account.update({ where: { id: acc.id }, data: { currency: cur } });
      await db.balanceSnapshot.upsert({
        where: { accountId_asOf: { accountId: acc.id, asOf } },
        update: { amount, currency: cur },
        create: { userId, accountId: acc.id, amount, currency: cur, asOf },
      });
      return text({ ok: true, account: acc.name, balance: amount, currency: cur, as_of: asOf.toISOString().slice(0, 10) });
    }
  );

  server.registerTool(
    "import_transactions",
    {
      title: "Bulk import",
      description:
        "Import parsed bank-statement rows (one statement/month per call). Dedupes against existing records, coerces unknown categories to 'other', and reconciles against the statement total. Sign convention: negative amount = money out, positive = money in.",
      inputSchema: {
        account: z.string().optional().describe("Target account name. Default: Manual."),
        statement_total: z
          .number()
          .optional()
          .describe("Signed sum of ALL rows in the source statement, for reconciliation."),
        transactions: z
          .array(
            z.object({
              date: dateSchema,
              amount: z.number().describe("Signed: negative = expense/out, positive = income/in."),
              currency: currencySchema.optional(),
              type: z.enum(["expense", "income", "transfer"]).optional().describe("Override sign-based detection."),
              category: z.string().optional(),
              merchant: z.string().optional(),
              note: z.string().optional(),
              external_id: z.string().optional().describe("Bank transaction reference, best dedup key."),
            })
          )
          .min(1)
          .max(500),
      },
    },
    async ({ account, statement_total, transactions }) => {
      const user = await getUser(userId);
      const acc = await resolveAccount(userId, account);
      let imported = 0;
      let duplicates = 0;
      let coerced = 0;
      let rowsSum = 0;

      const normalize = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

      for (const row of transactions) {
        rowsSum += row.amount;
        const cur = (row.currency ?? acc.currency ?? user.baseCurrency).toUpperCase();
        const occurredAt = parseDate(row.date);
        const type: TxType = row.type ?? (row.amount < 0 ? "expense" : "income");
        const amountAbs = round2(Math.abs(row.amount));

        if (row.external_id) {
          const byExt = await db.transaction.findFirst({
            where: { accountId: acc.id, externalId: row.external_id },
          });
          if (byExt) {
            duplicates++;
            continue;
          }
        }
        const windowStart = new Date(occurredAt.getTime() - 2 * 86_400_000);
        const windowEnd = new Date(occurredAt.getTime() + 2 * 86_400_000);
        const candidates = await db.transaction.findMany({
          where: { userId, accountId: acc.id, currency: cur, occurredAt: { gte: windowStart, lte: windowEnd } },
        });
        const rm = normalize(row.merchant);
        const isDup = candidates.some((c) => {
          if (Math.abs(Math.abs(Number(c.amount)) - amountAbs) > 0.009) return false;
          const cm = normalize(c.merchant);
          if (rm && cm) return cm.includes(rm) || rm.includes(cm);
          // no merchant info to compare: only exact same day counts as duplicate (conservative)
          return c.occurredAt.getTime() === occurredAt.getTime();
        });
        if (isDup) {
          duplicates++;
          continue;
        }

        let category = row.category;
        if (type !== "transfer") {
          if (!category || !ALL_CATEGORIES.has(category)) {
            if (category) coerced++;
            category = "other";
          }
        }

        const fx = await convert(amountAbs, cur, user.baseCurrency, occurredAt);
        await db.transaction.create({
          data: {
            userId,
            accountId: acc.id,
            type,
            amount: amountAbs,
            currency: cur,
            amountBase: fx.converted,
            fxRate: fx.rate,
            categoryKey: type === "transfer" ? null : category,
            merchant: row.merchant,
            note: row.note,
            occurredAt,
            source: "bank",
            externalId: row.external_id,
          },
        });
        imported++;
      }

      rowsSum = round2(rowsSum);
      const diff = statement_total !== undefined ? round2(statement_total - rowsSum) : undefined;
      logEvent("bank_imported", userId, { imported, duplicates });
      return text({
        account: acc.name,
        imported,
        duplicates_skipped: duplicates,
        unknown_categories_coerced_to_other: coerced,
        rows_sum: rowsSum,
        statement_total,
        reconciliation:
          statement_total === undefined ? "not_checked" : Math.abs(diff!) < 0.01 ? "ok" : `MISMATCH by ${diff}`,
      });
    }
  );

  server.registerTool(
    "get_summary",
    {
      _meta: DASHBOARD_TOOL_META,
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
        include: { account: { select: { name: true } } },
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
          account: t.account.name,
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
      _meta: DASHBOARD_TOOL_META,
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
      _meta: DASHBOARD_TOOL_META,
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
