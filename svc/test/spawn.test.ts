// Validation paths of spawn and transfer, which run BEFORE any chain call - so
// the stubs below are never reached, and a test that starts touching them is
// telling you an argument check moved after a side effect.

import { describe, it, expect } from 'bun:test';
import { decodeFunctionData } from 'viem';
import { TokenAbi } from '../src/abi.ts';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spawner } from '../src/spawn.ts';
import { droppedPatternsLogged, loadPolicyDefaults, capToWei, WALLET_KINDS, type AgentPolicy } from '../src/policy.ts';
import { Treasury, type Signer } from '../src/treasury.ts';
import { Store } from '../src/store.ts';
import { blankComments } from './support/source.ts';
import { asChainError } from '../src/chain.ts';
import { HttpError } from '../src/errors.ts';
import type { Config } from '../src/config.ts';
import type { Chain } from '../src/chain.ts';
import type { Keystore } from '../src/keystore.ts';
import type { Resolver } from '../src/resolver.ts';
import { closedCallPolicy } from '../src/calls.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = loadPolicyDefaults(join(PKG, 'policy-defaults.example.json'), 'play', ['play']);

const config = {
  policyDir: '/tmp/does-not-exist',
  rpcUrl: 'http://chain:8545',
  policyDefaultsPath: join(PKG, 'policy-defaults.example.json'),
} as Config;

/// Throws on any access EXCEPT the module view.
///
/// `chain.modules` is local state built at boot, not a call - it is how a
/// handler learns the deployed token's scale and symbol, and reading it emits
/// no RPC. The property these tests guard is that validation refuses before any
/// CHAIN CALL, and a proxy that cannot tell a field read from a request would
/// fail them for the wrong reason.
const STUB_MODULES = {
  tokens: [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }],
  names: { address: '0xreg', tld: 'play' },
};

function exploding(what: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (what === 'chain' && prop === 'modules') return STUB_MODULES;
        throw new Error(`${what} must not be reached: validation should have refused this first`);
      },
    },
  );
}

function spawner(store = new Store(':memory:')): { spawner: Spawner; store: Store } {
  return {
    spawner: new Spawner(
      config,
      exploding('chain') as Chain,
      exploding('keystore') as Keystore,
      store,
      exploding('resolver') as Resolver,
      DEFAULTS,
    ),
    store,
  };
}

function treasury(store = new Store(':memory:')): Treasury {
  return new Treasury(
    config,
    exploding('chain') as Chain,
    exploding('keystore') as Keystore,
    store,
    exploding('resolver') as Resolver,
    DEFAULTS,
    closedCallPolicy(),
  );
}

