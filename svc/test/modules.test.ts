// §8.4. THE ROUTE GATE, through a real listening server rather than by calling
// `assertModulesDeployed` directly.
//
// The gate is one line in `handle()`, and the bug that matters is not "does the
// function refuse?" - it is "does a request actually reach it, and in the right
// order relative to authentication?". A unit test of the predicate cannot tell
// the difference between a gate that runs and a gate that is never called.
//
// Each deployment shape gets its own server, because the module view is built
// once at boot and read from `chain.modules` on every request: that is what the
// real service does, and a test that mutated it between requests would be
// exercising a lifecycle nothing has.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import { createChainSvcServer, type Services } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { hashToken } from '../src/auth.ts';

const TOKEN = 'platform-credential';
const WALLET_TOKEN = 'wallet-credential';
const AGENT = 'orch:a';
const ADDRESS = '0x1111111111111111111111111111111111111111';

const TOKEN_MODULE = { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 };
const NAMES_MODULE = { address: '0xreg', tld: 'play' };

interface Harness {
  server: Server;
  base: string;
  store: Store;
}

/// Fills in the FLAT VIEW from the typed slots the caller passed.
///
/// Derived rather than written out at each call site, for the reason the flat
/// view exists at all: the two views are built from one manifest pass in
/// `buildModules`, so a fixture that supplied them independently could describe
/// a deployment that cannot happen - a token in `tokens` and not in `byKey`.
function withRegistry(modules: Record<string, unknown>): Record<string, unknown> {
  const entries: Array<Record<string, unknown>> = [];
  for (const t of (modules.tokens as Array<Record<string, unknown>>) ?? []) {
    entries.push({ key: t.key, kind: 'token', name: 'Token', address: t.address, abi: [] });
  }
  if (modules.names) {
    entries.push({
      key: 'names',
      kind: 'names',
      name: 'NameRegistry',
      address: (modules.names as Record<string, unknown>).address,
      abi: [],
    });
  }
  if (modules.converter) {
    entries.push({
      key: 'converter',
      kind: 'converter',
      name: 'Converter',
      address: (modules.converter as Record<string, unknown>).address,
      abi: [],
    });
  }
  return {
    ...modules,
    contracts: entries,
    byKey: new Map(entries.map((e) => [e.key as string, e])),
  };
}

async function serve(typedModules: Record<string, unknown>): Promise<Harness> {
  const modules = withRegistry(typedModules);
  const store = new Store(':memory:');
  store.setWalletTokenHash(AGENT, hashToken(WALLET_TOKEN));
  store.markSpawned(AGENT, ADDRESS, 'agent');

  const services = {
    config: { token: TOKEN },
    store,
    // `GET /wallets/:id` reports the effective policy and its source (§1). This
    // harness describes a deployment that loads no kind defaults, so `none` is
    // the honest answer rather than a placeholder.
    spawner: {
      effectivePolicy: async () => ({ policy: null, policySource: 'none' as const }),
    },
    chain: {
      deployment: { chainId: 31337, treasury: '0xtreasury' },
      modules,
      // Any handler that gets past the gate on these shapes would need a chain;
      // none of the assertions below should, and this makes that a failure
      // rather than a silent pass against a mock.
      publicClient: {
        readContract: () => {
          throw new Error('the chain must not be reached in a gating test');
        },
      },
    },
    resolver: {
      lookup: async () => null,
      require: async () => {
        throw new Error('the resolver must not be reached in a gating test');
      },
      reverseOf: async () => null,
      aliasesOf: async () => [],
    },
  } as unknown as Services;

  const server = createChainSvcServer(services);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, store };
}

const platform = { authorization: `Bearer ${TOKEN}` };
const wallet = { authorization: `Bearer ${WALLET_TOKEN}` };

async function code(h: Harness, method: string, path: string, headers = platform): Promise<string> {
  const res = await fetch(`${h.base}${path}`, { method, headers });
  if (res.status === 200) return 'ok';
  return ((await res.json()) as { error: string }).error;
}

