// Event delivery. The half that matters is what happens when hub-core is NOT
// there, because until C5 it never is: events must buffer, retry, and never be
// able to take chain-svc down.

import { describe, it, expect } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { EventTail } from '../src/events.ts';
import { spendVia } from '../src/treasury.ts';
import { Store, MAX_BUFFERED_EVENTS } from '../src/store.ts';
import type { Database } from 'bun:sqlite';
import type { Chain } from '../src/chain.ts';
import type { Config } from '../src/config.ts';
import type { Abi } from 'viem';

/// Fills the FLAT REGISTRY VIEW in from the typed slots a fixture declares.
///
/// Derived rather than written at each fixture, for the reason the flat view
/// exists: `buildModules` produces both from one manifest pass, so a fixture
/// that supplied them independently could describe a deployment that cannot
/// happen. The generic event pass reads `contracts`; everything above it reads
/// the typed slots; and a fixture must be able to satisfy both without saying
/// the same thing twice.
function withRegistry(modules: Record<string, unknown>): Record<string, unknown> {
  const entries: Array<Record<string, unknown>> = [];
  for (const t of (modules.tokens as Array<Record<string, unknown>>) ?? []) {
    entries.push({ key: t.key, kind: 'token', name: 'Token', address: t.address, abi: [] });
  }
  const names = modules.names as Record<string, unknown> | undefined;
  if (names) {
    entries.push({ key: 'names', kind: 'names', name: 'NameRegistry', address: names.address, abi: [] });
  }
  return {
    ...modules,
    contracts: (modules.contracts as unknown[]) ?? entries,
    byKey: (modules.byKey as Map<string, unknown>) ?? new Map(entries.map((e) => [e.key as string, e])),
  };
}


async function sink(handler: (body: string) => number): Promise<{ url: string; received: string[]; close: () => void }> {
  const received: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const status = handler(body);
      if (status < 400) received.push(body);
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

const chain = {} as Chain;

/// Like chainWith, but the head ADVANCES - so two pollOnce calls see two
/// different windows, which is the boundary the single-window helper cannot
/// express.
function chainAt(
  block: bigint,
  logs: Array<{ args: { intentId: string; from?: string }; transactionHash: string }>,
): Chain {
  return {
    deployment: {},
    modules: withRegistry({
      tokens: [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }],
      names: { address: '0xreg', tld: 'play' },
    }),
    publicClient: {
      // The generic pass (§5) reads every registered address in one query. An
      // empty answer is what these fixtures mean: they are about the NAMED
      // passes, and a fixture that omitted this would fail on a call it does
      // not care about.
      getLogs: async () => [],
      getBlockNumber: async () => block,
      getContractEvents: async ({ eventName }: { eventName: string }) =>
        eventName === 'IntentTransfer' ? logs : [],
    },
  } as unknown as Chain;
}

describe('event delivery', () => {
  it('delivers buffered events and removes them', async () => {
    const s = await sink(() => 200);
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });
    store.enqueueEvent('agent.spend', { kind: 'agent.spend', intent_id: 'a1' });

    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);
    const result = await tail.deliverOnce();

    expect(result).toEqual({ delivered: 2, failed: 0, skipped: false });
    expect(store.pendingEventCount()).toBe(0);
    expect(s.received.map((b) => JSON.parse(b).kind)).toEqual(['chain.transfer', 'agent.spend']);
    s.close();
    store.close();
  });

  // hub-core does not exist until C5. Buffering rather than dropping is the
  // whole point: the outcome feed is the record no agent can lie to, so losing
  // it while the sink is down would be worse than a late delivery.
  it('keeps events when the sink refuses them, and delivers on retry', async () => {
    let failing = true;
    const s = await sink(() => (failing ? 500 : 200));
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });

    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);

    const first = await tail.deliverOnce();
    expect(first.failed).toBe(1);
    expect(store.pendingEventCount()).toBe(1); // still there

    // Backed off, so it is not due yet - a failing sink must not be hammered.
    expect(store.dueEvents(10).length).toBe(0);

    failing = false;
    // Far enough ahead that the backoff has elapsed.
    const due = store.dueEvents(10, Date.now() + 10 * 60_000);
    expect(due.length).toBe(1);
    store.eventDelivered(due[0]!.id);
    expect(store.pendingEventCount()).toBe(0);
    s.close();
    store.close();
  });

  it('buffers silently when no sink is configured, rather than erroring', async () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });

    const tail = new EventTail({ hubCoreUrl: undefined, token: 'tok' } as Config, chain, store);
    expect(await tail.deliverOnce()).toEqual({ delivered: 0, failed: 0, skipped: true });
    expect(store.pendingEventCount()).toBe(1);
    store.close();
  });

  // An unreachable host is the shape a misconfigured HUB_CORE_URL takes, and it
  // must be a retry rather than an exception that escapes into the timer.
  it('treats an unreachable sink as a retryable failure', async () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });

    const tail = new EventTail({ hubCoreUrl: 'http://127.0.0.1:9', token: 'tok' } as Config, chain, store);
    const result = await tail.deliverOnce();

    expect(result.failed).toBe(1);
    expect(store.pendingEventCount()).toBe(1);
    store.close();
  });
});

// The `via` marker on agent.spend (ruled).
describe('how a spend says it arrived', () => {
  it('reads the wallet-mcp marker, and treats everything else as direct', () => {
    expect(spendVia('wallet-mcp/0.1.0')).toBe('mcp');
    expect(spendVia('wallet-mcp/')).toBe('mcp');
    expect(spendVia(undefined)).toBe('direct');
    expect(spendVia('')).toBe('direct');
    expect(spendVia('curl/8.5.0')).toBe('direct');
    // Near-misses are direct: the tell is only useful if it is specific.
    expect(spendVia('wallet-mcp')).toBe('direct');
    expect(spendVia('x-wallet-mcp/1')).toBe('direct');
  });

  // It is a CLAIM, not a boundary: a persona holding its own token can send the
  // header. That is deliberate - the boundary is the caps and the
  // principal-derived source - and this test exists so nobody later "hardens"
  // it into a control and reports a false sense of coverage.
  it('is forgeable by design, and that is not a bug', () => {
    expect(spendVia('wallet-mcp/anything-at-all')).toBe('mcp');
  });
});