/// The credential a wallet presents. Signing derives the source from THIS, not
/// from the request body.
const asWallet = (agentId: string) => ({ scope: 'wallet', agentId }) as const;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError: ${String(err)}`;
  }
  return 'no-error';
}

describe('POST /wallets validation', () => {
  it('refuses a bare local id, a two-colon relay string and uppercase', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'client' }))).toBe('invalid_agent_id');
    expect(await codeOf(() => s.spawn({ agentId: 'orch:pod1:alice' }))).toBe('invalid_agent_id');
    expect(await codeOf(() => s.spawn({ agentId: 'orch:Vendor' }))).toBe('invalid_agent_id');
  });

  // A burner is deliberately an unnamed address the game must trace, so a named
  // burner is a contradiction rather than a request to be helpful about.
  it('refuses a burner with an alias', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:ghost', kind: 'burner', alias: 'ghost.play' }))).toBe(
      'invalid_request',
    );
  });

  it('refuses an unknown kind', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', kind: 'wizard' }))).toBe('invalid_request');
  });

  // The condition and the message used to be separate lists, and the message
  // was PROSE - so the natural drift was a validator accepting a new kind
  // beside a message still calling it invalid, which sends the caller to fix
  // input that was already correct. Asserting the message against the CONSTANT
  // rather than against a fixed string means it stays true when the list grows,
  // without anyone remembering to update this test either.
  it('names every valid kind in the rejection message', async () => {
    const { spawner: s } = spawner();
    const err = await s.spawn({ agentId: 'orch:x', kind: 'wizard' }).catch((e: Error) => e);
    for (const kind of WALLET_KINDS) {
      expect((err as Error).message).toContain(kind);
    }
  });

  // STRUCTURAL, because a behavioural test CANNOT tell derivation from
  // coincidence here: with today's three kinds `WALLET_KINDS.join(', ')` is
  // byte-identical to the literal it replaced, so a test asserting the message
  // names each kind passes just as well on a hard-coded string. The drift only
  // becomes visible when the list changes - which is exactly when nobody is
  // running this test against the old message.
  //
  // Measured: re-hardcoding the message survived every behavioural test in this
  // file. So the thing to assert is the DERIVATION, not the output.
  // SCOPED TO parseKind's BODY, not to the file. A whole-file `toContain` is
  // satisfied by the join text appearing ANYWHERE - measured: hardcoding the
  // message while leaving `WALLET_KINDS.join` in a comment survived it. The
  // realistic version is not a planted comment but a SECOND site that
  // legitimately builds a message from the join, after which parseKind can be
  // hardcoded freely and this guard still passes.
  //
  // A source grep cannot tell you WHERE it matched, so the fix is to grep a
  // smaller thing: extract the function's own braces and look only in there.
  it('builds the rejection message FROM the constant, inside parseKind itself', async () => {
    // Comments blanked FIRST: this scan counts braces, and a `}` in prose
    // inside the function truncated the extracted body, so the guard reddened
    // on a comment rather than on a defect. Same bug as fees.test.ts's phantom
    // block, same fix, one helper - a second copy would be a second authority
    // for the rule these guards exist to enforce.
    const src = blankComments(await Bun.file(new URL('../src/spawn.ts', import.meta.url)).text());
    const at = src.indexOf('private parseKind(');
    // Compare to a VALUE: indexOf returns -1 when the function is renamed, and
    // slicing from -1 would silently search the whole file backwards.
    expect(at).toBeGreaterThan(-1);
    const open = src.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(open, end + 1);
    expect(body).toContain("WALLET_KINDS.join(', ')");
    // A narrow regression guard against the exact literal that was here before -
    // documented as narrow, not read as a general ban on the words.
    expect(body).not.toContain("'kind must be one of org, agent, burner'");
  });

  // The constant drives BEHAVIOUR, not only the message: every kind it lists
  // must get PAST validation, or the list is documentation the validator
  // happens to agree with today.
  //
  // Scoped to exactly that claim. This fixture's resolver explodes on contact,
  // so reaching it PROVES validation passed the kind through and proves nothing
  // else - which is the whole of what WALLET_KINDS governs. A full spawn would
  // exercise funding, registration and the chain, and pass or fail for reasons
  // that have nothing to do with this constant.
  it('lets every kind the constant lists through validation', async () => {
    for (const kind of WALLET_KINDS) {
      const { spawner: s } = spawner();
      const err = await s.spawn({ agentId: `orch:k-${kind}`, kind }).catch((e: Error) => e);
      expect((err as Error).message).toContain('resolver must not be reached');
    }
  });


  it('refuses an alias containing a colon, which could impersonate a canonical id', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', alias: 'orch:fake' }))).toBe('invalid_name');
  });

  it('refuses a fundVee with more than 18 decimal places', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', fundVee: '1.0000000000000000001' }))).toBe(
      'invalid_amount',
    );
  });

  // The idempotency marker is the ONLY thing that short-circuits a spawn. A key
  // file alone is not proof: a process that died between writing the key and
  // funding the wallet would otherwise report success for an empty wallet.
  it('returns the recorded wallet without touching the chain once spawned', async () => {
    const store = new Store(':memory:');
    const { spawner: s } = spawner(store);
    store.markSpawned('orch:vendor', '0x1111111111111111111111111111111111111111', null);

    const result = await s.spawn({ agentId: 'orch:vendor', fundVee: 250, kind: 'agent' });
    expect(result.address).toBe('0x1111111111111111111111111111111111111111');
    store.close();
  });
});

// The crash-recovery path, and the ONLY thing that isolates the anti-double-fund
// guard inside fundVee().
//
// Found by mutation: deleting `if (balance >= amount) return;` changed nothing
// in the integration run, because the spawn marker short-circuits a repeat
// spawn long before funding is reached. Two guards, one scenario, so either
// could be deleted and everything stayed green - the same shape as the two
// assertPrivateChain guards in C2a.
//
// The scenario that reaches the inner guard is a spawn that DIED between
// funding the wallet and writing its marker. A retry then re-runs every step
// against a wallet that is already funded, and only the balance check stops it
// minting the seed a second time.
describe('a resumed spawn (marker missing, wallet already funded)', () => {
  it('does not send a second seed', async () => {
    const store = new Store(':memory:');
    const address = '0x2222222222222222222222222222222222222222';
    const seed = 250n * 10n ** 18n;
    const writes: string[] = [];

    const chain = {
      viemChain: { id: 31337 },
      deployment: { treasury: '0x5', chainId: 31337 }, modules: { tokens: [{ key: 'play', address: '0x3', symbol: 'PLAY', decimals: 18 }], names: { address: '0x4', tld: 'play' } },
      publicClient: {
        getBalance: async () => 10n ** 18n, // already endowed with its 1 ETH
        readContract: async () => seed, // already holds the full seed
        waitForTransactionReceipt: async () => ({}),
      },
      walletClient: {
        account: { address: '0x5' },
        sendTransaction: async () => {
          writes.push('sendTransaction');
          return '0xdead';
        },
        writeContract: async () => {
          writes.push('writeContract');
          return '0xbeef';
        },
      },
    } as unknown as Chain;

    const keystore = {
      has: async () => true,
      load: async () => ({ address, privateKey: '0x00' }),
    } as unknown as Keystore;

    const resolver = {
      // Both names already registered to this wallet by the attempt that died.
      // Name-aware rather than answering the same wallet for everything: the
      // default deny list contains `treasury.play`, and a stub claiming that
      // resolves to THIS wallet makes it look like a vanity alias, which the
      // canonical-deny check then correctly refuses.
      lookup: async (name: string) =>
        name === 'treasury.play'
          ? { address: '0x0000000000000000000000000000000000007777', canonical: 'treasury.play' }
          : { address, canonical: 'orch:vendor' },
    } as unknown as Resolver;

    const s = new Spawner(
      { ...config, policyDir: mkdtempSync(join(tmpdir(), 'policies-')) } as Config,
      chain,
      keystore,
      store,
      resolver,
      DEFAULTS,
    );

    const result = await s.spawn({ agentId: 'orch:vendor', fundVee: 250, kind: 'agent', alias: 'sb.play' });

    expect(result.address).toBe(address);
    expect(writes).toEqual([]); // no ETH, no tokens, no registration - nothing to redo
    expect(store.spawnedAddress('orch:vendor')).toBe(address);
    store.close();
  });
});

// §1. SEED FUNDING PER TOKEN.
//
// `fundVee` can only ever name the DEFAULT token, so a two-token deployment
// could not fund its second currency at spawn at all - the wallet arrived
// holding one of the two currencies its game uses.
describe('POST /wallets fund: [{token, amount}]', () => {
  /// A spawner whose keystore RECORDS ANY ACCESS AND THROWS, so a refusal that
  /// arrived late shows as a touched keystore rather than as a passing test.
  /// Local rather than reaching for the one further down the file: that one is
  /// scoped to its own describe, and widening its scope to borrow it would make
  /// two unrelated blocks share a fixture.
  function on(modules: Record<string, unknown>): { s: Spawner; touched: string[] } {
    const touched: string[] = [];
    const s = new Spawner(
      config,
      { modules } as unknown as Chain,
      new Proxy({}, {
        get(_t, prop) {
          touched.push(String(prop));
          throw new Error('the keystore must not be reached: the request was refused first');
        },
      }) as Keystore,
      new Store(':memory:'),
      exploding('resolver') as Resolver,
      DEFAULTS,
    );
    return { s, touched };
  }

  const TWO = {
    tokens: [
      { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 },
      { key: 'au', address: '0xgold', symbol: 'GOLD', decimals: 6 },
    ],
    names: { address: '0xreg', tld: 'play' },
  };

  it('refuses fund AND fundVee together, rather than preferring either', async () => {
    const { s, touched } = on(TWO);
    expect(
      await codeOf(() => s.spawn({ agentId: 'orch:a', fundVee: 1, fund: [{ token: 'au', amount: '1' }] })),
    ).toBe('invalid_request');
    // BEFORE THE FIRST SIDE EFFECT, like every other spawn refusal: a refusal
    // that left a key file behind would make the retry take the idempotent
    // path and report success for the request that was just refused.
    expect(touched).toEqual([]);
  });

  it('refuses a token this deployment does not have, before any side effect', async () => {
    const { s, touched } = on(TWO);
    expect(await codeOf(() => s.spawn({ agentId: 'orch:a', fund: [{ token: 'silver', amount: '1' }] }))).toBe(
      'unknown_token',
    );
    expect(touched).toEqual([]);
  });

  it('refuses the same token named twice, rather than summing or last-wins', async () => {
    // Both readings are defensible, which is exactly what makes choosing
    // between them wrong: the caller wrote something ambiguous about money.
    const { s } = on(TWO);
    expect(
      await codeOf(() =>
        s.spawn({ agentId: 'orch:a', fund: [{ token: 'au', amount: '1' }, { token: 'GOLD', amount: '2' }] }),
      ),
    ).toBe('invalid_request');
  });

  it('refuses an entry that names no token', async () => {
    // An entry in a LIST that names no token is a mistake, where an absent
    // `token` on a single-token request is the documented default. The same
    // argument means different things in the two shapes.
    const { s } = on(TWO);
    expect(await codeOf(() => s.spawn({ agentId: 'orch:a', fund: [{ amount: '1' }] }))).toBe('invalid_request');
  });

  it('refuses a zero or negative amount', async () => {
    const { s } = on(TWO);
    expect(await codeOf(() => s.spawn({ agentId: 'orch:a', fund: [{ token: 'au', amount: '0' }] }))).toBe(
      'invalid_amount',
    );
  });

  it('SEEDS EACH TOKEN FROM ITS OWN CONTRACT, at its own decimals', async () => {
    // THE TEST THE OTHERS EXIST TO SUPPORT. Two tokens whose decimals differ,
    // so an amount parsed at the default token's scale is a 1e12x error rather
    // than an invisible one - the increment-3 defect, which was invisible while
    // every token was 18 dp.
    //
    // Asserting the CONTRACT each transfer addressed as well as the amount:
    // seeding gold from play's contract moves real money on the wrong ledger
    // while reporting a number that looks entirely correct.
    const store = new Store(':memory:');
    const address = '0x2222222222222222222222222222222222222222';
    const sent: Array<{ to: string; args: unknown[] }> = [];
    const chain = {
      viemChain: { id: 31337 },
      deployment: { treasury: '0x5', chainId: 31337 },
      modules: TWO,
      publicClient: {
        getBalance: async () => 10n ** 18n,
        readContract: async () => 0n, // holds nothing yet, so both seeds move
        waitForTransactionReceipt: async () => ({}),
      },
      walletClient: {
        account: { address: '0x5' },
        sendTransaction: async () => '0xdead',
        writeContract: async (a: { address: string; args: unknown[] }) => {
          sent.push({ to: a.address, args: a.args });
          return '0xbeef';
        },
      },
    } as unknown as Chain;

    const s = new Spawner(
      { ...config, policyDir: mkdtempSync(join(tmpdir(), 'policies-')) } as Config,
      chain,
      { has: async () => true, load: async () => ({ address, privateKey: '0x00' }) } as unknown as Keystore,
      store,
      { lookup: async () => null, require: async () => ({ address, canonical: 'orch:a' }) } as unknown as Resolver,
      DEFAULTS,
    );

    await s.spawn({
      agentId: 'orch:a',
      kind: 'burner', // no registration, so the only writes are the two seeds
      fund: [{ token: 'play', amount: '2' }, { token: 'GOLD', amount: '3' }],
    });

    expect(sent).toEqual([
      { to: '0xplay', args: [address, 2n * 10n ** 18n] }, // 2 PLAY at 18 dp
      { to: '0xgold', args: [address, 3_000000n] }, //       3 GOLD at 6 dp
    ]);
    store.close();
  });
});

describe('POST /sign-transfer validation', () => {
  it('refuses a RETIRED wallet before loading its key', async () => {
    const store = new Store(':memory:');
    store.freeze('orch:scammer');
    const t = treasury(store);

    expect(
      await codeOf(() => t.signTransfer(asWallet('orch:scammer'), { to: 'alpha.play', amount: 1 })),
    ).toBe('wallet_retired');
    store.close();
  });

  it('refuses a two-colon destination', async () => {
    const t = treasury();
    expect(
      await codeOf(() => t.signTransfer(asWallet('orch:a'), { to: 'orch:pod1:alice', amount: 1 })),
    ).toBe('invalid_name');
  });

  // The rule that closes the drain: the source comes from the credential, and a
  // body field that disagrees is refused rather than silently overridden.
  it('refuses a body fromAgentId naming another wallet', async () => {
    const t = treasury();
    expect(
      await codeOf(() =>
        t.signTransfer(asWallet('orch:persona'), { fromAgentId: 'orch:victim', to: 'alpha.play', amount: 1 }),
      ),
    ).toBe('principal_mismatch');
  });

  it('refuses the platform credential outright - it has no wallet identity', async () => {
    const t = treasury();
    expect(
      await codeOf(() => t.signTransfer({ scope: 'platform' }, { to: 'alpha.play', amount: 1 })),
    ).toBe('wrong_scope');
  });
});


// The caps are game balance the owner tunes (ledger D8), so they live in
// policy-defaults.example.json and NOT in a constant here. These tests assert the
// wiring - that the right entry is picked and a caller can override it - and
// deliberately do not assert the numbers, which are the spec's to move
// without breaking a build.
describe('policy defaults', () => {
  // Iterates WALLET_KINDS rather than a literal list, so adding a kind extends
  // this test automatically - and a kind added with no defaults fails at
  // STARTUP (loadPolicyDefaults throws by name) rather than at the first spawn
  // of that kind. Measured: adding 'wizard' to the constant stops the service
  // with `policy defaults ... have no valid "wizard" entry`.
  it('has an entry for every wallet kind', () => {
    for (const kind of WALLET_KINDS) {
      // Compared in WEI, not as numbers: a cap may be a decimal string, and
      // comparing those numerically is the imprecision the string form exists
      // to prevent.
      // PER TOKEN now, and asserted for EVERY token the defaults expanded to
      // rather than for one: the `*` entry is copied to each deployed key, so a
      // check of one key would pass while another carried nothing.
      // THE SHIPPED FILE writes both bounds for every kind, so these are
      // asserted non-null rather than skipped: the fields are optional in the
      // TYPE as of v0.8.0 and present in THIS document, and a test that
      // tolerated their absence would stop noticing the file losing one.
      const caps = DEFAULTS[kind].caps!;
      expect(Object.keys(caps).length).toBeGreaterThan(0);
      for (const pair of Object.values(caps)) {
        expect(capToWei(pair.max_per_tx!, 18)).toBeGreaterThan(0n);
        expect(capToWei(pair.max_per_stage!, 18)).toBeGreaterThanOrEqual(capToWei(pair.max_per_tx!, 18));
      }
      // The file ships `treasury.{tld}`; this is the substitution having
      // happened, asserted through the value a wallet actually gets.
      expect(DEFAULTS[kind].deny).toContain('treasury.play');
    }
  });

  // A missing or malformed file must stop the service rather than quietly
  // producing a wallet with no caps at all.
  it('refuses to load a missing or malformed defaults file', () => {
    expect(() => loadPolicyDefaults('/nope/policy-defaults.example.json', 'play', ['play'])).toThrow(/cannot read policy defaults/);
  });

  // §4.7. A pattern naming a TLD can match nothing on a deployment that
  // resolves no names, so it is DROPPED rather than kept as a literal
  // containing `{tld}` - which would read as a rule and match nothing.
  it('drops the TLD patterns when a deployment has no names module, and says so once', () => {
    // The set is process-wide, so this test owns it rather than inheriting
    // whatever another file left in it.
    droppedPatternsLogged.clear();
    const lines: string[] = [];
    const defaults = loadPolicyDefaults(join(PKG, 'policy-defaults.example.json'), undefined, ['play'], (m) => lines.push(m));

    expect(defaults.agent.deny).toEqual([]);
    // `converter` SURVIVES and `*.{tld}` does not, which is the rule working
    // rather than an exception to it: the patterns that drop are the ones that
    // name a TLD, and a CONTRACT KEY names none. A deployment with no names
    // module still has contracts, and an agent may still pay through them -
    // it just cannot pay anyone by name.
    expect(defaults.agent.allow).toEqual(['converter']);
    // `*` names no TLD, so it survives: the org default still allows anything.
    expect(defaults.org.allow).toEqual(['*']);
    expect(defaults.org.deny).toEqual([]);

    // Nothing anywhere contains an unfilled placeholder.
    for (const kind of ['org', 'agent', 'burner'] as const) {
      for (const p of [...(defaults[kind].allow ?? []), ...(defaults[kind].deny ?? [])]) {
        expect(p).not.toContain('{tld}');
      }
    }

    // ONE LINE PER DISTINCT PATTERN, not per kind and not per agent: three
    // kinds share `treasury.{tld}` and two share `*.{tld}`.
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.includes('treasury.{tld}'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('*.{tld}'))).toHaveLength(1);
  });

  it('does not repeat the dropped-pattern line on a second load in the same process', () => {
    const lines: string[] = [];
    loadPolicyDefaults(join(PKG, 'policy-defaults.example.json'), undefined, ['play'], (m) => lines.push(m));
    expect(lines).toHaveLength(0);

    const bad = join(mkdtempSync(join(tmpdir(), 'policy-')), 'p.json');
    writeFileSync(bad, JSON.stringify({ org: {}, agent: {}, burner: {} }));
    expect(() => loadPolicyDefaults(bad, 'play', ['play'])).toThrow(/no valid/);

    const negative = join(mkdtempSync(join(tmpdir(), 'policy-')), 'p.json');
    writeFileSync(
      negative,
      JSON.stringify({
        org: DEFAULTS.org,
        // The bad cap is inside `caps` now, where caps live. Left at the top
        // level it would be a field the loader no longer reads, so the file
        // would be VALID and the test would assert nothing.
        agent: { ...DEFAULTS.agent, caps: { '*': { max_per_tx: -1, max_per_stage: 5 } } },
        burner: DEFAULTS.burner,
      }),
    );
    // The message moved with the shape: a bad cap is now reported by the caps
    // expansion, which names the KIND and the CAPS KEY it was reading. The
    // property is the same - a defaults file with an unusable cap does not
    // load - and the message is more specific than the one it replaces.
    expect(() => loadPolicyDefaults(negative, 'play', ['play'])).toThrow(
      /"agent" caps "\*" is not \{max_per_tx, max_per_stage\} of usable amounts/,
    );
  });

  // A bad CAP is invalid_amount, a bad LIST is invalid_request: a cap is an
  // amount, and a caller sending 25.5 has made an amount mistake rather than a
  // malformed-request one (ruled).
  it('rejects a caller-supplied policy of the wrong shape', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { max_per_tx: 0 } }))).toBe('invalid_amount');
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { max_per_tx: 25.5 } }))).toBe(
      'invalid_amount',
    );
    expect(
      await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { ...DEFAULTS.agent, allow: [1] } })),
    ).toBe('invalid_request');
  });

  // A3, the spawn side. The canonical-deny rule was enforced on the PATCH path
  // only, so `POST /wallets` accepted a vanity-alias deny that PATCH refused -
  // the same document, two rule sets, in the other direction.
  it('refuses a vanity-alias deny at spawn, as PATCH does', async () => {
    const store = new Store(':memory:');
    const s = new Spawner(
      { ...config, policyDir: mkdtempSync(join(tmpdir(), 'policies-')) } as Config,
      exploding('chain') as Chain,
      exploding('keystore') as Keystore,
      store,
      {
        lookup: async (name: string) =>
          name === 'mark.play'
            ? { address: '0x000000000000000000000000000000000000dEaD', canonical: 'orch:mark' }
            : null,
      } as unknown as Resolver,
      DEFAULTS,
    );

    const code = await codeOf(() =>
      s.spawn({ agentId: 'orch:x', kind: 'agent', policy: { deny: ['mark.play'] } }),
    );
    expect(code).toBe('invalid_request');
  });

  // The shape the harness sends, at the endpoint rather than at the merge helper:
  // this is the call that returned 400 against a live stack.
  it('accepts a partial policy at spawn, the harness shape', async () => {
    const { spawner: s } = spawner();
    const code = await codeOf(() =>
      s.spawn({ agentId: 'orch:x', policy: { allow: ['acme:*'], deny: ['treasury.play'] } }),
    );
    // Reaches the chain rather than being refused on the policy - the exploding
    // stub is how we know it got past validation.
    expect(code).not.toBe('invalid_request');
    expect(code).not.toBe('invalid_amount');
  });
});

// THE RELEASE RULE, tested where it can actually go wrong. The store tests
// prove the reservation is atomic; these prove signTransfer does not hand it
// back after the money may already have moved.
// The bound recorded at reservation must be the observed HEAD, not the cursor.
// They are equal after a clean poll, so only a store where they DIVERGE can
// tell the two apart - and that divergence is exactly the window a transfer
// lands in, which is why the cursor is unsound.
describe('the reservation records a sound lower bound', () => {
  it('records the observed head, not the cursor, when they differ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny: [], frozen: false }),
    );
    const store = new Store(':memory:');
    store.setObservedHead(10n);
    store.setCursor('chain-log-tail', 3n); // processed less than it has looked at

    class FailingTreasury extends Treasury {
      protected signerFor(): Signer {
        return {
          prepareTransactionRequest: async (r: Record<string, unknown>) => r,
          signTransaction: async () => '0xsigned' as const,
          sendRawTransaction: async () => {
            throw new Error('socket hang up'); // leaves the reservation unresolved
          },
        };
      }
    }
    const t = new FailingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: {}, modules: { tokens: [{ key: 'play', address: '0x000000000000000000000000000000000000dEaD', symbol: 'PLAY', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      store,
      { require: async () => ({ address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:bob' }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.play' ? null : ({ address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:bob' })) } as unknown as Resolver,
      DEFAULTS,
      closedCallPolicy(),
    );

    await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', intentId: 'bounded' }).catch(() => undefined);

    const row = store.unresolvedIntents().find((r) => r.intentId === 'bounded');
    expect(row?.reservedAtBlock).toBe(10n); // the observed head, not the cursor's 3
    store.close();
  }, 20_000);
});

describe('the release rule', () => {
  const args = { agentId: 'orch:a', stage: 's1', amount: 10n ** 18n, stageCap: { cap: 10n ** 21n } };

  // A send whose broadcast throws is INDISTINGUISHABLE from one that landed and
  // whose response was lost. Releasing here would re-authorise a transfer that
  // may already have happened - which is the double-charge, arriving by way of
  // the caller's entirely correct retry.
  it('keeps the reservation when the broadcast fails', async () => {
    const store = new Store(':memory:');
    const t = treasury(store);
    store.reserve({ token: 'play', intentId: 'i1', ...args });

    const wallet = {
      sendRawTransaction: () => Promise.reject(new Error('socket hang up')),
    };
    await expect(
      (t as unknown as { broadcast: (a: unknown) => Promise<unknown> }).broadcast({
        wallet,
        serializedTransaction: '0xdead',
        intentId: 'i1',
        fromAgentId: 'orch:a',
        memo: null,
      }),
    ).rejects.toThrow();

    expect(store.spentThisStage('orch:a', 's1', 'play')).toBe(args.amount);
    expect(store.reserve({ token: 'play', intentId: 'i1', ...args })).toEqual({ outcome: 'duplicate', txHash: null });
    store.close();
  });

  // The crash window. If the hash is recorded only after the receipt, a process
  // that dies while waiting leaves an intent reserved with no hash - and the
  // retry gets `intent_unresolved` for a send that in fact completed, which is
  // an operator ticket for every dropped connection.
  it('records the hash as soon as the send returns one, before the receipt', async () => {
    const store = new Store(':memory:');
    const t = treasury(store);
    store.reserve({ token: 'play', intentId: 'i2', ...args });

    // `chain` is the exploding proxy, so touching publicClient IS the failure
    // between the send and the receipt.
    await expect(
      (t as unknown as { broadcast: (a: unknown) => Promise<unknown> }).broadcast({
        wallet: { sendRawTransaction: () => Promise.resolve('0xfeed') },
        serializedTransaction: '0xdead',
        intentId: 'i2',
        fromAgentId: 'orch:a',
        memo: null,
      }),
    ).rejects.toThrow();

    expect(store.intentTxHash('orch:a', 'i2')).toBe('0xfeed');
    store.close();
  });

  // signTransfer's two answers to a replay. Neither may reach the chain: one
  // returns the original result, the other refuses for reconciliation. The
  // chain stub explodes on any access, so reaching it fails the test.
  describe('a replayed intent never reaches the chain', () => {
    const replayTreasury = (store: Store) =>
      new Treasury(
        config,
        exploding('chain') as Chain,
        { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
        store,
        { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.play' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null })) } as unknown as Resolver,
        DEFAULTS,
        closedCallPolicy(),
      );
    // NOT treasury.play: that is on the default deny list, so the policy check
    // refuses first and the replay path is never reached - which is the correct
    // ordering, and made this fixture test the wrong thing until it was fixed.
    // `amount`, not `vee`: the alias is a WIRE concern that readBody applies,
    // and a direct method call is not the wire.
    const send = { fromAgentId: 'orch:a', to: 'bob.play', amount: '1', intentId: 'replay' };
    const seed = (store: Store) => {
      const stage = store.currentStage();
      store.reserve({ token: 'play', intentId: 'replay', agentId: 'orch:a', stage, amount: 10n ** 18n, stageCap: { cap: 10n ** 21n } });
    };

    it('returns the ORIGINAL hash when the first send completed', async () => {
      const store = new Store(':memory:');
      seed(store);
      store.completeIntent('orch:a', 'replay', '0xorig');
      expect(await replayTreasury(store).signTransfer(asWallet('orch:a'), send)).toEqual({
        txHash: '0xorig',
        intentId: 'replay',
        intentIdSource: 'caller',
        // A REPLAY CARRIES THEM TOO. Resolution happens before the reservation
        // is consulted, so the replay knows whom it paid and by which rule -
        // and a caller that gets the original hash back without them would have
        // to guess whether the id it used still means the same wallet.
        canonical: null,
        resolvedVia: 'exact',
      });
      store.close();
    });

    it('refuses with intent_unresolved when the first send has no recorded hash', async () => {
      const store = new Store(':memory:');
      seed(store);
      expect(await codeOf(() => replayTreasury(store).signTransfer(asWallet('orch:a'), send))).toBe(
        'intent_unresolved',
      );
      store.close();
    });
  });

  // Structural, and deliberately so: the review warning was that a SECOND
  // catch reasoning about release is the tell. A behavioural test cannot see a
  // release path that has not been written yet, so this asserts the SHAPE.
  //
  // IT USED TO ASSERT "exactly one", which was the same statement while
  // signTransfer was the only thing that reserved. The call op reserves too, so
  // a count is now a proxy for the property rather than the property - and a
  // proxy that goes red for a legitimate second site teaches whoever meets it
  // to raise the number, which is how a guard becomes a formality.
  //
  // THE PROPERTY IS: every release sits in a branch that PROVABLY PRECEDES THE
  // BROADCAST. So each site is located, and the nearest marker comment above it
  // must be the "before" one. That generalises to a third caller and stays a
  // statement about the rule rather than about the file's size.
  it('releases only in branches that provably precede the broadcast', async () => {
    const src = await Bun.file(join(PKG, 'src/treasury.ts')).text();
    const BEFORE = 'PROVABLY BEFORE THE BROADCAST';
    const AFTER = 'AT OR AFTER THE BROADCAST';

    const sites: number[] = [];
    for (let i = src.indexOf('.release('); i !== -1; i = src.indexOf('.release(', i + 1)) {
      sites.push(i);
    }
    // Not zero: a guard that passes when the thing it guards has been deleted
    // is the empty-set failure this codebase has already paid for three times.
    expect(sites.length).toBeGreaterThan(0);

    for (const at of sites) {
      const before = src.lastIndexOf(BEFORE, at);
      const after = src.lastIndexOf(AFTER, at);
      expect(before).toBeGreaterThan(-1);
      expect(before).toBeGreaterThan(after);
    }
  });
});

// A caller that forgets intentId loses idempotency. That is its choice to make,
// but it must be able to SEE that it made it - otherwise the first anyone knows
// is a double-charge nobody can explain.
describe('a missing intent id is visible, not silent', () => {
  const noIntent = new Treasury(
    config,
    exploding('chain') as Chain,
    { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
    new Store(':memory:'),
    { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.play' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null })) } as unknown as Resolver,
    DEFAULTS,
    closedCallPolicy(),
  );

  it('warns, naming the generated id and what was lost', async () => {
    const said: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void said.push(a.join(' '));
    try {
      await noIntent.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1' }).catch(() => undefined);
    } finally {
      console.warn = real;
    }

    const warned = said.join('\n');
    expect(warned).toContain('no intentId');
    expect(warned).toContain('NOT deduplicated');
    expect(warned).toMatch(/chain-svc:[0-9a-f-]{36}/); // the id it generated, so it can be traced
  });

  it('says nothing when the caller did supply one', async () => {
    const said: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void said.push(a.join(' '));
    try {
      await noIntent
        .signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', intentId: 'mine' })
        .catch(() => undefined);
    } finally {
      console.warn = real;
    }
    expect(said.join('\n')).not.toContain('no intentId');
  });
});

// THE REGRESSION, PINNED WHERE IT HAPPENED. The store-level probe proves the
// reservation primitive is atomic - but the defect was never in the primitive,
// it was the ORDER in signTransfer. Measured: moving only the over_stage_cap
// check past the broadcast leaves the entire store-level suite green at 118/118
// while every concurrent send reaches the chain. This drives the whole of
// signTransfer and counts BROADCASTS, which is the thing the cap has to bound.
describe('concurrent signTransfer against a stage cap', () => {
  /// A Treasury whose signer is a counter. Nothing else is stubbed: the policy,
  /// the reservation, the ordering and the release rule are all the real ones.
  class CountingTreasury extends Treasury {
    broadcasts = 0;
    protected signerFor(): Signer {
      return {
        prepareTransactionRequest: async () => ({}),
        signTransaction: async () => '0xsigned' as const,
        sendRawTransaction: async () => {
          this.broadcasts++;
          return `0x${String(this.broadcasts).padStart(64, '0')}` as `0x${string}`;
        },
      };
    }
  }

  async function treasuryWithStageCap(veePerStage: number): Promise<CountingTreasury> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({
        agentId: 'orch:a',
        max_per_tx: 100,
        max_per_stage: veePerStage,
        allow: ['*.play'],
        deny: [],
        frozen: false,
      }),
    );
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: {}, modules: { tokens: [{ key: 'play', address: '0x0', symbol: 'PLAY', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.play' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null })) } as unknown as Resolver,
      DEFAULTS,
      closedCallPolicy(),
    );
  }

  /// Same harness, but the resolver reports a CANONICAL that differs from the
  /// requested name - which is what an alias is.
  async function treasuryResolving(canonical: string, deny: string[]): Promise<CountingTreasury> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny, frozen: false }),
    );
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: {}, modules: { tokens: [{ key: 'play', address: '0x0', symbol: 'PLAY', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.play' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical })) } as unknown as Resolver,
      DEFAULTS,
      closedCallPolicy(),
    );
  }

  // THE RULED TEST, end to end. The unit tests pass `canonical` in by
  // hand, so they prove enforcePolicy uses it - they cannot prove signTransfer
  // RESOLVES FIRST and hands it over. Measured: with the call site reverted to
  // the pre-resolution order, every unit test still passes and this one fails.
  it('refuses an ALIAS of a denied wallet, and never reaches the chain', async () => {
    const t = await treasuryResolving('treasury.play', ['treasury.play']);
    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'treasure.play', amount: '1', intentId: 'alias-1' }),
    );
    expect(code).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // The control: the same wallet, not denied, must still go through - otherwise
  // a probe that refuses everything would pass the test above.
  it('still sends to an alias whose wallet is not denied', async () => {
    const t = await treasuryResolving('orch:bob', []);
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', intentId: 'alias-2' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  /// A resolver where a deny entry and the requested name are DIFFERENT names
  /// for the SAME address - the case no amount of string matching can catch.
  async function treasuryWithAliases(deny: string[], sameAddress: string[]): Promise<CountingTreasury> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny, frozen: false }),
    );
    const SHARED = '0x000000000000000000000000000000000000bEEF';
    const OTHER = '0x000000000000000000000000000000000000dEaD';
    const addressOf = (n: string) => (sameAddress.includes(n) ? SHARED : OTHER);
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: {}, modules: { tokens: [{ key: 'play', address: '0x0', symbol: 'PLAY', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      {
        require: async (n: string) => ({ address: addressOf(n), canonical: 'orch:someone' }),
        // No NAMESPACE PEERS in this fixture: a real registry resolves the
        // names that exist, and `orch:marky.play` does not. A blanket resolver
        // makes every bare name ambiguous with its own constructed peer.
        lookup: async (n: string) =>
          n.includes(':') ? null : { address: addressOf(n), canonical: 'orch:someone' },
      } as unknown as Resolver,
      DEFAULTS,
      closedCallPolicy(),
    );
  }

  // THE CASE NAME MATCHING CANNOT REACH. The deny names one alias; the caller
  // uses a DIFFERENT alias of the same wallet. Neither string matches the entry
  // and the canonical matches neither, so only comparing ADDRESSES catches it.
  it('refuses a wallet denied under a different alias entirely', async () => {
    const t = await treasuryWithAliases(['mark.play'], ['mark.play', 'marky.play']);
    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'id-1' }),
    );
    expect(code).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // The control: a different wallet with a similar name still goes through, so
  // the identity check is not simply refusing everything.
  it('still sends to a DIFFERENT wallet when a deny entry exists', async () => {
    const t = await treasuryWithAliases(['mark.play'], ['mark.play']);
    await t.signTransfer(asWallet('orch:a'), { to: 'someone-else.play', amount: '1', intentId: 'id-2' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  // A deny-entry resolve that FAILS is not the same as one that finds nothing,
  // and they now get opposite answers (ruled). Splitting them is the
  // whole point: "there is no such denied identity" is an answer, "I could not
  // find out" is not.
  function treasuryWhoseLookup(lookup: (n: string) => Promise<unknown>): CountingTreasury {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({
        agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000,
        allow: ['*'], deny: ['mark.play'], frozen: false,
      }),
    );
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: {}, modules: { tokens: [{ key: 'play', address: '0x0', symbol: 'PLAY', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      {
        require: async () => ({ address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:someone' }),
        // The callback models THE DENY ENTRY's registry state over time, which
        // is what every test here varies. Since §5 the resolution path calls
        // `lookup` too, so the TARGET is resolved explicitly rather than
        // falling into the callback and making every test also a test of
        // whether `marky.play` exists - which none of them are about.
        //
        // Wrapped the way the real Resolver.lookup wraps: a failed registry
        // read reaches callers as a chain error, never as a raw Error, so a
        // stub that throws raw would be testing a collaborator that does not
        // exist.
        lookup: async (n: string) => {
          if (n === 'marky.play') {
            return { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:someone' };
          }
          if (n.includes(':')) return null; // no namespace peers in this fixture
          try {
            return await lookup(n);
          } catch (err) {
            throw asChainError(err);
          }
        },
      } as unknown as Resolver,
      DEFAULTS,
      closedCallPolicy(),
    );
  }

  // READ FAILED -> refuse. Admitting a transfer we could not evaluate the deny
  // list against errs in the one direction a cap must not.
  it('refuses when a deny entry cannot be resolved, rather than sending anyway', async () => {
    const t = treasuryWhoseLookup(async () => {
      throw new Error('registry read failed');
    });
    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'f-1' }),
    );
    expect(['chain_error', 'chain_unreachable']).toContain(code);
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // NOT FOUND -> proceed. An unregistered deny entry names no identity, which
  // is a real answer and not an unknown.
  it('sends when a deny entry names nothing registered', async () => {
    const t = treasuryWhoseLookup(async () => null);
    await t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'f-2' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  // The failure is not cached, so a registry that recovers starts denying
  // again. Caching it would turn one failed read into a wallet un-denied for
  // the life of the process.
  it('does not remember a failed resolve, so recovery restores the deny', async () => {
    let calls = 0;
    const t = treasuryWhoseLookup(async () => {
      if (++calls === 1) throw new Error('registry read failed');
      return { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:someone' };
    });

    const first = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'f-3' }),
    );
    expect(['chain_error', 'chain_unreachable']).toContain(first);

    const second = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'f-4' }),
    );
    expect(second).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // A REVIEW'S FIXTURE, one line different from the read-failure one and the
  // difference is the whole finding: a deny entry that is NOT YET REGISTERED
  // resolves to null, and "not registered" is as transient as "read failed" -
  // names get registered, that is what the game does. Deny a counterparty by
  // canonical id BEFORE that agent is spawned, spawn it, and a cached null
  // un-denies its aliases for the life of the process.
  it('denies a wallet whose deny entry was registered AFTER an earlier send', async () => {
    let registered = false;
    const t = treasuryWhoseLookup(async () =>
      registered ? { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:mark' } : null,
    );

    // First send: the deny entry names nothing yet, so nothing matches.
    await t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'l-1' });
    expect(t.broadcasts).toBe(1);

    // The name is now registered, to the same wallet the alias points at.
    registered = true;

    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'l-2' }),
    );
    expect(code).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(1); // still one: the second never reached the chain
  }, 20_000);

  // And the other direction, which a cached POSITIVE would get wrong:
  // `setTargetFor` re-points a name and retirement clears it, so a resolution
  // that was correct once can stop being correct.
  it('stops denying once the deny entry no longer resolves to that wallet', async () => {
    let pointsAtTarget = true;
    const t = treasuryWhoseLookup(async () =>
      pointsAtTarget
        ? { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:mark' }
        : { address: '0x000000000000000000000000000000000000dEaD', canonical: 'orch:mark' },
    );

    expect(
      await codeOf(() => t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'l-3' })),
    ).toBe('counterparty_denied');

    pointsAtTarget = false;
    await t.signTransfer(asWallet('orch:a'), { to: 'marky.play', amount: '1', intentId: 'l-4' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  it('broadcasts exactly floor(cap/amount) of N concurrent sends', async () => {
    const t = await treasuryWithStageCap(100); // one 100-VEE send fits
    const send = (n: number) =>
      t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '100', intentId: `i${n}` });

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => send(n)));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const capped = results.filter(
      (r) => r.status === 'rejected' && (r.reason as HttpError).code === 'over_stage_cap',
    );

    expect(ok).toHaveLength(1);
    expect(capped).toHaveLength(7);
    // The assertion the store-level test cannot make: seven sends never reached
    // the chain at all. If the cap moves after the broadcast this is 8.
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  it('broadcasts five of ten when the cap is a multiple', async () => {
    const t = await treasuryWithStageCap(500);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, n) =>
        t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '100', intentId: `j${n}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(t.broadcasts).toBe(5);
  }, 20_000);

  // The control: without it, a probe that always reports "1 broadcast" would
  // pass for the wrong reason.
  it('broadcasts a single sequential send that fits, so the probe can pass', async () => {
    const t = await treasuryWithStageCap(100);
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '100', intentId: 'solo' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);
});

