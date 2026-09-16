// The store and the chain state share one lifetime (spec S4), and the pair can
// come apart in two directions. #52 detects the store wiped beside a live
// chain. This is the other direction: the chain replaced while the store
// survives, which leaves every spawn marker pointing at names that no longer
// exist and has no repair path.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { blankComments } from './support/source.ts';
import { assertDeploymentUnchanged, ChainSwapError, type DeploymentIdentity } from '../src/deployment.ts';
import { Resolver } from '../src/resolver.ts';
import { loadDeployment, type Chain, type Deployment } from '../src/chain.ts';
import type { HttpError } from '../src/errors.ts';
import { buildModules } from '../src/modules.ts';

const ADDR_A = '0x1111111111111111111111111111111111111111' as const;
const ADDR_B = '0x2222222222222222222222222222222222222222' as const;

const A: DeploymentIdentity = { chainId: '31337', modules: [{ kind: 'token' as const, key: 'play', address: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }, { kind: 'names' as const, address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' }] };
const B: DeploymentIdentity = {
  ...A,
  modules: [{ ...A.modules[0]!, address: '0x0000000000000000000000000000000000000BBB' }, A.modules[1]!],
};

const codeOf = (fn: () => void) => {
  try {
    fn();
    return 'no-throw';
  } catch (err) {
    return (err as { code?: string }).code ?? 'not-coded';
  }
};

describe('the chain this store belongs to', () => {
  it('starts clean on a store that has never seen a deployment', () => {
    expect(codeOf(() => assertDeploymentUnchanged(null, A, false))).toBe('no-throw');
  });

  it('starts clean when the deployment is the one it was written against', () => {
    expect(codeOf(() => assertDeploymentUnchanged(A, A, false))).toBe('no-throw');
  });

  // The whole finding. Same store, different chain.
  it('REFUSES when the chain has been replaced under the store', () => {
    expect(codeOf(() => assertDeploymentUnchanged(A, B, false))).toBe('chain_replaced_under_store');
  });

  // A redeploy onto a fresh chain moves the contract addresses even when the
  // chain id is identical - which is exactly the case that cost three rebuilds,
  // and which a chain-id-only check would miss.
  it('notices a redeploy that keeps the same chain id', () => {
    expect(A.chainId).toBe(B.chainId);
    expect(codeOf(() => assertDeploymentUnchanged(A, B, false))).toBe('chain_replaced_under_store');
  });

  it('notices a different chain id with the same addresses', () => {
    const other = { ...A, chainId: '1337' };
    expect(codeOf(() => assertDeploymentUnchanged(A, other, false))).toBe('chain_replaced_under_store');
  });

  // Addresses are compared case-insensitively: EIP-55 checksumming is a display
  // choice, and a store written before a client started checksumming would
  // otherwise report a swap that never happened.
  it('does not report a swap on a checksum difference alone', () => {
    const lower = { ...A, modules: A.modules.map((m) => ({ ...m, address: m.address.toLowerCase() })) };
    expect(codeOf(() => assertDeploymentUnchanged(A, lower, false))).toBe('no-throw');
  });

  it('names BOTH deployments and the way out', () => {
    let message = '';
    try { assertDeploymentUnchanged(A, B, false); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(A.modules[0]!.address);
    expect(message).toContain(B.modules[0]!.address);
    expect(message).toContain('--acknowledge-chain-reset');
    // The symptom points at the one component that is fine, so the message has
    // to say which thing is actually wrong.
    expect(message).toContain('unknown_name');
    expect(message).toContain('only the PAIRING is wrong');
  });

  describe('the acknowledgement', () => {
    it('permits the boot', () => {
      expect(codeOf(() => assertDeploymentUnchanged(A, B, true))).toBe('no-throw');
    });

    // IT PERMITS AND DOES NOT RESOLVE. Quieting it would be a detector
    // reporting "fixed" when nothing is fixed: the wallets are still
    // unregistered and the operator still meets unknown_name at runtime.
    // Updating the record is repair's job, at the point where "these now agree"
    // becomes true.
    it('does not make the disagreement go away for the next boot', () => {
      expect(codeOf(() => assertDeploymentUnchanged(A, B, true))).toBe('no-throw');
      // Same inputs, no acknowledgement: still refused.
      expect(codeOf(() => assertDeploymentUnchanged(A, B, false))).toBe('chain_replaced_under_store');
    });
  });
});

describe('the store records which chain it belongs to', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deploy-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads back null before anything is recorded', () => {
    const s = new Store(join(dir, 'a.sqlite'));
    expect(s.recordedDeployment()).toBeNull();
    s.close();
  });

  it('records and reads back the identity', () => {
    const path = join(dir, 'b.sqlite');
    const s = new Store(path);
    s.recordDeployment(A);
    s.close();
    const again = new Store(path);
    expect(again.recordedDeployment()).toEqual(A);
    again.close();
  });

  // WRITTEN ONCE. A second record must not overwrite the first, or an
  // acknowledged boot that happens to call it would silently resolve the
  // disagreement it was told to tolerate.
  it('never overwrites what it already recorded', () => {
    const s = new Store(join(dir, 'c.sqlite'));
    s.recordDeployment(A);
    s.recordDeployment(B);
    expect(s.recordedDeployment()).toEqual(A);
    s.close();
  });
});

// THE CALL SITE, structurally - the same idiom as the ledger-lifetime guard,
// and for the same reason: the decision and the facts are pinned above, and the
// WIRE that connects them lives in index.ts where no test reaches. A constant
// there would leave this control dormant with every test green.
describe('the call site in index.ts', () => {
  const indexSrc = () => Bun.file(new URL('../src/index.ts', import.meta.url)).text();

  it('wires the check to the real store and the real deployment', async () => {
    // Comments blanked with the shared helper, so a comment naming the call
    // cannot be mistaken for the call. This started as a count of the call
    // form - an honest weaker instrument, used because the helper was on an
    // unmerged branch - and the weaker one is gone rather than left in the tree
    // with a promise to collapse it later.
    const src = blankComments(await indexSrc());
    const call = src.indexOf('assertDeploymentUnchanged(');
    expect(call).toBeGreaterThan(-1);
    const wiring = src.slice(src.indexOf('const liveDeployment ='), call + 160);

    // Each fact from its own source, not a literal. The identity is now a
    // module LIST, so the wiring to check is that the list is built from the
    // loaded deployment's own modules rather than from anything reconstructed.
    expect(wiring).toContain('deployment.chainId');
    expect(wiring).toContain('deployment.modules.map(');
    expect(wiring).toContain('kind: m.kind');
    expect(wiring).toContain('address: m.address');
    expect(wiring).toContain('store.recordedDeployment()');
    expect(wiring).toContain('config.acknowledgeChainReset');
  });

  // ORDER MATTERS. A store pointed at a chain it was not written against cannot
  // resolve any name it recorded, so a later check would be reasoning about a
  // pairing that is already known to be wrong - and nothing may serve first.
  it('runs BEFORE the ledger check and before the server listens', async () => {
    const src = blankComments(await indexSrc());
    const swap = src.indexOf('assertDeploymentUnchanged(');
    const ledger = src.indexOf('assertLedgerLifetimeIntact(');
    const listen = src.indexOf('server.listen');
    expect(swap).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(swap).toBeLessThan(ledger);
    expect(swap).toBeLessThan(listen);
  });

  // RECORDED ONLY WHEN THERE IS NOTHING RECORDED. If the entrypoint recorded
  // unconditionally, an acknowledged boot would overwrite the old identity and
  // the next boot would see agreement - the detector reporting "fixed" when
  // nothing was fixed. The store refuses the overwrite too; this pins that the
  // entrypoint does not ask for it.
  it('records only on a store that has never seen a deployment', async () => {
    const src = blankComments(await indexSrc());
    const at = src.indexOf('store.recordDeployment(');
    expect(at).toBeGreaterThan(-1);
    const line = src.slice(src.lastIndexOf('\n', at) + 1, at);
    expect(line).toContain('recordedDeployment === null');
  });
});

// §4.5. A deployment with no names module still has wallets, and the store is
// the only record of which agent owns which address. These pin that the branch
// answers from the store and does NOT invent registry behaviour to go with it.
describe('resolution without a names module', () => {
  const namesless = (store: Store) =>
    new Resolver(
      {
        modules: { tokens: [{ key: 'play', address: '0xvee', symbol: 'PLAY', decimals: 18 }] },
        publicClient: {
          readContract: () => {
            throw new Error('the chain must not be reached: there is no registry to read');
          },
          getContractEvents: () => {
            throw new Error('the chain must not be reached: there is no registry to read');
          },
        },
      } as unknown as Chain,
      store,
    );

  it('resolves a spawned agent id exactly, from the store', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:a', ADDR_A, 'agent');

    expect(await namesless(store).lookup('orch:a')).toEqual({ address: ADDR_A, canonical: 'orch:a' });
    store.close();
  });

  // NO BARE-ID FALLBACK. With a registry, `a` inside namespace `orch` can reach
  // `orch:a`; without one, inventing that rule would give a names-less
  // deployment a second resolution rule nothing else knows about.
  it('does not resolve a bare id, and does not resolve an unspawned name', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:a', ADDR_A, 'agent');

    expect(await namesless(store).lookup('a')).toBeNull();
    expect(await namesless(store).lookup('alpha.play')).toBeNull();
    store.close();
  });

  it('reverses an address to the agent that owns it, and to null for a stranger', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:a', ADDR_A, 'agent');

    expect(await namesless(store).reverseOf(ADDR_A)).toBe('orch:a');
    expect(await namesless(store).reverseOf(ADDR_B)).toBeNull();
    store.close();
  });

  // An empty list is the honest answer, not a degraded one: there are no
  // aliases, as distinct from "none could be found".
  it('has no aliases at all', async () => {
    const store = new Store(':memory:');
    expect(await namesless(store).aliasesOf(ADDR_A)).toEqual([]);
    store.close();
  });

  it('refuses registrantOf by name rather than reading a registry that is absent', async () => {
    const store = new Store(':memory:');
    let code = 'no-throw';
    try {
      await namesless(store).registrantOf('alpha.play');
    } catch (e) {
      code = (e as HttpError).code ?? 'not-an-HttpError';
    }
    expect(code).toBe('module_not_deployed');
    store.close();
  });
});

