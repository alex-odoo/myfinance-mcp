/**
 * Per-user gate between base-currency switches and everything that prices
 * amounts in the base currency (logs, imports, edits, bank and ZenMoney
 * syncs). Writers share it; a switch takes it alone: it waits for the
 * running writers and holds new ones until it has committed, so no row is
 * ever priced in the old base after the switch (a sync that loaded the old
 * base used to keep writing it for minutes).
 *
 * In-process on purpose: one container serves all traffic, as the pending
 * sign-ins and login rate limits already assume.
 */
interface Gate {
  writers: number;
  switching: Promise<void> | null;
  drained: (() => void) | null;
}

const gates = new Map<string, Gate>();

function gateOf(userId: string): Gate {
  let gate = gates.get(userId);
  if (!gate) {
    gate = { writers: 0, switching: null, drained: null };
    gates.set(userId, gate);
  }
  return gate;
}

export async function asBaseWriter<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const gate = gateOf(userId);
  while (gate.switching) await gate.switching;
  gate.writers++;
  try {
    return await work();
  } finally {
    gate.writers--;
    if (gate.writers === 0) gate.drained?.();
  }
}

export async function asBaseSwitch<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const gate = gateOf(userId);
  while (gate.switching) await gate.switching;
  let release!: () => void;
  gate.switching = new Promise<void>((resolve) => (release = resolve));
  try {
    if (gate.writers > 0) await new Promise<void>((resolve) => (gate.drained = resolve));
    gate.drained = null;
    return await work();
  } finally {
    gate.switching = null;
    release();
  }
}