// A REVERT AT GAS ESTIMATION IS A REVERT, NOT A CHAIN ERROR - on the transfer
// path too.
//
// THE THIRD INSTANCE OF ONE DEFECT. admin-call's simulate had it, then the
// wallet `call` gas-estimate path, and `asCallError` was written for both. This
// path kept `asChainError` because nothing could reach it: `prepareTransactionRequest`
// estimates gas, and until the token had a freeze, a well-formed transfer had
// no contract-level revert available - the balance is checked before signing.
//
// Measured against a real Anvil before the fix, a frozen wallet's send answered
//   {"error":"chain_error","detail":"Execution reverted with reason:
//    custom error 0x4f2a367e: 000...8dab55de..."}
// - a 502 saying the NODE is broken, carrying the AccountFrozen selector and
// the frozen account's address to a wallet-scope caller.
describe('a revert while signing a transfer', () => {
  class RevertingSigner extends Treasury {
    protected signerFor(): Signer {
      return {
        // The shape viem produces for a custom error at estimation. The message
        // is what must NOT cross, so the fixture makes it recognisable: a test
        // whose fake reason could not appear in a reply proves nothing about
        // whether reasons appear in replies.
        prepareTransactionRequest: async () => {
          throw new Error(
            'Execution reverted with reason: custom error 0x4f2a367e: 000000000000000000000000dead.',
          );
        },
        signTransaction: async () => '0xsigned' as const,
        sendRawTransaction: async () => {
          throw new Error('the wire must not be reached: the estimate refused first');
        },
      };
    }
  }

  async function reverting(): Promise<{ t: RevertingSigner; store: Store }> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 100, max_per_stage: 500, allow: ['*'], deny: [], frozen: false }),
    );
    const store = new Store(':memory:');
    const t = new RevertingSigner(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: { treasury: '0x000000000000000000000000000000000000bEEF' }, treasury: '0x000000000000000000000000000000000000bEEF', modules: { tokens: [{ key: 'play', address: '0x0', symbol: 'PLAY', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}), readContract: async () => 100n * 10n ** 18n } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      store,
      { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }), lookup: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }) } as unknown as Resolver,
      DEFAULTS,
      closedCallPolicy(),
    );
    return { t, store };
  }

  it('answers `revert`, not `chain_error`', async () => {
    const { t, store } = await reverting();
    let err: HttpError | undefined;
    try {
      await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', intentId: 'r-1' });
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('revert');
    expect(err?.status).toBe(409);
    expect(err?.detail).toBe('the call was mined and reverted; nothing changed');
    store.close();
  });

  it('does not carry the revert data to the caller', async () => {
    // THE SELECTOR AND THE PAYLOAD, not the decoded name: viem gives a custom
    // error as hex, so a check for `AccountFrozen` would pass on a reply
    // carrying the whole thing. That exact mistake was in the compose smoke and
    // it passed while the leak was live.
    const { t, store } = await reverting();
    let err: unknown;
    try {
      await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', intentId: 'r-2' });
    } catch (e) {
      err = e;
    }
    const wire = JSON.stringify(err);
    expect(wire).not.toMatch(/0x4f2a367e/);
    expect(wire).not.toMatch(/custom error/i);
    expect(wire).not.toMatch(/0x[0-9a-f]{16,}/i);
    store.close();
  });

  // THE FOURTH INSTANCE, platform scope. `setBalance`'s SWEEP signs with the
  // WALLET's key, so a downward reset against a frozen wallet reverts at gas
  // estimation - and answered 502 chain_error with AccountFrozen's selector and
  // the frozen address, to an OPERATOR who asked for a balance reset.
  //
  // Both the spec and this PR's body said the operator gets `revert`. They were
  // describing the behaviour the send path has; nothing made it true here, and
  // the evaluator measured it false. Four paths, one defect, and each was
  // unreachable until something made a revert possible on it.
  it('the sweep answers `revert` too, and carries no revert data', async () => {
    const { t, store } = await reverting();
    let err: HttpError | undefined;
    try {
      // ABOVE the target, so the sweep branch runs rather than the top-up: the
      // two exits differ in which key signs, and only the sweep uses the
      // wallet's. A fixture below target would take the fund path and pass
      // while the sweep stayed broken.
      await t.setBalance('orch:a', { amount: '1', intentId: 's-rev' });
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('revert');
    expect(err?.detail).toBe('the call was mined and reverted; nothing changed');
    const wire = JSON.stringify(err);
    expect(wire).not.toMatch(/0x4f2a367e/);
    expect(wire).not.toMatch(/custom error/i);
    store.close();
  });

  it('releases the reservation, because nothing reached the wire', async () => {
    // An estimate is a READ. The stage hold comes back, or a frozen wallet
    // would burn its stage budget on sends that never happened.
    const { t, store } = await reverting();
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', intentId: 'r-3' }).catch(() => undefined);
    expect(store.spentThisStage('orch:a', store.currentStage(), 'play')).toBe(0n);
    store.close();
  });
});