// §8.2. EVERY REFUSAL IN loadDeployment, which had no coverage at all until a
// mutation run said so: disabling the schema check and disabling the
// duplicate-key check both left the suite green.
//
// This file is written by a deploy the operator may not have watched, and a
// service that will not start is the only symptom they get - so each refusal is
// asserted on its words, not just on throwing.
describe('loadDeployment refuses a local.json it cannot trust', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chain-svc-load-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (body: unknown) => writeFileSync(join(dir, 'local.json'), JSON.stringify(body));
  const load = () => loadDeployment(dir);

  const TOKEN_ENTRY = { kind: 'token', key: 'play', contract: 'Token', address: ADDR_A };
  const NAMES_ENTRY = { kind: 'names', contract: 'NameRegistry', address: ADDR_B, tld: 'play' };
  const GOOD = { schema: 1, chainId: 31337, treasury: ADDR_A, modules: [TOKEN_ENTRY, NAMES_ENTRY] };

  it('accepts the shape chain-deploy writes', () => {
    write(GOOD);
    const d = load();
    expect(d.modules.map((m) => m.kind)).toEqual(['token', 'names']);
    expect(d.modules[0]?.key).toBe('play');
    expect(d.modules[1]?.tld).toBe('play');
  });

  // ALL FOUR SHIPPED EXAMPLES, because "accepts the shape" above asserts ONE
  // shape and the four are what a deployment actually picks from. A loader that
  // happened to require a names entry, or a token, would pass the case above
  // and fail half of these.
  it('accepts the local.json each example manifest produces', () => {
    const shapes: Array<[string, Array<Record<string, unknown>>]> = [
      ['token-and-names', [{ ...TOKEN_ENTRY, key: 'play' }, { ...NAMES_ENTRY, tld: 'play' }]],
      ['token-only', [{ ...TOKEN_ENTRY, key: 'play' }]],
      ['names-only', [{ ...NAMES_ENTRY, tld: 'play' }]],
      [
        'two-tokens',
        [
          { ...TOKEN_ENTRY, key: 'play' },
          { ...TOKEN_ENTRY, key: 'gold', address: ADDR_B },
          { ...NAMES_ENTRY, tld: 'play' },
        ],
      ],
    ];

    for (const [name, modules] of shapes) {
      write({ schema: 1, chainId: 31337, treasury: ADDR_A, modules });
      const d = load();
      // The shape's name is in the failure via the module list itself; bun's
      // expect takes no label argument.
      expect(d.modules.map((m) => `${name}:${m.kind}`)).toEqual(modules.map((m) => `${name}:${m.kind as string}`));
    }
  });

  // The old four-key file is RETIRED rather than supported: reading it would
  // mean inventing a key and a TLD for contracts deployed before either
  // existed, and inventing them is how a wallet gets looked up under a name
  // nobody registered.
  it('names the retired shape rather than failing on a missing field', () => {
    write({ chainId: 31337, VEEBux: ADDR_A, NameRegistry: ADDR_B, treasury: ADDR_A });
    expect(() => load()).toThrow(/predates the manifest .*redeploy with chain-deploy/);
  });

  it('refuses a schema it does not know', () => {
    write({ ...GOOD, schema: 2 });
    expect(() => load()).toThrow(/schema 2 unsupported/);
  });

  it('refuses an empty module list', () => {
    write({ ...GOOD, modules: [] });
    expect(() => load()).toThrow(/declares no modules/);
  });

  it('refuses a module kind it has no contract for', () => {
    write({ ...GOOD, modules: [{ kind: 'oracle', contract: 'Oracle', address: ADDR_A }] });
    expect(() => load()).toThrow(/unknown module kind "oracle"/);
  });

  // The contract name is the kind's, or the file and the chain disagree about
  // what is at that address.
  it('refuses a contract that is not the one its kind deploys', () => {
    write({ ...GOOD, modules: [{ ...TOKEN_ENTRY, contract: 'Foo' }] });
    expect(() => load()).toThrow(/module "play" is "Foo", expected "Token"/);
  });

  it('refuses a token module with no key', () => {
    write({ ...GOOD, modules: [{ kind: 'token', contract: 'Token', address: ADDR_A }] });
    expect(() => load()).toThrow(/token module with no key/);
  });

  // Two instances under one key: every later lookup of that key would answer
  // about whichever came first, silently.
  //
  // The message says "duplicate key", not "duplicate token key", as of the call
  // increment: keys are now ONE namespace shared by tokens, custom contracts
  // and the implicit `names`/`converter`, so naming the kind in the refusal
  // would describe the entry rather than the collision. Deploy.s.sol refuses
  // the same manifest with the same words.
  it('refuses a duplicate token key', () => {
    write({ ...GOOD, modules: [TOKEN_ENTRY, { ...TOKEN_ENTRY, address: ADDR_B }] });
    expect(() => load()).toThrow(/duplicate key "play"/);
  });

  it('refuses a second names module', () => {
    write({ ...GOOD, modules: [NAMES_ENTRY, { ...NAMES_ENTRY, address: ADDR_A }] });
    expect(() => load()).toThrow(/more than one names module/);
  });

  it('refuses a names module with no tld', () => {
    write({ ...GOOD, modules: [{ kind: 'names', contract: 'NameRegistry', address: ADDR_B }] });
    expect(() => load()).toThrow(/names module has no tld/);
  });

  it('refuses a missing treasury', () => {
    write({ schema: 1, chainId: 31337, modules: [TOKEN_ENTRY] });
    expect(() => load()).toThrow(/missing treasury/);
  });

  // `Number(undefined)` is NaN, which used to reach assertPrivateChain and fail
  // there as a chain-id mismatch: a true message about the wrong thing.
  it('refuses a non-numeric chainId here, rather than as a chain mismatch later', () => {
    write({ ...GOOD, chainId: 'thirty-one-three-three-seven' });
    expect(() => load()).toThrow(/no numeric chainId/);
  });

  it('refuses a file that is not there at all, naming the deploy step', () => {
    expect(() => load()).toThrow(/no deployment at .*Run Deploy\.s\.sol first/);
  });
});

