// §8.3. THE CALL OP, driven end to end against a recording signer.
//
// The pattern is spawn.test.ts's: a Treasury with a subclassed signer that
// records what was signed rather than sending it. That matters more here than
// it did there, because the thing under test is an ORDER - kind, frozen,
// arguments, caps, reservation, sign - and a test that drove each check
// directly would stay green when the order changed. The defect the order
// prevents is a reservation taken for a call that is then refused, or a
// signature produced before the cap was consulted.
//
// The fixture contract is the Converter's real shape - `convert(address,
// address, uint256, bytes32)` - because it is the first real customer of the op
// and every rule in §2 has something to say about it: two address arguments
// with rules, an amount whose token is chosen per call, and an intent slot the
// server fills.

import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { decodeFunctionData, type Abi } from 'viem';
import { TokenAbi } from '../src/abi.ts';
import { Treasury, serialiseResult, PLATFORM_INTENT_AGENT, type Signer } from '../src/treasury.ts';
import { Store } from '../src/store.ts';
import { HttpError } from '../src/errors.ts';
import { fixedCallPolicy, type CallEntry } from '../src/calls.ts';
import type { Chain } from '../src/chain.ts';
import type { Keystore } from '../src/keystore.ts';
import type { Resolver } from '../src/resolver.ts';
import type { Config } from '../src/config.ts';
import { loadPolicyDefaults } from '../src/policy.ts';
import { buildModules, type Modules } from '../src/modules.ts';
import type { Deployment } from '../src/chain.ts';

const PKG = join(import.meta.dir, '..');
const DEFAULTS = loadPolicyDefaults(join(PKG, 'policy-defaults.example.json'), 'play', ['play', 'gold']);
/// A real directory, because one test writes a per-wallet policy file into it -
/// the shape a per-scenario override produces, which is the §7 trap.
const POLICY_DIR = mkdtempSync(join(tmpdir(), 'call-policies-'));
const config = { token: 't', rpcUrl: 'http://chain:8545', policyDir: POLICY_DIR } as Config;

// CHECKSUMMED SPELLINGS, because that is what the registry stores (getAddress
// in loadDeployment) and what platform scope must pass. A lowercase constant
// here would have made every comparison against a resolved address fail, and
// every admin-call argument refused - which is the validator working.
const PLAY = '0x00000000000000000000000000000000000000AA';
const GOLD = '0x00000000000000000000000000000000000000bb';
const CONV = '0x00000000000000000000000000000000000000dd';
const BOB = '0x000000000000000000000000000000000000bEEF';

const fn = (
  name: string,
  inputs: Array<{ type: string; name: string }>,
  stateMutability: string,
  outputs: Array<{ type: string; name: string }> = [],
) => ({ type: 'function', name, inputs, outputs, stateMutability });

const CONVERTER_ABI = [
  fn(
    'convert',
    [
      { type: 'address', name: 'source' },
      { type: 'address', name: 'target' },
      { type: 'uint256', name: 'amountIn' },
      { type: 'bytes32', name: 'intentId' },
    ],
    'nonpayable',
  ),
  fn('donate', [{ type: 'address', name: 'to' }], 'nonpayable'),
  // An ADMIN function that moves money, so §4's `hub.call.amount` has a
  // fixture that can express it. calls.json accepts `amount` on an admin
  // entry, so this is the shipped shape rather than an invention.
  fn(
    'seed',
    [
      { type: 'address', name: 'token' },
      { type: 'uint256', name: 'amount' },
    ],
    'nonpayable',
  ),
  fn(
    'quote',
    [
      { type: 'address', name: 'source' },
      { type: 'address', name: 'target' },
      { type: 'uint256', name: 'amountIn' },
    ],
    'view',
    [{ type: 'uint256', name: 'amountOut' }],
  ),
  fn(
    'setPair',
    [
      { type: 'address', name: 'source' },
      { type: 'address', name: 'target' },
      { type: 'uint256', name: 'rate' },
    ],
    'nonpayable',
  ),
] as unknown as Abi;

/// `transferWithIntent(address,uint256,bytes32)`, the one function a transfer
/// encodes - enough to decode the calldata and read the amount back out.
const TOKEN_ABI = [
  fn(
    'transferWithIntent',
    [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' },
      { type: 'bytes32', name: 'intentId' },
    ],
    'nonpayable',
  ),
] as unknown as Abi;

const ABIS = { Token: TOKEN_ABI, Converter: CONVERTER_ABI };

async function modules(): Promise<Modules> {
  const deployment = {
    schema: 1,
    chainId: 31337,
    treasury: PLAY,
    modules: [
      { kind: 'token', key: 'play', contract: 'Token', address: PLAY },
      { kind: 'token', key: 'gold', contract: 'Token', address: GOLD },
      { kind: 'converter', contract: 'Converter', address: CONV },
    ],
  } as unknown as Deployment;
  const meta: Record<string, { symbol: string; decimals: number }> = {
    [PLAY]: { symbol: 'PLAY', decimals: 18 },
    [GOLD]: { symbol: 'GOLD', decimals: 6 },
  };
  return buildModules(deployment, async (a) => meta[a]!, ABIS);
}

const abiFunction = (name: string) =>
  (CONVERTER_ABI as unknown as Array<{ type: string; name: string }>).find(
    (f) => f.type === 'function' && f.name === name,
  ) as never;

/// The §2 example entry, as the loader would have produced it.
const CONVERT: CallEntry = {
  contract: 'converter',
  function: 'convert',
  kinds: ['org', 'agent'],
  read: false,
  amount: { arg: 2, token: { arg: 0 } },
  // No `perTxCap`: retired. The bound for whichever token the {arg} form
  // resolves to lives on the WALLET, per token.
  intentArg: 3,
  maxPerStage: 2,
  addressArgs: { 0: 'token', 1: 'token' },
  abiFunction: abiFunction('convert'),
};

const DONATE: CallEntry = {
  contract: 'converter',
  function: 'donate',
  kinds: ['agent'],
  read: false,
  addressArgs: { 0: 'name' },
  abiFunction: abiFunction('donate'),
};

/// An entry whose address parameter has NO rule. Legal to load - the loader
/// does not require rules, because an admin-only entry genuinely needs none -
/// and uncallable by a wallet, which is the property under test.
const UNRULED: CallEntry = {
  contract: 'converter',
  function: 'donate',
  kinds: ['agent'],
  read: false,
  addressArgs: {},
  abiFunction: abiFunction('donate'),
};

const QUOTE: CallEntry = {
  contract: 'converter',
  function: 'quote',
  kinds: ['agent'],
  read: true,
  addressArgs: { 0: 'token', 1: 'token' },
  abiFunction: abiFunction('quote'),
};

/// §4. AN ADMIN ENTRY THAT DECLARES AN AMOUNT. Without one, every assertion
/// about `hub.call.amount` would be vacuous: the field is absent when the entry
/// declares no money, so a fixture of amount-less admin entries cannot tell
/// "the field is correctly omitted" from "the field is never built".
///
/// The `{arg}` token form deliberately, matching CONVERT: the token is whichever
/// one the caller's address argument names, so the event's `token` can disagree
/// with the calldata if the two are sourced separately.
const SEED: CallEntry = {
  contract: 'converter',
  function: 'seed',
  kinds: [],
  read: false,
  amount: { arg: 1, token: { arg: 0 } },
  addressArgs: { 0: 'token' },
  abiFunction: abiFunction('seed'),
};

const SET_PAIR: CallEntry = {
  contract: 'converter',
  function: 'setPair',
  kinds: [],
  read: false,
  addressArgs: {},
  abiFunction: abiFunction('setPair'),
};

interface Signed {
  to: string;
  data: `0x${string}`;
}

/// Records what was signed instead of sending it, and answers with a receipt.
class RecordingTreasury extends Treasury {
  readonly signed: Signed[] = [];
  reverted = false;
  estimateReverts = false;