// Harness spec S3. Set-balance is the one endpoint that can move money OUT of an
// agent's wallet, so the tests are about what it CANNOT do as much as what it can.
describe('POST /wallets/:agentId/balance', () => {
  const WALLET = '0x000000000000000000000000000000000000bEEF';
  const TREASURY = '0x0000000000000000000000000000000000007777';
  const vee = (n: number) => BigInt(n) * 10n ** 18n;

  /// Records every transfer the chain was asked to make, so a test can assert
  /// the DESTINATION and not just the resulting balance.
  class RecordingTreasury extends Treasury {
    sent: Array<{ to: string; amount: bigint }> = [];
    balance = 0n;
    /// Decodes the calldata and MOVES THE BALANCE, so the re-read at the end of
    /// setBalance sees what a real chain would. A fake that accepted the
    /// transfer without applying it would make the outcome-vs-intention test
    /// pass for the wrong reason - it would be reading a number that never
    /// changed, which is the defect the re-read exists to catch.
    protected signerFor(): Signer {
      let pending = 0n;
      return {
        prepareTransactionRequest: async (req: Record<string, unknown>) => {
          const { args } = decodeFunctionData({ abi: TokenAbi, data: req.data as `0x${string}` });
          pending = (args as readonly [string, bigint])[1];
          return req;
        },
        signTransaction: async () => '0xsigned' as const,
        sendRawTransaction: async () => {
          this.balance -= pending;
          this.sent.push({ to: TREASURY, amount: pending });
          return '0xswept' as `0x${string}`;
        },
      };
    }
  }

  function treasuryAt(
    balance: bigint,
    frozen = false,
    /// What the TREASURY holds, distinct from what the wallet holds. Ample by
    /// default so the tests that are about set-balance stay about set-balance.
    treasuryFloat = vee(1_000_000),
  ): { t: RecordingTreasury; store: Store } {
    const store = new Store(':memory:');
    store.markSpawned('orch:a', WALLET, null);
    if (frozen) store.freeze('orch:a');
    const t = new RecordingTreasury(
      { ...config, policyDir: '/tmp/none' } as Config,
      {
        viemChain: {},
        treasury: TREASURY,
        deployment: { treasury: TREASURY }, modules: { tokens: [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }] },
        publicClient: {
          // KEYED ON WHOSE BALANCE IS ASKED FOR. One stub answering `t.balance`
          // for every address meant the treasury's float and the wallet's
          // balance were the same number - so a fixture could not express "the
          // treasury is short" at all, and §1's guard had nothing to fail
          // against. The same collapse the resolver table's third token exists
          // to prevent, one layer down.
          readContract: async ({ args }: { args?: readonly unknown[] } = {}) =>
            args?.[0] === TREASURY ? treasuryFloat : t.balance,
          waitForTransactionReceipt: async () => ({}),
        },
        walletClient: {
          account: {},
          writeContract: async ({ args }: { args: [string, bigint] }) => {
            t.sent.push({ to: args[0], amount: args[1] });
            t.balance += args[1];
            return '0xfunded' as `0x${string}`;
          },
        },
      } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: WALLET }) } as unknown as Keystore,
      store,
      { require: async () => ({ address: WALLET, canonical: 'orch:a' }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.play' ? null : ({ address: WALLET, canonical: 'orch:a' })) } as unknown as Resolver,
      DEFAULTS,
      closedCallPolicy(),
    );
    t.balance = balance;
    return { t, store };
  }

  // Review recorded this against the pre-merge trees: `setBalance` reserves an
  // intent, and its TOP-UP branch called `fund` without it while the SWEEP
  // branch passed it through - so a top-up was the one money movement whose
  // intent could not be joined from /history. Both sides compiled, which is why
  // it needed a test rather than a rebase.
  it('a TOP-UP records the intent id on its memo', async () => {
    const { t, store } = treasuryAt(vee(10));
    await t.setBalance('orch:a', { amount: '100', intentId: 'top-up-1' });
    expect(store.memosFor(['0xfunded']).get('0xfunded')?.intentId).toBe('top-up-1');
  }, 20_000);

  it('a SWEEP records the intent id on its memo', async () => {
    const { t, store } = treasuryAt(vee(100));
    await t.setBalance('orch:a', { amount: '40', intentId: 'sweep-1' });
    expect(store.memosFor(['0xswept']).get('0xswept')?.intentId).toBe('sweep-1');
  }, 20_000);

  it('funds the difference when the balance is below target', async () => {
    const { t } = treasuryAt(vee(10));
    const res = await t.setBalance('orch:a', { amount: '100', intentId: 'b-1' });
    expect(res.balance).toBe('100');
    expect(t.sent).toEqual([{ to: WALLET, amount: vee(90) }]);
  }, 20_000);

  it('sweeps the difference to the TREASURY when above target', async () => {
    const { t } = treasuryAt(vee(100));
    const res = await t.setBalance('orch:a', { amount: '40', intentId: 'b-2' });
    expect(res.balance).toBe('40');
    expect(res.txHash).toBe('0xswept');
  }, 20_000);

  // A4. The reply used to be `formatVee(target)` at both exits - the INTENTION,
  // not the outcome, since `current` was read several awaits before the
  // transfer landed. It is what the harness's Wallets panel shows.
  it('reports the MEASURED balance, not the one it intended to set', async () => {
    const { t } = treasuryAt(vee(100));

    // The chain applies only part of the sweep - a partial fill, a fee, any
    // reason the outcome differs from the intention.
    const realSigner = (t as unknown as { signerFor: () => Signer }).signerFor.bind(t);
    (t as unknown as { signerFor: () => Signer }).signerFor = () => {
      const s = realSigner();
      return { ...s, sendRawTransaction: async () => { t.balance = vee(42); return '0xpartial' as `0x${string}`; } };
    };

    const res = await t.setBalance('orch:a', { amount: '40', intentId: 'b-measured' });

    // 42, what the chain holds - not 40, what we asked for.
    expect(res.balance).toBe('42');
  }, 20_000);

  it('does nothing at all when the balance is already correct', async () => {
    const { t } = treasuryAt(vee(50));
    const res = await t.setBalance('orch:a', { amount: '50', intentId: 'b-3' });
    expect(res).toEqual({ balance: '50' });
    expect(res.txHash).toBeUndefined();
    expect(t.sent).toHaveLength(0);
  }, 20_000);

  // An operator resetting is not an agent spending, so the freeze does not stop
  // it. This is the invariant sweepToTreasury changes, asserted rather than
  // described.
  it('sets the balance of a FROZEN wallet', async () => {
    const { t } = treasuryAt(vee(100), true);
    const res = await t.setBalance('orch:a', { amount: '40', intentId: 'b-4' });
    expect(res.balance).toBe('40');
  }, 20_000);

  // THE CONTAINMENT. Not "a `to` field is ignored" - a body carrying one is
  // REFUSED, because an ignored field is one somebody wires up later.
  it('refuses a body that tries to name a destination', async () => {
    const { t } = treasuryAt(vee(100));
    const code = await codeOf(() =>
      t.setBalance('orch:a', { amount: '40', to: '0xattacker', intentId: 'b-5' }),
    );
    expect(code).toBe('invalid_request');
    expect(t.sent).toHaveLength(0);
  }, 20_000);

  // Idempotency has two halves here and they are different mechanisms.
  //
  // The cheap half: once the balance IS the target, a repeat is a no-op before
  // any reservation is consulted, because "already correct" is the answer.
  it('a repeat after success moves nothing, because the balance is already right', async () => {
    const { t } = treasuryAt(vee(10));
    await t.setBalance('orch:a', { amount: '100', intentId: 'same' });
    const before = t.sent.length;

    const again = await t.setBalance('orch:a', { amount: '100', intentId: 'same' });

    expect(again).toEqual({ balance: '100' });
    expect(t.sent).toHaveLength(before);
  }, 20_000);

  // The half that matters: the caller RETRIES because it never saw the
  // response, so from its side nothing happened - and here the balance has not
  // settled either. Only the intent reservation can tell these apart, and it
  // answers with the original transaction instead of funding a second time.
  it('replays the original transaction when the caller retries a lost response', async () => {
    const { t } = treasuryAt(vee(10));
    const first = await t.setBalance('orch:a', { amount: '100', intentId: 'same' });
    const before = t.sent.length;

    t.balance = vee(10); // the retry sees the pre-transfer state

    const second = await t.setBalance('orch:a', { amount: '100', intentId: 'same' });

    expect(second.txHash).toBe(first.txHash);
    expect(t.sent).toHaveLength(before); // and did NOT fund again
  }, 20_000);

  // Platform scope has no stage cap, so a large reset is not refused as
  // over_stage_cap - the null cap hold, asserted through the endpoint.
  it('is not subject to the stage cap', async () => {
    const { t, store } = treasuryAt(vee(0));
    const res = await t.setBalance('orch:a', { amount: '100000', intentId: 'b-6' });
    expect(res.balance).toBe('100000');
    expect(store.spentThisStage('orch:a', store.currentStage(), 'play')).toBe(0n);
  }, 20_000);
});

