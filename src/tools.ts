import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, logEvent } from "./db";
import { convert, round2 } from "./fx";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./categories";
import { resolveAccount, computeBalance, connectionAccounts, setAccountSync, ACCOUNT_TYPES } from "./accounts";
import { SERVER_VERSION } from "./version";
import { DASHBOARD_TOOL_META } from "./ui";
import { detectZenHost } from "./zenmoney/client";
import { encryptToken, decryptToken } from "./zenmoney/crypto";
import { syncZenMoney } from "./zenmoney/sync";
import { ebConfigured, ebAspsps, ebStartAuth, ebDeleteSession } from "./enablebanking/client";
import { syncEnableBanking } from "./enablebanking/sync";
import { rememberMerchantCategory } from "./merchantMemory";
import type { EbConnectionMeta } from "./enablebanking/sync";
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

const entitySchema = z.enum(["personal", "business"]);

const categoryFilterSchema = z.enum([...ALL_CATEGORIES] as [string, ...string[]]);

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
  if (!user) throw new Error("Account not found. Reconnect the MyFinance MCP connector.");
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
  entity?: "personal" | "business";
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
      entity: input.entity ?? account.entity,
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
    entity: tx.entity,
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
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "Health check for the MyFinance MCP connection.",
      inputSchema: {},
    },
    async () => {
      const user = await getUser(userId);
      return text({ ok: true, server: "myfinancemcp", version: SERVER_VERSION, user: user.email, time: new Date().toISOString() });
    }
  );

  server.registerTool(
    "log_expense",
    {
      title: "Log expense",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Record ONE purchase, bill, or receipt. Negative amount = refund to the same category. NEVER use this for bank-statement rows or any batch of 3+ records: use import_transactions with the whole array instead (one-by-one logging hits the per-turn tool limit).",
      inputSchema: {
        amount: z.number().describe("Amount spent in the original currency. Negative = refund."),
        currency: currencySchema.optional(),
        category: z.enum(EXPENSE_CATEGORIES).optional().describe("Omit only if nothing fits; defaults to 'other'."),
        merchant: z.string().optional().describe("Store/service name, e.g. 'Silpo', 'Netflix'."),
        note: z.string().optional(),
        date: dateSchema.optional(),
        items: itemsSchema.optional(),
        account: z.string().optional().describe("Account name (see get_accounts). Default: Manual."),
        entity: entitySchema
          .optional()
          .describe("Override the account's default scope, e.g. a personal dinner paid with the business card."),
      },
    },
    async (input) => text(await logTransaction(userId, "expense", input as LogInput))
  );

  server.registerTool(
    "log_income",
    {
      title: "Log income",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "Record incoming money: salary, client payment, gift.",
      inputSchema: {
        amount: z.number().positive().describe("Amount received in the original currency."),
        currency: currencySchema.optional(),
        category: z.enum(INCOME_CATEGORIES).optional().describe("Defaults to 'other'."),
        merchant: z.string().optional().describe("Payer / source, e.g. client or employer name."),
        note: z.string().optional(),
        date: dateSchema.optional(),
        account: z.string().optional().describe("Account name (see get_accounts). Default: Manual."),
        entity: entitySchema
          .optional()
          .describe("Override the account's default scope, e.g. a client payment landing on a personal card."),
      },
    },
    async (input) => text(await logTransaction(userId, "income", input as LogInput))
  );

  server.registerTool(
    "create_account",
    {
      title: "Create account",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Add a money account: bank, card, cash, or investment (brokerage). Transfers between own accounts are then tracked without counting as spending.",
      inputSchema: {
        name: z.string().min(1).max(40).describe("Short name, e.g. 'Revolut', 'Mono black', 'IBKR'."),
        type: z.enum(ACCOUNT_TYPES).describe("cash | bank | card | investment"),
        currency: currencySchema.describe("Main currency of this account."),
        entity: entitySchema
          .optional()
          .describe("Whose money: personal (default) or business. Sets the default scope for this account's transactions."),
      },
    },
    async ({ name, type, currency, entity }) => {
      const existing = await db.account.findMany({ where: { userId } });
      if (existing.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Account "${name}" already exists.`);
      }
      const acc = await db.account.create({
        data: { userId, name, type, currency: currency.toUpperCase(), entity: entity ?? "personal" },
      });
      return text({ ok: true, account: acc.name, type: acc.type, currency: acc.currency, entity: acc.entity });
    }
  );

  server.registerTool(
    "update_account",
    {
      title: "Update account",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Rename an account or change its type, entity or main currency. Transactions keep their history; an entity change only affects future transactions.",
      inputSchema: {
        account: z.string().min(1).describe("Current account name (see get_accounts)."),
        new_name: z.string().min(1).max(40).optional(),
        type: z.enum(ACCOUNT_TYPES).optional(),
        entity: entitySchema.optional(),
        currency: currencySchema.optional().describe("Main currency the balance is shown in."),
      },
    },
    async ({ account, new_name, type, entity, currency }) => {
      if (!new_name && !type && !entity && !currency) {
        throw new Error("Nothing to change. Pass new_name, type, entity or currency.");
      }
      const acc = await resolveAccount(userId, account);
      if (new_name && new_name.toLowerCase() !== acc.name.toLowerCase()) {
        const siblings = await db.account.findMany({ where: { userId } });
        if (siblings.some((a) => a.id !== acc.id && a.name.toLowerCase() === new_name.toLowerCase())) {
          throw new Error(`Account "${new_name}" already exists.`);
        }
      }
      const updated = await db.account.update({
        where: { id: acc.id },
        data: {
          ...(new_name ? { name: new_name } : {}),
          ...(type ? { type } : {}),
          ...(entity ? { entity } : {}),
          ...(currency ? { currency: currency.toUpperCase() } : {}),
        },
      });
      return text({ ok: true, account: updated.name, type: updated.type, currency: updated.currency, entity: updated.entity });
    }
  );

  server.registerTool(
    "delete_account",
    {
      title: "Delete one account",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description:
        "Delete ONE money account (see get_accounts) together with its balance snapshots. If it still holds transactions, pass delete_transactions=true to confirm deleting them too. To erase the whole profile use delete_all_data instead.",
      inputSchema: {
        account: z.string().min(1).describe("Account name to delete."),
        delete_transactions: z
          .boolean()
          .optional()
          .describe("Must be true when the account still has transactions."),
      },
    },
    async ({ account, delete_transactions }) => {
      const acc = await resolveAccount(userId, account);
      const txCount = await db.transaction.count({ where: { accountId: acc.id } });
      if (txCount > 0 && delete_transactions !== true) {
        throw new Error(
          `Account "${acc.name}" still has ${txCount} transaction(s). Pass delete_transactions=true to delete them ` +
            `together with the account, or move them to another account first via update_transaction.`
        );
      }
      const counterLegs = await db.transaction.count({ where: { userId, counterAccountId: acc.id } });
      // Detach any bank/ZenMoney sync mapping so connectors stop targeting a dead id.
      const connections = await db.bankConnection.findMany({ where: { userId } });
      for (const c of connections) {
        const map = (c.accountMap ?? {}) as Record<string, { accountId: string; enabled: boolean }>;
        let touched = false;
        for (const entry of Object.values(map)) {
          if (entry && entry.accountId === acc.id && entry.enabled) {
            entry.enabled = false;
            touched = true;
          }
        }
        if (touched) {
          await db.bankConnection.update({ where: { id: c.id }, data: { accountMap: map as object } });
        }
      }
      await db.account.delete({ where: { id: acc.id } }); // cascades transactions + snapshots
      logEvent("account_removed", userId, { had_transactions: txCount });
      return text({
        deleted: acc.name,
        transactions_deleted: txCount,
        ...(counterLegs > 0
          ? { note: `${counterLegs} transfer(s) on other accounts pointed to this one; they remain as outgoing transfers.` }
          : {}),
      });
    }
  );

  server.registerTool(
    "merge_accounts",
    {
      title: "Merge accounts",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description:
        "Merge one account into another: moves all transactions to the target, de-duplicates rows present on both sides (same type, currency, amount and date within dedup_window_days; the row with a bank reference wins and absorbs the other's category), rewrites transfer references, then deletes the source account. Typical use: a hand-made statement-import account and a live bank sync account tracking the same real bank. Run with dry_run=true first and show the counts to the user.",
      inputSchema: {
        source: z.string().min(1).describe("Account to merge FROM (deleted afterwards)."),
        target: z.string().min(1).describe("Account to merge INTO (kept)."),
        dry_run: z.boolean().optional().describe("Preview counts without changing anything."),
        dedup_window_days: z
          .number()
          .int()
          .min(0)
          .max(14)
          .optional()
          .describe("Fuzzy duplicate match window, default 3. 0 = drop only exact bank-reference duplicates."),
      },
    },
    async ({ source, target, dry_run, dedup_window_days }) => {
      const src = await resolveAccount(userId, source);
      const dst = await resolveAccount(userId, target);
      if (src.id === dst.id) throw new Error("source and target are the same account.");
      if (src.provider && dst.provider) {
        throw new Error(
          "Both accounts are live-linked to a bank source; merging two live feeds is not allowed. Disable one side instead (connect_* action=set_account_sync)."
        );
      }
      const dryRun = dry_run === true;
      const windowMs = (dedup_window_days ?? 3) * 86_400_000;

      const srcRows = await db.transaction.findMany({ where: { accountId: src.id }, orderBy: { occurredAt: "asc" } });
      const dstRows = await db.transaction.findMany({ where: { accountId: dst.id } });
      const dstExt = new Set(dstRows.filter((r) => r.externalId).map((r) => r.externalId as string));

      const consumed = new Set<string>();
      const toDelete: string[] = [];
      const toMove: string[] = [];
      const absorb: Array<{ id: string; categoryKey: string }> = [];
      let merged = 0;
      let droppedExact = 0;
      let internalTransfersRemoved = 0;

      for (const row of srcRows) {
        // A transfer between source and target becomes a self-transfer after the
        // merge - meaningless, drop it.
        if (row.type === "transfer" && row.counterAccountId === dst.id) {
          toDelete.push(row.id);
          internalTransfersRemoved++;
          continue;
        }
        if (row.externalId && dstExt.has(row.externalId)) {
          toDelete.push(row.id);
          droppedExact++;
          continue;
        }
        const match =
          windowMs > 0
            ? dstRows.find(
                (d) =>
                  !consumed.has(d.id) &&
                  d.type === row.type &&
                  d.currency === row.currency &&
                  Math.abs(Number(d.amount) - Number(row.amount)) <= 0.011 &&
                  Math.abs(d.occurredAt.getTime() - row.occurredAt.getTime()) <= windowMs
              )
            : undefined;
        if (match) {
          consumed.add(match.id);
          merged++;
          const targetWins = !!match.externalId || !row.externalId;
          const winner = targetWins ? match : row;
          const loser = targetWins ? row : match;
          toDelete.push(loser.id);
          if (!targetWins) toMove.push(row.id);
          if ((winner.categoryKey === null || winner.categoryKey === "other") && loser.categoryKey && loser.categoryKey !== "other") {
            absorb.push({ id: winner.id, categoryKey: loser.categoryKey });
          }
          continue;
        }
        toMove.push(row.id);
      }
      for (const d of dstRows) {
        if (d.type === "transfer" && d.counterAccountId === src.id) {
          toDelete.push(d.id);
          internalTransfersRemoved++;
        }
      }

      const deleteSet = new Set(toDelete);
      const counterRefs = await db.transaction.count({
        where: { userId, counterAccountId: src.id, id: { notIn: toDelete } },
      });
      const snapshotsDropped = await db.balanceSnapshot.count({ where: { accountId: src.id } });

      if (!dryRun) {
        await db.transaction.deleteMany({ where: { id: { in: toDelete } } });
        await db.transaction.updateMany({
          where: { id: { in: toMove.filter((id) => !deleteSet.has(id)) } },
          data: { accountId: dst.id },
        });
        for (const a of absorb) {
          await db.transaction.update({ where: { id: a.id }, data: { categoryKey: a.categoryKey } });
        }
        await db.transaction.updateMany({
          where: { userId, counterAccountId: src.id },
          data: { counterAccountId: dst.id },
        });
        // If the source carried the live bank link, the target inherits it so
        // the feed keeps flowing into the merged account.
        if (src.provider) {
          await db.account.update({
            where: { id: dst.id },
            data: { provider: src.provider, externalId: src.externalId, currency: dst.currency ?? src.currency },
          });
          const connections = await db.bankConnection.findMany({ where: { userId } });
          for (const c of connections) {
            const map = { ...((c.accountMap ?? {}) as Record<string, { accountId: string; enabled: boolean }>) };
            let touched = false;
            for (const entry of Object.values(map)) {
              if (entry && entry.accountId === src.id) {
                entry.accountId = dst.id;
                touched = true;
              }
            }
            if (touched) await db.bankConnection.update({ where: { id: c.id }, data: { accountMap: map as object } });
          }
        }
        await db.account.delete({ where: { id: src.id } }); // cascades remaining snapshots
        logEvent("accounts_merged", userId, { moved: toMove.length, merged, dropped: droppedExact });
      }

      return text({
        ...(dryRun ? { dry_run: true } : {}),
        source: src.name,
        target: dst.name,
        moved: toMove.length,
        merged_duplicates: merged,
        dropped_exact_duplicates: droppedExact,
        internal_transfers_removed: internalTransfersRemoved,
        ...(counterRefs ? { transfer_refs_rewritten: counterRefs } : {}),
        ...(snapshotsDropped ? { snapshots_dropped: snapshotsDropped } : {}),
        ...(dryRun ? {} : { source_deleted: true }),
        note: "Target keeps its own balance snapshots; source snapshots are dropped (two accounts' absolute balances cannot be merged). Anchor with log_balance if the balance looks off.",
      });
    }
  );

  server.registerTool(
    "get_accounts",
    {
      _meta: DASHBOARD_TOOL_META,
      title: "Accounts & net worth",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "All accounts with computed balances (latest snapshot + tracked flows) and total net worth in the base currency. Optionally filtered to personal or business scope.",
      inputSchema: {
        entity: entitySchema.optional().describe("Only accounts of this scope. Omit for all."),
      },
    },
    async ({ entity }) => {
      const user = await getUser(userId);
      const accounts = await db.account.findMany({
        where: { userId, ...(entity ? { entity } : {}) },
        orderBy: { name: "asc" },
      });
      const today = parseDate(todayIn(user.timezone));
      const out = [];
      let netWorth = 0;
      const byEntity: Record<string, number> = {};
      for (const a of accounts) {
        const b = await computeBalance(a);
        const { converted } = await convert(b.balance, b.currency, user.baseCurrency, today);
        netWorth += converted;
        byEntity[a.entity] = round2((byEntity[a.entity] ?? 0) + converted);
        out.push({
          name: a.name,
          type: a.type,
          entity: a.entity,
          currency: b.currency,
          balance: b.balance,
          balance_base: converted,
          anchored_at: b.anchoredAt,
        });
      }
      return text({
        base_currency: user.baseCurrency,
        net_worth: round2(netWorth),
        ...(entity ? {} : Object.keys(byEntity).length > 1 ? { net_worth_by_entity: byEntity } : {}),
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
          entity: from.entity,
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Import bank-statement / statement-screenshot rows in bulk. ALWAYS send the ENTIRE statement as ONE call with the full transactions array (up to 500 rows) - never split into chunks, never log rows one-by-one via log_expense. If one statement truly cannot fit in a single call, EVERY row of EVERY chunk must carry external_id (bank reference; or the statement row number, e.g. 'r017') - rows without external_id are keyed by amount+date+occurrence WITHIN one call, so identical rows arriving in different calls are indistinguishable from re-imports. Safe to re-run: keyed rows are skipped, a hand-logged twin is merged into the bank row instead of duplicating, and repeated purchases (same merchant and amount on different days, or twice the same day) import normally. Unknown categories become 'other'. Pass statement_total to get a reconciliation check. Sign convention: negative amount = money out, positive = money in.",
      inputSchema: {
        account: z.string().optional().describe("Target account name. Default: Manual."),
        statement_total: z
          .number()
          .optional()
          .describe("Signed sum of ALL rows in the source statement, for reconciliation."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Preview only: report what would be imported/skipped/merged without writing anything."),
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
              external_id: z
                .string()
                .optional()
                .describe("Bank transaction reference - the strongest dedup key. If absent, the server derives a stable key from amount + date + position."),
              force: z
                .boolean()
                .optional()
                .describe("Import even if a similar row exists. Use ONLY when a previous response's hint asked to re-send this row. Exact external_id duplicates are still skipped."),
              entity: entitySchema
                .optional()
                .describe("Scope override for THIS row, e.g. a personal dinner inside a business-account statement. Default: the account's entity."),
            })
          )
          .min(1)
          .max(500),
      },
    },
    async ({ account, statement_total, dry_run, transactions }) => {
      const user = await getUser(userId);
      const acc = await resolveAccount(userId, account);
      const dryRun = dry_run === true;
      let imported = 0;
      let merged = 0;
      let coerced = 0;
      let rowsSum = 0;
      let noIdSkips = 0;
      const skipped: Array<{ row: number; reason: string; existing_id: string }> = [];

      const normalize = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const SYN_PREFIX = "fmcp:";
      const isRealId = (id?: string | null): id is string => !!id && !id.startsWith(SYN_PREFIX);

      // The statement itself is the source of truth: rows inserted by THIS call are
      // never dedup candidates (two identical rides on one day = two real rides),
      // and each pre-existing row can absorb at most one statement row.
      const createdIds = new Set<string>();
      const usedCandidates = new Set<string>();
      // Rows without a bank reference get a deterministic synthetic key
      // (amount + currency + date + occurrence counter, YNAB pattern), so re-importing
      // the same statement stays idempotent even when merchant wording drifts
      // between extractions. Counted per row SENT, not per row imported.
      const occurrence = new Map<string, number>();

      for (const [idx, row] of transactions.entries()) {
        rowsSum += row.amount;
        const cur = (row.currency ?? acc.currency ?? user.baseCurrency).toUpperCase();
        const occurredAt = parseDate(row.date);
        const type: TxType = row.type ?? (row.amount < 0 ? "expense" : "income");
        const amountSigned = round2(row.amount);
        const amountAbs = Math.abs(amountSigned);

        const occKey = `${amountSigned}:${cur}:${row.date}`;
        const occ = (occurrence.get(occKey) ?? 0) + 1;
        occurrence.set(occKey, occ);
        const externalId = row.external_id ?? `${SYN_PREFIX}${occKey}:${occ}`;

        const byExt = await db.transaction.findFirst({
          where: { accountId: acc.id, externalId },
        });
        if (byExt) {
          if (!row.external_id) noIdSkips++;
          skipped.push({
            row: idx + 1,
            reason: row.external_id ? "external_id_exists" : "already_imported",
            existing_id: byExt.id,
          });
          continue;
        }

        const windowStart = new Date(occurredAt.getTime() - 2 * 86_400_000);
        const windowEnd = new Date(occurredAt.getTime() + 2 * 86_400_000);
        // Manual/receipt entries live on the Manual account by default: match them
        // user-wide or hand-logged rows duplicate on import. Bank rows only compete
        // within the same account. force = the hint-driven recovery path: the model
        // confirmed this row is new, so only the exact-key check above applies.
        const candidates = row.force
          ? []
          : (
              await db.transaction.findMany({
                where: {
                  userId,
                  currency: cur,
                  occurredAt: { gte: windowStart, lte: windowEnd },
                  OR: [{ source: { in: ["manual", "receipt"] } }, { accountId: acc.id, source: "bank" }],
                },
              })
            ).filter(
          (c) =>
            !createdIds.has(c.id) &&
            !usedCandidates.has(c.id) &&
            Math.abs(Math.abs(Number(c.amount)) - amountAbs) <= 0.009
        );
        const rm = normalize(row.merchant);

        // Bank-vs-bank (checked first: exact evidence beats fuzzy): same day only.
        // Two REAL bank references that differ mean distinct transactions no matter
        // how similar the rows look. Same-merchant candidates are preferred, but
        // merchant wording drifts between exports, so any remaining same-day
        // same-amount bank row still counts as the re-imported twin.
        const bankPool = candidates.filter(
          (c) =>
            c.source === "bank" &&
            c.occurredAt.getTime() === occurredAt.getTime() &&
            !(isRealId(row.external_id) && isRealId(c.externalId))
        );
        const bankTwin = bankPool.find((c) => normalize(c.merchant) === rm) ?? bankPool[0];
        if (bankTwin) {
          usedCandidates.add(bankTwin.id);
          // Self-heal: stamp the dedup key on legacy/synthetic rows so the next
          // re-run matches by key directly instead of by day+amount.
          if (!dryRun && !isRealId(bankTwin.externalId)) {
            await db.transaction.update({ where: { id: bankTwin.id }, data: { externalId } });
          }
          if (!row.external_id) noIdSkips++;
          skipped.push({ row: idx + 1, reason: "already_imported", existing_id: bankTwin.id });
          continue;
        }

        // Hand-logged twin (fuzzy merchant, +-2 days): merge instead of skip - the
        // bank feed confirms the entry, so it moves to the real account and gains
        // the dedup key. User-entered category/note/date stay untouched.
        const manualTwin = candidates.find((c) => {
          if (c.source === "bank") return false;
          const cm = normalize(c.merchant);
          if (rm && cm) return cm.includes(rm) || rm.includes(cm);
          // no merchant info to compare: only exact same day counts as duplicate (conservative)
          return c.occurredAt.getTime() === occurredAt.getTime();
        });
        if (manualTwin) {
          usedCandidates.add(manualTwin.id);
          if (!dryRun) {
            await db.transaction.update({
              where: { id: manualTwin.id },
              data: { accountId: acc.id, externalId, entity: row.entity ?? acc.entity },
            });
          }
          merged++;
          skipped.push({ row: idx + 1, reason: "manual_twin_merged", existing_id: manualTwin.id });
          continue;
        }

        let category = row.category;
        if (type !== "transfer") {
          if (!category || !ALL_CATEGORIES.has(category)) {
            if (category) coerced++;
            category = "other";
          }
        }

        if (!dryRun) {
          const fx = await convert(amountAbs, cur, user.baseCurrency, occurredAt);
          const created = await db.transaction.create({
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
              externalId,
              entity: row.entity ?? acc.entity,
            },
          });
          createdIds.add(created.id);
        }
        imported++;
      }

      rowsSum = round2(rowsSum);
      const diff = statement_total !== undefined ? round2(statement_total - rowsSum) : undefined;
      logEvent("bank_imported", userId, { imported, duplicates: skipped.length, merged, dry_run: dryRun });
      const SKIP_REPORT_CAP = 100;
      return text({
        account: acc.name,
        ...(dryRun ? { dry_run: true } : {}),
        imported,
        duplicates_skipped: skipped.length,
        manual_twins_merged: merged,
        unknown_categories_coerced_to_other: coerced,
        rows_sum: rowsSum,
        statement_total,
        reconciliation:
          statement_total === undefined ? "not_checked" : Math.abs(diff!) < 0.01 ? "ok" : `MISMATCH by ${diff}`,
        ...(skipped.length > 0 ? { skipped: skipped.slice(0, SKIP_REPORT_CAP) } : {}),
        ...(skipped.length > SKIP_REPORT_CAP ? { skipped_not_listed: skipped.length - SKIP_REPORT_CAP } : {}),
        ...(noIdSkips > 0
          ? {
              hint: `${noIdSkips} row(s) without external_id matched existing records by derived key (amount+date+occurrence). If they are re-imported rows, this is correct. If they are NEW rows (e.g. this call is a continuation chunk of a statement with several identical rows), re-send ONLY those rows with an explicit external_id (bank reference or statement row number) and force=true.`,
            }
          : {}),
      });
    }
  );

  server.registerTool(
    "get_summary",
    {
      _meta: DASHBOARD_TOOL_META,
      title: "Spending summary",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Totals for a period, computed server-side in the user's base currency. Breaks down expenses (default) or income: 'how much did I spend on X in July', 'what does my June income consist of'. Supports category drill-down (category=subscriptions + group_by=merchant) and exclusions (exclude_categories).",
      inputSchema: {
        period: z.string().optional().describe("YYYY-MM or YYYY. Defaults to the current month."),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        type: z
          .enum(["expense", "income"])
          .optional()
          .describe("Which side the groups break down. Default: expense. Use income for 'where does my income come from'."),
        group_by: z.enum(["category", "merchant", "month"]).optional().describe("Default: category."),
        category: categoryFilterSchema.optional().describe("Only this category, e.g. subscriptions with group_by=merchant to see what the subscriptions consist of."),
        exclude_categories: z
          .array(categoryFilterSchema)
          .optional()
          .describe("Drop these categories from totals and groups, e.g. ['business'] for personal stats without business-categorized records."),
        entity: entitySchema.optional().describe("personal or business only. Omit for everything."),
      },
    },
    async ({ period, from, to, type, group_by, category, exclude_categories, entity }) => {
      const user = await getUser(userId);
      const range = periodRange(period, from, to);
      const rows = await db.transaction.findMany({
        where: {
          userId,
          occurredAt: { gte: range.start, lt: range.end },
          type: { not: "transfer" },
          ...(entity ? { entity } : {}),
          ...(category
            ? { categoryKey: category }
            : exclude_categories?.length
              ? { categoryKey: { notIn: exclude_categories } }
              : {}),
        },
        select: { type: true, amountBase: true, categoryKey: true, merchant: true, occurredAt: true },
      });
      const expenses = rows.filter((r) => r.type === "expense");
      const income = rows.filter((r) => r.type === "income");
      const totalExpense = round2(expenses.reduce((s, r) => s + Number(r.amountBase), 0));
      const totalIncome = round2(income.reduce((s, r) => s + Number(r.amountBase), 0));

      const groupedType = type ?? "expense";
      const grouped = groupedType === "income" ? income : expenses;
      const groupedTotal = groupedType === "income" ? totalIncome : totalExpense;
      const key = (r: (typeof rows)[number]) =>
        group_by === "merchant"
          ? (r.merchant ?? "(no merchant)")
          : group_by === "month"
            ? r.occurredAt.toISOString().slice(0, 7)
            : (r.categoryKey ?? "other");
      const groups = new Map<string, number>();
      for (const r of grouped) groups.set(key(r), (groups.get(key(r)) ?? 0) + Number(r.amountBase));

      logEvent("summary_run", userId, { period: range.label });
      return text({
        period: range.label,
        entity: entity ?? "all",
        ...(category ? { category } : {}),
        ...(exclude_categories?.length && !category ? { excluded_categories: exclude_categories } : {}),
        base_currency: user.baseCurrency,
        total_expense: totalExpense,
        total_income: totalIncome,
        net: round2(totalIncome - totalExpense),
        transactions: rows.length,
        grouped_type: groupedType,
        grouped_by: group_by ?? "category",
        // legacy alias kept for older dashboard payload readers
        expense_by: group_by ?? "category",
        groups: [...groups.entries()]
          // months read as a timeline, categories/merchants as a ranking
          .sort(group_by === "month" ? (a, b) => a[0].localeCompare(b[0]) : (a, b) => b[1] - a[1])
          .map(([k, v]) => ({
            key: k,
            total: round2(v),
            share_pct: groupedTotal > 0 ? round2((v / groupedTotal) * 100) : 0,
          })),
      });
    }
  );

  server.registerTool(
    "get_transactions",
    {
      title: "List transactions",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "Find records: 'what was that 40 eur charge', recent spending, by category or merchant.",
      inputSchema: {
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        category: z.string().optional(),
        merchant: z.string().optional().describe("Substring match, case-insensitive."),
        query: z.string().optional().describe("Searches note and merchant."),
        entity: entitySchema.optional().describe("personal or business only."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ from, to, category, merchant, query, entity, limit }) => {
      const user = await getUser(userId);
      const txs = await db.transaction.findMany({
        where: {
          userId,
          ...(entity ? { entity } : {}),
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
          entity: t.entity,
        })),
      });
    }
  );

  server.registerTool(
    "update_transaction",
    {
      title: "Update transaction",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Fix a logged record: wrong category, amount, merchant, date, personal/business scope, or type. type=transfer + counter_account converts a mislogged row into a transfer between own accounts (e.g. a cash withdrawal into a transfer to Cash). Category fixes on rows with a merchant are remembered: future bank syncs of that merchant reuse your category.",
      inputSchema: {
        id: z.string().uuid(),
        amount: z.number().optional(),
        currency: currencySchema.optional(),
        category: z.enum([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]).optional(),
        merchant: z.string().optional(),
        note: z.string().optional(),
        date: dateSchema.optional(),
        entity: entitySchema.optional(),
        type: z
          .enum(["expense", "income", "transfer"])
          .optional()
          .describe("Convert the record's type. transfer additionally needs counter_account."),
        counter_account: z
          .string()
          .optional()
          .describe("type=transfer only: the OTHER own account of the transfer (for an expense row: where the money went, e.g. Cash)."),
      },
    },
    async ({ id, amount, currency, category, merchant, note, date, entity, type, counter_account }) => {
      const user = await getUser(userId);
      const existing = await db.transaction.findFirst({ where: { id, userId } });
      if (!existing) throw new Error("Transaction not found.");

      const newType = type ?? existing.type;
      if (category && newType !== "transfer") {
        const valid = newType === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
        if (!(valid as readonly string[]).includes(category)) {
          throw new Error(`Category "${category}" is not a valid ${newType} category. Valid: ${valid.join(", ")}.`);
        }
      }

      // Type conversion. Transfers live on the SOURCE account with a counter
      // leg; an income row flips (money arrived here, so this account becomes
      // the counter side). Bank external ids stay put - the edited row counts
      // as user-touched, so re-syncs leave it alone.
      let accountId = existing.accountId;
      let typeData: Record<string, unknown> = {};
      if (type && type !== existing.type) {
        if (type === "transfer") {
          if (!counter_account) {
            throw new Error("Converting to a transfer needs counter_account (the other own account, e.g. Cash).");
          }
          const counter = await resolveAccount(userId, counter_account);
          if (counter.id === existing.accountId) {
            throw new Error("counter_account must be a different account than the transaction's own.");
          }
          if (existing.type === "income") {
            accountId = counter.id;
            typeData = { type, categoryKey: null, counterAccountId: existing.accountId };
          } else {
            typeData = { type, categoryKey: null, counterAccountId: counter.id };
          }
        } else {
          // transfer -> expense/income (or expense <-> income): drop the counter leg
          const fallback = type === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
          const keep =
            existing.categoryKey && (fallback as readonly string[]).includes(existing.categoryKey)
              ? existing.categoryKey
              : "other";
          typeData = {
            type,
            categoryKey: category ?? keep,
            counterAccountId: null,
            counterAmount: null,
            counterCurrency: null,
          };
        }
      }

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
          accountId,
          ...(category && newType !== "transfer" ? { categoryKey: category } : {}),
          ...(merchant !== undefined ? { merchant } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(entity ? { entity } : {}),
          ...typeData,
        },
      });
      if (category && tx.merchant && tx.type !== "transfer") {
        await rememberMerchantCategory(userId, tx.merchant, category);
      }
      return text({
        updated: true,
        id: tx.id,
        type: tx.type,
        amount_base: Number(tx.amountBase),
        category: tx.categoryKey,
        entity: tx.entity,
        ...(tx.type === "transfer" && tx.counterAccountId ? { transfer: true } : {}),
      });
    }
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Delete transaction",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: "Remove ONE wrongly logged record. For 3+ records use delete_transactions (bulk) with the ids array.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const res = await db.transaction.deleteMany({ where: { id, userId } });
      if (res.count === 0) throw new Error("Transaction not found.");
      return text({ deleted: true, id });
    }
  );

  server.registerTool(
    "delete_transactions",
    {
      title: "Bulk delete",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Delete MANY transactions in ONE call by ids (from get_transactions). Always prefer this over repeated delete_transaction calls - one-by-one deletion hits the per-turn tool limit.",
      inputSchema: {
        ids: z.array(z.string().uuid()).min(1).max(500),
      },
    },
    async ({ ids }) => {
      const res = await db.transaction.deleteMany({ where: { id: { in: ids }, userId } });
      logEvent("bulk_deleted", userId, { requested: ids.length, deleted: res.count });
      return text({ deleted: res.count, not_found: ids.length - res.count });
    }
  );

  server.registerTool(
    "get_trends",
    {
      _meta: DASHBOARD_TOOL_META,
      title: "Monthly trends",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "Month-over-month expense/income dynamics, optionally for one category or scope.",
      inputSchema: {
        months: z.number().int().min(2).max(24).optional().describe("How many months back. Default 6."),
        category: z.enum(EXPENSE_CATEGORIES).optional(),
        entity: entitySchema.optional().describe("personal or business only. Omit for everything."),
      },
    },
    async ({ months, category, entity }) => {
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
          ...(entity ? { entity } : {}),
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
      return text({ base_currency: user.baseCurrency, category: category ?? "all", entity: entity ?? "all", months: series });
    }
  );

  server.registerTool(
    "set_budget",
    {
      title: "Set budget",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "Current month: spent vs cap for every budget. Budgets track PERSONAL spending only; business-scope transactions never count against them.",
      inputSchema: {},
    },
    async () => {
      const user = await getUser(userId);
      const budgets = await db.budget.findMany({ where: { userId } });
      if (budgets.length === 0) return text({ budgets: [], hint: "No budgets set. Use set_budget." });
      const range = periodRange(undefined);
      const rows = await db.transaction.findMany({
        where: { userId, type: "expense", entity: "personal", occurredAt: { gte: range.start, lt: range.end } },
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
      annotations: { readOnlyHint: true, openWorldHint: false },
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
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "All transactions as CSV (GDPR portability). Optionally one scope only, e.g. business rows for the accountant.",
      inputSchema: { from: dateSchema.optional(), to: dateSchema.optional(), entity: entitySchema.optional() },
    },
    async ({ from, to, entity }) => {
      const user = await getUser(userId);
      const txs = await db.transaction.findMany({
        where: {
          userId,
          ...(entity ? { entity } : {}),
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
      const header = "date,type,amount,currency,amount_base,base_currency,category,merchant,note,source,entity";
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
          t.entity,
        ].join(",")
      );
      return { content: [{ type: "text" as const, text: [header, ...lines].join("\n") }] };
    }
  );

  server.registerTool(
    "connect_zenmoney",
    {
      title: "Connect ZenMoney",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Link a ZenMoney account (both zenmoney.app international and zenmoney.ru work; the right backend is auto-detected) for read-only transaction sync. action=paste_token stores the user's personal ZenMoney API token: get it free at zerro.app - log in choosing YOUR ZenMoney version on the login screen, then open zerro.app/token and copy it. action=status shows connection health and the synced accounts list. action=set_account_sync with account + enabled turns syncing of ONE account on or off, for example when the same bank is also connected via connect_bank. action=disconnect removes the link and stored token; already-imported transactions stay. After connecting, run sync_zenmoney.",
      inputSchema: {
        action: z.enum(["paste_token", "status", "disconnect", "set_account_sync"]),
        token: z.string().min(10).optional().describe("ZenMoney API token. Required for action=paste_token."),
        account: z.string().optional().describe("set_account_sync: account name or id (see action=status)."),
        enabled: z.boolean().optional().describe("set_account_sync: true = resume syncing this account, false = stop."),
      },
    },
    async ({ action, token, account, enabled }) => {
      await getUser(userId);
      const existing = await db.bankConnection.findUnique({
        where: { userId_provider: { userId, provider: "zenmoney" } },
      });

      if (action === "status") {
        if (!existing) return text({ connected: false, hint: "Connect with action=paste_token." });
        const map = (existing.accountMap ?? {}) as Record<string, { accountId: string; enabled: boolean }>;
        return text({
          connected: true,
          status: existing.status,
          backend: existing.apiBase.replace("https://api.", ""),
          last_sync: existing.lastSyncAt?.toISOString() ?? null,
          last_error: existing.lastError ?? undefined,
          accounts_synced: Object.values(map).filter((m) => m.enabled).length,
          accounts: await connectionAccounts(existing),
          auto_sync: "Healthy connections are synced server-side roughly daily.",
        });
      }

      if (action === "set_account_sync") {
        if (!existing) throw new Error("No ZenMoney connection. Connect with action=paste_token first.");
        if (!account || enabled === undefined) throw new Error("set_account_sync requires account and enabled.");
        const name = await setAccountSync(existing, account, enabled);
        return text({
          account: name,
          provider: "zenmoney",
          enabled,
          note: enabled
            ? "Sync resumed. ZenMoney diffs are incremental; a long-disabled account may have a history gap."
            : "This account is no longer pulled from ZenMoney. Already-imported transactions were kept; remove them with get_transactions + delete_transactions if they duplicate another source.",
        });
      }

      if (action === "disconnect") {
        if (!existing) return text({ connected: false });
        await db.bankConnection.delete({ where: { id: existing.id } });
        logEvent("bank_disconnected", userId, { provider: "zenmoney" });
        return text({ disconnected: true, note: "Token erased. Imported transactions were kept." });
      }

      if (!token) throw new Error("action=paste_token requires the token parameter.");
      // Validate before storing AND detect which ZenMoney backend issued the
      // token (zenmoney.app international vs zenmoney.ru run separate servers).
      const apiBase = await detectZenHost(token);
      const tokenEnc = encryptToken(token);
      await db.bankConnection.upsert({
        where: { userId_provider: { userId, provider: "zenmoney" } },
        update: { tokenEnc, apiBase, status: "active", lastError: null },
        create: { userId, provider: "zenmoney", tokenEnc, apiBase },
      });
      logEvent("bank_connected", userId, { provider: "zenmoney" });
      return text({
        connected: true,
        next: "Run sync_zenmoney to import accounts and transaction history. Use months_back to limit history, or dry_run for a preview.",
      });
    }
  );

  server.registerTool(
    "sync_zenmoney",
    {
      title: "Sync ZenMoney",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Pull transactions, accounts and balances from the linked ZenMoney account (read-only, incremental after the first run, safe to re-run). First sync imports full history unless months_back is set. dry_run previews transaction changes (account mapping is still saved). Report includes unmapped ZenMoney tags: those rows land in category 'other' for the user to review. If the same real bank account is also connected via connect_bank its transactions WILL duplicate: relay any overlap_warnings from the response to the user and offer to disable one side (action=set_account_sync).",
      inputSchema: {
        dry_run: z.boolean().optional().describe("Preview transaction changes without writing them."),
        months_back: z
          .number()
          .int()
          .positive()
          .max(240)
          .optional()
          .describe("First sync only: import history no older than this many months. Default: everything."),
      },
    },
    async ({ dry_run, months_back }) => {
      const report = await syncZenMoney(userId, { dryRun: dry_run, monthsBack: months_back });
      return text(report);
    }
  );

  server.registerTool(
    "connect_bank",
    {
      title: "Connect a bank",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Link a real bank account via open banking (Enable Banking, EU/UK/EEA coverage) for read-only transaction sync. Flow: action=list_banks with the user's country (and optional search) to find the exact bank name -> action=start with bank_name + country -> give the user the returned authorize_url to open and approve at their bank -> after they confirm they are done, run sync_bank. action=status shows connection health, consent expiry and the synced accounts list. action=set_account_sync with account + enabled turns syncing of ONE account on or off, for example when the same bank is also connected via another source. action=disconnect revokes the session and removes the link; imported transactions stay. Only one bank connection at a time for now; connecting a different bank replaces the previous one after disconnect.",
      inputSchema: {
        action: z.enum(["list_banks", "start", "status", "disconnect", "set_account_sync"]),
        country: z
          .string()
          .length(2)
          .optional()
          .describe("2-letter country code (FI, DE, FR, ...). Required for list_banks and start."),
        search: z.string().optional().describe("list_banks: case-insensitive substring filter on bank names."),
        bank_name: z
          .string()
          .optional()
          .describe("start: exact bank name as returned by list_banks. Required for action=start."),
        account: z.string().optional().describe("set_account_sync: account name or id (see action=status)."),
        enabled: z.boolean().optional().describe("set_account_sync: true = resume syncing this account, false = stop."),
      },
    },
    async ({ action, country, search, bank_name, account, enabled }) => {
      await getUser(userId);
      if (!ebConfigured()) {
        throw new Error("Bank connections are not enabled on this server yet. Use import_transactions with a statement export instead.");
      }
      const existing = await db.bankConnection.findUnique({
        where: { userId_provider: { userId, provider: "enablebanking" } },
      });

      if (action === "list_banks") {
        if (!country) throw new Error("list_banks requires the country parameter (2-letter code).");
        const all = await ebAspsps(country);
        const q = search?.toLowerCase();
        const matches = q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all;
        return text({
          country: country.toUpperCase(),
          total: matches.length,
          banks: matches.slice(0, 30).map((a) => a.name),
          ...(matches.length > 30 ? { hint: "More than 30 matches; narrow with the search parameter." } : {}),
          next: "Call connect_bank action=start with the exact bank_name and country.",
        });
      }

      if (action === "status") {
        if (!existing) return text({ connected: false, hint: "Connect with action=start." });
        const meta = (existing.meta ?? {}) as EbConnectionMeta;
        const map = (existing.accountMap ?? {}) as Record<string, { enabled: boolean }>;
        return text({
          connected: existing.status === "active",
          status: existing.status,
          bank: meta.aspsp?.name,
          country: meta.aspsp?.country,
          consent_valid_until: meta.validUntil,
          last_sync: existing.lastSyncAt?.toISOString() ?? null,
          last_error: existing.lastError ?? undefined,
          accounts_synced: Object.values(map).filter((m) => m.enabled).length,
          accounts: await connectionAccounts(existing),
          auto_sync: "Healthy connections are synced server-side roughly daily.",
        });
      }

      if (action === "set_account_sync") {
        if (!existing) throw new Error("No bank connection. Connect with action=start first.");
        if (!account || enabled === undefined) throw new Error("set_account_sync requires account and enabled.");
        const name = await setAccountSync(existing, account, enabled);
        return text({
          account: name,
          provider: "enablebanking",
          enabled,
          note: enabled
            ? "Sync resumed. A long-disabled account may have a history gap: the bank re-fetches only a few days behind the cursor; re-sync with months_back after reconnecting if needed."
            : "This account is no longer pulled from the bank. Already-imported transactions were kept; remove them with get_transactions + delete_transactions if they duplicate another source.",
        });
      }

      if (action === "disconnect") {
        if (!existing) return text({ connected: false });
        if (existing.tokenEnc) await ebDeleteSession(decryptToken(existing.tokenEnc));
        await db.bankConnection.delete({ where: { id: existing.id } });
        logEvent("bank_disconnected", userId, { provider: "enablebanking" });
        return text({ disconnected: true, note: "Bank access revoked. Imported transactions were kept." });
      }

      // action=start
      if (!country || !bank_name) throw new Error("action=start requires bank_name and country.");
      if (existing && existing.status === "active") {
        throw new Error("A bank is already connected. Run connect_bank action=disconnect first to replace it.");
      }
      const banks = await ebAspsps(country);
      const bank = banks.find((b) => b.name.toLowerCase() === bank_name.toLowerCase());
      if (!bank) {
        throw new Error(`Bank "${bank_name}" not found in ${country.toUpperCase()}. Use action=list_banks to get exact names.`);
      }
      const state = crypto.randomUUID();
      // Consent window: 90 days or whatever shorter maximum the bank enforces.
      const maxSeconds = Math.min(bank.maximum_consent_validity ?? 90 * 86_400, 90 * 86_400);
      const validUntil = new Date(Date.now() + maxSeconds * 1000).toISOString();
      const { url } = await ebStartAuth({ aspspName: bank.name, country, state, validUntil });
      await db.bankConnection.upsert({
        where: { userId_provider: { userId, provider: "enablebanking" } },
        update: {
          tokenEnc: "",
          status: "pending",
          lastError: null,
          accountMap: {},
          meta: { state, aspsp: { name: bank.name, country: country.toUpperCase() } },
        },
        create: {
          userId,
          provider: "enablebanking",
          status: "pending",
          meta: { state, aspsp: { name: bank.name, country: country.toUpperCase() } },
        },
      });
      logEvent("bank_connected", userId, { provider: "enablebanking" });
      return text({
        authorize_url: url,
        bank: bank.name,
        instructions:
          "Show authorize_url to the user as a clickable link. They open it, sign in at their bank and approve read-only access, then land on a confirmation page. When they say they are done, run sync_bank.",
      });
    }
  );

  server.registerTool(
    "sync_bank",
    {
      title: "Sync bank",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Pull booked transactions and balances from the connected bank (via connect_bank; read-only, incremental, safe to re-run). First sync imports months_back of history (default 3; banks may return less). Equal-amount same-day debit/credit pairs across the user's own synced accounts are merged into transfers. Categories come from the user's remembered per-merchant fixes first, then MCC; the rest land in 'other'. The server also auto-syncs healthy connections roughly daily; run this only for immediate freshness or right after connecting. If the same real bank account is also connected via ZenMoney its transactions WILL duplicate: relay any overlap_warnings from the response to the user and offer to disable one side (action=set_account_sync).",
      inputSchema: {
        dry_run: z.boolean().optional().describe("Preview changes without writing them."),
        months_back: z
          .number()
          .int()
          .positive()
          .max(24)
          .optional()
          .describe("First sync only: how many months of history to request. Default 3."),
      },
    },
    async ({ dry_run, months_back }) => {
      await getUser(userId);
      const report = await syncEnableBanking(userId, { dryRun: dry_run, monthsBack: months_back });
      return text(report);
    }
  );

  server.registerTool(
    "delete_all_data",
    {
      title: "Delete all data",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Erase the user profile and ALL financial data permanently (GDPR). For removing a single money account use delete_account instead. Requires confirm='DELETE'.",
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