/// The converter module is deployment data, like every other module: a local.json
/// that carries it must load, and the built module view must expose its address.
/// Both were rejected before `converter` was a known kind - a converter entry has
/// no tld, so the old not-token-means-names branch failed it as a names module.
describe('a deployment with a converter module', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'converter-deploy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const TREASURY = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const PLAY = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
  const REGISTRY = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
  const CONVERTER = '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0';

  it('loadDeployment accepts a converter entry alongside a names module', () => {
    const local = {
      schema: 1,
      chainId: 31337,
      treasury: TREASURY,
      modules: [
        { kind: 'token', key: 'play', contract: 'Token', address: PLAY },
        { kind: 'names', contract: 'NameRegistry', address: REGISTRY, tld: 'play' },
        { kind: 'converter', contract: 'Converter', address: CONVERTER },
      ],
    };
    writeFileSync(join(dir, 'local.json'), JSON.stringify(local));

    // Before converter was a known kind this threw - either "no tld" or, with a
    // names module also present, "more than one names module".
    const deployment = loadDeployment(dir);
    const converter = deployment.modules.find((m) => m.kind === 'converter');
    expect(converter).toBeDefined();
    expect(converter?.address.toLowerCase()).toBe(CONVERTER);
    expect(converter?.key).toBeUndefined();
    expect(converter?.tld).toBeUndefined();
    // The names module is still the single names module: the converter did not
    // count toward it.
    expect(deployment.modules.filter((m) => m.kind === 'names')).toHaveLength(1);
  });

  it('buildModules exposes the converter by address without reading the chain', async () => {
    const deployment: Deployment = {
      schema: 1,
      chainId: 31337,
      treasury: TREASURY as `0x${string}`,
      modules: [
        { kind: 'token', key: 'play', contract: 'Token', address: PLAY as `0x${string}` },
        { kind: 'converter', contract: 'Converter', address: CONVERTER as `0x${string}` },
      ],
    };

    let reads = 0;
    const modules = await buildModules(deployment, async () => {
      reads++;
      return { symbol: 'PLAY', decimals: 18 };
    });

    expect(modules.converter).toEqual({ address: CONVERTER });
    expect(modules.tokens).toHaveLength(1);
    // One read for the token; none for the converter.
    expect(reads).toBe(1);
  });
});

