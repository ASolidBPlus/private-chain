import { describe, it, expect } from 'bun:test';
import { Store, MAX_BUFFERED_EVENTS } from '../src/store.ts';

describe('memos', () => {
  it('joins a memo back onto its transaction, case-insensitively', () => {
    const store = new Store(':memory:');
    store.recordMemo({ txHash: '0xABC', memo: 'for the stream job', intentId: 'a1', fromAgentId: 'orch:vendor' });

    const found = store.memosFor(['0xabc']);
    expect(found.get('0xabc')?.memo).toBe('for the stream job');
    expect(found.get('0xabc')?.intentId).toBe('a1');
    store.close();
  });

  it('returns nothing for unknown hashes rather than throwing', () => {
    const store = new Store(':memory:');
    expect(store.memosFor(['0xdeadbeef']).size).toBe(0);
    expect(store.memosFor([]).size).toBe(0);
    store.close();
  });
});

describe('frozen', () => {
  // This table is the ONLY truth for whether a wallet may spend; the per-agent
  // POLICY_FILE is a fast-path copy that loses any disagreement.
  it('records and reports a freeze, and is idempotent', () => {
    const store = new Store(':memory:');
    expect(store.isRetired('orch:scammer')).toBe(false);

    store.freeze('orch:scammer');
    expect(store.isRetired('orch:scammer')).toBe(true);

    store.freeze('orch:scammer');
    expect(store.isRetired('orch:scammer')).toBe(true);
    expect(store.isRetired('orch:vendor')).toBe(false);
    store.close();
  });
});

describe('the event outbox', () => {
  it('buffers events until they are delivered', () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { txHash: '0x1' });
    store.enqueueEvent('agent.spend', { intent_id: 'a1' });
    expect(store.pendingEventCount()).toBe(2);

    const due = store.dueEvents(10);
    expect(due).toHaveLength(2);
    expect(JSON.parse(due[0]!.payload)).toEqual({ txHash: '0x1' });

    store.eventDelivered(due[0]!.id);
    expect(store.pendingEventCount()).toBe(1);
    store.close();
  });

  it('backs off a failed event instead of retrying it immediately', () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { txHash: '0x1' });
    const [event] = store.dueEvents(10);

    const now = Date.now();
    store.eventFailed(event!.id, now);

    expect(store.dueEvents(10, now)).toHaveLength(0);
    expect(store.dueEvents(10, now + 10 * 60_000)).toHaveLength(1);
    store.close();
  });

  // A hub-core that is down - or absent, which it is until C5 - must not be
  // able to fill the disk. Oldest go first and the drop count is returned so
  // the caller can log it: a silently truncated audit trail is worse than a
  // noisy one.
  it('bounds the buffer and reports what it dropped', () => {
    const store = new Store(':memory:');
    let dropped = 0;
    for (let i = 0; i < MAX_BUFFERED_EVENTS + 5; i++) {
      dropped += store.enqueueEvent('chain.transfer', { i });
    }

    expect(dropped).toBe(5);
    expect(store.pendingEventCount()).toBe(MAX_BUFFERED_EVENTS);

    // The five dropped are the OLDEST, so the survivors start at i=5.
    const [oldest] = store.dueEvents(1);
    expect(JSON.parse(oldest!.payload)).toEqual({ i: 5 });
    store.close();
  }, 30_000);
});

