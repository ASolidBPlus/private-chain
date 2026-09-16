// viem clients and the deployed addresses. One place that knows how to reach
// the chain, so nothing else has to care where the treasury key comes from.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  type Address,
  type Chain as ViemChain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { HttpError } from './errors.ts';
import { ABIS } from './abi.ts';
import {
  CONTRACT_NAME,
  MANIFEST_KEY,
  RESERVED_MANIFEST_KEYS,
  MODULES,
  type ManifestKind,
  type ModuleKind,
  type Modules,
} from './modules.ts';

/// Bounded so a stalled Anvil cannot hold a poll open indefinitely.
const RPC_TIMEOUT_MS = 10_000;

/// Chain ids conventionally reserved for LOCAL DEVELOPMENT chains: Anvil and
/// Hardhat use 31337, Ganache 1337. chain-svc refuses to start against anything
/// else, and that refusal is the point.
///
/// The money is play money because the chain is a private Anvil with zero
/// gas and a treasury that mints from nothing (confirmed by the game owner,
/// 2026-09-08). Left as configuration, that stays true only as long as nobody
/// repoints RPC_URL - and the personas holding these wallets are DELIBERATELY
/// socially-engineerable, so the day someone points this service at a real
/// network the tools that spend are already wired up and nobody re-asks a
/// question that was answered once. Making it a startup assertion turns "we
/// deployed it safely" into "it cannot run otherwise".
///
/// There is deliberately NO bridge, withdrawal or export primitive anywhere in
/// this service - not an unused one, none. Do not add one; a disabled path is
/// an enabled path with a flag in front of it.
///
/// ruled (spec S4, "Play money is structural, not configured").
const PRIVATE_CHAIN_ID = 31337;

export interface DeployedModule {
  kind: ManifestKind;
  /// Token and custom-contract entries. The manifest's stable label for the
  /// instance, and what a caller of the generic op names it by. `names` and
  /// `converter` have no key of their own: they are addressed by their kind.
  key?: string;
  contract: string;
  address: Address;
  /// Names entries only.
  tld?: string;
}

export interface Deployment {
  schema: 1;
  chainId: number;
  treasury: Address;
  /// In manifest order, so the first `token` entry is the default token.
  modules: DeployedModule[];
}

