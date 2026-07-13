import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { db, logEvent } from "./db";

/**
 * MCP tool-call telemetry for tuning the server against weaker models.
 * Hooks transport.send, so every JSON-RPC response (including SDK-level
 * validation errors) is matched to its request. Captures the SHAPE of each
 * tools/call - tool, duration, error class, which args were provided, enum
 * values - never amounts, merchants, or notes. Fire-and-forget writes.
 */

// Arg values safe to record verbatim: enums and small numerics, no user text.
const SAFE_ARG_VALUES = new Set(["category", "currency", "type", "group_by", "period", "months", "limit", "from", "to"]);
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

  const meta: Record<string, string | number | boolean | null> = {
    tool: entry.rpc.params?.name ?? "unknown",
    ms: Date.now() - entry.started,
    error: isError,
    arg_keys: Object.keys(args).sort().join(","),
  };
  if (errText) meta.err = String(errText).slice(0, 160);
  for (const [k, v] of Object.entries(args)) {
    if (SAFE_ARG_VALUES.has(k) && (typeof v === "string" || typeof v === "number")) meta[`a_${k}`] = v;
  }
  const txRows = (args as { transactions?: unknown[] }).transactions;
  if (Array.isArray(txRows)) meta.rows = txRows.length;
  logEvent("tool_call", userId, meta);
}

export async function pruneOldEvents(): Promise<void> {
  await db.event
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000) } } })
    .catch(() => {});
}
