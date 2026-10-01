import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { db, logEvent } from "./db";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./categories";
import { ACCOUNT_TYPES } from "./accounts";

/**
 * MCP tool-call telemetry for tuning the server against weaker models.
 * Hooks transport.send, so every JSON-RPC response (including SDK-level
 * validation errors) is matched to its request. Captures the SHAPE of each
 * tools/call - tool, duration, error class, which args were provided, enum
 * values - never amounts, merchants, notes or any free text. Fire-and-forget writes.
 */

const CATEGORIES = new Set<string>([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]);
const isStr = (re: RegExp) => (v: unknown) => typeof v === "string" && re.test(v);
const oneOf = (values: readonly string[]) => (v: unknown) => typeof v === "string" && values.includes(v);
const intIn = (min: number, max: number) => (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isDate = isStr(/^\d{4}-\d{2}-\d{2}$/);

// Arg values recorded verbatim, each only when it fits its key's closed shape.
// Key names alone are not enough: get_transactions.category is free text, so
// a value outside the shape (a typo, a merchant name) is dropped, never stored.
// A Map, not an object literal: raw args are client-controlled and a key like
// "constructor" must not resolve to an inherited function.
const SAFE_ARG_VALUES = new Map<string, (v: unknown) => boolean>([
  ["category", (v) => typeof v === "string" && CATEGORIES.has(v)],
  ["currency", isStr(/^[A-Za-z]{3}$/)],
  ["type", oneOf(["expense", "income", "transfer", ...ACCOUNT_TYPES])],
  ["group_by", oneOf(["category", "merchant", "month"])],
  ["period", isStr(/^\d{4}(-\d{2})?$/)],
  ["from", isDate],
  ["to", isDate],
  ["months", intIn(1, 240)],
  ["limit", intIn(1, 1000)],
]);

// Tool error text embeds account names (often the holder's full name), IBANs
// and Prisma argument dumps, so only a CLASS is stored. First match wins.
const ERROR_CLASSES: Array<[RegExp, string]> = [
  [/Input validation error|Invalid arguments for tool/, "validation"],
  [/Unknown currency/, "unknown_currency"],
  [/FX rates unavailable/, "fx_unavailable"],
  [/^Account not found/, "auth"], // the signed-in user's profile is gone
  [/^Account ".*" not found|is not part of this connection/, "account_not_found"],
  [/rate.?limit|\b429\b/i, "rate_limited"],
  [/application credentials/, "server_auth"], // our own Enable Banking key, not the user's consent
  [/rejected the token|access was rejected|consent .*expired|reconnect with connect_|token is malformed/i, "auth"],
  [/No (bank|ZenMoney) connection|is not connected|No bank is connected|not finished|not configured|not enabled/i, "not_connected"],
  [/not found/i, "not_found"],
  [/already (exists|connected|taken)|Unique constraint|still has/i, "conflict"],
  [/unreachable|try again later|timed? ?out|Enable Banking rejected/i, "upstream"],
  [/prisma|\bP\d{4}\b/i, "db"],
  [/requires|must |^Invalid |is not a valid|Unknown timezone|Nothing to change|Use either|do not apply|needs /i, "validation"],
];

export function errorClass(text: string): string {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return "other";
}

const EVENT_RETENTION_DAYS = 90;

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; clientInfo?: { name?: string; version?: string } };
}

interface RpcResponse {
  id?: number | string | null;
  error?: { code?: number; message?: string };
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

interface SendCapable {
  send: (message: JSONRPCMessage, options?: { relatedRequestId?: string | number }) => Promise<void>;
}

export function instrumentTransport(transport: SendCapable, body: unknown, userId: string): void {
  const rpcs: RpcMessage[] = (Array.isArray(body) ? body : [body]).filter(
    (r): r is RpcMessage => !!r && typeof r === "object"
  );
  const calls = new Map<number | string, { rpc: RpcMessage; started: number }>();
  for (const r of rpcs) {
    if (r.method === "initialize") {
      logEvent("client_init", userId, {
        client: r.params?.clientInfo?.name ?? "unknown",
        version: r.params?.clientInfo?.version ?? "unknown",
      });
    }
    if (r.method === "tools/call" && r.id != null) calls.set(r.id, { rpc: r, started: Date.now() });
  }
  if (calls.size === 0) return;

  const origSend = transport.send.bind(transport);
  transport.send = async (message, options) => {
    try {
      recordResponse(message as unknown as RpcResponse, calls, userId);
    } catch {
      /* telemetry must never break the response path */
    }
    return origSend(message, options);
  };
}

function recordResponse(
  msg: RpcResponse,
  calls: Map<number | string, { rpc: RpcMessage; started: number }>,
  userId: string
): void {
  if (!msg || typeof msg !== "object" || msg.id == null) return;
  const entry = calls.get(msg.id) ?? (calls.size === 1 ? [...calls.values()][0] : undefined);
  if (!entry || (!msg.result && !msg.error)) return;
  calls.delete(msg.id);

  const isError = Boolean(msg.error || msg.result?.isError);
  const errText = msg.error?.message ?? (isError ? msg.result?.content?.[0]?.text : undefined);
  const args = entry.rpc.params?.arguments ?? {};

  const name = entry.rpc.params?.name;
  const meta: Record<string, string | number | boolean | null> = {
    // client-supplied too: a name that is not tool-shaped is not recorded
    tool: typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name) ? name : "unknown",
    ms: Date.now() - entry.started,
    error: isError,
    arg_keys: Object.keys(args).sort().join(","),
  };
  if (errText) meta.err = errorClass(String(errText));
  for (const [k, v] of Object.entries(args)) {
    if (SAFE_ARG_VALUES.get(k)?.(v)) meta[`a_${k}`] = v as string | number;
  }
  const txRows = (args as { transactions?: unknown[] }).transactions;
  if (Array.isArray(txRows)) meta.rows = txRows.length;
  // delete_all_data erased the user: an event keyed to their id would outlive them.
  logEvent("tool_call", meta.tool === "delete_all_data" ? undefined : userId, meta);
}

// High-volume telemetry types get the 90d retention. Product milestones
// (bank_imported, bulk_deleted, account_deleted) are kept forever: they are
// low-volume and feed the public lifetime counters on the landing (/api/stats).
const PRUNED_EVENT_TYPES = ["tool_call", "client_init", "logged", "summary_run", "oauth_error"];

export async function pruneOldEvents(): Promise<void> {
  await db.event
    .deleteMany({
      where: {
        type: { in: PRUNED_EVENT_TYPES },
        createdAt: { lt: new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000) },
      },
    })
    .catch(() => {});
}