/// EVERY REFUSAL HERE NAMES WHAT IS WRONG AND WHAT TO DO, because this file is
/// written by a deploy the operator may not have watched, and a service that
/// will not start is the only symptom they get.
export function loadDeployment(deploymentsDir: string): Deployment {
  const path = join(deploymentsDir, 'local.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `chain-svc: no deployment at ${path}. Run Deploy.s.sol first - ` +
        `compose does this before starting the service (spec S7).`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  // The old four-key shape is retired rather than supported. Reading it would
  // mean inventing a key and a TLD for contracts deployed before either
  // existed, and inventing them is how a wallet ends up looked up under a name
  // nobody registered.
  if (parsed.schema === undefined) {
    throw new Error(
      `chain-svc: ${path} predates the manifest (no "schema" field); redeploy with chain-deploy`,
    );
  }
  if (parsed.schema !== 1) {
    throw new Error(`chain-svc: ${path} schema ${String(parsed.schema)} unsupported`);
  }
  // `Number(undefined)` is NaN, which used to reach assertPrivateChain and fail
  // there as a chain-id mismatch - a true message about the wrong thing.
  if (typeof parsed.chainId !== 'number' || !Number.isFinite(parsed.chainId)) {
    throw new Error(`chain-svc: ${path} has no numeric chainId`);
  }
  if (typeof parsed.treasury !== 'string') {
    throw new Error(`chain-svc: ${path} is missing treasury`);
  }
  const declared = parsed.modules;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`chain-svc: ${path} declares no modules`);
  }

  const modules: DeployedModule[] = [];
  const keys = new Set<string>();
  let namesSeen = 0;
  for (const entry of declared as Array<Record<string, unknown>>) {
    const kind = entry.kind as ManifestKind;
    // `Object.hasOwn` rather than a truthiness test on the lookup: `MODULES` is
    // a plain object, so `MODULES["constructor"]` and `MODULES["__proto__"]`
    // both answer with something truthy from the prototype and a manifest kind
    // of `constructor` would pass a check that only asked whether the lookup
    // found anything.
    const isCustom = kind === 'contract';
    const expected = Object.hasOwn(MODULES, kind) ? MODULES[kind as ModuleKind] : undefined;
    if (!isCustom && !expected) {
      throw new Error(`chain-svc: ${path} has an unknown module kind "${String(entry.kind)}"`);
    }
    const label = String(entry.key ?? kind);
    // TWO RULES, because the kinds differ in what a contract name MEANS.
    //
    // A typed kind deploys one known contract, so its name is a fact to check
    // against MODULES ([[Chain Modules Increment]] §4.2). A custom entry names
    // its own contract - that is the kind's whole purpose - so there is nothing
    // to compare it to, and what replaces the comparison is the ABI table: a
    // contract chain-svc cannot encode a call to is not one it can register.
    // The shape check comes FIRST and is not decorative: `ABIS` is a plain
    // object, so `ABIS["constructor"]` is a function and `ABIS["__proto__"]` an
    // object, and either would pass a bare presence test.
    if (isCustom) {
      const name = entry.contract;
      if (typeof name !== 'string' || !CONTRACT_NAME.test(name)) {
        throw new Error(
          `chain-svc: ${path} module "${label}" has an invalid contract name ` +
            `"${String(name)}"; expected a Solidity contract name`,
        );
      }
      if (!Object.hasOwn(ABIS, name)) {
        throw new Error(
          `chain-svc: ${path} module "${label}": no ABI for contract "${name}"; ` +
            `regenerate abi.ts (cd svc && bun run scripts/generate-abi.ts)`,
        );
      }
    } else if (entry.contract !== expected) {
      throw new Error(
        `chain-svc: ${path} module "${label}" is "${String(entry.contract)}", expected "${expected}"`,
      );
    }
    if (typeof entry.address !== 'string') {
      throw new Error(`chain-svc: ${path} module "${label}" has no address`);
    }
    // ONE BRANCH PER KIND, never `token` versus everything-else. The
    // else-form was correct while there were exactly two kinds and became
    // silently wrong the moment a third could exist: a module that is not a
    // token was validated AS a names module, so it was rejected for having no
    // tld, and a deployment carrying both tripped "more than one names module".
    // Neither message would have named the real problem.
    //
    // An unknown kind cannot reach here - MODULES is checked above - so the
    // default is unreachable today and is written anyway, because the next kind
    // should fail loudly here rather than be mistaken for one of these.
    // ONE NAMESPACE FOR EVERY KEY, and it is not a tidiness rule.
    //
    // Increment 2 checked token keys against token keys, which was complete
    // while tokens were the only kind that carried one. The generic call op
    // takes a key and returns ONE contract, and `names`/`converter` are
    // addressed by their kind because the manifest gives them no key - so those
    // two strings are taken even though no entry spells them out. Two entries
    // under one key is not a duplicate row: it is a lookup whose answer depends
    // on which entry the loop saw last.
    //
    // Deploy.s.sol enforces the same rule with the same message, which is the
    // direction that matters: the deploy refuses a colliding manifest, so
    // chain-svc never meets one. This mirror exists for the local.json a human
    // edited.
    const claim = (key: string): void => {
      if (keys.has(key)) {
        throw new Error(`chain-svc: ${path} has duplicate key "${key}"`);
      }
      keys.add(key);
    };

    if (kind === 'token' || isCustom) {
      if (typeof entry.key !== 'string' || entry.key.length === 0) {
        throw new Error(`chain-svc: ${path} has a ${kind} module with no key`);
      }
      if (!MANIFEST_KEY.test(entry.key)) {
        throw new Error(
          `chain-svc: ${path} module key "${entry.key}" is not a manifest key ` +
            `(${MANIFEST_KEY.source})`,
        );
      }
      // FINDING 5. Refused at LOAD, naming the column, because this is the last
      // point an operator can change it: past here the key is written into
      // `stage_spend.token` and `intents.token` as a value, and renaming a token
      // after wallets have spent in it is a migration nobody wants to write.
      if (RESERVED_MANIFEST_KEYS.has(entry.key)) {
        throw new Error(
          `chain-svc: ${path} module key "${entry.key}" is a column name in this store's schema; ` +
            `pick another key`,
        );
      }
      claim(entry.key);
    } else if (kind === 'names') {
      namesSeen++;
      if (namesSeen > 1) {
        throw new Error(`chain-svc: ${path} declares more than one names module`);
      }
      if (typeof entry.tld !== 'string' || entry.tld.length === 0) {
        throw new Error(`chain-svc: ${path} names module has no tld`);
      }
      claim('names');
    } else if (kind === 'converter') {
      // No key, no tld, and it does not count toward namesSeen: contract and
      // address were checked above, and that is all a converter entry carries.
      // It claims its implicit key like the names module does.
      claim('converter');
    } else {
      throw new Error(`chain-svc: ${path} module kind "${String(kind)}" has no validation rule`);
    }
    modules.push({
      kind,
      key: kind === 'token' || isCustom ? (entry.key as string) : undefined,
      // For a typed kind this is MODULES[kind], checked equal above; for a
      // custom entry it is the manifest's own, checked to be a real contract
      // name with an ABI. Either way it is the key into the ABI table.
      contract: isCustom ? (entry.contract as string) : (expected as string),
      address: getAddress(entry.address),
      tld: kind === 'names' ? (entry.tld as string) : undefined,
    });
  }

  return { schema: 1, chainId: parsed.chainId, treasury: getAddress(parsed.treasury), modules };
}