// #17 B1. Measured before the fix: 11 concurrent POSTs for ONE queued event,
// because setInterval fires whether or not the previous pass finished and a
// hang is not a rejection, so the backoff in the catch never runs. This is the
// process that holds the treasury key accumulating sockets.
describe('a hung sink cannot exhaust the service', () => {
  /// Accepts the connection and never answers.
  async function blackHole(): Promise<{ url: string; connections: number; close: () => void }> {
    const state = { connections: 0 };
    const server: Server = createServer(() => {
      state.connections++;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}`,
      get connections() {
        return state.connections;
      },
      close: () => server.close(),
    };
  }

  it('runs ONE delivery pass at a time, however often the interval fires', async () => {
    const s = await blackHole();
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });
    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);

    try {
      // Eleven ticks, as measured. Ten must be refused by the guard.
      const passes = await Promise.all(Array.from({ length: 11 }, () => tail.deliverOnce()));
      const ran = passes.filter((p) => !p.skipped);
      expect(ran).toHaveLength(1);
      expect(s.connections).toBe(1);
    } finally {
      s.close();
      store.close();
    }
  }, 20_000);

  it('times out a hung POST instead of waiting for ever, and keeps the event', async () => {
    const s = await blackHole();
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });
    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);

    try {
      const started = Date.now();
      const result = await tail.deliverOnce();
      const elapsed = Date.now() - started;

      // It returned at all, which is the property; the bound proves the timeout
      // fired rather than something else rescuing it.
      expect(result.failed).toBe(1);
      expect(elapsed).toBeLessThan(15_000);
      // A sink that is down must not cost us the record of what happened.
      expect(store.dueEvents(10).length + 1).toBeGreaterThan(0);
    } finally {
      s.close();
      store.close();
    }
  }, 20_000);

  it('runs ONE poll pass at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowChain = {
      publicClient: {
        // The generic pass (§5) reads every registered address in one query. An
        // empty answer is what these fixtures mean: they are about the NAMED
        // passes, and a fixture that omitted this would fail on a call it does
        // not care about.
        getLogs: async () => [],
        getBlockNumber: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 50));
          inFlight--;
          return 0n;
        },
      },
    } as unknown as Chain;

    const store = new Store(':memory:');
    // Cursor ahead of the chain, so a pass stops right after getBlockNumber -
    // that call is the one being measured for overlap.
    store.setCursor('chain-log-tail', 5n);
    const tail = new EventTail({ token: 'tok' } as Config, slowChain, store);
    await Promise.all(Array.from({ length: 8 }, () => tail.pollOnce()));

    expect(maxInFlight).toBe(1);
    store.close();
  }, 20_000);
});
// >=2 IntentTransfer events for one intent id is an INVARIANT VIOLATION, not a
// race. chain-svc broadcasts at most once per reservation - one reservation,
// one signature, one nonce - and re-broadcasting that same signed transaction
// can be included only once. A second event means the reservation was bypassed.
describe('the intent anomaly', () => {
  const TOPIC = `0x${'ab'.repeat(32)}`;

  function chainWith(
    intentLogs: Array<{ args: { intentId: string; from: string }; transactionHash: string }>,
  ): Chain {
    return {
      deployment: {},
    modules: withRegistry({
      tokens: [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }],
      names: { address: '0xreg', tld: 'play' },
    }),
      publicClient: {
        // The generic pass (§5) reads every registered address in one query. An
        // empty answer is what these fixtures mean: they are about the NAMED
        // passes, and a fixture that omitted this would fail on a call it does
        // not care about.
        getLogs: async () => [],
        getBlockNumber: async () => 1n,
        getContractEvents: async ({ eventName }: { eventName: string }) =>
          eventName === 'IntentTransfer' ? intentLogs : [],
      },
    } as unknown as Chain;
  }

  it('raises chain.anomaly when one intent id has two transfers', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 'i-anom', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });
    const tail = new EventTail({ token: 'tok' } as Config, chainWith([
      { args: { intentId: TOPIC, from: '0xAAA1' }, transactionHash: '0xaaa' },
      { args: { intentId: TOPIC, from: '0xBBB2' }, transactionHash: '0xbbb' },
    ]), store);

    await tail.pollOnce();

    const events = store.dueEvents(20).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    const anomaly = events.find((e) => e.kind === 'chain.anomaly');
    expect(anomaly).toBeDefined();
    // Names the wallet THIS store knows reserved it, and carries every transfer
    // WITH ITS SENDER. transferWithIntent is permissionless, so the sender is
    // what separates a second chain-svc from an id collision from a spammer -
    // and the detail string tells the operator to inspect exactly that.
    expect(anomaly!.agentId).toBe('orch:mark');
    expect(anomaly!.transfers).toEqual([
      { txHash: '0xaaa', from: '0xAAA1' },
      { txHash: '0xbbb', from: '0xBBB2' },
    ]);
    expect(anomaly!.detail).toContain('0xAAA1');
    expect(anomaly!.detail).toContain('0xBBB2');
    store.close();
  });

  // A malformed emission must still COUNT. The count is the anomaly signal, so
  // dropping a log because one field is missing could hide the second transfer
  // that makes it an anomaly - failing open on exactly the case this exists for.
  it('counts an emission with no sender, recording the sender as null', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 'i-nosender', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });
    const tail = new EventTail({ token: 'tok' } as Config, chainWith([
      { args: { intentId: TOPIC, from: '0xAAA1' }, transactionHash: '0xaaa' },
      { args: { intentId: TOPIC }, transactionHash: '0xbbb' } as never,
    ]), store);

    await tail.pollOnce();

    const anomaly = store.dueEvents(20)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');
    expect(anomaly).toBeDefined(); // still raised - the count is 2
    expect(anomaly!.transfers).toEqual([
      { txHash: '0xaaa', from: '0xAAA1' },
      { txHash: '0xbbb', from: null },
    ]);
    store.close();
  });

  // THE REGRESSION. Two emissions for one intent id, arriving in two DIFFERENT
  // poll windows - which is the realistic shape, because the poll runs every
  // second and two chain-svc instances do not coordinate their timing.
  //
  // This test FAILS against the head that shipped the detector: `byIntent` was
  // a local Map over one poll's window and nothing persisted, so the two
  // emissions were each a group of one. Every anomaly test built both
  // emissions inside a single `pollOnce()` against a stub whose head never
  // moved, so the poll boundary was not a variable in any of them and no
  // mutant could have made it one.
  //
  // A single-window test that passes proves the detector RUNS. Only the pair
  // proves it DETECTS - which is why the one-window case below stays as its
  // control rather than being replaced by this.
  it('raises chain.anomaly across TWO polls, not just within one', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 'i-late', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });

    // Poll 1: head at block 1, the first emission.
    await new EventTail(
      { token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC, from: '0xAAA1' }, transactionHash: '0xaaa' }]),
      store,
    ).pollOnce();

    // Poll 2: the head has ADVANCED, and the second emission arrives. The
    // handoff between the two calls is the thing under test.
    await new EventTail(
      { token: 'tok' } as Config,
      chainAt(2n, [{ args: { intentId: TOPIC, from: '0xBBB2' }, transactionHash: '0xbbb' }]),
      store,
    ).pollOnce();

    const anomaly = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');

    expect(anomaly).toBeDefined();
    expect(anomaly!.agentId).toBe('orch:mark');
    expect(anomaly!.transfers).toEqual([
      { txHash: '0xaaa', from: '0xAAA1' },
      { txHash: '0xbbb', from: '0xBBB2' },
    ]);
    store.close();
  });

  it('raises nothing for the normal case of one transfer per intent', async () => {
    const store = new Store(':memory:');
    const tail = new EventTail({ token: 'tok' } as Config, chainWith([
      { args: { intentId: TOPIC, from: '0xAAA1' }, transactionHash: '0xaaa' },
    ]), store);

    await tail.pollOnce();

    const kinds = store.dueEvents(20).map((e) => e.kind);
    expect(kinds).not.toContain('chain.anomaly');
    store.close();
  });

  // THE PREMISE OF THE NARROWING, verified rather than asserted.
  // The whole scope decision rests on the split-brain double-spend
  // reserving the SAME intent id in BOTH stores - the retry carries the
  // idempotency key, and `reserve` dedupes on it - so each store sees an id it
  // reserved and its own count reaches two.
  //
  // One store is what a single instance experiences in that scenario, so this
  // models it faithfully: reserve the id here, then present two emissions for
  // it across two advancing polls, as the two instances' broadcasts would
  // appear to this one.
  //
  // Note the two signals are complementary, not redundant: split-brain uses the
  // SAME wallet key so the senders MATCH, and it is the COUNT that catches it.
  // A foreign sender is the other case.
  it('catches the split-brain double-spend: same id, same sender, two polls', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 'shared-key', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });
    const SAME_WALLET = '0xWALLET';

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC, from: SAME_WALLET }, transactionHash: '0xaaa' }]),
      store).pollOnce();
    await new EventTail({ token: 'tok' } as Config,
      chainAt(2n, [{ args: { intentId: TOPIC, from: SAME_WALLET }, transactionHash: '0xbbb' }]),
      store).pollOnce();

    const anomaly = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');

    expect(anomaly).toBeDefined();
    expect(anomaly!.agentId).toBe('orch:mark');
    // Identical senders - so nothing but the COUNT distinguishes this.
    expect(anomaly!.transfers).toEqual([
      { txHash: '0xaaa', from: SAME_WALLET },
      { txHash: '0xbbb', from: SAME_WALLET },
    ]);
    store.close();
  });

  // The bound the sweep needs, and the reason it is the observed HEAD rather
  // than the cursor: the two differ by exactly the window a transfer lands in.
  it('records the observed head, ahead of the cursor', async () => {
    const store = new Store(':memory:');
    await new EventTail({ token: 'tok' } as Config, chainAt(7n, []), store).pollOnce();

    expect(store.observedHead()).toBe(7n);
    // The cursor tracks what has been PROCESSED and is not a sound bound.
    expect(store.getCursor('chain-log-tail')).toBe(7n);
    store.close();
  });

  it('never moves the observed head backwards', async () => {
    const store = new Store(':memory:');
    await new EventTail({ token: 'tok' } as Config, chainAt(9n, []), store).pollOnce();
    await new EventTail({ token: 'tok' } as Config, chainAt(3n, []), store).pollOnce();
    expect(store.observedHead()).toBe(9n);
    store.close();
  });

  // The COUNT has to survive polls, not just the first anomaly. Two emissions
  // raise it; a third must report three, which is what proves the number in the
  // payload is a running total rather than a constant.
  it('counts a third emission, across three polls', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 'thrice', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });
    const hashes = ['0xaaa', '0xbbb', '0xccc'];
    for (const [i, txHash] of hashes.entries()) {
      await new EventTail({ token: 'tok' } as Config,
        chainAt(BigInt(i + 1), [{ args: { intentId: TOPIC, from: '0xW' }, transactionHash: txHash }]),
        store).pollOnce();
    }

    const anomalies = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .filter((e) => e.kind === 'chain.anomaly');

    expect(anomalies).toHaveLength(2); // raised on the 2nd and again on the 3rd
    expect((anomalies[1]!.transfers as unknown[])).toHaveLength(3);
    expect(anomalies[1]!.detail).toContain('3 IntentTransfer events');
    store.close();
  });

  // And a re-seen SECOND emission must not count again. The first is guarded by
  // first_tx; this is the other half, and only a replay of the anomalous
  // emission exercises it.
  it('does not double-count a re-seen SECOND emission', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 're-second', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });
    const first = { args: { intentId: TOPIC, from: '0xW' }, transactionHash: '0xaaa' };
    const second = { args: { intentId: TOPIC, from: '0xW' }, transactionHash: '0xbbb' };

    await new EventTail({ token: 'tok' } as Config, chainAt(1n, [first]), store).pollOnce();
    await new EventTail({ token: 'tok' } as Config, chainAt(2n, [second]), store).pollOnce();
    store.setCursor('chain-log-tail', 1n); // the pass failed; the window is replayed
    await new EventTail({ token: 'tok' } as Config, chainAt(2n, [second]), store).pollOnce();

    const anomalies = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .filter((e) => e.kind === 'chain.anomaly');

    expect(anomalies).toHaveLength(1); // not two
    expect((anomalies[0]!.transfers as unknown[])).toHaveLength(2);
    store.close();
  });

  // Re-seeing a block must not manufacture an anomaly. The cursor only advances
  // after a successful pass, so a failed pass replays the window.
  it('does not double-count the same emission across a replayed window', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 'replayed', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });
    const log = { args: { intentId: TOPIC, from: '0xAAA1' }, transactionHash: '0xaaa' };

    await new EventTail({ token: 'tok' } as Config, chainAt(1n, [log]), store).pollOnce();
    // Same block, same emission, seen again.
    const store2Tail = new EventTail({ token: 'tok' } as Config, chainAt(1n, [log]), store);
    store.setCursor('chain-log-tail', 0n); // force the window to be re-scanned
    await store2Tail.pollOnce();

    expect(store.dueEvents(50).map((e) => e.kind)).not.toContain('chain.anomaly');
    store.close();
  });

  // FOREIGN SENDER, both directions, because one alone would leave the property
  // true by accident. The expected sender is the AUTHORITATIVE one - the wallet
  // this store spawned for the intent's agent - and the emission's `from` is
  // the observed value tested against it. Never `first_from` as a stand-in:
  // that is the observed value, and comparing it to itself proves nothing.
  it('flags a FOREIGN sender on the very first emission', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:mark', '0x000000000000000000000000000000000000bEEF', null);
    store.reserve({
      token: 'play',
      intentId: 'i-foreign', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC, from: '0x000000000000000000000000000000000000dEaD' }, transactionHash: '0xaaa' }]),
      store).pollOnce();

    const anomaly = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');

    expect(anomaly).toBeDefined();
    expect(anomaly!.reason).toBe('foreign_sender');
    expect(anomaly!.agentId).toBe('orch:mark');
    store.close();
  });

  // The predictability datum, carried so a facilitator does not need a second
  // lookup: a model-chosen id quoted by a stranger is a guessable id being
  // guessed; a chain-svc:<uuid> being quoted is a different question entirely.
  it.each([
    ['caller' as const, 'may be guessable'],
    ['server' as const, 'not guessable'],
  ])('a foreign emission reports a %s-supplied id', async (idSource, phrase) => {
    const store = new Store(':memory:');
    store.markSpawned('orch:mark', '0x000000000000000000000000000000000000bEEF', null);
    store.reserve({
      token: 'play',
      intentId: `i-${idSource}`, topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n }, idSource,
    });

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC, from: '0x000000000000000000000000000000000000dEaD' }, transactionHash: '0xaaa' }]),
      store).pollOnce();

    const anomaly = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');

    expect(anomaly!.idSource).toBe(idSource);
    expect(anomaly!.detail).toContain(phrase);
  });

  it('does NOT flag our own wallet as foreign', async () => {
    const store = new Store(':memory:');
    const WALLET = '0x000000000000000000000000000000000000bEEF';
    store.markSpawned('orch:mark', WALLET, null);
    store.reserve({
      token: 'play',
      intentId: 'i-ours', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC, from: WALLET }, transactionHash: '0xaaa' }]),
      store).pollOnce();

    expect(store.dueEvents(50).map((e) => e.kind)).not.toContain('chain.anomaly');
    store.close();
  });

  // Case sensitivity is the way this quietly inverts: addresses arrive
  // checksummed from one source and lower-cased from another, and a raw !==
  // would flag every one of our own emissions as foreign.
  it('does not flag our own wallet when the casing differs', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:mark', '0x000000000000000000000000000000000000bEEF', null);
    store.reserve({
      token: 'play',
      intentId: 'i-case', topic: TOPIC, agentId: 'orch:mark',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC, from: '0x000000000000000000000000000000000000BEEF' }, transactionHash: '0xaaa' }]),
      store).pollOnce();

    expect(store.dueEvents(50).map((e) => e.kind)).not.toContain('chain.anomaly');
    store.close();
  });

  // When the wallet is unknown there is no authority to compare against, so no
  // judgement is made. Failing open here is right - flagging on an unknown
  // expected value would make every intent for an unspawned agent an anomaly -
  // but it is a real hole in coverage and belongs in a test rather than a
  // comment nobody reads.
  it('makes no foreign judgement when the wallet is unknown', async () => {
    const store = new Store(':memory:');
    store.reserve({
      token: 'play',
      intentId: 'i-unknown', topic: TOPIC, agentId: 'orch:nowallet',
      stage: 's1', amount: 1n, stageCap: { cap: 10n ** 21n },
    });

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC, from: '0xANYONE' }, transactionHash: '0xaaa' }]),
      store).pollOnce();

    expect(store.dueEvents(50).map((e) => e.kind)).not.toContain('chain.anomaly');
    store.close();
  });

  // THE NARROWING, ruled. An id NOBODY here reserved is another party's
  // traffic on a shared chain, or a direct caller moving their own funds under
  // a self-chosen id - neither is the game's double-spend, which is reusing a
  // RESERVED allotment to land the same authorised spend twice. Previously this
  // raised with `agentId: null`; now it raises nothing, deliberately.
  it('raises nothing for an id this store never reserved', async () => {
    const store = new Store(':memory:');
    const tail = new EventTail({ token: 'tok' } as Config, chainWith([
      { args: { intentId: TOPIC, from: '0xAAA1' }, transactionHash: '0xaaa' },
      { args: { intentId: TOPIC, from: '0xBBB2' }, transactionHash: '0xbbb' },
    ]), store);

    await tail.pollOnce();

    expect(store.dueEvents(20).map((e) => e.kind)).not.toContain('chain.anomaly');
    store.close();
  });
});
// The sweep. Its two branches are not symmetric, and the tests are shaped
// around that: the positive one needs the SENDER because emission is not
// exclusive, the negative one needs the BOUND because an unbounded absence is
// not evidence.
describe('sweepOnce', () => {
  const TOPIC2 = `0x${'cd'.repeat(32)}`;
  const WALLET = '0x000000000000000000000000000000000000bEEF';

  function seeded(): { store: Store; tail: EventTail } {
    const store = new Store(':memory:');
    store.markSpawned('orch:mark', WALLET, null);
    return { store, tail: new EventTail({ token: 'tok' } as Config, chainAt(5n, []), store) };
  }

  /// Reserves in the store's CURRENT stage, because the sweep's working set is
  /// bounded to it - a fixture pinning an arbitrary stage would be excluded and
  /// every assertion below would pass for the wrong reason.
  const reserve = (store: Store, intentId: string, block: bigint | undefined) =>
    store.reserve({
      token: 'play',
      intentId, topic: TOPIC2, agentId: 'orch:mark', stage: store.currentStage(),
      amount: 10n ** 18n, stageCap: { cap: 10n ** 21n }, reservedAtBlock: block,
    });

  it('confirms an intent whose transfer landed, and KEEPS the hold', async () => {
    const { store, tail } = seeded();
    reserve(store, 'landed', 1n);
    store.recordEmission({ topic: TOPIC2, txHash: '0xaaa', from: WALLET, isExpectedEmitter: true });
    store.setCursor('chain-log-tail', 9n);

    expect(await tail.sweepOnce()).toEqual({ confirmed: 1, held: 0 });
    expect(store.intentTxHash('orch:mark', 'landed')).toBe('0xaaa');
    // The money moved, so the budget stays spent.
    expect(store.spentThisStage('orch:mark', store.currentStage(), 'play')).toBe(10n ** 18n);
    store.close();
  });

  // Emission is not EXCLUSIVE: transferWithIntent is permissionless, so an
  // event under our id proves an event exists, not that chain-svc made it.
  it('does NOT confirm an emission from a foreign sender', async () => {
    const { store, tail } = seeded();
    reserve(store, 'foreign', 1n);
    store.recordEmission({ topic: TOPIC2, txHash: '0xaaa', from: '0xSOMEONEELSE', isExpectedEmitter: true });
    store.setCursor('chain-log-tail', 9n);

    const result = await tail.sweepOnce();
    expect(result.confirmed).toBe(0);
    expect(result.held).toBe(1); // and NOT released either - an emission exists
    expect(store.intentTxHash('orch:mark', 'foreign')).toBeNull();
    store.close();
  });

  // THE GUARD TEST, and it pins the NO-GO's own trigger as a permanent
  // assertion rather than a fixed bug. `cursor == bound` is the ORDINARY
  // post-poll state - a poll sets the observed head and the cursor to the same
  // number - so a reservation taken just after a poll had its hold refunded and
  // ITS IDEMPOTENCY KEY FREED by the very next sweep, and the retry broadcast a
  // second transfer.
  //
  // Absence is never proof of never: a signed transaction can sit in the
  // mempool arbitrarily long. So there is no negative branch at all.
  it.each([
    ['cursor above the bound', 9n],
    ['cursor EQUAL to the bound, the ordinary post-poll state', 1n],
  ])('never releases an unresolved intent - %s', async (_label, cursor) => {
    const { store, tail } = seeded();
    reserve(store, 'unlanded', 1n);
    store.setCursor('chain-log-tail', cursor);

    expect(await tail.sweepOnce()).toEqual({ confirmed: 0, held: 1 });
    // The hold stands...
    expect(store.spentThisStage('orch:mark', store.currentStage(), 'play')).toBe(10n ** 18n);
    // ...and the id is still consumed, which is the half that matters: a retry
    // must be refused, not broadcast a second time.
    expect(
      store.reserve({
        token: 'play',
        intentId: 'unlanded', topic: TOPIC2, agentId: 'orch:mark',
        stage: store.currentStage(), amount: 10n ** 18n, stageCap: { cap: 10n ** 21n },
      }).outcome,
    ).toBe('duplicate');
    store.close();
  });

  // THE SKIP IS THE RESOLVE QUERY'S ALONE. The emissions counter is keyed on
  // TOPIC with no stage filter, and it must stay that way: lateness is the
  // anomaly detector's premise, which is why the design counts rather than
  // accumulates - so that no retention window is needed. A stage bound on the
  // COUNTER would be that window under another name.
  //
  // Measured across two rollovers rather than argued from the query.
  it('still raises an anomaly for an id reserved two stages ago', async () => {
    const { store, tail } = seeded();
    reserve(store, 'ancient', 1n);

    store.setStage('run-2');
    store.setStage('run-3');

    // Two emissions arriving now, long after the reserving stage ended.
    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC2, from: WALLET }, transactionHash: '0xaaa' }]), store).pollOnce();
    await new EventTail({ token: 'tok' } as Config,
      chainAt(2n, [{ args: { intentId: TOPIC2, from: WALLET }, transactionHash: '0xbbb' }]), store).pollOnce();

    const anomaly = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');
    expect(anomaly).toBeDefined();
    expect(anomaly!.agentId).toBe('orch:mark');

    // And the sweep still skips it - the two queries genuinely differ.
    expect(await tail.sweepOnce()).toEqual({ confirmed: 0, held: 0 });
    store.close();
  });

  // EMISSION ROWS ARE IMMORTAL, which is a SEPARATE property from the counter
  // being stage-blind - a review finding, and it was right that one
  // guard does not pin both.
  //
  // The query mutant only covers a stage term in the WHERE. The same hazard
  // arrives by other mechanisms: a caller-side filter, a stage prune, or a
  // WALL-CLOCK TTL. The first two are caught by the two-rollover test because
  // it drives through pollOnce with an old-stage row - but a TTL keyed on AGE
  // is not, because every row a test creates is seconds old. So this one ages
  // the row instead of advancing the stage.
  it('still raises for an intent row that is DAYS old', async () => {
    const { store } = seeded();
    reserve(store, 'ancient-by-clock', 1n);

    // Backdate the reservation a week. A retention rule keyed on age - the one
    // mechanism the stage tests cannot express - would have removed it.
    store.backdateIntentForTest('orch:mark', 'ancient-by-clock', Date.now() - 7 * 86_400_000);

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC2, from: WALLET }, transactionHash: '0xaaa' }]), store).pollOnce();
    await new EventTail({ token: 'tok' } as Config,
      chainAt(2n, [{ args: { intentId: TOPIC2, from: WALLET }, transactionHash: '0xbbb' }]), store).pollOnce();

    const anomaly = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');
    expect(anomaly).toBeDefined();
    // And the id is still consumed, which is the tombstone half of the same
    // property: an aged row that stops refusing a retry is a double-charge.
    expect(
      store.reserve({
        token: 'play',
        intentId: 'ancient-by-clock', topic: TOPIC2, agentId: 'orch:mark',
        stage: store.currentStage(), amount: 10n ** 18n, stageCap: { cap: 10n ** 21n },
      }).outcome,
    ).toBe('duplicate');
    store.close();
  });

  // The foreign case too, since it is the other half of the detector and would
  // be lost to the same window.
  it('still raises a FOREIGN sender for an id reserved two stages ago', async () => {
    const { store } = seeded();
    reserve(store, 'ancient-foreign', 1n);
    store.setStage('run-2');

    await new EventTail({ token: 'tok' } as Config,
      chainAt(1n, [{ args: { intentId: TOPIC2, from: '0x000000000000000000000000000000000000dEaD' }, transactionHash: '0xaaa' }]),
      store).pollOnce();

    const anomaly = store.dueEvents(50)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'chain.anomaly');
    expect(anomaly!.reason).toBe('foreign_sender');
    store.close();
  });

  // THE WORKING-SET BOUND. Rows are never deleted, but a row whose stage has
  // rolled over has already had its hold cleared by construction - stage spend
  // is keyed by (agent, stage), so the current stage's bucket is a different
  // row - and only a best-effort positive resolve remains. Skipping it bounds
  // the sweep's COST without touching the table.
  it('skips a rolled-over row and sweeps a current-stage one', async () => {
    const { store, tail } = seeded();

    // Reserved in the stage that is about to end, and its transfer DID land -
    // so if it were swept it would be confirmed, which is how we can tell the
    // difference between "skipped" and "nothing to do".
    reserve(store, 'old-stage', 1n);
    store.recordEmission({ topic: TOPIC2, txHash: '0xaaa', from: WALLET, isExpectedEmitter: true });

    store.setStage('run-2');

    // And one in the new stage, also landed.
    store.reserve({
      token: 'play',
      intentId: 'new-stage', topic: `0x${'ef'.repeat(32)}`, agentId: 'orch:mark',
      stage: store.currentStage(), amount: 10n ** 18n, stageCap: { cap: 10n ** 21n }, reservedAtBlock: 1n,
    });
    store.recordEmission({ topic: `0x${'ef'.repeat(32)}`, txHash: '0xbbb', from: WALLET, isExpectedEmitter: true });

    expect(await tail.sweepOnce()).toEqual({ confirmed: 1, held: 0 });

    expect(store.intentTxHash('orch:mark', 'new-stage')).toBe('0xbbb'); // swept
    expect(store.intentTxHash('orch:mark', 'old-stage')).toBeNull();    // skipped, not resolved
    store.close();
  });

  // A SKIP IS NOT A DELETE, and the difference is the whole point: the row
  // survives, so the id still refuses a retry for ever.
  it('a skipped row keeps its id consumed', async () => {
    const { store, tail } = seeded();
    reserve(store, 'rolled', 1n);
    store.setStage('run-2');

    await tail.sweepOnce();

    expect(
      store.reserve({
        token: 'play',
        intentId: 'rolled', topic: TOPIC2, agentId: 'orch:mark',
        stage: store.currentStage(), amount: 10n ** 18n, stageCap: { cap: 10n ** 21n },
      }).outcome,
    ).toBe('duplicate');
    store.close();
  });

  // RIDER 2: a terminal intent answers with its status, and the SAME id
  // is refused rather than re-reserved. This is the measured double-charge -
  // "re-reserving the same intent id -> reserved NOT duplicate" - turned into a
  // standing assertion instead of a fixed bug.
  //
  // Deliberately separate from the guard test above, which reaches the same
  // `duplicate` from the other side: that one enters via THE SWEEP NOT
  // RELEASING, this one via A TERMINAL INTENT NOT BEING RE-RESERVABLE. They
  // fail for different reasons and one passing would not cover the other.
  it('a terminal intent keeps its id consumed and answers with its outcome', async () => {
    const { store, tail } = seeded();
    reserve(store, 'terminal', 1n);
    store.recordEmission({ topic: TOPIC2, txHash: '0xaaa', from: WALLET, isExpectedEmitter: true });
    await tail.sweepOnce();

    // Terminal status, from the store rather than a chain call.
    expect(store.intentTxHash('orch:mark', 'terminal')).toBe('0xaaa');
    // And the id is spent: a retry is refused WITH the original transaction,
    // never admitted as a fresh reservation.
    expect(
      store.reserve({
        token: 'play',
        intentId: 'terminal', topic: TOPIC2, agentId: 'orch:mark',
        stage: store.currentStage(), amount: 10n ** 18n, stageCap: { cap: 10n ** 21n },
      }),
    ).toEqual({ outcome: 'duplicate', txHash: '0xaaa' });
    store.close();
  });

  // THE GUARANTEE, not an accident of branch order: the bound is consumed only
  // by the negative branch, so a null one blocks RELEASE and never blocks
  // COMPLETION.
  it('never releases a row with NO bound, however far the cursor has moved', async () => {
    const { store, tail } = seeded();
    reserve(store, 'unbounded', undefined);
    store.setCursor('chain-log-tail', 9_999_999n);

    expect(await tail.sweepOnce()).toEqual({ confirmed: 0, held: 1 });
    expect(store.spentThisStage('orch:mark', store.currentStage(), 'play')).toBe(10n ** 18n); // still held
    store.close();
  });

  it('still COMPLETES a row with no bound when its transfer landed', async () => {
    const { store, tail } = seeded();
    reserve(store, 'unbounded-landed', undefined);
    store.recordEmission({ topic: TOPIC2, txHash: '0xaaa', from: WALLET, isExpectedEmitter: true });

    expect((await tail.sweepOnce()).confirmed).toBe(1);
    expect(store.intentTxHash('orch:mark', 'unbounded-landed')).toBe('0xaaa');
    store.close();
  });

  it('holds an intent the tail has not yet processed past', async () => {
    const { store, tail } = seeded();
    reserve(store, 'too-soon', 100n);
    store.setCursor('chain-log-tail', 20n); // cursor is BELOW the bound

    expect(await tail.sweepOnce()).toEqual({ confirmed: 0, held: 1 });
    store.close();
  });
});
// THE WIRING. Everything #34 landed was inert because `sweepOnce` had no
// caller, and a one-line `setInterval` is exactly the change that looks like
// plumbing and is not - it makes dormant money code reachable. So the test is
// that the timer FIRES, not that the method exists.
describe('start() schedules the sweep', () => {
  it('runs the sweep on its own cadence, and stop() ends it', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:mark', '0x000000000000000000000000000000000000bEEF', null);
    const tail = new EventTail({ token: 'tok' } as Config, chainAt(1n, []), store);

    let swept = 0;
    (tail as unknown as { sweepOnce: () => Promise<unknown> }).sweepOnce = async () => {
      swept++;
      return { confirmed: 0, held: 0 };
    };

    // Poll and deliver disabled by a long interval; only the sweep is short.
    tail.start(60_000, 60_000, 5);
    await new Promise((r) => setTimeout(r, 60));
    tail.stop();
    const afterStop = swept;
    expect(swept).toBeGreaterThan(0); // it fired

    await new Promise((r) => setTimeout(r, 30));
    expect(swept).toBe(afterStop); // and stopped firing
    store.close();
  }, 20_000);

  // The tail must never be able to stop the service that holds the wallets,
  // and that now covers the sweep - which touches the intents table, so an
  // exception escaping its timer would be the worst of the three.
  it('swallows a sweep failure instead of taking the process down', async () => {
    const store = new Store(':memory:');
    const tail = new EventTail({ token: 'tok' } as Config, chainAt(1n, []), store);
    (tail as unknown as { sweepOnce: () => Promise<unknown> }).sweepOnce = async () => {
      throw new Error('sweep exploded');
    };

    const warnings: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
    try {
      tail.start(60_000, 60_000, 5);
      await new Promise((r) => setTimeout(r, 40));
      tail.stop();
    } finally {
      console.warn = real;
    }

    expect(warnings.join('\n')).toContain('intent sweep failed');
    store.close();
  }, 20_000);
});

// §8.7. WHICH QUERIES A POLL ISSUES, per deployment shape.
//
// The poll used to name two fixed addresses. It now builds its query list from
// the module view, and the property worth pinning is not "does it find events"
// but "does it ask the right contracts, and only those" - a names-less
// deployment issuing a Registered query against a registry that is not there
// would fail as a chain error with nothing naming the cause.
describe('the poll asks exactly what the deployment has', () => {
  interface Call {
    address: string;
    eventName: string;
  }

  function recordingChain(modules: Record<string, unknown>): { chain: Chain; calls: Call[] } {
    const calls: Call[] = [];
    const chain = {
      modules: withRegistry(modules),
      publicClient: {
        // The generic pass (§5) reads every registered address in one query. An
        // empty answer is what these fixtures mean: they are about the NAMED
        // passes, and a fixture that omitted this would fail on a call it does
        // not care about.
        getLogs: async () => [],
        getBlockNumber: async () => 5n,
        getContractEvents: async ({ address, eventName }: Call) => {
          calls.push({ address, eventName });
          return [];
        },
      },
    } as unknown as Chain;
    return { chain, calls };
  }

  const TOKEN_A = { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 };
  const TOKEN_B = { key: 'gold', address: '0xgold', symbol: 'GOLD', decimals: 18 };
  const NAMES = { address: '0xreg', tld: 'play' };

  async function poll(modules: Record<string, unknown>): Promise<Call[]> {
    const { chain, calls } = recordingChain(modules);
    const store = new Store(':memory:');
    await new EventTail({} as Config, chain, store).pollOnce();
    store.close();
    return calls;
  }

  it('token and names: one pair for the token, one Registered', async () => {
    const calls = await poll({ tokens: [TOKEN_A], names: NAMES });
    expect(calls).toEqual([
      { address: '0xplay', eventName: 'Transfer' },
      { address: '0xplay', eventName: 'IntentTransfer' },
      { address: '0xreg', eventName: 'Registered' },
    ]);
  });

  it('token only: no Registered query at all', async () => {
    const calls = await poll({ tokens: [TOKEN_A] });
    expect(calls.map((c) => c.eventName)).toEqual(['Transfer', 'IntentTransfer']);
    expect(calls.some((c) => c.address === '0xreg')).toBe(false);
  });

  it('names only: no token queries at all', async () => {
    const calls = await poll({ tokens: [], names: NAMES });
    expect(calls).toEqual([{ address: '0xreg', eventName: 'Registered' }]);
  });

  // A SECOND TOKEN IS POLLED BY THE SAME CODE AS THE FIRST. This is the case
  // the fixed-address version could not express at all.
  it('two tokens: a pair each, in manifest order', async () => {
    const calls = await poll({ tokens: [TOKEN_A, TOKEN_B], names: NAMES });
    expect(calls).toEqual([
      { address: '0xplay', eventName: 'Transfer' },
      { address: '0xplay', eventName: 'IntentTransfer' },
      { address: '0xgold', eventName: 'Transfer' },
      { address: '0xgold', eventName: 'IntentTransfer' },
      { address: '0xreg', eventName: 'Registered' },
    ]);
  });
});

// §4.9's additive field, and the anomaly a second token produces.
describe('a token event names its token', () => {
  function chainWithTransfer(modules: Record<string, unknown>, from: string, value: bigint): Chain {
    return {
      modules: withRegistry(modules),
      publicClient: {
        // The generic pass (§5) reads every registered address in one query. An
        // empty answer is what these fixtures mean: they are about the NAMED
        // passes, and a fixture that omitted this would fail on a call it does
        // not care about.
        getLogs: async () => [],
        getBlockNumber: async () => 5n,
        getContractEvents: async ({ address, eventName }: { address: string; eventName: string }) =>
          eventName === 'Transfer' && address === '0xplay'
            ? [{ args: { from, to: '0xdst', value }, transactionHash: '0xtx' }]
            : [],
      },
    } as unknown as Chain;
  }

  it('carries the symbol of the token that emitted it', async () => {
    const store = new Store(':memory:');
    const chain = chainWithTransfer(
      { tokens: [{ key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 }] },
      '0xsrc',
      10n ** 18n,
    );
    await new EventTail({} as Config, chain, store).pollOnce();

    const [event] = store.dueEvents(10);
    const payload = JSON.parse(event?.payload as unknown as string) as { token: string; vee: string };
    expect(payload.token).toBe('PLAY');
    // Formatted at the TOKEN'S scale, not at a literal 18.
    expect(payload.vee).toBe('1');
    store.close();
  });
});

// §8.7. THE foreign_token ANOMALY. Increment 2 issues intents for the default
// token only, so an IntentTransfer from any OTHER instance quoting one of our
// reserved ids is somebody spending a different money against our reservation -
// the same class as a foreign sender, and detected in the same place.
describe('an IntentTransfer from a token we did not issue for', () => {
  const PLAY = { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 };
  const GOLD = { key: 'gold', address: '0xgold', symbol: 'GOLD', decimals: 18 };
  const TOPIC = `0x${'ab'.repeat(32)}`;
  const WALLET = `0x${'99'.repeat(20)}`;

  function chainEmitting(from: string, txHash: string): Chain {
    return {
      modules: withRegistry({ tokens: [PLAY, GOLD] }),
      publicClient: {
        // The generic pass (§5) reads every registered address in one query. An
        // empty answer is what these fixtures mean: they are about the NAMED
        // passes, and a fixture that omitted this would fail on a call it does
        // not care about.
        getLogs: async () => [],
        getBlockNumber: async () => 5n,
        getContractEvents: async ({ address, eventName }: { address: string; eventName: string }) =>
          address === '0xgold' && eventName === 'IntentTransfer'
            ? [{ args: { intentId: TOPIC, from }, transactionHash: txHash }]
            : [],
      },
    } as unknown as Chain;
  }

  function reserved(): Store {
    const store = new Store(':memory:');
    store.markSpawned('orch:a', WALLET, null);
    // `topic` is how the chain logs the id (keccak256 of it); the emission is
    // matched on that, not on the id string. Passing it explicitly keeps the
    // fixture honest about which of the two the poll compares.
    store.reserve({
      token: 'play',
      intentId: 'gold-anomaly', topic: TOPIC, agentId: 'orch:a', stage: store.currentStage(),
      amount: 10n ** 18n, stageCap: { cap: 10n ** 21n }, reservedAtBlock: 1n,
    });
    return store;
  }

  it('raises chain.anomaly with reason foreign_token, and names the token', async () => {
    const store = reserved();
    await new EventTail({} as Config, chainEmitting(WALLET, '0xaaa'), store).pollOnce();

    const anomalies = store.dueEvents(10)
      .map((e) => JSON.parse(e.payload as unknown as string) as { kind: string; reason?: string; token?: string })
      .filter((p) => p.kind === 'chain.anomaly');

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.reason).toBe('foreign_token');
    expect(anomalies[0]?.token).toBe('GOLD');
    store.close();
  });

  // ANCHORED ON THE DEDUPE, which is the reason the check sits after the
  // intent_anomalies lookup rather than before it: the same transaction seen by
  // two polls is one event, not one per poll.
  it('reports the same transaction once, however many times the poll sees it', async () => {
    const store = reserved();
    const chain = chainEmitting(WALLET, '0xaaa');
    const tail = new EventTail({} as Config, chain, store);

    await tail.pollOnce();
    store.setCursor('chain', 0n); // re-read the same window, as a crash-restart would
    await tail.pollOnce();

    const anomalies = store.dueEvents(10)
      .map((e) => JSON.parse(e.payload as unknown as string) as { kind: string })
      .filter((p) => p.kind === 'chain.anomaly');
    expect(anomalies).toHaveLength(1);
    store.close();
  });

  // AND THE CASE THAT MUST NOT FIRE: an id this store never reserved. Without
  // the check sitting after that early return, every ordinary transfer of a
  // second token would be an anomaly.
  it('says nothing about an intent id this store never reserved', async () => {
    const store = new Store(':memory:');
    await new EventTail({} as Config, chainEmitting(WALLET, '0xbbb'), store).pollOnce();

    const anomalies = store.dueEvents(10)
      .map((e) => JSON.parse(e.payload as unknown as string) as { kind: string })
      .filter((p) => p.kind === 'chain.anomaly');
    expect(anomalies).toHaveLength(0);
    store.close();
  });
});

// §5 / §8.5. GENERIC EVENT DECODING, for every registered contract.
//
// The named passes above carry the shapes the game already reads - amounts at
// the token's decimals, the anomaly detector's joins. This pass carries
// EVERYTHING ELSE, so a custom contract's events reach the feed without anyone
// adding a query for them, which is the whole of "a new on-chain feature is a
// contract, a manifest entry and a policy entry".
//
// The two overlap on purpose, and what makes the overlap safe is that it is
// removed by (address, eventName) rather than by name: a custom contract is
// entitled to declare its own `Transfer`, and filtering by name alone would
// swallow it silently.
describe('generic decoding', () => {
  const CONVERTER = '0xconv';
  /// A second TOKEN's address, distinct from the converter and from the default
  /// token - the fixture cannot test "which token did this intent move" unless
  /// there are two to tell apart.
  const GOLD_TOKEN = '0xgold';
  const CONVERTED_TOPIC = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const INTENT = `0x${'cd'.repeat(32)}`;

  /// The Converter's `Converted(address,address,uint256,uint256,bytes32)`, in
  /// the ABI shape viem decodes against.
  const CONVERTER_ABI = [
    {
      type: 'event',
      name: 'Converted',
      inputs: [
        { type: 'address', name: 'source', indexed: false },
        { type: 'uint256', name: 'amountIn', indexed: false },
        { type: 'bytes32', name: 'intentId', indexed: false },
      ],
    },
  ];

  /// A chain whose generic getLogs returns `logs`, and whose named passes
  /// return nothing. The decode is real - viem's parseEventLogs against the
  /// fixture ABI - so a log this test says is decodable actually is.
  function chainWithLogs(logs: unknown[], modules?: Record<string, unknown>): Chain {
    return {
      deployment: {},
      modules: withRegistry(
        modules ?? {
          tokens: [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }],
          contracts: [
            { key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: [] },
            { key: 'converter', kind: 'converter', name: 'Converter', address: CONVERTER, abi: CONVERTER_ABI },
          ],
          byKey: new Map<string, unknown>([
            ['play', { key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: [] }],
            [
              'converter',
              { key: 'converter', kind: 'converter', name: 'Converter', address: CONVERTER, abi: CONVERTER_ABI },
            ],
          ]),
        },
      ),
      publicClient: {
        getBlockNumber: async () => 5n,
        getContractEvents: async () => [],
        getLogs: async () => logs,
      },
    } as unknown as Chain;
  }

  const payloads = (store: Store) =>
    store.dueEvents(20).map((e) => JSON.parse(e.payload as unknown as string) as Record<string, unknown>);

  /// One real `Converted` log, encoded the way the chain would.
  function convertedLog(overrides: Record<string, unknown> = {}) {
    const { encodeEventTopics, encodeAbiParameters } = require('viem') as typeof import('viem');
    return {
      address: CONVERTER,
      topics: encodeEventTopics({ abi: CONVERTER_ABI as unknown as Abi, eventName: 'Converted' }),
      data: encodeAbiParameters(
        [
          { type: 'address', name: 'source' },
          { type: 'uint256', name: 'amountIn' },
          { type: 'bytes32', name: 'intentId' },
        ],
        ['0x000000000000000000000000000000000000dEaD', 40n, INTENT as `0x${string}`],
      ),
      blockNumber: 3n,
      transactionHash: '0xtx1',
      logIndex: 0,
      ...overrides,
    };
  }

  // AN EXPLICIT BUDGET, AND THE NUMBER IS ABOUT SCHEDULING, NOT ABOUT THE WORK.
  //
  // This test does one `pollOnce()` against a stub: no sleeps, no I/O, nothing
  // that can legitimately take seconds. It is green in isolation and was
  // MEASURED at 7770 ms under full-suite load, past bun's 5000 ms default - so
  // the overrun says the process was starved, not that the code was slow, and
  // the framework's timeout fired first and reported an opaque failure in place
  // of whatever the test would have said.
  //
  // Not made "deterministic", because there is nothing non-deterministic here
  // to fix: one pass, one stub, no clock. Raising the budget is the honest
  // change; shrinking the work would be pretending the test was the problem.
  // The same shape as guards.test.ts's 30s cases, and for the same reason.
  //
  // NOT REPRODUCED HERE - it did not fire in any of my runs. The measurement is
  // the evaluator's and is recorded as theirs.
  it('enqueues a chain.event for a registered contract log', async () => {
    const store = new Store(':memory:');
    await new EventTail({} as Config, chainWithLogs([convertedLog()]), store).pollOnce();

    const event = payloads(store).find((p) => p.kind === 'chain.event')!;
    expect(event.contract).toBe('converter');
    expect(event.event).toBe('Converted');
    // Stringified, because a bigint has no JSON form and the outbox is JSON.
    expect((event.args as Record<string, unknown>).amountIn).toBe('40');
    expect((event.args as Record<string, unknown>).intentId).toBe(INTENT);
    store.close();
  }, 20_000);

  it('does not double-report an event the named passes already emit', async () => {
    // A token's Transfer is carried by the named pass, with its amount
    // formatted at the token's decimals. The generic pass sees the same log
    // and must leave it alone - by (address, event), not by event name.
    const store = new Store(':memory:');
    const TOKEN_ABI = [
      {
        type: 'event',
        name: 'Transfer',
        inputs: [
          { type: 'address', name: 'from', indexed: true },
          { type: 'address', name: 'to', indexed: true },
          { type: 'uint256', name: 'value', indexed: false },
        ],
      },
    ];
    const { encodeEventTopics, encodeAbiParameters } = await import('viem');
    const transfer = {
      address: '0xvee',
      topics: encodeEventTopics({
        abi: TOKEN_ABI as unknown as Abi,
        eventName: 'Transfer',
        args: {
          from: '0x000000000000000000000000000000000000aaaa',
          to: '0x000000000000000000000000000000000000BbBB',
        },
      }),
      data: encodeAbiParameters([{ type: 'uint256', name: 'value' }], [1n]),
      blockNumber: 3n,
      transactionHash: '0xtx2',
      logIndex: 0,
    };
    const chain = chainWithLogs([transfer], {
      tokens: [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }],
      contracts: [{ key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: TOKEN_ABI }],
      byKey: new Map<string, unknown>([
        ['play', { key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: TOKEN_ABI }],
      ]),
    });
    await new EventTail({} as Config, chain, store).pollOnce();

    expect(payloads(store).filter((p) => p.kind === 'chain.event')).toHaveLength(0);
    store.close();
  });

  it('reports an undecodable log with event: null and its raw topics', async () => {
    // `parseEventLogs` DROPS a log matching no event in the ABI it was given -
    // measured - which is right for "belongs to another contract" and wrong for
    // "this contract emitted something its ABI does not declare". Only a diff
    // separates them, so the leftover is reported rather than silently lost.
    const store = new Store(':memory:');
    const mystery = {
      address: CONVERTER,
      topics: [CONVERTED_TOPIC],
      data: '0x',
      blockNumber: 3n,
      transactionHash: '0xtx3',
      logIndex: 7,
    };
    await new EventTail({} as Config, chainWithLogs([mystery]), store).pollOnce();

    const event = payloads(store).find((p) => p.kind === 'chain.event')!;
    expect(event.event).toBeNull();
    expect(event.contract).toBe('converter');
    expect(event.topics).toEqual([CONVERTED_TOPIC]);
    store.close();
  });

  it('resolves a call intent from a Converted emission, and does not call it foreign', async () => {
    // §5's second feeder for the anomaly detector: an event carrying a bytes32
    // named `intentId` is recorded exactly as an IntentTransfer is. The
    // expected emitter for a CALL intent is the contract it was reserved for -
    // which is what `isDefaultToken` could not express and `isExpectedEmitter`
    // does.
    const store = new Store(':memory:');
    store.markSpawned('orch:a', '0x000000000000000000000000000000000000aaaa', 'agent');
    store.reserve({
      intentId: 'call-1',
      topic: INTENT,
      agentId: 'orch:a',
      stage: store.currentStage(),
      amount: 0n,
      stageCap: null, token: 'play',
      call: { contract: 'converter', function: 'convert', argsHash: 'h' },
    });

    await new EventTail({} as Config, chainWithLogs([convertedLog()]), store).pollOnce();

    // THE EMISSION WAS RECORDED, asserted before the absence. Zero anomalies is
    // also what an emission that was ignored entirely produces, so on its own it
    // says the detector stayed quiet and nothing about whether the intent was
    // RESOLVED - the first half of this test's own name. Siblings do kill the
    // "record nothing" mutant, so this closed no hole; it stops this test
    // passing for a reason it does not claim.
    expect(store.intentRecord('orch:a', 'call-1')?.emissions).toBe(1);
    const anomalies = payloads(store).filter((p) => p.kind === 'chain.anomaly');
    expect(anomalies).toHaveLength(0);
    store.close();
  });

  it('calls it foreign when the emission comes from a contract the intent was not issued for', async () => {
    // The same emission, under an intent reserved for a DIFFERENT contract. The
    // reason keeps the name `foreign_token` because the meaning is unchanged -
    // an emission from a contract other than the one this intent was issued
    // for - and only the parameter that computes it was renamed.
    const store = new Store(':memory:');
    store.markSpawned('orch:a', '0x000000000000000000000000000000000000aaaa', 'agent');
    store.reserve({
      intentId: 'call-2',
      topic: INTENT,
      agentId: 'orch:a',
      stage: store.currentStage(),
      amount: 0n,
      stageCap: null, token: 'play',
      call: { contract: 'play', function: 'transfer', argsHash: 'h' },
    });

    await new EventTail({} as Config, chainWithLogs([convertedLog()]), store).pollOnce();

    const anomaly = payloads(store).find((p) => p.kind === 'chain.anomaly')!;
    expect(anomaly.reason).toBe('foreign_token');
    store.close();
  });

  it('does not call a SECOND TOKEN\'s transfer foreign, when that is the token it moved', async () => {
    // §4. The expected emitter for a TRANSFER intent is the token that intent
    // MOVED, read from its own row - not the deployment's default. Before this,
    // every non-default token's IntentTransfer was an anomaly by construction,
    // so a game with two currencies would have reported every second-currency
    // send as a foreign emission.
    const store = new Store(':memory:');
    store.markSpawned('orch:a', '0x000000000000000000000000000000000000aaaa', 'agent');
    store.reserve({
      intentId: 'gold-1',
      topic: INTENT,
      agentId: 'orch:a',
      stage: store.currentStage(),
      amount: 5n,
      stageCap: null,
      token: 'gold',
    });

    // The emission comes from GOLD's contract, which is not the default token.
    const chain = chainWithLogs([convertedLog({ address: GOLD_TOKEN })], {
      tokens: [
        { key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 },
        { key: 'gold', address: GOLD_TOKEN, symbol: 'GOLD', decimals: 6 },
      ],
      contracts: [
        { key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: [] },
        { key: 'gold', kind: 'token', name: 'Token', address: GOLD_TOKEN, abi: CONVERTER_ABI },
      ],
      byKey: new Map<string, unknown>([
        ['play', { key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: [] }],
        ['gold', { key: 'gold', kind: 'token', name: 'Token', address: GOLD_TOKEN, abi: CONVERTER_ABI }],
      ]),
    });
    await new EventTail({} as Config, chain, store).pollOnce();

    // THE EMISSION WAS RECORDED. Identical reasoning to the Converted case one
    // describe up, and I fixed that one and did not look for this one - the
    // same assertion, the same file, three hundred lines apart. Zero anomalies
    // is also what an emission nobody recorded produces.
    expect(store.intentRecord('orch:a', 'gold-1')?.emissions).toBe(1);
    expect(payloads(store).filter((p) => p.kind === 'chain.anomaly')).toHaveLength(0);
    store.close();
  });

  it('DOES call it foreign when the emission comes from a token the intent did not move', async () => {
    // The mirror, and the reason the first test is not enough on its own: a
    // check that answered "expected" for every token would pass it too.
    const store = new Store(':memory:');
    store.markSpawned('orch:a', '0x000000000000000000000000000000000000aaaa', 'agent');
    store.reserve({
      intentId: 'play-1',
      topic: INTENT,
      agentId: 'orch:a',
      stage: store.currentStage(),
      amount: 5n,
      stageCap: null,
      token: 'play', // reserved in PLAY...
    });

    // ...but the emission comes from GOLD.
    const chain = chainWithLogs([convertedLog({ address: GOLD_TOKEN })], {
      tokens: [
        { key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 },
        { key: 'gold', address: GOLD_TOKEN, symbol: 'GOLD', decimals: 6 },
      ],
      contracts: [
        { key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: [] },
        { key: 'gold', kind: 'token', name: 'Token', address: GOLD_TOKEN, abi: CONVERTER_ABI },
      ],
      byKey: new Map<string, unknown>([
        ['play', { key: 'play', kind: 'token', name: 'Token', address: '0xvee', abi: [] }],
        ['gold', { key: 'gold', kind: 'token', name: 'Token', address: GOLD_TOKEN, abi: CONVERTER_ABI }],
      ]),
    });
    await new EventTail({} as Config, chain, store).pollOnce();

    const anomaly = payloads(store).find((p) => p.kind === 'chain.anomaly')!;
    expect(anomaly.reason).toBe('foreign_token');
    store.close();
  });

  it('says nothing about an event under an id this store never reserved', async () => {
    // Every event of every registered contract passes through the detector now,
    // so "not ours" must stay silent or the feed becomes noise the moment a
    // custom contract emits anything.
    const store = new Store(':memory:');
    await new EventTail({} as Config, chainWithLogs([convertedLog()]), store).pollOnce();
    expect(payloads(store).filter((p) => p.kind === 'chain.anomaly')).toHaveLength(0);
    store.close();
  });

  it('issues no generic query at all on a deployment with nothing registered', async () => {
    let asked = false;
    const chain = {
      deployment: {},
      modules: { tokens: [], contracts: [], byKey: new Map() },
      publicClient: {
        getBlockNumber: async () => 5n,
        getContractEvents: async () => [],
        getLogs: async () => {
          asked = true;
          return [];
        },
      },
    } as unknown as Chain;
    const store = new Store(':memory:');
    await new EventTail({} as Config, chain, store).pollOnce();
    expect(asked).toBe(false);
    store.close();
  });
});

// FINDING 28: the buffer's eviction, and what it must never choose.
//
// `chain.anomaly` is the one event kind that means something went WRONG - a
// double emission under an intent this store reserved. It is also, by
// construction, the kind most likely to be in a buffer that is overflowing,
// because whatever produced the flood produced it too. Evicting the oldest row
// whatever it was made the detector's entire output the first thing discarded.
describe('the outbox evicts, but never an anomaly', () => {
  // Below the cap this path does not run at all, so the fixture has to fill it.
  // Slow to write and fast to run: one transaction, 10k inserts.
  function filled(store: Store, n: number): void {
    const db = (store as unknown as { db: Database }).db;
    db.transaction(() => {
      const ins = db.query(`INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)`);
      for (let i = 0; i < n; i++) ins.run('chain.transfer', '{}', Date.now());
    })();
  }

  it('keeps the anomaly and drops an ordinary event instead', () => {
    const store = new Store(':memory:');
    // The anomaly goes in FIRST, so it is the oldest row - the one the old
    // eviction would have taken.
    store.enqueueEvent('chain.anomaly', { kind: 'chain.anomaly', topic: '0xdead' });
    filled(store, MAX_BUFFERED_EVENTS - 1);

    // One more, which tips it over.
    const evicted = store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x2' });
    expect(evicted).toBe(1);

    const db = (store as unknown as { db: Database }).db;
    const anomalies = (db.query(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'chain.anomaly'`).get() as { n: number }).n;
    // THE VALUE, not "greater than zero": the anomaly is still there, exactly
    // once, and it was the oldest row in the buffer when the eviction ran.
    expect(anomalies).toBe(1);
    store.close();
  });

  // THE CONTROL: an ordinary oldest row IS evicted, so the row above cannot be
  // passing because nothing is ever evicted.
  it('control: an ordinary event at the front is evicted', () => {
    const store = new Store(':memory:');
    filled(store, MAX_BUFFERED_EVENTS);
    const db = (store as unknown as { db: Database }).db;
    const first = (db.query(`SELECT MIN(id) AS id FROM outbox`).get() as { id: number }).id;

    expect(store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x3' })).toBe(1);

    const stillThere = db.query(`SELECT 1 FROM outbox WHERE id = ?`).get(first);
    expect(stillThere).toBeNull();
    store.close();
  });

  // ANOMALIES ARE EXEMT FROM BEING CHOSEN, NOT FROM THE CAP. A buffer that is
  // nothing but anomalies evicts none and grows - the right failure, because an
  // operator with ten thousand anomalies queued has a problem silence would not
  // fix, and the count returned says truthfully that nothing was removed.
  it('reports zero rather than a number nobody removed, when only anomalies are there', () => {
    const store = new Store(':memory:');
    const db = (store as unknown as { db: Database }).db;
    db.transaction(() => {
      const ins = db.query(`INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)`);
      for (let i = 0; i < MAX_BUFFERED_EVENTS; i++) ins.run('chain.anomaly', '{}', Date.now());
    })();

    expect(store.enqueueEvent('chain.anomaly', { kind: 'chain.anomaly', topic: '0xbeef' })).toBe(0);
    const n = (db.query(`SELECT COUNT(*) AS n FROM outbox`).get() as { n: number }).n;
    expect(n).toBe(MAX_BUFFERED_EVENTS + 1);
    store.close();
  });
});