describe('a names-only deployment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({ tokens: [], names: NAMES_MODULE });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('refuses every money route with module_not_deployed', async () => {
    expect(await code(h, 'GET', '/supply')).toBe('module_not_deployed');
    expect(await code(h, 'GET', '/balance/orch%3Aa', wallet)).toBe('module_not_deployed');
    expect(await code(h, 'POST', '/fund')).toBe('module_not_deployed');
    expect(await code(h, 'POST', '/sign-transfer', wallet)).toBe('module_not_deployed');
  });

  it('serves the name routes', async () => {
    // 404 from the HANDLER, not from the gate: the route is open on this
    // deployment and the name is simply not registered. Distinguishing those
    // two answers is the whole point of the assertion - a gate that refused
    // here would look identical to a working deployment with no such name.
    //
    // Asked with the wallet credential so it takes the bare-id path through
    // `lookup`, leaving `require` as a tripwire for the tests that must not
    // reach the resolver at all.
    expect(await code(h, 'GET', '/resolve/nothing', wallet)).toBe('unknown_name');
  });

  // §1: `balances` on the wallet row ONLY when a token module exists. The
  // route's `requires` stays EMPTY so the endpoint survives here - a wallet on
  // a names-only deployment still has an address, a kind and a canonical, and
  // those are what it is for. OMITTED rather than `{}`: an empty map says "this
  // wallet holds nothing", absent says "this deployment has no tokens", and a
  // consumer that branches on the field learns different things from each.
  it('serves the wallet row WITHOUT balances', async () => {
    const res = await fetch(`${h.base}/wallets/${encodeURIComponent(AGENT)}`, { headers: platform });
    expect(res.status).toBe(200);
    const row = (await res.json()) as Record<string, unknown>;
    expect('balances' in row).toBe(false);
    // The rest of the row is there, which is what makes the absence a
    // statement about tokens rather than about the endpoint being broken.
    expect(row.agentId).toBe(AGENT);
    expect(row.kind).toBe('agent');
  });

  it('lists only the deployed module on /health and /modules', async () => {
    expect(await (await fetch(`${h.base}/health`)).json()).toEqual({ ok: true, modules: ['names'] });
    const m = (await (await fetch(`${h.base}/modules`, { headers: platform })).json()) as Record<string, unknown>;
    expect(m.defaultToken).toBeNull();
    expect(m.tokens).toEqual([]);
    expect(m.names).toEqual({ address: '0xreg', tld: 'play' });
  });
});

describe('a token-only deployment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({ tokens: [TOKEN_MODULE] });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('refuses every name route with module_not_deployed', async () => {
    expect(await code(h, 'GET', '/resolve/anything')).toBe('module_not_deployed');
    expect(await code(h, 'GET', '/reverse/0xabc')).toBe('module_not_deployed');
    expect(await code(h, 'POST', '/aliases')).toBe('module_not_deployed');
  });

  it('lists only the deployed module', async () => {
    expect(await (await fetch(`${h.base}/health`)).json()).toEqual({ ok: true, modules: ['token:play'] });
    const m = (await (await fetch(`${h.base}/modules`, { headers: platform })).json()) as Record<string, unknown>;
    expect(m.defaultToken).toBe('play');
    expect(m.names).toBeNull();
  });
});

describe('a two-token deployment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({
      tokens: [TOKEN_MODULE, { key: 'gold', address: '0xgold', symbol: 'GOLD', decimals: 18 }],
      names: NAMES_MODULE,
    });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('names the FIRST token as the default and lists both', async () => {
    const m = (await (await fetch(`${h.base}/modules`, { headers: platform })).json()) as {
      defaultToken: string;
      tokens: Array<{ key: string }>;
    };
    expect(m.defaultToken).toBe('play');
    expect(m.tokens.map((t) => t.key)).toEqual(['play', 'gold']);
  });

  it('sorts /health so two deployments with the same modules compare equal', async () => {
    expect(await (await fetch(`${h.base}/health`)).json()).toEqual({
      ok: true,
      modules: ['names', 'token:gold', 'token:play'],
    });
  });
});

