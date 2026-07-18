import { config } from "../config";

/**
 * ZenMoney Diff API v8 client, read-only: we send an empty change set and pull
 * server changes since the cursor. Docs: github.com/zenmoney/ZenPlugins/wiki.
 */

export interface ZenInstrument {
  id: number;
  shortTitle: string; // 3-letter ISO code
  rate?: number;
}

export interface ZenAccount {
  id: string; // uuid
  title: string;
  type: string; // cash | ccard | checking | loan | deposit | emoney | debt
  instrument: number | null;
  balance?: number | null;
  archive?: boolean;
}

export interface ZenTag {
  id: string;
  title: string;
  parent?: string | null;
}

export interface ZenMerchant {
  id: string;
  title: string;
}

export interface ZenTransaction {
  id: string; // uuid
  date: string; // YYYY-MM-DD
  income: number;
  outcome: number;
  incomeAccount: string | null;
  outcomeAccount: string | null;
  incomeInstrument: number | null;
  outcomeInstrument: number | null;
  opIncome?: number | null;
  opOutcome?: number | null;
  opIncomeInstrument?: number | null;
  opOutcomeInstrument?: number | null;
  tag?: string[] | null;
  merchant?: string | null;
  payee?: string | null;
  mcc?: number | null;
  comment?: string | null;
  deleted?: boolean;
  changed: number;
}

export interface ZenDeletion {
  id: string;
  object: string; // "transaction" | "account" | ...
  stamp: number;
}

export interface ZenDiffResponse {
  serverTimestamp: number;
  instrument?: ZenInstrument[];
  account?: ZenAccount[];
  tag?: ZenTag[];
  merchant?: ZenMerchant[];
  transaction?: ZenTransaction[];
  deletion?: ZenDeletion[];
}

export async function zenDiff(token: string, serverTimestamp: number): Promise<ZenDiffResponse> {
  const body = JSON.stringify({
    currentClientTimestamp: Math.floor(Date.now() / 1000),
    serverTimestamp,
    // Incremental diff only returns CHANGED entities; transactions reference
    // instruments/accounts/tags by id, so always pull reference data in full
    // (they are tiny) and keep only transactions incremental.
    forceFetch: ["instrument", "account", "tag", "merchant"],
  });
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${config.zenmoneyApiBase}/v8/diff/`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 || res.status === 403) {
        throw new ZenAuthError("ZenMoney rejected the token. Get a fresh one and reconnect with connect_zenmoney.");
      }
      if (!res.ok) {
        lastError = `ZenMoney API returned ${res.status}`;
        continue; // retry once on 5xx
      }
      return (await res.json()) as ZenDiffResponse;
    } catch (e) {
      if (e instanceof ZenAuthError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`ZenMoney API unreachable (${lastError}). Try again later.`);
}

export class ZenAuthError extends Error {}