  protected override signerFor(): Signer {
    return {
      prepareTransactionRequest: async (a: Record<string, unknown>) => {
        if (this.estimateReverts) {
          throw new Error(
            'Execution reverted with reason: pair is paused.\n\nEstimate Gas Arguments: …',
          );
        }
        this.signed.push({ to: String(a.to), data: a.data as `0x${string}` });
        return a;
      },
      signTransaction: async () => '0xsigned' as const,
      sendRawTransaction: async () => '0xhash' as const,
    } as unknown as Signer;
  }
}

/// Every address the TREASURY wrote to, in order. The platform paths - `fund`
/// and `set-balance` - name their token by the CONTRACT they address, and that
/// is the use no amount assertion can see.
const written: string[] = [];

/// Every address the treasury READ from, in order, for the same reason one
/// level over. `set-balance` reads a balance and then moves the difference, so
/// the token is named TWICE on two different clients - and asserting only the
/// write leaves "measure one, move another" invisible, which is precisely the
/// failure the test's own comment describes.
const readFrom: string[] = [];

/// The argument list of every contract write, in order. `written` answers WHICH
/// CONTRACT; this answers WITH WHAT - two facts about one call, and the second
/// is where an amount's scale lives.
const adminArgs: unknown[][] = [];

async function harness(
  entries: CallEntry[] = [CONVERT, DONATE, QUOTE, SET_PAIR, SEED],
  opts: {
    reverted?: boolean;
    store?: Store;
    keystoreThrows?: boolean;
    /// What the treasury holds OF THE DEFAULT TOKEN, in its smallest unit.
    /// Ample by default, and deliberately per-token: gold's float stays ample
    /// whatever this is set to, which is what lets a test show that the check
    /// consulted the NAMED token rather than the default one. A single float
    /// for every token could not express that at all.
    treasuryFloat?: bigint;
    /// Makes writeContract and readContract throw the way a REAL revert
    /// arrives: `writeContract` simulates before it sends, so a contract-level
    /// refusal is an exception here rather than a reverted receipt. The message
    /// is viem's own, measured against a live Anvil.
    contractReverts?: boolean;
    /// Makes the SIGNER's prepareTransactionRequest throw a revert-shaped
    /// error, which is how a wallet-scope call the contract would reject
    /// actually fails: viem estimates gas there, so the rejection arrives
    /// before any receipt and before anything reaches the wire.
    estimateReverts?: boolean;
    /// Makes the name argument resolve to the SAME address as the deny entry
    /// `treasury.{tld}`, which is how a deny is evaded in the real world: the
    /// policy names one string and the caller uses another for the same wallet.
    nameIsDenied?: boolean;
  } = {},
): Promise<{ t: RecordingTreasury; store: Store }> {
  const store = opts.store ?? new Store(':memory:');
  store.markSpawned('orch:a', '0x000000000000000000000000000000000000aaaa', 'agent');
  store.markSpawned('orch:b', '0x000000000000000000000000000000000000bbbb', 'burner');
  store.markSpawned('orch:o', '0x000000000000000000000000000000000000cccc', 'org');

  const chain = {
    modules: await modules(),
    // The sweep half of set-balance reads the treasury address from here. A
    // fixture without it throws a TypeError inside sweepToTreasury's try, which
    // asChainError then dresses up as a chain failure - the error reads as "the
    // node is broken" about a stub that simply lacks a field.
    deployment: { chainId: 31337, treasury: PLAY },
    // The account that SIGNS, which is what §1's treasury-float check reads -
    // "can the sender cover it" is a question about the sender, not about the
    // address the manifest declares. Equal here, as the real Chain's
    // constructor requires.
    treasury: PLAY,
    viemChain: { id: 31337 },
    publicClient: {
      waitForTransactionReceipt: async () => ({ status: opts.reverted ? 'reverted' : 'success' }),
      readContract: async (a: { address?: string; functionName?: string; args?: readonly unknown[] } = {}) => {
        readFrom.push(String(a.address));
        if (opts.contractReverts) {
          throw new Error('The contract function "quote" reverted.\n\nError: UnknownPair()');
        }
        // THE TREASURY'S FLOAT IS ITS OWN FACT. A single constant for every
        // read made the treasury's holding and a view function's result the
        // same number, so no fixture could say "the treasury is short" and
        // §1's guard had nothing to fail against.
        if (a.functionName === 'balanceOf' && a.args?.[0] === PLAY) {
          // `PLAY` is both the treasury's address and the default token's in
          // this fixture. The FIRST is whose balance is asked for; the second
          // is which token's ledger it is read from, and only the second
          // selects the float.
          return a.address === PLAY ? (opts.treasuryFloat ?? 10n ** 30n) : 10n ** 30n;
        }
        return 40n;
      },
    },
    walletClient: {
      account: { address: PLAY },
      writeContract: async (a: { address?: string; args?: readonly unknown[] }) => {
        written.push(String(a.address));
        // THE ARGUMENTS THE CHAIN RECEIVES. `written` records which contract was
        // addressed and says nothing about what was sent to it - so the admin
        // path's amount scaling had no assertion anywhere and its mutant
        // survived the whole suite.
        adminArgs.push([...(a.args ?? [])]);
        if (opts.contractReverts) {
          throw new Error(
            'The contract function "setPair" reverted.\n\nError: LoopMintsValue(0x…, 0x…, 1500000000000000000, 750000000000000000)',
          );
        }
        return '0xadminhash';
      },
    },
  } as unknown as Chain;

  const t = new RecordingTreasury(
    config,
    chain,
    {
      load: async () => {
        if (opts.keystoreThrows) throw new Error('keystore unreadable');
        return { privateKey: `0x${'11'.repeat(32)}`, address: '0x' };
      },
    } as unknown as Keystore,
    store,
    {
      require: async () => ({ address: BOB, canonical: 'orch:bob' }),
      // `treasury.play` must NOT resolve to the same address as the target:
      // it is on every kind's deny list, and a fixture that resolved both to
      // one address would make the identity pass refuse every call - correctly,
      // and for a reason that has nothing to do with what is under test.
      lookup: async (n: string) =>
        n === 'treasury.play'
          ? opts.nameIsDenied
            ? { address: BOB, canonical: 'treasury.play' }
            : null
          : { address: BOB, canonical: 'orch:bob' },
    } as unknown as Resolver,
    DEFAULTS,
    fixedCallPolicy(entries),
  );
  t.estimateReverts = opts.estimateReverts === true;
  written.length = 0;
  readFrom.length = 0;
  adminArgs.length = 0;
  return { t, store };
}