// THE ORDER OF THE TWO CHECKS, which is the half of this that is a security
// property rather than a usability one.
describe('the gate does not run before authentication', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({ tokens: [], names: NAMES_MODULE });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('answers an unauthenticated caller with unauthorized, not module_not_deployed', async () => {
    // /fund needs a token this deployment does not have, so a gate running
    // first would answer module_not_deployed - and a stranger could map which
    // modules a deployment has by reading which refusal each path returns.
    const res = await fetch(`${h.base}/fund`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  it('answers a wrong-scope caller with wrong_scope, not module_not_deployed', async () => {
    const res = await fetch(`${h.base}/fund`, { method: 'POST', headers: wallet });
    expect(((await res.json()) as { error: string }).error).toBe('wrong_scope');
  });
});

// §4.4 / §8.4. A SPAWN ON A DEPLOYMENT WITH NO REGISTRY still produces a
// wallet: a key, a wallet token and a policy file need no contracts. It simply
// has no name.
//
// This is the case the review caught, and it failed in a way worth recording:
// registration ran for every non-burner kind regardless of modules, so the
// registry write reached `requireNames`, threw module_not_deployed, and came
// back to the caller as 502 chain_error because asChainError rewrapped it. A
// refusal about the deployment's SHAPE, reported as the chain being broken.
import { Spawner } from '../src/spawn.ts';
import { Keystore } from '../src/keystore.ts';
import { loadPolicyDefaults } from '../src/policy.ts';
import { asChainError } from '../src/chain.ts';
import { Resolver } from '../src/resolver.ts';
import { Treasury, skippedDenyEntriesLogged } from '../src/treasury.ts';
import { HttpError } from '../src/errors.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closedCallPolicy } from '../src/calls.ts';

describe('spawning without a names module', () => {
  const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

  function spawnerOn(modules: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-nonames-'));
    const store = new Store(':memory:');
    const registryCalls: string[] = [];
    const chain = {
      modules,
      publicClient: {
        waitForTransactionReceipt: async () => ({}),
        // endowGas reads the balance before topping it up; already funded, so
        // the spawn takes the no-op branch and the gas path is not what this
        // test is about.
        getBalance: async () => 10n ** 18n,
      },
      // Any registry write would have to come through here; recording rather
      // than throwing, so the assertion can be "it was never attempted" instead
      // of "it threw something".
      walletClient: {
        writeContract: async ({ functionName }: { functionName: string }) => {
          registryCalls.push(functionName);
          return '0xtx';
        },
      },
      viemChain: {},
      treasury: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    } as unknown as import('../src/chain.ts').Chain;

    const s = new Spawner(
      { policyDir: dir, policyDefaultsPath: join(PKG, 'policy-defaults.example.json'), rpcUrl: 'http://x' } as never,
      chain,
      new Keystore(join(dir, 'keys'), 'secret-secret-secret-secret'),
      store,
      { lookup: async () => null, require: async () => null } as never,
      loadPolicyDefaults(join(PKG, 'policy-defaults.example.json'), undefined, []),
    );
    return { s, store, registryCalls };
  }

  it('spawns an agent and never attempts a registration', async () => {
    const { s, store, registryCalls } = spawnerOn({
      tokens: [{ key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 }],
    });

    const out = await s.spawn({ agentId: 'orch:a' });

    expect(out.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(store.spawnedAddress('orch:a')).toBe(out.address);
    expect(registryCalls).toEqual([]);
    store.close();
  });
});

// The rule the above depends on, tested on its own because it applies to every
// call site in chain.ts rather than just that one.
describe('asChainError', () => {
  it('passes an HttpError through untouched, because a refusal is not a chain error', () => {
    const refusal = new HttpError('module_not_deployed', 'this deployment has no names module');
    expect(asChainError(refusal)).toBe(refusal);
    expect(asChainError(refusal).code).toBe('module_not_deployed');
  });

  it('still classifies what has not already been classified', () => {
    expect(asChainError(new Error('fetch failed')).code).toBe('chain_unreachable');
    expect(asChainError(new Error('execution reverted')).code).toBe('chain_error');
  });

  // FINDING 11: the detail is a FIXED STRING per code, and the raw line goes to
  // the log - the split `asCallError` already makes for a revert.
  //
  // The reviewer's two shapes. viem's first line carries whatever the node
  // said: RPC urls, internal addresses, encoded calldata. Both codes are
  // persona-facing and their detail crosses with them, so that text reached a
  // model through a refusal - and a persona can do nothing with it either way,
  // since the remedy for both is "tell an operator".
  it('says the same thing whatever the node said', () => {
    const transport = new Error(
      'fetch failed\nURL: http://chain-internal.hub.local:8545\nRequest body: {"method":"eth_call"}',
    );
    const revert = new Error(
      'execution reverted\nRaw Call Arguments:\n  to: 0x5FbDB2315678afecb367f032d93F642f64180aa3\n  data: 0xa9059cbb',
    );
    expect(asChainError(transport).detail).toBe('node unreachable');
    expect(asChainError(revert).detail).toBe('chain call failed');
  });

  // THE CONTROL: the raw text is not merely absent from the body, it is PRESENT
  // in the log. Asserting the fixed string alone would pass on a build that
  // threw the diagnostic away entirely, which is safe and useless - the point
  // is that the operator still has it.
  it('control: the raw line reaches the log and not the body', () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      const err = asChainError(new Error('execution reverted\n  to: 0xdeadbeef secret-rpc.internal'));
      expect(err.detail).not.toContain('0xdeadbeef');
      expect(err.detail).not.toContain('secret-rpc.internal');
      expect(lines.join('\n')).toContain('0xdeadbeef');
    } finally {
      console.warn = warn;
    }
  });
});

// §4.4 / §8.8. WHAT A DENY LIST MEANS ON A DEPLOYMENT WITH NO REGISTRY.
//
// The rule is not "deny lists stop working". Entries that are AGENT IDS still
// bind, because the store can resolve those. Entries that are NAMES cannot
// resolve, so they are skipped - and that is harmless only because nothing can
// be addressed by name either, which is a different reason from the one the
// pattern-matching code gives.
//
// It is said out loud once per distinct entry per process, because a deny list
// is a safety expectation and an operator should not have to infer that part of
// theirs is inert.
describe('deny entries without a names module', () => {
  const PKG2 = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ADDR_B_LOCAL = '0x2222222222222222222222222222222222222222';

  function treasuryWith(deny: string[], agent: string) {
    const dir = mkdtempSync(join(tmpdir(), 'deny-nonames-'));
    writeFileSync(
      join(dir, `${encodeURIComponent(agent)}.json`),
      JSON.stringify({ agentId: agent, max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny, frozen: false }),
    );
    const store = new Store(':memory:');
    store.markSpawned(agent, '0x9999999999999999999999999999999999999999', null);
    store.markSpawned('orch:b', ADDR_B_LOCAL, null);

    const chain = {
      viemChain: {},
      modules: { tokens: [{ key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 }] },
      publicClient: { waitForTransactionReceipt: async () => ({}) },
      walletClient: { writeContract: async () => '0xsent' },
    } as unknown as import('../src/chain.ts').Chain;

    const resolver = new Resolver(chain, store);
    const t = new Treasury(
      { policyDir: dir, policyDefaultsPath: join(PKG2, 'policy-defaults.example.json') } as never,
      chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x9999999999999999999999999999999999999999' }) } as never,
      store,
      resolver,
      loadPolicyDefaults(join(PKG2, 'policy-defaults.example.json'), undefined, []),
      closedCallPolicy(),
    );
    return { t, store };
  }

  const code = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
      return 'no-error';
    } catch (e) {
      return (e as HttpError).code ?? 'not-an-HttpError';
    }
  };

  // AN AGENT ID STILL BINDS. The store resolves it, so the rule has something
  // to compare and the refusal is the same one a registry deployment gives.
  it('still refuses a send to a denied AGENT ID', async () => {
    const { t, store } = treasuryWith(['orch:b'], 'orch:a');
    expect(
      await code(() => t.signTransfer({ scope: 'wallet', agentId: 'orch:a' }, { to: 'orch:b', amount: '1', intentId: 'd1' })),
    ).toBe('counterparty_denied');
    store.close();
  });

  // ONCE PER DISTINCT ENTRY PER PROCESS, across two sends from two DIFFERENT
  // agents. Per-agent would print it once per wallet on a names-less
  // deployment, because every agent without its own policy file inherits the
  // same defaults; per-send would print it on every transfer, because policyFor
  // re-reads the file each time by design.
  it('says an unresolvable deny entry is skipped exactly once, whoever sends', async () => {
    skippedDenyEntriesLogged.clear();
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => lines.push(m);
    try {
      // The send must RESOLVE for the deny loop to run at all: a send TO the
      // unresolvable name fails at resolution first, before any deny entry is
      // considered. So both sends go to a spawned agent, and it is the deny
      // ENTRY that cannot resolve.
      const a = treasuryWith(['treasury.play'], 'orch:a');
      await code(() =>
        a.t.signTransfer({ scope: 'wallet', agentId: 'orch:a' }, { to: 'orch:b', amount: '1', intentId: 'x1' }),
      );
      a.store.close();

      const b = treasuryWith(['treasury.play'], 'orch:c');
      await code(() =>
        b.t.signTransfer({ scope: 'wallet', agentId: 'orch:c' }, { to: 'orch:b', amount: '1', intentId: 'x2' }),
      );
      b.store.close();
    } finally {
      console.warn = warn;
    }

    expect(lines.filter((l) => l.includes('treasury.play'))).toHaveLength(1);
  });

  // A NAME CANNOT RESOLVE, so the entry is skipped - and the send fails for the
  // OTHER reason, which is that the recipient cannot be addressed either.
  it('skips a deny entry that is a NAME, and the send fails as unknown_name', async () => {
    const { t, store } = treasuryWith(['treasury.play'], 'orch:a');
    expect(
      await code(() =>
        t.signTransfer({ scope: 'wallet', agentId: 'orch:a' }, { to: 'treasury.play', amount: '1', intentId: 'd2' }),
      ),
    ).toBe('unknown_name');
    store.close();
  });
});