// Harness spec S3. The only way back from frozen; DELETE /wallets keeps meaning
// retirement and stays irreversible.
describe('PATCH /wallets/:agentId/policy', () => {
  function spawnerWith(canonicalOf: Record<string, string> = {}): { s: Spawner; store: Store; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const store = new Store(':memory:');
    // KINDED, as of v0.8.0. The merge base for a PATCH is the wallet's OWN
    // kind's default, read from this row - so a row with a NULL kind has no
    // kind default to merge onto and every test here would be patching against
    // nothing. The row was `null` because until now `policyFor` took the
    // `agent` defaults for every wallet regardless of kind, and the fixture
    // never had to say which kind it was.
    store.markSpawned('orch:a', '0x000000000000000000000000000000000000bEEF', 'agent');
    const s = new Spawner(
      { ...config, policyDir: dir } as Config,
      exploding('chain') as Chain,
      exploding('keystore') as Keystore,
      store,
      {
        lookup: async (n: string) =>
          canonicalOf[n] ? { address: '0x000000000000000000000000000000000000dEaD', canonical: canonicalOf[n] } : null,
      } as unknown as Resolver,
      DEFAULTS,
    );
    return { s, store, dir };
  }

  const read = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'orch%3Aa.json'), 'utf8')) as Record<string, unknown> & {
      caps: Record<string, { max_per_tx: unknown; max_per_stage: unknown }>;
    };

  // Every field, both directions: the one supplied changes and EVERY omitted
  // one survives. Asserting only the supplied field would leave the fallbacks
  // untested - a patch that quietly reset an omitted cap to a default would
  // pass, and that is a cap silently lowered or raised on a live wallet.
  it('updates only the fields present, leaving every other one alone', async () => {
    const { s, dir } = spawnerWith();

    await s.patchPolicy('orch:a', { max_per_stage: 4242 });

    // A PATCH carrying the legacy pair still means the DEFAULT token, and only
    // that token: the other half of the pair and every other token's caps come
    // from the kind's defaults untouched. A patch that widened one number must
    // not silently reset the rest.
    const p = read(dir);
    expect(p.caps.play).toEqual({
      max_per_stage: 4242,
      max_per_tx: DEFAULTS.agent.caps!.play!.max_per_tx,
    });
    expect(p.allow).toEqual(DEFAULTS.agent.allow);
    expect(p.deny).toEqual(DEFAULTS.agent.deny);
  }, 20_000);

  it('preserves an earlier patch when a later one touches a different field', async () => {
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { max_per_tx: 250 });
    await s.patchPolicy('orch:a', { max_per_stage: 999 });
    // BOTH HALVES OF ONE TOKEN'S PAIR, and the property is unchanged by the
    // reshape: a patch naming one number leaves the other alone. What the
    // reshape adds is that it also leaves every OTHER token's pair alone,
    // asserted below.
    const p = read(dir);
    expect(p.caps.play).toEqual({ max_per_tx: 250, max_per_stage: 999 });
  }, 20_000);

  // §3. `frozen` LEFT THE PATCH BODY. These two rows asserted that a PATCH
  // flipped the freeze both ways and that the STORE was the authority; the
  // service-side lock is retirement now, written by `retire()` alone, and
  // freezing a LIVE wallet is the Token contract's job through admin-call.
  //
  // REFUSED, NOT IGNORED. An ignored field is one somebody wires up later, and
  // an operator who sends `{frozen: true}` expecting a wallet to stop spending
  // must not get a 200 and a wallet that keeps spending.
  it('refuses `frozen` rather than ignoring it, and names both replacements', async () => {
    const { s, store } = spawnerWith();
    let err: unknown;
    try {
      await s.patchPolicy('orch:a', { frozen: true });
    } catch (e) {
      err = e;
    }
    expect((err as HttpError).code).toBe('invalid_request');
    expect((err as HttpError).detail).toContain('DELETE');
    expect((err as HttpError).detail).toContain('admin-call');
    // AND NOTHING HAPPENED. A refusal that had already frozen the wallet would
    // be the worst of both.
    expect(store.isRetired('orch:a')).toBe(false);
  }, 20_000);

  it('does not write `frozen` into the document it stores', async () => {
    // The field is gone from the written shape, not merely from the body -
    // wallet-mcp stopped reading it, and a value nothing writes and nothing
    // reads is the comment-contradicts-code defect in data form.
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { max_per_stage: 99 });
    expect('frozen' in read(dir)).toBe(false);
  }, 20_000);

  // §5's durable rule: a deny entry names a canonical id or a platform name.
  // The two are indistinguishable by shape, so the registry decides.
  it('refuses a deny entry that is a vanity alias', async () => {
    const { s } = spawnerWith({ 'mark.play': 'orch:mark' });
    const code = await codeOf(() => s.patchPolicy('orch:a', { deny: ['mark.play'] }));
    expect(code).toBe('invalid_request');
  }, 20_000);

  it('accepts a deny entry that IS the canonical name for its address', async () => {
    const { s, dir } = spawnerWith({ 'treasury.play': 'treasury.play' });
    await s.patchPolicy('orch:a', { deny: ['treasury.play'] });
    expect(read(dir).deny).toEqual(['treasury.play']);
  }, 20_000);

  // Accepted on purpose: it names no identity today, and refusing it would make
  // a policy un-writable until the wallet it names exists - inverting the spawn
  // order the harness needs.
  it('accepts a deny entry that resolves to nothing yet', async () => {
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { deny: ['orch:notyet'] });
    expect(read(dir).deny).toEqual(['orch:notyet']);
  }, 20_000);

  it('refuses a malformed pattern in either list', async () => {
    const { s } = spawnerWith();
    expect(await codeOf(() => s.patchPolicy('orch:a', { deny: ['a*b'] }))).toBe('invalid_request');
    expect(await codeOf(() => s.patchPolicy('orch:a', { allow: ['a*b'] }))).toBe('invalid_request');
  }, 20_000);

  // Same codes as POST /wallets now, because it is the same validator: a bad
  // CAP is invalid_amount, a bad LIST is invalid_request.
  it('refuses a cap that is not an amount, with the same code POST uses', async () => {
    const { s } = spawnerWith();
    for (const bad of [0, -5, 1.5, '', 'lots', null]) {
      expect(await codeOf(() => s.patchPolicy('orch:a', { max_per_tx: bad }))).toBe('invalid_amount');
    }
  }, 20_000);

  // A2/A3: a wallet must be patchable in the form it was spawned with.
  it('leaves every other token\'s caps alone when a patch names one', async () => {
    // The multi-token half of the same property. A patch carrying the legacy
    // pair is about the DEFAULT token; a second token's caps are not its
    // business, and silently resetting them would be the widest possible
    // reading of the narrowest possible request.
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { caps: { play: { max_per_tx: 5, max_per_stage: 6 }, gold: { max_per_tx: 7, max_per_stage: 8 } } });
    await s.patchPolicy('orch:a', { max_per_tx: 250 });
    const p = read(dir);
    expect(p.caps.gold).toEqual({ max_per_tx: 7, max_per_stage: 8 });
    expect(p.caps.play).toEqual({ max_per_tx: 250, max_per_stage: 6 });
  }, 20_000);

  it('accepts a STRING cap, the form POST /wallets accepts', async () => {
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { max_per_tx: '25' });
    expect(read(dir).caps.play!.max_per_tx).toBe('25');
  }, 20_000);

  it('refuses to patch a wallet that does not exist', async () => {
    // A VALID FIELD, so this tests what its name says. It used to send
    // `{frozen: true}` as an arbitrary payload; `frozen` is now refused in its
    // own right, and the row would have passed on whichever refusal came first
    // - a test that cannot tell which of two guards answered it.
    const { s } = spawnerWith();
    expect(await codeOf(() => s.patchPolicy('orch:nobody', { max_per_tx: 5 }))).toBe('wallet_not_found');
  }, 20_000);

  // THE WRITE PATH AND THE READ PATH AGREE ABOUT ONE DOCUMENT, which is the
  // property the gate/parse fix restores and the one the security review found
  // broken end to end.
  //
  // At 60da6e4 a spawn carrying a caps-only policy, on a deployment with no
  // defaults file, WROTE a document `normalisePolicy` then threw on - so the
  // read turned it into the unreadable marker and every spend refused. The
  // service bricked the wallet at birth, with its own file.
  //
  // Driven through spawn and policyFor rather than through the two functions,
  // because that is where the two halves meet: a unit test of either alone
  // passed throughout.
  it('reads back a caps-only policy it wrote at spawn, with no defaults loaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const store = new Store(':memory:');
    const chain = {
      viemChain: {},
      deployment: {},
      modules: { tokens: [{ key: 'play', address: '0x0', symbol: 'PLAY', decimals: 18 }] },
      publicClient: { getBalance: async () => 10n ** 18n, waitForTransactionReceipt: async () => ({}) },
      walletClient: { account: {}, sendTransaction: async () => '0xdead' },
    } as unknown as Chain;
    // NO KIND DEFAULTS, which is the condition: with defaults loaded the
    // written document carries allow/deny from them and the old gate passed.
    //
    // This `null` did not mean that when the test was written. The constructor
    // took the argument as optional and fell back with `??`, so null and absent
    // were the same thing and the example defaults were loaded anyway - the
    // document under test carried `allow: ["converter"]` and the mutant it was
    // built to catch survived it. The parameter is now required and null is an
    // answer; if that ever regresses, this test goes quiet again rather than
    // failing - so what proves it is a mutant, not a reading: restore the old
    // allow+deny gate in normalisePolicy and this test must go red.
    const s = new Spawner(
      { ...config, policyDir: dir } as Config,
      chain,
      { has: async () => false, create: async () => ({ address: '0x000000000000000000000000000000000000bEEF' }) } as unknown as Keystore,
      store,
      { lookup: async () => null } as unknown as Resolver,
      null,
    );

    await s.spawn({ agentId: 'orch:capsonly', kind: 'agent', policy: { caps: { play: { max_per_tx: '500' } } } });

    // The file exists, and what it says is what comes back.
    const t = new Treasury(
      { ...config, policyDir: dir } as Config,
      chain,
      exploding('keystore') as Keystore,
      store,
      exploding('resolver') as Resolver,
      null,
      closedCallPolicy(),
    );
    const read = await (t as unknown as { policyFor(a: string): Promise<AgentPolicy | null> }).policyFor('orch:capsonly');
    expect(read?.caps?.play).toEqual({ max_per_tx: '500' });
  }, 20_000);

  // §1 + the security review's finding 23. `clear` DELETES A FILE, and the four
  // states it can be asked to delete in are not the same operation.
  describe('PATCH { clear: true }', () => {
    it('refuses a wallet that was never spawned, rather than reporting success', () => {
      // FOUND BY THE SECURITY REVIEW, and it was mine: the clear branch sat
      // ABOVE the exists check, so clearing a typo'd id answered
      // `{cleared: true}`. `rm --force` is silent by design, so nothing else
      // could have said otherwise - and "done" is the one answer a clear must
      // never give when it looked at nothing.
      const { s } = spawnerWith();
      return expect(codeOf(() => s.patchPolicy('orch:nobody', { clear: true }))).resolves.toBe(
        'wallet_not_found',
      );
    });

    it('deletes a file that is there', async () => {
      const { s, dir } = spawnerWith();
      await s.patchPolicy('orch:a', { max_per_tx: 100 });
      expect(existsSync(join(dir, 'orch%3Aa.json'))).toBe(true);
      expect(await s.patchPolicy('orch:a', { clear: true })).toEqual({ agentId: 'orch:a', cleared: true });
      expect(existsSync(join(dir, 'orch%3Aa.json'))).toBe(false);
    });

    it('is not an error when there is no file', async () => {
      // IDEMPOTENT. "This wallet has no rules of its own" is the state being
      // asked for, and it is already true - refusing would make an operator
      // check before every clear.
      const { s } = spawnerWith();
      expect(await s.patchPolicy('orch:a', { clear: true })).toEqual({ agentId: 'orch:a', cleared: true });
    });

    it('WORKS on an unreadable file, which is the way out of one', async () => {
      // The row that matters: a PATCH over an unreadable file is refused, so
      // clear is the only way back. It reads nothing, so there is nothing for a
      // bad document to break.
      const { s, dir } = spawnerWith();
      writeFileSync(join(dir, 'orch%3Aa.json'), '{ this is not json');
      expect(await s.patchPolicy('orch:a', { clear: true })).toEqual({ agentId: 'orch:a', cleared: true });
      expect(existsSync(join(dir, 'orch%3Aa.json'))).toBe(false);
    });

    it('refuses any other field alongside it', async () => {
      // "Delete the file and also set this" has two readings that differ in
      // what the wallet ends up with, and neither is worth guessing.
      const { s } = spawnerWith();
      expect(await codeOf(() => s.patchPolicy('orch:a', { clear: true, max_per_tx: 5 }))).toBe(
        'invalid_request',
      );
    });

    it('refuses `clear: false` rather than treating it as absent', async () => {
      const { s } = spawnerWith();
      expect(await codeOf(() => s.patchPolicy('orch:a', { clear: false }))).toBe('invalid_request');
    });
  });

  // §3. THE REPLY SHAPE, which nothing in this suite asserted. Changing
  // `{frozen: true}` to `{retired: true}` broke no test - the only thing that
  // reads it is the compose smoke, which needs Docker and so says nothing in
  // CI. A reply shape a consumer parses deserves a test that runs everywhere.
  it('replies { retired: true }, not { frozen: true }', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:a', '0x000000000000000000000000000000000000bEEF', 'agent');
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const s = new Spawner(
      { ...config, policyDir: dir } as Config,
      { modules: { tokens: [], names: undefined } } as unknown as Chain,
      exploding('keystore') as Keystore,
      store,
      { aliasesOf: async () => [], clearAliases: async () => undefined } as unknown as Resolver,
      DEFAULTS,
    );
    expect(await s.retire('orch:a')).toEqual({ retired: true });
    expect(store.isRetired('orch:a')).toBe(true);
    store.close();
  }, 20_000);
});