const asWallet = (agentId: string) => ({ scope: 'wallet', agentId }) as const;
const asPlatform = { scope: 'platform' } as const;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError: ${String(err)}`;
  }
  return 'no-error';
}

const convertBody = (over: Record<string, unknown> = {}) => ({
  contract: 'converter',
  function: 'convert',
  args: [{ token: 'play' }, { token: 'gold' }, '40'],
  intentId: 'i-1',
  ...over,
});

describe('what may be called', () => {
  it('signs a call the allowlist permits', async () => {
    const { t } = await harness();
    const out = await t.call(asWallet('orch:a'), convertBody());
    expect(out.txHash).toBe('0xhash');
    expect(t.signed).toHaveLength(1);
    expect(t.signed[0]!.to).toBe(CONV);
  });

  it('refuses a contract that is not in the registry', async () => {
    const { t } = await harness();
    expect(await codeOf(() => t.call(asWallet('orch:a'), convertBody({ contract: 'bazaar' })))).toBe(
      'unknown_contract',
    );
  });

  it('refuses a function with no entry, one for the wrong op, and a kind not listed', async () => {
    // ONE CODE FOR ALL THREE. Telling a persona which of them it was tells it
    // what other kinds of wallet are permitted to do, which is the one thing
    // the allowlist is keeping from it.
    const { t } = await harness();
    expect(await codeOf(() => t.call(asWallet('orch:a'), convertBody({ function: 'setPaused' })))).toBe(
      'function_not_allowed',
    );
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), { contract: 'converter', function: 'quote', args: [], intentId: 'x' }),
      ),
    ).toBe('function_not_allowed');
    // `orch:b` is a burner, and convert lists org and agent.
    expect(await codeOf(() => t.call(asWallet('orch:b'), convertBody()))).toBe('function_not_allowed');
  });

  it('reads a null kind as agent, for this decision and nothing else', async () => {
    // A pre-v4 wallet has no recorded kind. Reading it as `agent` at REQUEST
    // TIME is not the backfill migrate.ts forbids: nothing is written, and
    // spawns.kind still says "spawned before chain-svc recorded kinds", which
    // stays the true answer to a different question.
    const store = new Store(':memory:');
    // NULL, not omitted: this is a wallet spawned before chain-svc recorded
    // kinds at all, which is the state migrate.ts forbids backfilling.
    store.markSpawned('orch:old', '0x000000000000000000000000000000000000dddd', null);
    const { t } = await harness(undefined, { store });
    await expect(t.call(asWallet('orch:old'), convertBody())).resolves.toBeDefined();
    expect(store.walletRow('orch:old')!.kind).toBeNull();
  });

  it('refuses a RETIRED wallet before it signs anything', async () => {
    const { t, store } = await harness();
    store.freeze('orch:a');
    expect(await codeOf(() => t.call(asWallet('orch:a'), convertBody()))).toBe('wallet_retired');
    expect(t.signed).toHaveLength(0);
  });

  it('refuses a platform credential', async () => {
    const { t } = await harness();
    expect(await codeOf(() => t.call(asPlatform as never, convertBody()))).toBe('wrong_scope');
  });
});

describe('arguments', () => {
  it('resolves token keys to addresses and never takes a raw one', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    const decoded = decodeFunctionData({ abi: CONVERTER_ABI, data: t.signed[0]!.data });
    expect((decoded.args as unknown[])[0]).toBe(PLAY);
    expect((decoded.args as unknown[])[1]).toBe(GOLD);

    expect(
      await codeOf(() => t.call(asWallet('orch:a'), convertBody({ args: [PLAY, { token: 'gold' }, '40'] }))),
    ).toBe('bad_args');
  });

  it('refuses a wire form the index rule does not allow', async () => {
    // The validator said `{"name": ...}` is a shape SOME rule takes; this index
    // takes a token key, and the refusal says so in the same detail format the
    // validator uses.
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ name: 'bob' }, { token: 'gold' }, '40'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('bad_args');
    expect(err?.detail).toBe('argument 0 (source): expected a token key');
  });

  it('resolves a name through the registry and applies the deny list', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), {
      contract: 'converter',
      function: 'donate',
      args: [{ name: 'bob' }],
      intentId: 'd-1',
    });
    const decoded = decodeFunctionData({ abi: CONVERTER_ABI, data: t.signed[0]!.data });
    expect((decoded.args as unknown[])[0]).toBe(BOB);
  });

  it('applies the deny list by IDENTITY to a name argument', async () => {
    // THE DENY LIST IS ABOUT WHOM A PERSONA MAY PAY, and paying through a
    // contract call is still paying. A deny that applied to `send` and not to
    // `call` would be a deny with a documented bypass - and the bypass would be
    // the interesting half of the game.
    //
    // By IDENTITY, not by string: the deny entry names `treasury.play` and the
    // caller writes `bob`. Only resolving both and comparing addresses catches
    // that, which is the same pass sign-transfer already makes.
    const { t } = await harness([DONATE], { nameIsDenied: true });
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), {
          contract: 'converter',
          function: 'donate',
          args: [{ name: 'bob' }],
          intentId: 'deny-1',
        }),
      ),
    ).toBe('counterparty_denied');
    expect(t.signed).toHaveLength(0);
  });

  it('refuses an address parameter that has no rule, for wallet scope', async () => {
    // NOT DEFAULTED TO `any`. A default would open every address parameter of
    // every future contract the moment it was added to the allowlist - the
    // author writes one entry and gets a permission they did not write. The
    // refusal says which argument and why, so the fix is to add the rule.
    const { t } = await harness([UNRULED]);
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), {
        contract: 'converter',
        function: 'donate',
        args: [{ name: 'bob' }],
        intentId: 'u-1',
      });
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('bad_args');
    expect(err?.detail).toMatch(/argument 0 \(to\).*no addressArgs rule/);
    expect(t.signed).toHaveLength(0);
  });

  it('refuses an argument count that does not match the abi minus the intent slot', async () => {
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('bad_args');
    // THREE, not four: the intentArg slot is the server's and the caller does
    // not supply it.
    expect(err?.detail).toBe('expected 3 arguments, got 2');
  });
});

describe('the intent slot', () => {
  it('fills it with the intent topic, at the index the entry named', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody({ intentId: 'my-intent' }));
    const decoded = decodeFunctionData({ abi: CONVERTER_ABI, data: t.signed[0]!.data });
    const args = decoded.args as unknown[];
    expect(args).toHaveLength(4);
    // keccak256 of the intent id, the form the chain logs - which is what lets
    // the Converter's own event join the anomaly detector.
    expect(args[3]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(args[2]).toBe(40000000000000000000n);
  });

  it('refuses a caller that supplies a value for it', async () => {
    // Four arguments where the ABI has four but the caller may pass three. A
    // caller choosing the id the chain logs is choosing the join the anomaly
    // detector reads.
    const { t } = await harness();
    expect(
      await codeOf(() =>
        t.call(
          asWallet('orch:a'),
          convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '40', `0x${'00'.repeat(32)}`] }),
        ),
      ),
    ).toBe('bad_args');
  });
});

describe('money', () => {
  it('applies the wallet cap when the amount is in the default token', async () => {
    // BOTH BOUNDS CAN REFUSE and both answer `over_max_per_tx`, so the code
    // alone cannot say which one fired. The DETAIL can, and which one fired is
    // the thing worth asserting: the wallet's own cap is what bounds an amount
    // in the default token, and the entry's cap is a second bound on top.
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '150'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('over_max_per_tx');
    expect(err?.detail).toBe('max_per_tx is 100 PLAY');
  });

  it('applies THE WALLET\'S cap for the token that moved, not the default one', async () => {
    // gold -> play: the amount is in GOLD, and the bound is the wallet's own
    // GOLD cap. Before per-token caps this was the allowlist entry's
    // `perTxCap`, because the wallet carried no bound for any currency but the
    // default - which is the gap that field existed to paper over, and why it
    // is retired rather than kept beside the real thing.
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '101'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('over_max_per_tx');
    // GOLD's symbol, because a refusal naming PLAY would send a persona to look
    // at the wrong balance.
    expect(err?.detail).toMatch(/GOLD/);
    await expect(
      t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '99'] })),
    ).resolves.toBeDefined();
  });

  it('takes a stage hold in WHICHEVER token moved, and leaves the others alone', async () => {
    // THE RULE INVERTED BY PER-TOKEN CAPS. This used to take a hold only for
    // the DEFAULT token, because that was the only currency a wallet had a
    // per-stage bound for - which meant every other currency had an UNBOUNDED
    // stage, and the allowlist entry's `perTxCap` was the paper over it.
    //
    // Now `stage_spend` is keyed by token and the wallet carries a bound for
    // each, so a gold call takes a GOLD hold against a GOLD cap and the play
    // budget is untouched. Both halves asserted: a hold that was taken, and a
    // budget that was not.
    const { t, store } = await harness();
    const stage = store.currentStage();

    await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '5'] }));
    expect(store.spentThisStage('orch:a', stage, 'gold')).toBe(5_000000n); // 6 dp
    expect(store.spentThisStage('orch:a', stage, 'play')).toBe(0n);

    await t.call(asWallet('orch:a'), convertBody({ intentId: 'i-2', args: [{ token: 'play' }, { token: 'gold' }, '5'] }));
    expect(store.spentThisStage('orch:a', stage, 'play')).toBe(5_000000000000000000n); // 18 dp
    // AND THE GOLD HOLD IS STILL EXACTLY WHAT IT WAS: a second call in another
    // currency must not disturb the first's budget.
    expect(store.spentThisStage('orch:a', stage, 'gold')).toBe(5_000000n);
  });

  it('names the allow list when a contract is not an allowed counterparty', async () => {
    // §7's trap, and the refusal a scenario author is most likely to misread.
    // A per-scenario policy override REPLACES the kind defaults rather than
    // extending them, so a scenario setting allow: ["acme:*"] silently drops
    // the `converter` entry policy-defaults.example.json carries - and every call whose
    // amount is in the default token is refused. The CODE is right;
    // "converter is not an allowed counterparty" sends an author looking at
    // wallets, so the DETAIL names the list to edit.
    const store = new Store(':memory:');
    store.markSpawned('orch:narrow', '0x000000000000000000000000000000000000eeee', 'agent');
    const { t } = await harness(undefined, { store });
    // A policy file whose allow list names wallets only, exactly as a scenario
    // override produces.
    writeFileSync(
      join(POLICY_DIR, 'orch%3Anarrow.json'),
      JSON.stringify({
        agentId: 'orch:narrow',
        max_per_tx: '1000',
        max_per_stage: '5000',
        allow: ['acme:*'],
        deny: [],
      }),
    );

    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:narrow'), convertBody({ intentId: 'narrow-1' }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('counterparty_denied');
    expect(err?.detail).toMatch(/add "converter" to this wallet's allow list/);
    store.close();
  });

  it('refuses a zero amount', async () => {
    const { t } = await harness();
    expect(
      await codeOf(() => t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '0'] }))),
    ).toBe('invalid_amount');
  });

  it('moves no money for an entry with no amount rule', async () => {
    // The push-only rule holding: an entry with no `amount` moves nothing FROM
    // the caller by this call, because a function that pulled funds would need
    // an allowance and this service has none to give.
    const { t, store } = await harness();
    await t.call(asWallet('orch:a'), {
      contract: 'converter',
      function: 'donate',
      args: [{ name: 'bob' }],
      intentId: 'd-1',
    });
    expect(store.spentThisStage('orch:a', store.currentStage(), 'play')).toBe(0n);
  });
});

describe('per-entry counting', () => {
  it('refuses the call after the entry limit, and signs nothing', async () => {
    const { t } = await harness();
    const go = (id: string) =>
      codeOf(() => t.call(asWallet('orch:a'), convertBody({ intentId: id, args: [{ token: 'gold' }, { token: 'play' }, '1'] })));
    expect(await go('c-1')).toBe('no-error');
    expect(await go('c-2')).toBe('no-error');
    expect(await go('c-3')).toBe('over_stage_cap');
    expect(t.signed).toHaveLength(2);
  });

  it('gives the slot back when the failure precedes the broadcast', async () => {
    // A keystore that cannot load is a failure that PROVABLY precedes the
    // broadcast - nothing has reached the wire - so the reservation, the stage
    // hold and the count all come back. Without that, two failed key loads
    // would consume a persona's whole per-stage allowance for a call it never
    // made.
    const { t, store } = await harness([CONVERT], { keystoreThrows: true });
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] })),
      ),
    ).not.toBe('no-error');
    expect(store.callCount('orch:a', store.currentStage(), 'converter', 'convert')).toBe(0);
    expect(store.intentCall('orch:a', 'i-1')).toBeNull();
    store.close();
  });
});

describe('replay', () => {
  it('returns the original hash for the same call under the same id', async () => {
    const { t } = await harness();
    const first = await t.call(asWallet('orch:a'), convertBody());
    const again = await t.call(asWallet('orch:a'), convertBody());
    expect(again.txHash).toBe(first.txHash);
    // Signed ONCE. That is the whole promise of the intent id.
    expect(t.signed).toHaveLength(1);
  });

  it('refuses the same id carrying a different call', async () => {
    // Returning the first call's hash would tell this caller their SECOND call
    // had succeeded, which is the one wrong answer that looks like it worked.
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '41'] })),
      ),
    ).toBe('invalid_request');
  });

  it('refuses the same id on a different function', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), {
          contract: 'converter',
          function: 'donate',
          args: [{ name: 'bob' }],
          intentId: 'i-1',
        }),
      ),
    ).toBe('invalid_request');
  });
});

describe('a revert the contract rejects BEFORE it is mined', () => {
  // THE PRIMARY PERSONA-FACING PATH, and the one a unit test with a fake signer
  // does not reach by accident: `prepareTransactionRequest` ESTIMATES GAS when
  // the request carries none - ZERO_FEES sets fees, not gas - so a call the
  // contract would reject fails at the estimate and never reaches a receipt.
  //
  // Under asChainError that came out as 502 chain_error WITH viem's text in the
  // detail, because errorBody ships a detail for every code. Two rules broken
  // at once on the op a persona actually uses: a revert classified as a dead
  // node, and the revert REASON handed to the persona.
  it('answers revert, withholds the reason, and gives everything back', async () => {
    const { t, store } = await harness(undefined, { estimateReverts: true });
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] }));
    } catch (e) {
      err = e as HttpError;
    }

    expect(err?.code).toBe('revert');
    expect(err?.status).toBe(409);
    expect(err?.detail).toBe('the call was mined and reverted; nothing changed');
    // THE REASON NEVER CROSSES. "pair is paused" is the contract's internal
    // state, and a persona learning which pair is paused learns the shape of
    // the game's machinery.
    expect(JSON.stringify(err)).not.toMatch(/paused/i);

    // PROVABLY PRE-BROADCAST: an estimate is a read, so nothing reached the
    // wire and the whole reservation comes back - the intent, the stage hold
    // and the per-entry count.
    expect(store.callCount('orch:a', store.currentStage(), 'converter', 'convert')).toBe(0);
    expect(store.intentCall('orch:a', 'i-1')).toBeNull();
    expect(t.signed).toHaveLength(0);
  });

  it('still answers chain_unreachable when the NODE is the problem', async () => {
    // asCallError falls through to asChainError for anything that is not a
    // revert, so classifying reverts did not swallow the case the original
    // catch was written for.
    const { t } = await harness(undefined, { keystoreThrows: true });
    expect(
      await codeOf(() => t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] }))),
    ).not.toBe('revert');
  });
});

describe('a mined revert', () => {
  it('refuses with revert, keeps the reservation, and withholds the reason', async () => {
    const { t, store } = await harness(undefined, { reverted: true });
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('revert');
    expect(err?.status).toBe(409);
    expect(err?.detail).toBe('the call was mined and reverted; nothing changed');

    // IT WAS MINED, so the slot stays spent. A persona can lose stage budget to
    // a paused pair, and `read` is free for anyone unsure.
    expect(store.callCount('orch:a', store.currentStage(), 'converter', 'convert')).toBe(1);
    expect(store.intentTxHash('orch:a', 'i-1')).toBe('0xhash');
  });

  it('still emits the event, marked reverted', async () => {
    const { t, store } = await harness(undefined, { reverted: true });
    await t
      .call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] }))
      .catch(() => undefined);
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    const call = events.find((e) => e.kind === 'agent.call')!;
    expect(call.status).toBe('reverted');
  });
});

describe('the agent.call event', () => {
  it('reports the names the caller used, never the addresses', async () => {
    const { t, store } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    const call = events.find((e) => e.kind === 'agent.call')!;

    expect(call.name).toBe('orch:a');
    expect(call.contract).toBe('converter');
    expect(call.function).toBe('convert');
    expect(call.args).toEqual([{ token: 'play' }, { token: 'gold' }, '40']);
    expect(call.intent_id).toBe('i-1');
    expect(call.status).toBe('ok');
    expect(call.amount).toEqual({ value: '40', token: 'play' });
    expect(JSON.stringify(call)).not.toContain(PLAY);
  });
});

describe('admin-call', () => {
  it('signs with the treasury and needs no kind', async () => {
    const { t } = await harness();
    const out = await t.adminCall({
      contract: 'converter',
      function: 'setPair',
      args: [PLAY, GOLD, '1500000000000000000'],
      intentId: 'a-1',
    });
    expect(out.txHash).toBe('0xadminhash');
    // Nothing signed by a wallet key.
    expect(t.signed).toHaveLength(0);
  });

  it('takes raw addresses, which wallet scope may not', async () => {
    const { t } = await harness();
    await expect(
      t.adminCall({ contract: 'converter', function: 'setPair', args: [PLAY, GOLD, '1'], intentId: 'a-2' }),
    ).resolves.toBeDefined();
    expect(
      await codeOf(() =>
        t.adminCall({
          contract: 'converter',
          function: 'setPair',
          args: [{ token: 'play' }, { token: 'gold' }, '1'],
          intentId: 'a-3',
        }),
      ),
    ).toBe('bad_args');
  });

  // §2. FLIPPED at v0.8.0. This asserted that the hub could only call a
  // function the allowlist marked `admin`, so its powers were "on the record".
  // The platform IS the game: the allowlist describes the shape of the PERSONA
  // surface, and an operator is not on it.
  //
  // An entry, WHEN ONE EXISTS, is still USED rather than bypassed - `convert`
  // has one here, so its `intentArg` is injected and its `amount` rule feeds
  // the event, and the call looks the same whoever made it.
  it('uses a persona entry when one exists, rather than bypassing it', async () => {
    const { t, store } = await harness();
    await t.adminCall({ contract: 'converter', function: 'convert', args: [PLAY, GOLD, '1'], intentId: 'a-4' });
    // THE ENTRY'S intentArg WAS INJECTED: `convert` declares slot 3, and the
    // platform passed three arguments. A bypass would have encoded three.
    expect(adminArgs[0]).toHaveLength(4);
    // ...and the entry's amount rule fed the event.
    const ev = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'hub.call')!;
    expect(ev.amount).toEqual({ value: '1', token: 'play' });
  });

  it('calls a function with NO entry at all', async () => {
    // "Any function of any registered contract." `setPaused` has no entry in
    // this fixture, so nothing about it was written down anywhere.
    // An EMPTY allowlist: the persona surface is closed entirely, and the
    // platform still reaches `donate`. That is the §2 rule at its starkest -
    // an absent calls.json means personas can call nothing, and means nothing
    // at all about what an operator may do.
    const { t } = await harness([]);
    await t.adminCall({ contract: 'converter', function: 'donate', args: [PLAY], intentId: 'a-11' });
    expect(written).toEqual([CONV]);
  });

  it('refuses a function that is not on the contract at all', async () => {
    // "Any function" is any function THIS CONTRACT HAS. The registry is the
    // authority, and the refusal is the same one a missing entry used to give.
    const { t } = await harness();
    expect(
      await codeOf(() => t.adminCall({ contract: 'converter', function: 'nosuch', args: [], intentId: 'a-12' })),
    ).toBe('function_not_allowed');
  });

  it('refuses an entry-less VIEW, because a view is read and not called', async () => {
    // "Any function" must not mean signing a transaction to learn something
    // `POST /read` answers for free.
    const { t } = await harness([]);
    expect(
      await codeOf(() =>
        t.adminCall({ contract: 'converter', function: 'quote', args: [PLAY, GOLD, '1'], intentId: 'a-13' }),
      ),
    ).toBe('invalid_request');
  });

  it('answers a simulated revert with revert, not chain_error', async () => {
    // FOUND BY THE COMPOSE SMOKE, and it is the shape of defect a unit test
    // does not reach on its own: `asChainError` cannot tell a REVERT from a
    // broken node, so it answered 502 chain_error - "the chain is down" - about
    // a chain doing exactly what it was asked. writeContract SIMULATES before
    // it sends, so this arrives as an exception rather than as a reverted
    // receipt, which is the one way this path differs from `call`.
    const { t } = await harness(undefined, { contractReverts: true });
    let err: HttpError | undefined;
    try {
      await t.adminCall({
        contract: 'converter',
        function: 'setPair',
        args: [PLAY, GOLD, '1500000000000000000'],
        intentId: 'a-rev',
      });
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('revert');
    expect(err?.status).toBe(409);
    // The REASON is the contract's internal state and stays in the log sink.
    expect(err?.detail).toBe('the call was mined and reverted; nothing changed');
    expect(JSON.stringify(err?.detail)).not.toContain('LoopMintsValue');
  });

  it('emits hub.call with status refused and no hash when the simulation refuses', async () => {
    // A THIRD STATUS, and not decoration. Nothing was mined, so a null hash
    // under "reverted" would lie about what happened - and silence would hide
    // the hub trying something the chain would not accept, which is exactly
    // what an operator wants to see.
    const { t, store } = await harness(undefined, { contractReverts: true });
    await t
      .adminCall({
        contract: 'converter',
        function: 'setPair',
        args: [PLAY, GOLD, '1500000000000000000'],
        intentId: 'a-refused',
      })
      .catch(() => undefined);

    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(events.find((e) => e.kind === 'hub.call')).toMatchObject({
      contract: 'converter',
      function: 'setPair',
      status: 'refused',
      txHash: null,
    });
  });

  it('records a generated id as server-generated, even when intentId was empty', async () => {
    // `typeof body.intentId === 'string'` is true of "", so an empty string
    // recorded the id as CALLER-supplied while GENERATING a server one - the
    // column then said the caller chose an id it never sent. That column is not
    // bookkeeping: the anomaly detector reads it to tell a guessable id being
    // guessed from a chain-svc uuid being quoted, which are different stories
    // about how somebody learned it.
    const { t, store } = await harness();
    const out = await t.adminCall({
      contract: 'converter',
      function: 'setPair',
      args: [PLAY, GOLD, '1'],
      intentId: '',
    });
    expect(out.intentId).toMatch(/^chain-svc:/);
    expect(store.intentIdSource(PLATFORM_INTENT_AGENT, out.intentId)).toBe('server');
  });

  it('emits hub.call', async () => {
    const { t, store } = await harness();
    await t.adminCall({ contract: 'converter', function: 'setPair', args: [PLAY, GOLD, '1'], intentId: 'a-5' });
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(events.find((e) => e.kind === 'hub.call')).toMatchObject({
      contract: 'converter',
      function: 'setPair',
      status: 'ok',
    });
  });

  // §4. ONE SHAPE FOR BOTH ACTORS. `agent.call` has carried `amount` since
  // v0.4.0; `hub.call` did not, so a feed reader had to know which actor it was
  // looking at to know whether an absent `amount` meant "no money" or "this
  // event never carries it". Informational only: the hub has no cap (§3.3), so
  // this records the operator moving money rather than bounding it.
  it('carries the AMOUNT and its token on hub.call', async () => {
    const { t, store } = await harness();
    await t.adminCall({ contract: 'converter', function: 'seed', args: [GOLD, '3'], intentId: 'a-6' });
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(events.find((e) => e.kind === 'hub.call')).toMatchObject({
      contract: 'converter',
      function: 'seed',
      status: 'ok',
      // The token the ADDRESS ARGUMENT named, and the value in WHOLE UNITS -
      // gold is 6 dp, so a value scaled at the default token's 18 reads as
      // 0.000000000003 here rather than 3.
      amount: { value: '3', token: 'gold' },
    });
  });

  it('carries the amount on a REFUSED hub.call too', async () => {
    // The refused branch is a separate emission site, so it can drift from the
    // other one - and an operator reading a refusal most wants to know what it
    // was trying to move.
    const { t, store } = await harness(undefined, { contractReverts: true });
    await t
      .adminCall({ contract: 'converter', function: 'seed', args: [GOLD, '3'], intentId: 'a-7' })
      .catch(() => undefined);
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(events.find((e) => e.kind === 'hub.call')).toMatchObject({
      status: 'refused',
      txHash: null,
      amount: { value: '3', token: 'gold' },
    });
  });

  // A BEHAVIOUR CHANGE, NOT A FIELD. Carrying the amount on `hub.call` meant
  // computing it through `callMoney`, and step 6 of the shared path WRITES THE
  // SCALED VALUE BACK into the argument the chain receives. So an admin call now
  // signs 3000000n where it signed 3n - the token's smallest unit rather than
  // the wire's whole units.
  //
  // That is the correct reading of the Call spec (§3.3 is "§3.2 with
  // requirePlatform", and §3.2 step 6 parses at the token's decimals), so the
  // OLD admin path was the defect: `seed(GOLD, "3")` moved three millionths of
  // a GOLD. But it is outside Multi-token §4's "informational only" wording,
  // and it went in with no assertion at all - the mutant `if (money && false)`
  // survived all 825 tests, because `written` records which contract was
  // addressed and nothing recorded what was sent to it.
  it('SCALES the argument the admin call signs, not just the event it emits', async () => {
    const { t } = await harness();
    await t.adminCall({ contract: 'converter', function: 'seed', args: [GOLD, '3'], intentId: 'a-9' });
    // 3 GOLD at 6 dp. Read off the arguments the wallet client received, which
    // is the only place the calldata's value is visible.
    expect(adminArgs).toEqual([[GOLD, 3_000000n]]);
  });

  it('leaves a non-money argument alone', async () => {
    // setPair's third argument is a RATE, not an amount, and its entry declares
    // no `amount` - so nothing is rescaled. Without this row a mutant that
    // scaled every uint256 would pass the test above.
    const { t } = await harness();
    await t.adminCall({ contract: 'converter', function: 'setPair', args: [PLAY, GOLD, '1'], intentId: 'a-10' });
    expect(adminArgs).toEqual([[PLAY, GOLD, 1n]]);
  });

  it('omits amount when the admin entry declares none', async () => {
    // COMPARE TO A VALUE, not to presence: without this row a mutant that
    // always emitted an amount would pass every assertion above.
    const { t, store } = await harness();
    await t.adminCall({ contract: 'converter', function: 'setPair', args: [PLAY, GOLD, '1'], intentId: 'a-8' });
    const ev = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'hub.call')!;
    expect('amount' in ev).toBe(false);
  });
});

describe('read', () => {
  it('serves a view without signing or reserving', async () => {
    const { t, store } = await harness();
    expect(
      await t.read(asWallet('orch:a'), {
        contract: 'converter',
        function: 'quote',
        args: [{ token: 'play' }, { token: 'gold' }, '40'],
      }),
    ).toEqual({ result: '40' });
    expect(t.signed).toHaveLength(0);
    expect(store.dueEvents(10)).toHaveLength(0);
  });

  it('refuses a non-read entry, and a read entry the kind is not in', async () => {
    const { t } = await harness();
    expect(
      await codeOf(() =>
        t.read(asWallet('orch:a'), { contract: 'converter', function: 'convert', args: [] }),
      ),
    ).toBe('function_not_allowed');
    expect(
      await codeOf(() =>
        t.read(asWallet('orch:b'), {
          contract: 'converter',
          function: 'quote',
          args: [{ token: 'play' }, { token: 'gold' }, '40'],
        }),
      ),
    ).toBe('function_not_allowed');
  });

  it('answers a reverting view with revert, and no reason', async () => {
    const { t } = await harness(undefined, { contractReverts: true });
    let err: HttpError | undefined;
    try {
      await t.read(asWallet('orch:a'), {
        contract: 'converter',
        function: 'quote',
        args: [{ token: 'play' }, { token: 'gold' }, '40'],
      });
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('revert');
    expect(JSON.stringify(err?.detail)).not.toContain('UnknownPair');
  });

  it('serves a platform caller without a kind check, with raw addresses', async () => {
    const { t } = await harness();
    expect(
      await t.read(asPlatform as never, {
        contract: 'converter',
        function: 'quote',
        args: [PLAY, GOLD, '40'],
      }),
    ).toEqual({ result: '40' });
  });
});

// §3.4. HOW A RETURN VALUE REACHES A MODEL.
//
// Every rule here exists because a model reads the answer and has to act on it:
// a bigint has no JSON form, an address has a canonical spelling that is not
// the one the chain returns, and a positional array of three values is three
// values nobody can tell apart.
describe('serialiseResult', () => {
  const fn = (outputs: Array<{ type: string; name: string; components?: unknown[] }>) =>
    ({ type: 'function', name: 'f', inputs: [], outputs, stateMutability: 'view' }) as never;

  it('returns a single value bare, not wrapped in a list', () => {
    expect(serialiseResult(40n, fn([{ type: 'uint256', name: 'amountOut' }]))).toBe('40');
  });

  it('keys several NAMED return values by name', () => {
    // THE DEFECT THE COMPOSE SMOKE FOUND. The Converter's
    // `pair() -> (rate, paused, exists)` reached a persona as
    // ["750000000000000000", false, true] - and the two booleans are not even
    // distinguishable from each other by inspection.
    expect(
      serialiseResult(
        [750000000000000000n, false, true],
        fn([
          { type: 'uint256', name: 'rate' },
          { type: 'bool', name: 'paused' },
          { type: 'bool', name: 'exists' },
        ]),
      ),
    ).toEqual({ rate: '750000000000000000', paused: false, exists: true });
  });

  it('stays positional when a name is missing', () => {
    // There is nothing to key on, and an invented index would be a worse lie
    // than the array.
    expect(
      serialiseResult([1n, 2n], fn([{ type: 'uint256', name: 'a' }, { type: 'uint256', name: '' }])),
    ).toEqual(['1', '2']);
  });

  it('checksums an address', () => {
    expect(
      serialiseResult('0x5fbdb2315678afecb367f032d93f642f64180aa3', fn([{ type: 'address', name: 'who' }])),
    ).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });

  it('walks into arrays and structs', () => {
    expect(serialiseResult([1n, 2n], fn([{ type: 'uint256[]', name: 'xs' }]))).toEqual(['1', '2']);
    expect(
      serialiseResult(
        { token: '0x5fbdb2315678afecb367f032d93f642f64180aa3', amount: 5n },
        fn([
          {
            type: 'tuple',
            name: 'p',
            components: [
              { type: 'address', name: 'token' },
              { type: 'uint256', name: 'amount' },
            ],
          },
        ]),
      ),
    ).toEqual({ token: '0x5FbDB2315678afecb367f032d93F642f64180aa3', amount: '5' });
  });
});

// §3.4's bound, in the unit the spec names it in.
// §1. A TRANSFER IN A NON-DEFAULT TOKEN, and the five things that have to agree
// about which token it is.
//
// `signTransfer` uses the resolved token five times: its decimals parse the
// amount, its symbol appears in refusals, its key is the caps coordinate, its
// key is the stage-spend coordinate, and its ADDRESS is the contract the
// transfer is sent to. The fixture's two tokens differ in key, in symbol (GOLD
// is not `au` upper-cased) and in DECIMALS (18 and 6), so a use that reached
// for the default token instead is visible in at least one of them - and the
// address one is visible in the transaction itself.
describe('a transfer in a second token', () => {
  it('sends to THAT token\'s contract, at THAT token\'s scale', async () => {
    const { t, store } = await harness();
    await t.signTransfer(asWallet('orch:a'), {
      to: 'bob.play',
      amount: '3',
      token: 'gold',
      intentId: 'g-1',
    });

    // THE CONTRACT THE TRANSFER WENT TO. The one use whose failure moves real
    // money to the wrong ledger, and the one no amount assertion would catch.
    expect(t.signed[0]!.to).toBe(GOLD);

    // THE SCALE. GOLD is 6 dp in this fixture, so 3 whole units are 3_000000 -
    // at PLAY's 18 the calldata would carry 3e18, a millionfold error that
    // looks like a plausible number.
    const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: t.signed[0]!.data });
    expect((decoded.args as unknown[])[1]).toBe(3_000000n);

    // THE BOOKKEEPING COORDINATE, which is the KEY and never the symbol.
    expect(store.intentToken('orch:a', 'g-1')).toBe('gold');
    expect(store.spentThisStage('orch:a', store.currentStage(), 'gold')).toBe(3_000000n);
    // AND THE DEFAULT TOKEN'S BUDGET IS UNTOUCHED, which is the whole point of
    // per-token caps: spending gold must not consume a persona's play budget.
    expect(store.spentThisStage('orch:a', store.currentStage(), 'play')).toBe(0n);
  });

  it('emits agent.spend at THAT token\'s scale, and names it', async () => {
    // FOUND BY A TIP FROM THE WALLET-MCP LANE, which hit the same shape in its
    // own reconcile: a site that takes a SYMBOL or DECIMALS rather than the
    // resolved token. This one formatted every spend at the DEFAULT token's
    // decimals and carried no token field at all - so a 3 GOLD transfer reached
    // the feed as "0.000000000003" of an unnamed currency, while the transfer
    // itself was entirely correct and every assertion about it passed.
    //
    // The event was the only thing wrong, which is why nothing caught it: the
    // money moved right and the RECORD of it did not.
    const { t, store } = await harness();
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '3', token: 'gold', intentId: 'e-1' });

    const spend = store
      .dueEvents(10)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((e) => e.kind === 'agent.spend')!;
    expect(spend.amount).toBe('3');
    expect(spend.token).toBe('GOLD');
  });

  it('accepts the SYMBOL as well as the key', async () => {
    const { t } = await harness();
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', token: 'GOLD', intentId: 'g-2' });
    expect(t.signed[0]!.to).toBe(GOLD);
  });

  it('refuses a token this deployment does not have', async () => {
    const { t } = await harness();
    expect(
      await codeOf(() =>
        t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', token: 'silver', intentId: 'g-3' }),
      ),
    ).toBe('unknown_token');
  });

  it('still means the default token when none is named', async () => {
    // The increment's ONE RULE, asserted on the path most callers use.
    const { t } = await harness();
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.play', amount: '1', intentId: 'g-4' });
    expect(t.signed[0]!.to).toBe(PLAY);
  });
});

// §1. THE PLATFORM PATHS NAME THEIR TOKEN TOO, and act on that one only.
describe('fund and set-balance, per token', () => {
  // §1. A SHORT TREASURY IS REFUSED BY NAME.
  //
  // Without this the shortfall arrived as whatever the token contract said - a
  // raw revert, classified `revert`, reading to an operator as "mined and
  // reverted; nothing changed". True and useless: it names no cause, and the
  // remedy is specific and is the operator's to perform.
  it('refuses a fund the treasury cannot cover, and says how short it is', async () => {
    const { t } = await harness(undefined, { treasuryFloat: 2n * 10n ** 18n });
    let err: unknown;
    try {
      await t.fund({ to: 'bob.play', amount: '5', intentId: 'short-1' });
    } catch (e) {
      err = e;
    }
    expect((err as HttpError).code).toBe('treasury_insufficient');
    // THE NUMBERS IN THE MESSAGE, in whole units, because the operator's next
    // action is to mint the difference and a message that made them compute it
    // from wei would be a worse message than none.
    expect((err as HttpError).detail).toContain('holds 2 PLAY');
    expect((err as HttpError).detail).toContain('moves 5');
    // NOTHING WAS SENT. A refusal after the transfer would be a lie about a
    // movement that happened.
    expect(written).toEqual([]);
  });

  it('checks the float of the NAMED token, not the default one', async () => {
    // The check is two uses of one resolution - read the float, then move it -
    // and sourcing them separately is what lets a fund be refused because a
    // DIFFERENT token's treasury is short. The fixture's float applies to PLAY
    // only, so a gold fund must sail past it.
    const { t } = await harness(undefined, { treasuryFloat: 0n });
    await t.fund({ to: 'bob.play', amount: '1', token: 'gold', intentId: 'short-2' });
    expect(written).toEqual([GOLD]);
  });

  it('passes a fund the treasury can exactly cover', async () => {
    // COMPARE TO A VALUE at the boundary: `<` and `<=` differ only here, and a
    // treasury refusing to spend its last unit is a bug an operator meets at
    // the worst moment.
    const { t } = await harness(undefined, { treasuryFloat: 5n * 10n ** 18n });
    await t.fund({ to: 'bob.play', amount: '5', intentId: 'exact-1' });
    expect(written).toEqual([PLAY]);
  });

  it('funds the NAMED token, leaving the others alone', async () => {
    const { t } = await harness();
    await t.fund({ to: 'bob.play', amount: '2', token: 'gold', intentId: 'f-1' });
    // The CONTRACT addressed is the assertion: a fund that reached for the
    // default token would move real money on the wrong ledger while reporting
    // a number that looks entirely correct.
    expect(written).toEqual([GOLD]);
  });

  // FINDING 1, PART TWO: fund RESERVES now, so it is idempotent like every other
  // intent path. It emitted a topic and wrote no row, so `recordEmission` hit
  // its "not an intent this store reserved" branch on every facilitator top-up
  // and the transfer was invisible to the emission and anomaly path - and two
  // POST /fund with one intentId both moved money, with the double emission
  // invisible for the same reason.
  it('a repeated fund under one intent id moves money ONCE', async () => {
    const { t, store } = await harness();
    const first = await t.fund({ to: 'bob.play', amount: '2', intentId: 'dedupe-1' });
    written.length = 0;
    const second = await t.fund({ to: 'bob.play', amount: '2', intentId: 'dedupe-1' });

    // THE CONTRACT WAS NOT TOUCHED the second time. Asserting only the txHash
    // would pass against a second real transfer that happened to be reported
    // with the first one's hash.
    expect(written).toEqual([]);
    expect(second.txHash).toBe(first.txHash);
    // ...and there is ONE row, under the RECIPIENT, which is who the money is
    // for and the wallet a reconciliation would be about.
    expect(store.intentTxHash('orch:bob', 'dedupe-1')).toBe(first.txHash);
  });

  it('a fund is visible to the emission path, which is what makes absence mean something', async () => {
    const { t, store } = await harness();
    await t.fund({ to: 'bob.play', amount: '2', intentId: 'emit-1' });

    // EVERY EMISSION HAS A ROW - the first half of the invariant printed on
    // sweepToTreasury. Before this, the topic went on chain and no row existed,
    // so this read null and every fund was another party's traffic as far as
    // the detector was concerned.
    const topic = store.intentTopicOf('orch:bob', 'emit-1');
    expect(topic).not.toBeNull();
    expect(store.recordEmission({ topic: topic!, txHash: '0xfund', from: '0xtreasury', isExpectedEmitter: true })).toBeNull();
    expect(store.intentRecord('orch:bob', 'emit-1')?.emissions).toBe(1);
  });

  it('defaults to the default token when none is named', async () => {
    const { t } = await harness();
    await t.fund({ to: 'bob.play', amount: '2', intentId: 'f-2' });
    expect(written).toEqual([PLAY]);
  });

  it('refuses a token this deployment does not have', async () => {
    const { t } = await harness();
    expect(
      await codeOf(() => t.fund({ to: 'bob.play', amount: '1', token: 'silver', intentId: 'f-3' })),
    ).toBe('unknown_token');
    expect(written).toEqual([]);
  });

  it('SWEEPS the named token too, not the default one', async () => {
    // The other half of set-balance, and the same shape one branch over: a GOLD
    // set-balance that needs to sweep would take PLAY out of the wallet,
    // leaving the gold balance exactly as it was while the reply reported a
    // number nobody moved. The fixture's balances make the sweep the branch
    // taken.
    //
    // The fixture's `balanceOf` answers 40 wei, which at GOLD's 6 decimals is
    // 0.00004 - so a target of 0.00001 is BELOW it and the sweep is the branch
    // taken. Stated rather than left to the reader, because a target above it
    // would exercise the FUNDING branch and this test would assert nothing
    // about sweeping at all.
    const { t } = await harness();
    // The tail of the sweep needs more of a chain than this fixture has, and
    // that is fine: the contract addressed is RECORDED AT PREPARE, before
    // anything that could fail, so the assertion holds either way. Catching
    // rather than asserting no-throw keeps the test about the token and not
    // about how complete the stub is.
    await t.setBalance('orch:a', { amount: '0.00001', token: 'gold', intentId: 'sw-1' }).catch(() => undefined);
    // The SIGNED transaction is the assertion here, because a sweep is signed
    // with the wallet's own key rather than written by the treasury.
    expect(t.signed[0]!.to).toBe(GOLD);
  });

  // FINDING 1, THE OTHER DIRECTION OF THE INVARIANT PRINTED ON sweepToTreasury:
  // "`fund` and this and `/sign-transfer` all emit an IntentTransfer and absence
  // of one keeps meaning something".
  //
  // The fund half is asserted above (every emission has a row). This is the
  // half that was false from the other side: the sweep RECORDED an intent and
  // emitted a plain `transfer`, under a comment saying transferWithIntent
  // "arrives with the contract PR, which sequences after this one" - and that
  // PR landed at v0.7.0 while the line stayed. So a sweep's absence of an
  // IntentTransfer meant nothing, and the sweep's negative branch reads absence
  // as "it did not land".
  it('the sweep emits an IntentTransfer carrying the topic on its own row', async () => {
    const { t, store } = await harness();
    await t.setBalance('orch:a', { amount: '0.00001', token: 'gold', intentId: 'sw-2' }).catch(() => undefined);

    // DECODED FROM THE CALLDATA, because that is what goes on chain. The
    // harness records `{to, data}`, and `to` alone cannot tell `transfer` from
    // `transferWithIntent` - both reach the right contract with the right
    // amount, and only one of them tells the tail which intent authorised it.
    const call = decodeFunctionData({ abi: TokenAbi, data: t.signed[0]!.data });
    expect(call.functionName).toBe('transferWithIntent');

    // ...and the bytes32 it carries is the one ON THE ROW, not a re-derivation.
    // With rows written either side of v8 in one store, a re-derivation puts a
    // topic on chain that the row does not carry, `recordEmission` matches
    // nothing, and the intent sits unresolved for ever with a transfer that
    // really happened.
    const stored = store.intentTopicOf('orch:a', 'sw-2');
    expect(stored).not.toBeNull();
    expect((call.args as readonly unknown[])[2]).toBe(stored);
  });

  it('sets the balance of the NAMED token, measuring and moving the same one', async () => {
    // set-balance READS a balance and then MOVES the difference. If the read
    // and the write named different tokens it would set one token's balance by
    // measuring another's - and the reply, which re-reads, would report a
    // number nobody moved.
    const { t } = await harness();
    await t.setBalance('orch:a', { amount: '9', token: 'gold', intentId: 's-1' });
    expect(written).toEqual([GOLD]);
    // THE OTHER HALF OF THE NAME. Asserting only the write left the mutant
    // "read the DEFAULT token's balance, move the named one" alive against the
    // whole suite - measured, 807 pass 0 fail - which is the exact defect the
    // comment above says must not happen. A set is used rather than a list
    // because the reply re-reads: the claim is that every read named GOLD, not
    // how many there were.
    expect([...new Set(readFrom)]).toEqual([GOLD]);
  });
});

describe('the read size bound', () => {
  it('counts BYTES, not UTF-16 units', async () => {
    // The same reasoning callargs.ts's string cap carries, and it was
    // inconsistent with it: `JSON.stringify(x).length` counts UTF-16 units, so
    // a result of astral characters passed a 64 KiB bound at up to four times
    // that many bytes. The bound exists to bound what crosses the wire.
    const { t } = await harness([
      {
        contract: 'converter',
        function: 'quote',
        kinds: ['agent'],
        read: true,
        addressArgs: { 0: 'token', 1: 'token' },
        abiFunction: {
          type: 'function',
          name: 'quote',
          inputs: [],
          outputs: [{ type: 'string', name: 's' }],
          stateMutability: 'view',
        } as never,
      },
    ]);
    // One emoji is 2 UTF-16 units and 4 bytes, so 20k of them are 40k units -
    // under the bound by a character count - and 80k bytes, over it.
    (t as unknown as { chain: { publicClient: { readContract: () => Promise<string> } } }).chain =
      {
        ...(t as unknown as { chain: object }).chain,
        publicClient: { readContract: async () => '😀'.repeat(20_000) },
      } as never;

    expect(
      await codeOf(() => t.read(asWallet('orch:a'), { contract: 'converter', function: 'quote', args: [] })),
    ).toBe('bad_args');
  });
});

// THE over_stage_cap DETAIL NAMES THE LIMIT THAT ACTUALLY FIRED.
//
// Two different limits produce one outcome: the WALLET's per-stage spend bound
// (its policy) and the ENTRY's per-stage call count (calls.json). They are
// configured in different files by different people, so an operator told the
// wrong one goes and edits the wrong file.
//
// The message used to key on `entry.maxPerStage !== undefined && !money`, so on
// an entry carrying BOTH - which `convert` does, and which is the ordinary shape
// for anything that moves money a bounded number of times - the count branch was
// skipped and the reply reported the wallet's max_per_stage AMOUNT, a bound that
// had not tripped.
describe('over_stage_cap says which limit tripped', () => {
  const capped = (agentId: string, maxPerStage: string) =>
    writeFileSync(
      join(POLICY_DIR, `${encodeURIComponent(agentId)}.json`),
      JSON.stringify({ agentId, caps: { play: { max_per_tx: '1000', max_per_stage: maxPerStage } }, allow: ['*'], deny: [] }),
    );

  it('names the COUNT and the entry when the call count trips', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:counted', '0x000000000000000000000000000000000000cc01', 'agent');
    // A stage amount high enough that only the COUNT can fire. Stated rather
    // than left implicit: with both able to trip, this row would be asserting
    // the tie-break instead of the branch it names.
    capped('orch:counted', '1000000');
    const { t } = await harness(undefined, { store });

    // CONVERT carries maxPerStage: 2 AND an amount rule, which is the shape the
    // finding is about.
    await t.call(asWallet('orch:counted'), convertBody({ intentId: 'c-1' }));
    await t.call(asWallet('orch:counted'), convertBody({ intentId: 'c-2' }));

    let err: HttpError | undefined;
    try { await t.call(asWallet('orch:counted'), convertBody({ intentId: 'c-3' })); } catch (e) { err = e as HttpError; }
    expect(err?.code).toBe('over_stage_cap');
    expect(err?.detail).toBe('convert on converter may be called 2 times per stage');
    // AND NOT the other limit's words, because the defect was not "says
    // nothing" - it was "says the other one, confidently".
    expect(err?.detail).not.toMatch(/max_per_stage/);
    store.close();
  });

  it('names the AMOUNT when the wallet stage bound trips', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:broke', '0x000000000000000000000000000000000000cc02', 'agent');
    // Below one convert, so the FIRST call trips the amount and the count
    // (limit 2) cannot have fired.
    capped('orch:broke', '1');
    const { t } = await harness(undefined, { store });

    let err: HttpError | undefined;
    try { await t.call(asWallet('orch:broke'), convertBody({ intentId: 'b-1' })); } catch (e) { err = e as HttpError; }
    expect(err?.code).toBe('over_stage_cap');
    expect(err?.detail).toMatch(/^max_per_stage is 1 for this stage$/);
    store.close();
  });

  // WHEN BOTH WOULD TRIP, THE AMOUNT WINS - because `reserve` checks the stage
  // spend before the entry count. Asserted rather than left to chance: a
  // tie-break nobody wrote down is one that changes silently when the two
  // checks are reordered, and the two limits are refused in the same breath.
  //
  // (The spec's parenthetical said the count is checked first. Measured here:
  // it is not. `reserve` tests the stage amount at the top of the transaction
  // and the entry count below it.)
  it('reports the AMOUNT when both would trip, because that is the one checked first', async () => {
    const store = new Store(':memory:');
    store.markSpawned('orch:both', '0x000000000000000000000000000000000000cc03', 'agent');
    capped('orch:both', '1');
    const { t } = await harness(undefined, { store });

    // Exhaust the count too, so both are genuinely over - each of these refuses
    // on the amount, which is the point: the count never gets to increment.
    for (const id of ['x-1', 'x-2', 'x-3']) {
      await t.call(asWallet('orch:both'), convertBody({ intentId: id })).catch(() => undefined);
    }
    let err: HttpError | undefined;
    try { await t.call(asWallet('orch:both'), convertBody({ intentId: 'x-4' })); } catch (e) { err = e as HttpError; }
    expect(err?.detail).toMatch(/^max_per_stage is 1 for this stage$/);
    store.close();
  });
});