// §1.3. THE `contract` MANIFEST KIND, and the one namespace every key shares.
//
// #7 taught the DEPLOY to write `{kind:"contract"}`; until this increment
// chain-svc refused that file outright, because MODULES has no `contract` kind
// and an unknown kind is an unknown kind. chain-svc being stricter than the
// deploy is the bad direction of the two - the deploy is what an operator runs,
// and a service that will not boot against what it wrote is a service that
// cannot be deployed - so the two halves were deliberately kept in one release.
describe('a deployment with custom contract entries', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'custom-deploy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const TREASURY = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const PLAY = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
  const REGISTRY = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
  const CONVERTER = '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0';
  const SHOP = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';

  const TOKEN_ENTRY = { kind: 'token', key: 'play', contract: 'Token', address: PLAY };
  const NAMES_ENTRY = { kind: 'names', contract: 'NameRegistry', address: REGISTRY, tld: 'play' };
  const CONVERTER_ENTRY = { kind: 'converter', contract: 'Converter', address: CONVERTER };

  const write = (modules: Array<Record<string, unknown>>) =>
    writeFileSync(
      join(dir, 'local.json'),
      JSON.stringify({ schema: 1, chainId: 31337, treasury: TREASURY, modules }),
    );

  it('accepts an entry whose contract is any name the ABI table knows', () => {
    // The typed kinds keep their rule - a `token` entry must name `Token` - but
    // a custom entry has no single expected name, which is the whole point of
    // the kind. What replaces the equality check is the ABI table: a contract
    // chain-svc cannot encode a call to is not a contract it can register.
    write([TOKEN_ENTRY, { kind: 'contract', key: 'shop', contract: 'Converter', address: SHOP }]);
    const d = loadDeployment(dir);
    expect(d.modules.map((m) => m.kind)).toEqual(['token', 'contract']);
    expect(d.modules[1]?.key).toBe('shop');
    expect(d.modules[1]?.contract).toBe('Converter');
  });

  it('refuses a custom entry whose contract has no ABI, naming the fix', () => {
    write([TOKEN_ENTRY, { kind: 'contract', key: 'shop', contract: 'Bazaar', address: SHOP }]);
    expect(() => loadDeployment(dir)).toThrow(/no ABI for contract "Bazaar"/);
  });

  it('refuses a contract name that is not a Solidity contract name', () => {
    // Checked as a SHAPE before it is used as a lookup key, because the lookup
    // is into an object: `constructor`, `__proto__` and `toString` all resolve
    // on a plain object literal and none of them is a contract.
    for (const name of ['shop', '', 'toString', 'constructor', '__proto__', 'Sh op']) {
      write([TOKEN_ENTRY, { kind: 'contract', key: 'shop', contract: name, address: SHOP }]);
      expect(() => loadDeployment(dir)).toThrow(/contract name/);
    }
  });

  it('refuses a custom entry with no key, or a key that is not a manifest key', () => {
    write([TOKEN_ENTRY, { kind: 'contract', contract: 'Converter', address: SHOP }]);
    expect(() => loadDeployment(dir)).toThrow(/has a contract module with no key/);

    for (const key of ['Shop', '1shop', 'shop-2', 'averyverylongcontractkey']) {
      write([TOKEN_ENTRY, { kind: 'contract', key, contract: 'Converter', address: SHOP }]);
      expect(() => loadDeployment(dir)).toThrow(/key/);
    }
  });

  // FINDING 5: a key that spells one of this store's COLUMN names is refused at
  // load, naming the column.
  //
  // Not a corruption by itself - the key is written as a VALUE - but a trap for
  // the next migration: the v6 -> v7 step's `SELECT agent_id, stage, <key>,
  // spent` reads as "select the key" and becomes "select the column" the moment
  // somebody interpolates instead of binding, which is what that step did until
  // this release. Load is the last point an operator can change it: past here
  // the key is in `stage_spend.token` and `intents.token`, and renaming a token
  // after wallets have spent in it is a migration nobody wants to write.
  it('refuses a token key that is a column name in the schema', () => {
    for (const key of ['token', 'stage', 'amount', 'spent', 'topic', 'emissions']) {
      write([{ kind: 'token', key, contract: 'Token', address: SHOP, symbol: 'X', decimals: 18 }]);
      expect(() => loadDeployment(dir)).toThrow(/is a column name in this store's schema/);
    }
  });

  // THE CONTROL. Every row above would pass on a loader that refused every key,
  // so an ordinary key must still load - and `play`, the key every fixture in
  // this repo uses, is the one that proves the list is a list rather than a
  // rejection.
  it('control: an ordinary key still loads', () => {
    write([TOKEN_ENTRY, { kind: 'contract', key: 'shop', contract: 'Converter', address: SHOP }]);
    expect(() => loadDeployment(dir)).not.toThrow();
  });

  // ONE NAMESPACE. Increment 2 checked token keys against token keys, which was
  // complete while tokens were the only kind carrying one. A caller of the
  // generic op passes a key and gets back one contract, so two entries under
  // one key is not a duplicate row - it is a lookup whose answer depends on
  // which entry the loop saw last.
  it('refuses a custom key that collides with a token key', () => {
    write([TOKEN_ENTRY, { kind: 'contract', key: 'play', contract: 'Converter', address: SHOP }]);
    expect(() => loadDeployment(dir)).toThrow(/duplicate key "play"/);
  });

  it('refuses a custom key that collides with the implicit names key', () => {
    // `names` and `converter` are addressed BY THEIR KIND - the manifest gives
    // them no key - so those two strings are taken even though no entry spells
    // them out. A custom contract keyed `names` would shadow the registry.
    write([NAMES_ENTRY, { kind: 'contract', key: 'names', contract: 'Converter', address: SHOP }]);
    expect(() => loadDeployment(dir)).toThrow(/duplicate key "names"/);
  });

  it('refuses a custom key that collides with the implicit converter key', () => {
    write([CONVERTER_ENTRY, { kind: 'contract', key: 'converter', contract: 'Token', address: SHOP }]);
    expect(() => loadDeployment(dir)).toThrow(/duplicate key "converter"/);
  });

  it('refuses a token key that collides with an implicit key, in either order', () => {
    // The check is on the NAMESPACE, not on "custom entries": a token keyed
    // `names` breaks the same lookup, and the manifest may declare it first.
    write([{ ...TOKEN_ENTRY, key: 'names' }, NAMES_ENTRY]);
    expect(() => loadDeployment(dir)).toThrow(/duplicate key "names"/);

    write([NAMES_ENTRY, { ...TOKEN_ENTRY, key: 'names' }]);
    expect(() => loadDeployment(dir)).toThrow(/duplicate key "names"/);
  });

  it('refuses two custom entries under one key', () => {
    write([
      { kind: 'contract', key: 'shop', contract: 'Converter', address: SHOP },
      { kind: 'contract', key: 'shop', contract: 'Token', address: PLAY },
    ]);
    expect(() => loadDeployment(dir)).toThrow(/duplicate key "shop"/);
  });

  it('accepts two instances of one contract under two keys', () => {
    // The mirror image of the case above, and the reason the check is on the
    // KEY and not on the contract name: two shops are a reasonable manifest.
    write([
      { kind: 'contract', key: 'shop', contract: 'Converter', address: SHOP },
      { kind: 'contract', key: 'market', contract: 'Converter', address: CONVERTER },
    ]);
    expect(loadDeployment(dir).modules).toHaveLength(2);
  });

  it('builds a registry entry for a custom contract', async () => {
    write([TOKEN_ENTRY, { kind: 'contract', key: 'shop', contract: 'Converter', address: SHOP }]);
    const modules = await buildModules(loadDeployment(dir), async () => ({
      symbol: 'PLAY',
      decimals: 18,
    }));

    expect(modules.byKey.get('shop')?.name).toBe('Converter');
    expect(modules.byKey.get('shop')?.kind).toBe('contract');
    // Registered, and in no typed slot: `contracts`/`byKey` is the whole of it.
    expect(modules.tokens).toHaveLength(1);
    expect(modules.converter).toBeUndefined();
  });
});