// §3.2.7. PER-ENTRY CALL COUNTING, in the same transaction as the reservation.
//
// The count is taken AT RESERVATION, before the broadcast, exactly like the
// stage hold - so a call that reaches the chain and reverts still costs its
// slot. That is the honest cost of a call that happened: a persona can lose
// stage budget to a paused pair, and `read` is free for anyone who is unsure.
//
// It rides `reserve` rather than sitting beside it because the two are one
// decision - "may this call happen" - and two transactions would admit a window
// where the intent is taken and the count is not, or the reverse. That is the
// same argument the stage hold already won.
describe('call counting', () => {
  const CALL = { contract: 'converter', function: 'convert', argsHash: 'h1', maxPerStage: 2 };

  it('records what the intent was reserved for', () => {
    const store = new Store(':memory:');
    store.reserve({
      intentId: 'i-1',
      agentId: 'orch:a',
      stage: 's1',
      amount: 0n,
      stageCap: null, token: 'play',
      call: CALL,
    });
    expect(store.intentCall('orch:a', 'i-1')).toEqual({
      contract: 'converter',
      function: 'convert',
      argsHash: 'h1',
    });
    store.close();
  });

  it('leaves the call columns null for a transfer intent', () => {
    const store = new Store(':memory:');
    store.reserve({ intentId: 'i-1', agentId: 'orch:a', stage: 's1', amount: 1n, stageCap: null, token: 'play' });
    expect(store.intentCall('orch:a', 'i-1')).toBeNull();
    store.close();
  });

  it('counts up to the entry limit and refuses the one after', () => {
    const store = new Store(':memory:');
    const call = (id: string) =>
      store.reserve({
        intentId: id,
        agentId: 'orch:a',
        stage: 's1',
        amount: 0n,
        stageCap: null, token: 'play',
        call: CALL,
      }).outcome;

    expect(call('i-1')).toBe('reserved');
    expect(call('i-2')).toBe('reserved');
    expect(call('i-3')).toBe('over_stage_cap');
    store.close();
  });

  it('writes NOTHING when the limit refuses', () => {
    // The refusal must not consume the intent id it refused. A caller that
    // retries next stage under the same id would otherwise be told `duplicate`
    // about a call that never happened - and `duplicate` carries a null txHash,
    // which reads as `intent_unresolved`: "it may have been sent".
    const store = new Store(':memory:');
    for (const id of ['i-1', 'i-2']) {
      store.reserve({ token: 'play', intentId: id, agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: CALL });
    }
    expect(
      store.reserve({ token: 'play', intentId: 'i-3', agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: CALL })
        .outcome,
    ).toBe('over_stage_cap');
    expect(store.intentCall('orch:a', 'i-3')).toBeNull();
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(2);
    store.close();
  });

  it('counts per wallet, per stage, per contract and per function', () => {
    // Four coordinates, and each one is a separate test of the primary key: a
    // count keyed on fewer of them would let one wallet's calls limit another's,
    // or one function's limit another's on the same contract.
    const store = new Store(':memory:');
    const call = (id: string, agent: string, stage: string, contract: string, fn: string) =>
      store.reserve({
        intentId: id,
        agentId: agent,
        stage,
        amount: 0n,
        stageCap: null, token: 'play',
        call: { contract, function: fn, argsHash: 'h', maxPerStage: 1 },
      }).outcome;

    expect(call('i-1', 'orch:a', 's1', 'converter', 'convert')).toBe('reserved');
    expect(call('i-2', 'orch:b', 's1', 'converter', 'convert')).toBe('reserved'); // other wallet
    expect(call('i-3', 'orch:a', 's2', 'converter', 'convert')).toBe('reserved'); // other stage
    expect(call('i-4', 'orch:a', 's1', 'shop', 'convert')).toBe('reserved'); // other contract
    expect(call('i-5', 'orch:a', 's1', 'converter', 'other')).toBe('reserved'); // other function
    expect(call('i-6', 'orch:a', 's1', 'converter', 'convert')).toBe('over_stage_cap');
    store.close();
  });

  it('counts nothing at all for an entry with no limit', () => {
    // No row written and none read. A counter nothing enforces is a table that
    // grows for the sake of it, and a row whose absence is meaningful is easier
    // to reason about than a row whose value is ignored.
    const store = new Store(':memory:');
    const { maxPerStage: _none, ...noLimit } = CALL;
    for (const id of ['i-1', 'i-2', 'i-3']) {
      expect(
        store.reserve({ token: 'play', intentId: id, agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: noLimit })
          .outcome,
      ).toBe('reserved');
    }
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(0);
    store.close();
  });

  it('gives the count back on release, found through the intent row', () => {
    // `release(intentId)` takes ONE coordinate and reads every other from the
    // row - which wallet, which stage, how much was held, and now which entry
    // was counted. The caller does not get to say, because a caller that
    // remembers its own coordinates is a caller that can be wrong about them.
    const store = new Store(':memory:');
    store.reserve({ token: 'play', intentId: 'i-1', agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: CALL });
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(1);

    store.release('orch:a', 'i-1');
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(0);
    store.close();
  });

  it('frees the slot the release gave back, not merely the number', () => {
    const store = new Store(':memory:');
    const call = (id: string) =>
      store.reserve({ token: 'play', intentId: id, agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: CALL })
        .outcome;
    expect(call('i-1')).toBe('reserved');
    expect(call('i-2')).toBe('reserved');
    expect(call('i-3')).toBe('over_stage_cap');

    store.release('orch:a', 'i-2');
    expect(call('i-4')).toBe('reserved');
    store.close();
  });

  it('does not give the count back once the intent has completed', () => {
    // THE RELEASE RULE, unchanged and now covering a third thing. Release only
    // on a failure that provably PRECEDES the broadcast; a completed intent has
    // a tx_hash, so it is not released, and neither is its count. A reverted
    // call has a hash too - it was mined - so it keeps its slot.
    const store = new Store(':memory:');
    store.reserve({ token: 'play', intentId: 'i-1', agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: CALL });
    store.completeIntent('orch:a', 'i-1', '0xdead');

    store.release('orch:a', 'i-1');
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(1);
    store.close();
  });

  it('releases the stage hold and the call count together', () => {
    // One reservation, two halves, one rule. A release that gave back the wei
    // and kept the count - or the reverse - would be the two-rule shape the
    // release rule exists to forbid.
    const store = new Store(':memory:');
    store.reserve({
      intentId: 'i-1',
      agentId: 'orch:a',
      stage: 's1',
      amount: 10n,
      stageCap: { cap: 100n }, token: 'play',
      call: CALL,
    });
    expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(10n);
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(1);

    store.release('orch:a', 'i-1');
    expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(0n);
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(0);
    store.close();
  });

  it('does not go negative if a release arrives with no count row', () => {
    // Reachable through a store that predates v6: an intent reserved before the
    // table existed, released after the upgrade. A count clamped at zero is the
    // same clamp the stage hold already has, for the same reason.
    const store = new Store(':memory:');
    const { maxPerStage: _none, ...noLimit } = CALL;
    store.reserve({ token: 'play', intentId: 'i-1', agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: noLimit });
    store.release('orch:a', 'i-1');
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(0);
    store.close();
  });

  it('refuses a duplicate intent id before it counts anything', () => {
    const store = new Store(':memory:');
    store.reserve({ token: 'play', intentId: 'i-1', agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: CALL });
    expect(
      store.reserve({ token: 'play', intentId: 'i-1', agentId: 'orch:a', stage: 's1', amount: 0n, stageCap: null, call: CALL })
        .outcome,
    ).toBe('duplicate');
    expect(store.callCount('orch:a', 's1', 'converter', 'convert')).toBe(1);
    store.close();
  });
});