/// EVERY transaction chain-svc sends carries these, and the reason is that
/// OMITTING them is what made the zero-gas claim false.
///
/// The chain is configured correctly - `anvil --gas-price 0 --base-fee 0`, so
/// the base fee IS zero. But viem fills an absent `maxPriorityFeePerGas` with
/// its own 1 gwei default, and the effective price is baseFee(0) + tip(1 gwei).
/// So chain-svc was overriding a correctly-configured zero-fee chain, at every
/// site, BY OMISSION. THE FIX IS TO STOP OMITTING, NOT TO LOWER ANYTHING.
///
/// ONE CONSTANT, SPREAD AT ALL SIX SEND SITES, rather than six literal pairs:
/// six copies of a value that must agree is the shape that put four copies of
/// the wallet-kind list in this codebase, and the failure there was a message
/// that drifted from the condition it explained. A site that forgets these is
/// invisible - the transaction still succeeds, it just is not free - so the
/// only defence is that there is nothing per-site to get right.
///
/// Sizing, so nobody plans around this being urgent: at a 1 gwei tip against
/// the 1 ETH endowment it is ~19,600 ERC-20 transfers before a wallet is
/// spent, so no wallet ran out during a game. The defect is that §2's zero-gas
/// claim was FALSE and visibly so - a student inspecting any transaction sees a
/// non-zero fee, in a game whose framing asks them to trust that the money is
/// play money.
export const ZERO_FEES = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n } as const;

export class Chain {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly deployment: Deployment;
  readonly treasury: Address;
  readonly viemChain: ViemChain;
  /// The ONLY non-readonly field here, and it is populated immediately after
  /// construction in index.ts rather than in the constructor: building it needs
  /// a live contract read through `publicClient` (each token's symbol and
  /// decimals), and a constructor that awaits is a constructor nothing can
  /// call. `Chain` stays a viem wrapper; the boot sequence owns the order.
  modules!: Modules;

  constructor(config: Config, deployment: Deployment) {
    this.deployment = deployment;
    // Account 0 of the chain's own mnemonic is the deployer and the treasury
    // (spec S2). Derived in memory; never written to the keystore volume.
    const account = mnemonicToAccount(config.anvilMnemonic);
    this.treasury = account.address;

    if (account.address.toLowerCase() !== deployment.treasury.toLowerCase()) {
      // Silently signing as the wrong account would mint from an address with
      // no MINTER_ROLE and fail deep inside a transfer, so say it at startup.
      throw new Error(
        `chain-svc: ANVIL_MNEMONIC derives ${account.address} but the deployment ` +
          `names ${deployment.treasury} as treasury - wrong mnemonic for this chain`,
      );
    }

    // viem needs a chain object to send a transaction at all. Defined here
    // rather than imported from viem/chains so the id is the one this service
    // asserts on at boot, not whatever a library constant happens to say.
    this.viemChain = defineChain({
      id: PRIVATE_CHAIN_ID,
      name: 'private chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });

    // An explicit timeout for the same reason the event sink has one: a hung
    // RPC would otherwise stall a poll for ever, and the interval that drives
    // it does not wait. viem's default is 10s; naming it here keeps the two
    // sides of that argument in one place.
    const transport = http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS });
    // viem polls every 4 SECONDS by default, which is sensible for a public
    // network and absurd for an instant-mining local chain: it made a spawn
    // that does the work in ~200ms take 4.2s, because waitForTransactionReceipt
    // missed on its first check and then slept a full interval. That was
    // measured, not guessed - and it is why spawn timings read 277ms one run
    // and 4297ms the next. Anvil mines on submission, so poll fast.
    const pollingInterval = 50;
    this.publicClient = createPublicClient({ chain: this.viemChain, transport, pollingInterval }) as PublicClient;
    this.walletClient = createWalletClient({ account, chain: this.viemChain, transport, pollingInterval });
  }
}