// ── The kind reaches the STORE ──────────────────────────────────────────────
//
// The column round-trips and the endpoint reads it - and neither shows that
// SPAWN puts the real kind in. Measured: replacing `kind` with `null` at
// `spawn.ts`'s markSpawned call left every other test in this package green,
// which is the same defect as the bare-id counter that nothing read. A value
// recorded by nobody and a value recorded wrongly are both invisible to tests
// of the recorder.
describe('spawn records the kind it enforced', () => {
  const completing = (store: Store) => {
    const address = '0x000000000000000000000000000000000000bEEF';
    const chain = {
      viemChain: {},
      deployment: {}, modules: { tokens: [{ key: 'play', address: '0x0', symbol: 'PLAY', decimals: 18 }], names: { address: '0x1', tld: 'play' } },
      publicClient: {
        getBalance: async () => 10n ** 18n,      // already endowed
        readContract: async () => 10n ** 30n,    // already funded
        waitForTransactionReceipt: async () => ({}),
      },
      walletClient: {
        account: { address: '0x5' },
        sendTransaction: async () => '0xdead',
        writeContract: async () => '0xbeef',
      },
    } as unknown as Chain;
    const keystore = { has: async () => true, load: async () => ({ address, privateKey: '0x00' }) } as unknown as Keystore;
    const resolver = {
      lookup: async (name: string) =>
        name === 'treasury.play'
          ? { address: '0x0000000000000000000000000000000000007777', canonical: 'treasury.play' }
          : { address, canonical: 'orch:kindwire' },
      reverseOf: async () => 'orch:kindwire',
      aliasesOf: async () => [],
    } as unknown as Resolver;
    return new Spawner(
      { ...config, policyDir: mkdtempSync(join(tmpdir(), 'policies-')) } as Config,
      chain, keystore, store, resolver, DEFAULTS,
    );
  };

  // `org` rather than `agent`: `parseKind` defaults to 'agent', so asserting
  // 'agent' would pass on a spawn that recorded nothing and let the default
  // answer for it.
  it('stores the kind the caller asked for, not the default', async () => {
    const store = new Store(':memory:');
    await completing(store).spawn({ agentId: 'orch:kindwire', kind: 'org' });
    expect(store.walletRow('orch:kindwire')?.kind).toBe('org');
    store.close();
  });

  // A burner takes the other registration branch, so this also pins that the
  // record does not depend on names having been registered.
  it('stores burner, which registers no names at all', async () => {
    const store = new Store(':memory:');
    await completing(store).spawn({ agentId: 'orch:kindburner', kind: 'burner' });
    expect(store.walletRow('orch:kindburner')?.kind).toBe('burner');
    store.close();
  });
});