// §2. STAGE SPEND IS PER TOKEN, and the fixture has to carry two of them or it
// tests nothing.
//
// The mutant that found this gap removed the token from `spentThisStage`'s
// WHERE clause and SURVIVED - because every other test in this file records
// spend in one token only, so filtering and not filtering give the same answer.
// The same shape as a fixture whose key and symbol agree: the test cannot
// express the violation, so the guard is vacuous however many assertions point
// at it.
describe('stage spend, per token', () => {
  const stage = 's1';

  it('keeps two tokens apart in one stage for one wallet', () => {
    const store = new Store(':memory:');
    store.reserve({ intentId: 'i-play', agentId: 'orch:a', stage, amount: 100n, stageCap: { cap: 1000n }, token: 'play' });
    store.reserve({ intentId: 'i-gold', agentId: 'orch:a', stage, amount: 7n, stageCap: { cap: 1000n }, token: 'gold' });

    expect(store.spentThisStage('orch:a', stage, 'play')).toBe(100n);
    expect(store.spentThisStage('orch:a', stage, 'gold')).toBe(7n);
    // AND NOT THE SUM. A total across currencies is a number in no unit, and
    // the thing it would be compared against is a cap denominated in one of
    // them - so a wallet would be refused for spending gold it had not spent.
    expect(store.spentThisStage('orch:a', stage, 'play')).not.toBe(107n);
    store.close();
  });

  it('caps each token independently', () => {
    // The consequence that matters: exhausting one currency's stage budget
    // leaves the other's untouched. Under one shared total, spending the
    // default token would have locked a persona out of every other.
    const store = new Store(':memory:');
    expect(
      store.reserve({ intentId: 'p1', agentId: 'orch:a', stage, amount: 100n, stageCap: { cap: 100n }, token: 'play' })
        .outcome,
    ).toBe('reserved');
    expect(
      store.reserve({ intentId: 'p2', agentId: 'orch:a', stage, amount: 1n, stageCap: { cap: 100n }, token: 'play' })
        .outcome,
    ).toBe('over_stage_cap');
    expect(
      store.reserve({ intentId: 'g1', agentId: 'orch:a', stage, amount: 50n, stageCap: { cap: 100n }, token: 'gold' })
        .outcome,
    ).toBe('reserved');
    store.close();
  });

  it('releases the hold in the token it was taken in', () => {
    // `release` reads the token from the intents row, like every other
    // coordinate. A release against the wrong currency would leave the real
    // hold standing AND credit budget somewhere it was never taken.
    const store = new Store(':memory:');
    store.reserve({ intentId: 'i-play', agentId: 'orch:a', stage, amount: 100n, stageCap: { cap: 1000n }, token: 'play' });
    store.reserve({ intentId: 'i-gold', agentId: 'orch:a', stage, amount: 7n, stageCap: { cap: 1000n }, token: 'gold' });

    store.release('orch:a', 'i-gold');
    expect(store.spentThisStage('orch:a', stage, 'gold')).toBe(0n);
    expect(store.spentThisStage('orch:a', stage, 'play')).toBe(100n);
    store.close();
  });

  it('records the token on the intent itself', () => {
    const store = new Store(':memory:');
    store.reserve({ intentId: 'i-gold', agentId: 'orch:a', stage, amount: 7n, stageCap: null, token: 'gold' });
    expect(store.intentToken('orch:a', 'i-gold')).toBe('gold');
    store.close();
  });
});
