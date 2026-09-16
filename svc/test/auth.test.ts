// The authorisation model, unit level.
//
// There are deliberately TWO scope checks: one at the router (from the ROUTES
// table) and one inside each platform handler (requirePlatform). That is
// defence in depth and it is also exactly the co-satisfied-guards shape that
// has bitten this project three times - either check alone makes the
// end-to-end tests pass. So each is isolated here: the handler guard by
// calling it directly, and the router declaration by asserting the table.

import { describe, it, expect } from 'bun:test';
import { authenticate, assertMayRead, hashToken, requirePlatform, walletPrincipal, constantTimeEquals } from '../src/auth.ts';
import { ROUTES, assertRouteScope, type Route } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { HttpError } from '../src/errors.ts';
import { enforcePolicy, matchesPattern, stageCapWei, UNLIMITED, type StageCap } from '../src/policy.ts';
import type { AgentPolicy } from '../src/policy.ts';

const PLATFORM = 'platform-token';
const WALLET = 'wallet-token';

function storeWith(agentId: string, token: string): Store {
  const store = new Store(':memory:');
  store.setWalletTokenHash(agentId, hashToken(token));
  return store;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError: ${String(err)}`;
  }
  return 'no-error';
}

describe('authenticate', () => {
  it('distinguishes the platform credential from a wallet one', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(authenticate(`Bearer ${PLATFORM}`, PLATFORM, store)).toEqual({ scope: 'platform' });
    expect(authenticate(`Bearer ${WALLET}`, PLATFORM, store)).toEqual({ scope: 'wallet', agentId: 'orch:persona' });
    store.close();
  });

  it('refuses an unknown, empty or unschemed token', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(codeOf(() => authenticate('Bearer nope', PLATFORM, store))).toBe('unauthorized');
    expect(codeOf(() => authenticate('Bearer ', PLATFORM, store))).toBe('unauthorized');
    expect(codeOf(() => authenticate(PLATFORM, PLATFORM, store))).toBe('unauthorized');
    expect(codeOf(() => authenticate(undefined, PLATFORM, store))).toBe('unauthorized');
    store.close();
  });

  // Rotation works by REPLACING the stored hash, so there is no list of
  // superseded tokens to forget to clean up - and the old credential stops
  // authenticating immediately.
  it('revokes the previous token when a new one is issued', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(authenticate(`Bearer ${WALLET}`, PLATFORM, store)).toEqual({ scope: 'wallet', agentId: 'orch:persona' });

    store.setWalletTokenHash('orch:persona', hashToken('rotated-token'));

    expect(codeOf(() => authenticate(`Bearer ${WALLET}`, PLATFORM, store))).toBe('unauthorized');
    expect(authenticate('Bearer rotated-token', PLATFORM, store)).toEqual({
      scope: 'wallet',
      agentId: 'orch:persona',
    });
    store.close();
  });

  // The token is stored only as a hash, so a dumped database is not a set of
  // spending credentials.
  it('stores only a hash of the wallet token', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(store.agentForTokenHash(hashToken(WALLET))).toBe('orch:persona');
    expect(store.agentForTokenHash(WALLET)).toBeNull();
    store.close();
  });

  it('compares without short-circuiting or throwing on length', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('the handler-level scope guard, isolated from the router', () => {
  it('refuses a wallet credential on a platform action', () => {
    expect(codeOf(() => requirePlatform({ scope: 'wallet', agentId: 'orch:a' }, 'POST /wallets'))).toBe('wrong_scope');
    expect(codeOf(() => requirePlatform({ scope: 'platform' }, 'POST /wallets'))).toBe('no-error');
  });

  it('derives the transfer source from the credential, not the body', () => {
    expect(walletPrincipal({ scope: 'wallet', agentId: 'orch:a' }, undefined)).toBe('orch:a');
    expect(walletPrincipal({ scope: 'wallet', agentId: 'orch:a' }, 'orch:a')).toBe('orch:a');
    // The drain, at the smallest scale it can be expressed.
    expect(codeOf(() => walletPrincipal({ scope: 'wallet', agentId: 'orch:a' }, 'orch:victim'))).toBe(
      'principal_mismatch',
    );
    expect(codeOf(() => walletPrincipal({ scope: 'platform' }, 'orch:a'))).toBe('wrong_scope');
  });

  it('restricts a wallet credential to reading its own wallet', () => {
    expect(codeOf(() => assertMayRead({ scope: 'wallet', agentId: 'orch:a' }, 'orch:a'))).toBe('no-error');
    expect(codeOf(() => assertMayRead({ scope: 'wallet', agentId: 'orch:a' }, 'orch:b'))).toBe('not_your_wallet');
    expect(codeOf(() => assertMayRead({ scope: 'wallet', agentId: 'orch:a' }, null))).toBe('not_your_wallet');
    // The platform credential reads anything, including an unnamed burner.
    expect(codeOf(() => assertMayRead({ scope: 'platform' }, 'orch:b'))).toBe('no-error');
    expect(codeOf(() => assertMayRead({ scope: 'platform' }, null))).toBe('no-error');
  });
});

// The router guard exists for the route somebody adds LATER without a
// requirePlatform call. Asserting the table is what isolates it: the
// end-to-end tests cannot, because the handler guard catches everything first.
// Isolates the ROUTER guard from the handler guard: a route whose handler does
// nothing, so only the router can refuse it. Without this, deleting the router
// check leaves every test passing, because each real platform handler also
// calls requirePlatform.
describe('the router-level scope guard, isolated from the handlers', () => {
  const unguarded = (scope: Route['scope']): Route => ({
    method: 'POST',
    path: '/hypothetical',
    prefix: false,
    scope,
    handler: async () => ({}),
    requires: [],
  });

  it('refuses a wallet credential on a platform-scoped route', () => {
    expect(codeOf(() => assertRouteScope(unguarded('platform'), { scope: 'wallet', agentId: 'orch:a' }, 'x'))).toBe(
      'wrong_scope',
    );
    expect(codeOf(() => assertRouteScope(unguarded('platform'), { scope: 'platform' }, 'x'))).toBe('no-error');
  });

  it('refuses the platform credential on a wallet-scoped route', () => {
    expect(codeOf(() => assertRouteScope(unguarded('wallet'), { scope: 'platform' }, 'x'))).toBe('wrong_scope');
    expect(codeOf(() => assertRouteScope(unguarded('wallet'), { scope: 'wallet', agentId: 'orch:a' }, 'x'))).toBe(
      'no-error',
    );
  });

  it('lets either credential through an open route', () => {
    expect(codeOf(() => assertRouteScope(unguarded('any'), { scope: 'wallet', agentId: 'orch:a' }, 'x'))).toBe(
      'no-error',
    );
    expect(codeOf(() => assertRouteScope(unguarded('any'), { scope: 'platform' }, 'x'))).toBe('no-error');
  });
});

describe('the route table', () => {
  it('declares a scope for every route', () => {
    for (const route of ROUTES) {
      expect(['platform', 'wallet', 'any']).toContain(route.scope);
    }
  });

  it('never leaves a mutating route open to any credential', () => {
    // A POST that any credential may reach is how a wallet-scope caller
    // performs an operator's action. The one exception is declared in the ROUTE
    // TABLE rather than named here: `mutates: false` is a claim a reviewer
    // reads beside the route, and a future POST that forgets it is still
    // caught - which a list of exempt paths in this file would not be.
    const open = ROUTES.filter(
      (r) => r.method !== 'GET' && r.scope === 'any' && r.mutates !== false,
    );
    expect(open.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('exempts nothing from that rule except a route that provably cannot write', () => {
    // COMPARE TO A VALUE, not to emptiness: without this, deleting the
    // exemption or adding a careless one both read as "fine".
    const exempt = ROUTES.filter((r) => r.mutates === false).map((r) => `${r.method} ${r.path}`);
    expect(exempt).toEqual(['POST /read']);
  });

  it('keeps every wallet-mutating platform action off the wallet scope', () => {
    const platformOnly = ['/wallets', '/aliases', '/fund', '/stage'];
    for (const path of platformOnly) {
      const route = ROUTES.find((r) => r.path === path && r.method === 'POST');
      expect(route?.scope).toBe('platform');
    }
    expect(ROUTES.find((r) => r.method === 'DELETE')?.scope).toBe('platform');
  });
});

describe('policy enforcement', () => {
  // CAPS PER TOKEN as of the multi-token increment. The same two numbers, now
  // keyed by the token they bound - which is the whole change: a wallet holding
  // two currencies has two bounds, and a cap that named neither was only ever
  // right while there was one.
  const policy: AgentPolicy = {
    caps: { play: { max_per_tx: 100, max_per_stage: 500 } },
    allow: ['*.play'],
    deny: ['treasury.play'],
  };
  const vee = (n: number) => BigInt(n) * 10n ** 18n;

  it('matches only the patterns the game config can express', () => {
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('*.play', 'alpha.play')).toBe(true);
    expect(matchesPattern('*.play', 'alpha.playx')).toBe(false);
    expect(matchesPattern('treasury.play', 'treasury.play')).toBe(true);
    expect(matchesPattern('treasury.play', 'alpha.play')).toBe(false);
  });

  it('refuses over max_per_tx and a denied counterparty', () => {
    expect(codeOf(() => enforcePolicy({ policy, to: 'alpha.play', amount: vee(150), decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('over_max_per_tx');
    expect(codeOf(() => enforcePolicy({ policy, to: 'treasury.play', amount: vee(1), decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('counterparty_denied');
    expect(codeOf(() => enforcePolicy({ policy, to: 'alpha.play', amount: vee(100), decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('no-error');
  });

  // Deny wins: a name matching both lists is refused, because deny is what an
  // author writes to stop something specific.
  it('lets deny beat allow', () => {
    const both: AgentPolicy = { ...policy, allow: ['*'], deny: ['treasury.play'] };
    expect(codeOf(() => enforcePolicy({ policy: both, to: 'treasury.play', amount: vee(1), decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe(
      'counterparty_denied',
    );
  });

  // The stage cap is NOT enforcePolicy's any more. It was, and that is exactly
  // why the cap did not hold: a predicate taking `spentThisStage` as an
  // argument can only test a figure somebody read earlier, and by the time the
  // money moved that figure was stale. These tests exercise the RESERVATION,
  // which is the thing that has to be right - and it is one primitive covering
  // the cap and the intent together, because they were the same defect twice:
  // a decision and its durable record that were not one operation.
  // §1b. "unlimited" ON EACH BOUND INDEPENDENTLY, and the audit fact that
  // survives it.
  describe('"unlimited" caps', () => {
    const unlimitedTx: AgentPolicy = {
      caps: { play: { max_per_tx: UNLIMITED, max_per_stage: 500 } },
      allow: ['*'],
      deny: [],
    };
    const unlimitedStage: AgentPolicy = {
      caps: { play: { max_per_tx: 100, max_per_stage: UNLIMITED } },
      allow: ['*'],
      deny: [],
    };
    const enforce = (p: AgentPolicy, amount: bigint) =>
      enforcePolicy({ policy: p, to: 'alpha.play', amount, decimals: 18, symbol: 'PLAY', tokenKey: 'play' });

    it('skips the per-transaction bound, at any size', () => {
      expect(() => enforce(unlimitedTx, vee(1_000_000))).not.toThrow();
    });

    it('leaves the OTHER bound alone - each field takes the value independently', () => {
      // The pair is the point: an unlimited max_per_tx must not quietly
      // unbound the stage. A fixture with both set to "unlimited" could not
      // tell the two apart, and one flag serving both is the obvious wrong
      // implementation.
      const store = new Store(':memory:');
      const cap = stageCapWei(unlimitedTx, 'play', 18);
      expect(cap).toEqual({ cap: vee(500) });
      expect(
        store.reserve({ token: 'play', intentId: 'u-1', agentId: 'orch:a', stage: 's1', amount: vee(600), stageCap: cap })
          .outcome,
      ).toBe('over_stage_cap');
      store.close();
    });

    it('still refuses over max_per_tx when only the STAGE is unlimited', () => {
      expect(() => enforce(unlimitedStage, vee(101))).toThrow(HttpError);
      expect(() => enforce(unlimitedStage, vee(100))).not.toThrow();
    });

    it('RECORDS THE SPEND with an unlimited stage cap, rather than skipping it', () => {
      // THE AUDIT FACT. Recording and bounding used to be one branch, so the
      // obvious implementation - pass null - made a wallet's unlimited spends
      // absent from the trail rather than unbounded, and every cap test stayed
      // green because nothing was over any cap.
      const store = new Store(':memory:');
      const cap = stageCapWei(unlimitedStage, 'play', 18);
      expect(cap).toEqual({ cap: UNLIMITED });
      for (const id of ['u-2', 'u-3']) {
        expect(
          store.reserve({ token: 'play', intentId: id, agentId: 'orch:b', stage: 's1', amount: vee(10_000), stageCap: cap })
            .outcome,
        ).toBe('reserved');
      }
      // COMPARE TO A VALUE, not to non-zero: the sum is what says both landed.
      expect(store.spentThisStage('orch:b', 's1', 'play')).toBe(vee(20_000));
      store.close();
    });

    it('records NOTHING for platform scope, which has no stage at all', () => {
      // The third state, and the row that keeps it distinct from the second.
      // Without it, "records whenever there is no bound" passes every
      // assertion above.
      const store = new Store(':memory:');
      store.reserve({ token: 'play', intentId: 'p-1', agentId: 'platform', stage: 's1', amount: vee(999), stageCap: null });
      expect(store.spentThisStage('platform', 's1', 'play')).toBe(0n);
      store.close();
    });

    it('treats a token with NO entry as unbounded, like a written "unlimited"', () => {
      // FLIPPED at v0.8.0. This asserted that silence fails closed while
      // "unlimited" is a written decision; the owner reversed the first half.
      // The two now reach the same stage state by different routes - and the
      // state is `{cap: 'unlimited'}`, never `null`, so the spend is still
      // RECORDED. That is the half of the old rule that survives.
      expect(stageCapWei(unlimitedTx, 'au', 6)).toEqual({ cap: UNLIMITED });
      expect(stageCapWei(unlimitedStage, 'play', 18)).toEqual({ cap: UNLIMITED });
      // And a WRITTEN garbage value still refuses, which is what keeps this a
      // statement about silence rather than about the check being gone.
      const typo = { caps: { au: { max_per_stage: 'lots' } }, allow: ['*'], deny: [] } as never;
      let err: unknown;
      try {
        stageCapWei(typo, 'au', 6);
      } catch (e) {
        err = e;
      }
      expect((err as HttpError).code).toBe('no_cap_set');
    });
  });

  describe('the reservation', () => {
    const cap = stageCapWei(policy, 'play', 18); // 500 VEE
    let n = 0;
    const uniq = () => `i${++n}`;
    const take = (store: Store, agentId: string, stage: string, amount: bigint, stageCap: StageCap) =>
      store.reserve({ token: 'play', intentId: uniq(), agentId, stage, amount, stageCap });

    it('allows exactly up to the cap and no further', () => {
      const store = new Store(':memory:');
      expect(take(store, 'orch:a', 's1', vee(450), cap).outcome).toBe('reserved');
      expect(take(store, 'orch:a', 's1', vee(50), cap).outcome).toBe('reserved');
      expect(take(store, 'orch:a', 's1', vee(1), cap).outcome).toBe('over_stage_cap');
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(500));
      store.close();
    });

    // Both halves, because a refusal that still consumed the intent id would
    // make the caller's honest retry an unresolvable duplicate for ever.
    it('records NEITHER half when it refuses on the cap', () => {
      const store = new Store(':memory:');
      const id = 'refused-intent';
      expect(store.reserve({ intentId: id, agentId: 'orch:a', stage: 's1', amount: vee(600), stageCap: cap, token: 'play' }).outcome)
        .toBe('over_stage_cap');
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(0n);
      // The id is still free: retrying under it after a top-up must work.
      expect(store.reserve({ intentId: id, agentId: 'orch:a', stage: 's1', amount: vee(1), stageCap: cap, token: 'play' }).outcome)
        .toBe('reserved');
      store.close();
    });

    it('keeps a separate budget per stage, so a stage change resets it', () => {
      const store = new Store(':memory:');
      expect(take(store, 'orch:a', 's1', vee(500), cap).outcome).toBe('reserved');
      expect(take(store, 'orch:a', 's1', vee(1), cap).outcome).toBe('over_stage_cap');
      expect(take(store, 'orch:a', 's2', vee(500), cap).outcome).toBe('reserved');
      store.close();
    });

    // THE STAGE-CAP REGRESSION. Three concurrent 100-VEE sends against a
    // 100/stage cap all succeeded, because read-check-write straddled four
    // awaits. Asserting the predicate cannot catch that - the old tests passed
    // `spentThisStage` in as a literal and proved only that the arithmetic was
    // right.
    it('admits exactly floor(cap/amount) of N concurrent reservations', () => {
      const store = new Store(':memory:');
      const results = Array.from({ length: 8 }, () => take(store, 'orch:racer', 's1', vee(100), { cap: vee(100) }));
      expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(1); // floor(100/100)
      expect(store.spentThisStage('orch:racer', 's1', 'play')).toBe(vee(100));
      store.close();
    });

    it('admits exactly floor(cap/amount) when the cap is a multiple', () => {
      const store = new Store(':memory:');
      const results = Array.from({ length: 10 }, () => take(store, 'orch:racer', 's1', vee(100), { cap: vee(500) }));
      expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(5); // floor(500/100)
      expect(store.spentThisStage('orch:racer', 's1', 'play')).toBe(vee(500));
      store.close();
    });

    // THE INTENT REGRESSION. chain-svc performed the transfer, the response was
    // dropped, and the caller's CORRECT retry transferred again - two real
    // transfers for one intent, the caller told it succeeded once.
    it('refuses a second reservation under the same intent id', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'once', agentId: 'orch:a', stage: 's1', amount: vee(10), stageCap: cap, token: 'play' };
      expect(store.reserve(args).outcome).toBe('reserved');
      expect(store.reserve(args).outcome).toBe('duplicate');
      // And it did not charge twice.
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(10));
      store.close();
    });

    it('answers a replayed intent with the ORIGINAL transaction hash', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'once', agentId: 'orch:a', stage: 's1', amount: vee(10), stageCap: cap, token: 'play' };
      store.reserve(args);
      store.completeIntent('orch:a', 'once', '0xabc');
      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: '0xabc' });
      store.close();
    });

    // The reconciliation case: reserved, broadcast, outcome unknown. It must be
    // distinguishable from a completed replay, because guessing either way is
    // wrong - re-sending double-charges, reporting success invents a hash.
    it('reports a reserved-but-uncompleted intent as duplicate with no hash', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'inflight', agentId: 'orch:a', stage: 's1', amount: vee(10), stageCap: cap, token: 'play' };
      store.reserve(args);
      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: null });
      store.close();
    });

    it('admits exactly ONE of N concurrent reservations of the same intent', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'racy', agentId: 'orch:a', stage: 's1', amount: vee(1), stageCap: cap, token: 'play' };
      const results = Array.from({ length: 8 }, () => store.reserve(args));
      expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(1);
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(1));
      store.close();
    });

    // Release is for failures that PROVABLY precede the broadcast, and it gives
    // BOTH halves back - a released reservation that kept the intent id would
    // leave the caller unable to retry the send that never happened.
    it('release frees both the budget and the intent id', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'unsent', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' };
      store.reserve(args);
      store.release('orch:a', 'unsent');
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(0n);
      expect(store.reserve(args).outcome).toBe('reserved');
      store.close();
    });

    // The one thing release must NEVER do: undo a send that happened. Once a
    // hash is recorded the intent is history, not a reservation.
    it('release cannot erase a COMPLETED intent', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'done', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' };
      store.reserve(args);
      store.completeIntent('orch:a', 'done', '0xabc');
      store.release('orch:a', 'done');
      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: '0xabc' });
      store.close();
    });

    // NO CURRENT CONSUMER: nothing reads `reserved_at_block`. This pins that
    // the VALUE is stamped, not that a row exists - the reserve-time head is
    // irrecoverable afterwards, so the future nonce-based branch gets a floor
    // or gets nothing. It is deliberately NOT a claim that anything depends on
    // the column today; see the comment on Store.reserve.
    //
    // (The two sentences that used to sit here were an orphan from the release
    // tests above and the "lower bound that makes absence evidence" claim that
    // the #34 fix retired.)
    it('records the chain head observed before the reservation', () => {
      const store = new Store(':memory:');
      // The store's CURRENT stage: `unresolvedIntents` is bounded to it, so a
      // fixture pinning an arbitrary stage would be filtered out and the
      // assertion would fail for a reason that has nothing to do with the bound.
      store.reserve({
        token: 'play',
        intentId: 'bounded', agentId: 'orch:a', stage: store.currentStage(),
        amount: vee(1), stageCap: cap, reservedAtBlock: 4242n,
      });
      const [row] = store.unresolvedIntents();
      expect(row!.reservedAtBlock).toBe(4242n);
      store.close();
    });

    // Null when the tail has not polled yet. No consumer exists to mis-read it
    // today; the point is that it stays distinguishable from block zero, because
    // zero would make every absence look like evidence - the defect that removed
    // the sweep's negative branch.
    it('reports a missing bound as null, not as zero', () => {
      const store = new Store(':memory:');
      store.reserve({
        intentId: 'unbounded', agentId: 'orch:a', stage: store.currentStage(),
        amount: vee(1), stageCap: cap, token: 'play',
      });
      expect(store.unresolvedIntents()[0]!.reservedAtBlock).toBeNull();
      store.close();
    });

    // A1. `reserve` grew a no-hold mode, so "an intent row exists" and "a hold
    // was taken" became independent facts - and the refund was keyed on the
    // first. Releasing a no-hold reservation refunded budget never taken, and
    // the zero-clamp turned the overshoot into wiping the wallet's real spend.
    it('releasing a NO-HOLD reservation refunds nothing, and leaves a real hold alone', () => {
      const store = new Store(':memory:');

      // A real agent send, holding 100.
      store.reserve({ intentId: 'agent-send', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' });
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(100));

      // A platform set-balance for 400, holding NOTHING.
      store.reserve({ intentId: 'platform-set', agentId: 'orch:a', stage: 's1', amount: vee(400), stageCap: null, token: 'play' });
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(100)); // unchanged, correct

      store.release('orch:a', 'platform-set');

      // The agent's real hold survives. Before the fix this refunded 400 that
      // was never held, and the clamp floored the result at zero.
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(100));
      store.close();
    });

    // A5. A review's two separations. `release` takes the WALLET and the id
    // since v8, and everything else still comes off the row - so the stage and
    // the amount have no caller coordinate to be wrong, and the wallet now has
    // one that must MATCH rather than be trusted. These assert the behaviour
    // rather than the signature, because a future overload could reintroduce
    // either.
    it('refunds the stage the intent was reserved IN, not one the caller names', () => {
      const store = new Store(':memory:');
      store.reserve({ intentId: 'i', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' });
      store.reserve({ intentId: 'j', agentId: 'orch:a', stage: 's2', amount: vee(300), stageCap: cap, token: 'play' });

      store.release('orch:a', 'i');

      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(0n);   // refunded
      expect(store.spentThisStage('orch:a', 's2', 'play')).toBe(vee(300)); // untouched
      store.close();
    });

    // TWO WAYS TO REFUND THE WRONG WALLET, and v8 splits them.
    //
    // Before, `release` took an id alone, found whatever row had it, and
    // refunded the wallet that row named - so the property was "trust the row,
    // not the caller". Now the wallet is a coordinate of the lookup, which
    // makes a second failure possible that could not exist before: asking to
    // release SOMEBODY ELSE'S id. A test that only kept the first assertion
    // would pass while that one went unguarded.
    it('refunds the wallet the intent belongs TO, and nobody else', () => {
      const store = new Store(':memory:');
      store.reserve({ intentId: 'i', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' });
      store.reserve({ intentId: 'k', agentId: 'orch:b', stage: 's1', amount: vee(200), stageCap: cap, token: 'play' });

      store.release('orch:a', 'i');

      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(0n);        // refunded
      expect(store.spentThisStage('orch:b', 's1', 'play')).toBe(vee(200));  // untouched
      store.close();
    });

    it('releasing ANOTHER wallet\'s intent id cancels nothing and refunds nothing', () => {
      const store = new Store(':memory:');
      store.reserve({ intentId: 'i', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' });
      store.reserve({ intentId: 'k', agentId: 'orch:b', stage: 's1', amount: vee(200), stageCap: cap, token: 'play' });

      // orch:b asking to release the string orch:a reserved. Under the old key
      // this DELETEd alice's open reservation and credited her budget back on
      // bob's say-so.
      store.release('orch:b', 'i');

      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(100));  // still held
      expect(store.spentThisStage('orch:b', 's1', 'play')).toBe(vee(200));  // still held
      // ...and alice's reservation is still there, so her own retry is a
      // duplicate rather than a fresh slot.
      expect(
        store.reserve({ intentId: 'i', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' })
          .outcome,
      ).toBe('duplicate');
      store.close();
    });

    // The refund comes from the ROW, not the caller's argument - the caller's
    // idea of the amount is exactly what went wrong.
    it('refunds what was held even when the caller names a different amount', () => {
      const store = new Store(':memory:');
      store.reserve({ intentId: 'x', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' });
      store.release('orch:a', 'x');
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(0n);
      store.close();
    });

    it('refunds nothing for an intent that was never reserved', () => {
      const store = new Store(':memory:');
      take(store, 'orch:a', 's1', vee(500), cap);
      store.release('orch:a', 'never-existed');
      // The budget stands. The old code refunded unconditionally and merely
      // CLAMPED at zero, which is a different property and the wrong one: it
      // made an unknown intent id a way to zero a wallet's stage spend.
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(500));
      store.close();
    });

    it('refunds once for a double release of the same intent', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'twice', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: cap, token: 'play' };
      store.reserve(args);
      store.release('orch:a', 'twice');
      store.release('orch:a', 'twice');
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(0n);
      store.close();
    });

    // THE MEASURED DEFECT. reserve 100 under a 100 cap, complete it, release it:
    // the intent correctly survived as duplicate{txHash} while spentThisStage
    // dropped to 0, and a second 100-VEE send was then admitted.
    it('a release on a COMPLETED intent refunds nothing, so the cap still binds', () => {
      const store = new Store(':memory:');
      const capOf100 = vee(100);
      const args = { intentId: 'landed', agentId: 'orch:a', stage: 's1', amount: vee(100), stageCap: { cap: capOf100 }, token: 'play' };
      expect(store.reserve(args).outcome).toBe('reserved');
      store.completeIntent('orch:a', 'landed', '0xabc');

      store.release('orch:a', 'landed');

      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: '0xabc' });
      expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(vee(100));
      expect(store.reserve({ ...args, intentId: 'second' }).outcome).toBe('over_stage_cap');
      store.close();
    });
  });
});

// The deny list's known limit, asserted so it cannot change silently. This is
// NOT a test that the behaviour is right - it is a test that the behaviour is
// what the comment in policy.ts says, so that the day someone fixes it, this
// fails and the comment gets retired with it.
describe('deny matches the resolved principal, not just the requested name', () => {
  const denied = {
    agentId: 'orch:mark',
    caps: { play: { max_per_tx: 1000, max_per_stage: 5000 } },
    allow: ['*'],
    deny: ['mark.play'],
    frozen: false,
  };
  const oneVee = 10n ** 18n; // the `vee` helper is scoped to the describe above
  const to = (name: string) => codeOf(() => enforcePolicy({ policy: denied, to: name, amount: oneVee, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }));
  const toResolved = (name: string, canonical: string) =>
    codeOf(() => enforcePolicy({ policy: denied, to: name, canonical, amount: oneVee, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }));

  it('refuses the denied name', () => {
    expect(to('mark.play')).toBe('counterparty_denied');
  });

  // THE BYPASS THIS CLOSES. `addAlias` registers an alias with
  // registerFor(alias, wallet, wallet), so a vanity alias and the canonical id
  // resolve to the SAME address. Denying one name used to leave the wallet
  // reachable under the other - no registrar write, no privilege, no attack,
  // just the name that is always there.
  it('refuses the same wallet reached by its canonical id', () => {
    expect(toResolved('mark.play', 'orch:mark')).toBe('counterparty_denied');
  });

  // The ruled test: deny treasury.play, register treasure.play as a
  // treasury alias, send to treasure.play. The registry keeps the FIRST
  // registered name as `reverse[target]`, so the alias resolves canonical to
  // treasury.play and the deny entry bites.
  it('refuses a treasury alias when the deny list names the treasury', () => {
    const p = { ...denied, deny: ['treasury.play'] };
    const code = codeOf(() =>
      enforcePolicy({ policy: p, to: 'treasure.play', canonical: 'treasury.play', amount: oneVee, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }),
    );
    expect(code).toBe('counterparty_denied');
  });

  // ALLOW must NOT be evaluated against the canonical alone. Measured: the
  // default agent allow list is ["*.play"] and canonical ids look like
  // `orch:bob`, so canonical-only matching matches nothing and every send in
  // the game is refused. Widening deny is safe; narrowing allow is not.
  it('still allows an ordinary send whose canonical does not match the allow list', () => {
    const p = { ...denied, allow: ['*.play'], deny: [] };
    const code = codeOf(() =>
      enforcePolicy({ policy: p, to: 'bob.play', canonical: 'orch:bob', amount: oneVee, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }),
    );
    expect(code).toBe('no-error');
  });
});