// §4.4 / §8.4. THE TWO OPTIONAL HALVES OF A SPAWN, refused before anything is
// written. Both guards existed with no test until a mutation run said so:
// disabling either left the whole suite green.
//
// The assertion is not only the refusal but WHEN it happens. Refusing after
// keystore.create would leave a key file behind, and the retry after that
// refusal would take the idempotent path and report success for the request
// that was just refused - so each case checks the store has no spawn row and
// the keystore was never reached.
describe('a spawn refuses what this deployment cannot do', () => {
  function spawnerOn(modules: Record<string, unknown>): { s: Spawner; store: Store; touched: string[] } {
    const touched: string[] = [];
    const store = new Store(':memory:');
    const s = new Spawner(
      config,
      { modules } as unknown as Chain,
      new Proxy(
        {},
        {
          get(_t, prop) {
            touched.push(String(prop));
            throw new Error('the keystore must not be reached: the request was refused first');
          },
        },
      ) as Keystore,
      store,
      exploding('resolver') as Resolver,
      DEFAULTS,
    );
    return { s, store, touched };
  }

  const TOKENS = [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }];
  const NAMES = { address: '0xreg', tld: 'play' };

  it('refuses fundVee without a token module, before any side effect', async () => {
    const { s, store, touched } = spawnerOn({ tokens: [], names: NAMES });

    expect(await codeOf(() => s.spawn({ agentId: 'orch:a', fundVee: 10 }))).toBe('module_not_deployed');
    expect(touched).toEqual([]);
    expect(store.spawnedAddress('orch:a')).toBeNull();
    store.close();
  });

  it('refuses an alias without a names module, before any side effect', async () => {
    const { s, store, touched } = spawnerOn({ tokens: TOKENS });

    expect(await codeOf(() => s.spawn({ agentId: 'orch:a', alias: 'a.play' }))).toBe('module_not_deployed');
    expect(touched).toEqual([]);
    expect(store.spawnedAddress('orch:a')).toBeNull();
    store.close();
  });

  // THE HALVES ARE INDEPENDENT. A spawn needs NEITHER module: a wallet is a
  // key, a token and a policy file, and all three exist on a deployment with no
  // contracts at all. Only the optional halves need one each - so asking for
  // neither must get past both guards, and the proof it got past them is that
  // it reached the keystore.
  it('lets a spawn asking for neither reach the keystore on a bare deployment', async () => {
    const { s, store, touched } = spawnerOn({ tokens: [] });

    await s.spawn({ agentId: 'orch:a' }).catch(() => undefined);
    expect(touched.length).toBeGreaterThan(0);
    store.close();
  });

  it('accepts fundVee zero without a token module, because nothing moves', async () => {
    const { s, store, touched } = spawnerOn({ tokens: [] });

    await s.spawn({ agentId: 'orch:a', fundVee: 0 }).catch(() => undefined);
    expect(touched.length).toBeGreaterThan(0);
    store.close();
  });
});