/// Refuses any RPC host that could be a public endpoint. Checked BEFORE the
/// chain id, because the chain-id check requires actually talking to the host,
/// and this service should never emit a request to a public node at all.
///
/// The rule is deliberately strict rather than clever: loopback, RFC 1918 /
/// unique-local addresses, or a bare hostname (a Compose service name such as
/// `chain`). A dotted name is refused even if it might be internal - the cost
/// of that is one deliberate edit here, and the cost of being wrong the other
/// way is a socially-engineerable persona holding a wallet on a real network.
export function assertPrivateRpcUrl(rpcUrl: string): void {
  const refuse = (why: string): never => {
    throw new Error(
      `chain-svc: refusing_public_rpc - RPC_URL ${rpcUrl} ${why}. This service only ever ` +
        `talks to the game's private chain; see PRIVATE_CHAIN_ID in chain.ts.`,
    );
  };

  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    return refuse('is not a valid URL');
  }

  // new URL keeps IPv6 literals in brackets.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();

  if (lower === 'localhost' || lower.endsWith('.localhost')) return;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const isPrivate =
      a === 127 || // loopback
      a === 10 || // RFC 1918
      (a === 172 && b >= 16 && b <= 31) || // RFC 1918
      (a === 192 && b === 168) || // RFC 1918
      (a === 169 && b === 254); // link-local
    return isPrivate ? undefined : refuse('is a public IPv4 address');
  }

  if (lower.includes(':')) {
    const isPrivate = lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower); // loopback or unique-local
    return isPrivate ? undefined : refuse('is a public IPv6 address');
  }

  // A bare hostname is a Compose service name (`chain`). A dotted one is a
  // domain, and this service has no business resolving one.
  if (lower.includes('.')) return refuse('is a dotted hostname, not a Compose service name');
}

/// Verified at startup, before the service accepts a single request.
export async function assertPrivateChain(chain: Chain): Promise<void> {
  const chainId = await chain.publicClient.getChainId();

  if (chainId !== PRIVATE_CHAIN_ID) {
    throw new Error(
      `chain-svc: wrong_chain_id - RPC reports chain id ${chainId}, expected ${PRIVATE_CHAIN_ID}. ` +
        `This service mints and spends on behalf of personas that are designed to be manipulated, ` +
        `and only ever runs against the game's private chain.`,
    );
  }
  if (chainId !== chain.deployment.chainId) {
    throw new Error(
      `chain-svc: wrong_chain_id - RPC reports ${chainId} but the deployment in local.json was ` +
        `made on ${chain.deployment.chainId}`,
    );
  }
}

/// Turns a viem failure into the right wire error: a node that is unreachable
/// is a 503 the caller can retry, a revert is a 502 they cannot (spec S4).
export function asChainError(err: unknown): HttpError {
  // A REFUSAL IS NOT A CHAIN ERROR. Anything that already decided what it is -
  // module_not_deployed, unknown_name, wallet_retired - passes through with its
  // code intact.
  //
  // Without this, a guard that throws inside a call this function wraps has its
  // answer overwritten: module_not_deployed left a token-only spawn reporting
  // 502 chain_error, which says "the chain is broken" about a deployment that
  // is working exactly as configured. The rule is for the whole file, not just
  // that path: this function exists to CLASSIFY things that are not already
  // classified.
  if (err instanceof HttpError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const unreachable =
    /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|HttpRequestError/i.test(message);
  const code = unreachable ? 'chain_unreachable' : 'chain_error';

  // FINDING 11: TWO AUDIENCES, TWO STRINGS - the split `asCallError` already
  // makes for a revert, made here for everything else.
  //
  // The detail used to be viem's own first line, which carries whatever the
  // node said: RPC urls, internal addresses, encoded calldata, the shape of the
  // deployment. `chain_error` and `chain_unreachable` are persona-facing and
  // their detail crosses with them, so that text reached a model through a
  // refusal. A persona can do nothing with it in any case - the remedy for both
  // codes is "tell an operator" - so the fixed sentence loses a persona nothing
  // and the operator loses nothing either, because the raw line is right here
  // in the log.
  // THE WHOLE MESSAGE, not its first line, and this is a deliberate departure
  // from `asCallError`'s shape next door.
  //
  // For a REVERT, viem puts the reason on line one, so the first line IS the
  // diagnostic and `asCallError` loses nothing by taking it. For a transport
  // error it does not: line one is "fetch failed" and the URL, the method and
  // the request body are on the lines after it. Logging only the first line
  // would hand the operator exactly what the persona already has - the fixed
  // string in different words - and the split would buy nobody anything.
  //
  // Caught by the control on the test below, which asserted the raw text
  // reaches the log and found that it did not.
  console.warn(`[chain-svc] ${code}: ${message}`);
  return new HttpError(
    code,
    code === 'chain_unreachable' ? 'node unreachable' : 'chain call failed',
  );
}
