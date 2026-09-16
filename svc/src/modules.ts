import type { Abi, Address } from 'viem';
import type { Deployment } from './chain.ts';
import { ABIS } from './abi.ts';
import { HttpError } from './errors.ts';

/// The deployable modules, and the contract each one deploys.
///
/// ONE PLACE, and the Solidity side (`KIND_CONTRACT` in Deploy.s.sol) is the
/// other. They are two declarations of one fact and nothing but a test makes
/// them agree - which is why the manifest's `kind` is validated against this
/// map rather than against a list written beside it.
export const MODULES = {
  token: 'Token',
  names: 'NameRegistry',
  converter: 'Converter',
} as const;

export type ModuleKind = keyof typeof MODULES;

/// Every kind a manifest entry may declare.
///
/// `contract` is NOT in MODULES and that is the point: MODULES maps a kind to
/// THE contract that kind deploys, and a custom entry names its own. So the two
/// are different questions - "which kinds exist" and "which kinds have a fixed
/// contract" - and this type is the first, which until now they shared.
export type ManifestKind = ModuleKind | 'contract';

/// A contract name, as `forge build` and the ABI table spell it.
export const CONTRACT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

/// The manifest's own key shape: lower-case, short, and stable. Shared by token
/// and contract entries, and matched by the implicit keys `names`/`converter`.
export const MANIFEST_KEY = /^[a-z][a-z0-9]{0,15}$/;

/// KEYS THIS STORE'S SCHEMA HAS ALREADY SPOKEN FOR (finding 5).
///
/// A token key is written into `stage_spend.token` and `intents.token` as a
/// VALUE, so a key that happens to spell a COLUMN name is not a corruption by
/// itself. It is a trap for the next person who writes a migration: the v6 -> v7
/// step's `SELECT agent_id, stage, <key>, spent` reads as "select the key" and
/// would become "select the column" the moment somebody interpolates rather
/// than binds - which is precisely what that step did until this release.
///
/// So the collision is refused where an operator can still fix it - at manifest
/// load, by name - rather than left as a rule a future migration has to
/// remember. Every one of these matches MANIFEST_KEY, so none of them is
/// hypothetical; `agent_id` and `tx_hash` do not, and are left out rather than
/// listed for symmetry, because a list containing unreachable entries invites
/// the reader to trust it as a description of the schema.
export const RESERVED_MANIFEST_KEYS = new Set([
  'amount',
  'emissions',
  'spent',
  'stage',
  'token',
  'topic',
]);

export interface TokenModule {
  key: string;
  address: Address;
  /// Read FROM THE CHAIN at boot, not from local.json. A file that records a
  /// symbol can disagree with the contract; a contract cannot disagree with
  /// itself.
  symbol: string;
  decimals: number;
}

export interface NamesModule {
  address: Address;
  /// The suffix canonical names end in, without the dot. Deployment data
  /// rather than code: it was a literal suffix in the validators until the
  /// manifest carried it.
  tld: string;
}

export interface ConverterModule {
  /// Address only: nothing is read from the converter at boot and nothing is
  /// callable through chain-svc yet. Its pairs live on the contract, not here.
  address: Address;
}

/// One deployed contract, as the generic call op sees it: a key to name it, an
/// address to send to, and the ABI to encode with. What KIND it is survives
/// only so `/modules` and the boot line can say so - the call op never branches
/// on it, which is what makes a new on-chain feature a contract, a manifest
/// entry and a policy entry rather than chain-svc code.
export interface RegisteredContract {
  key: string;
  kind: ManifestKind;
  /// The Solidity contract name, and the key into the ABI table. `Shop` is the
  /// class; `shop` is this instance of it.
  name: string;
  address: Address;
  abi: Abi;
}

export interface Modules {
  /// In manifest order, so `tokens[0]` is the default token - the one every
  /// money endpoint, message and wallet-mcp tool operates on. Empty on a
  /// deployment with no token module.
  tokens: TokenModule[];
  names?: NamesModule;
  converter?: ConverterModule;
  /// EVERY entry of EVERY kind, in manifest order, and the same objects are in
  /// `byKey`. Not "the custom ones": a caller asking to call `converter` uses
  /// the same op and the same lookup as one calling `shop`, and a flat view
  /// that held only the new kind would need a second lookup path for the old
  /// ones - which is the branching this view exists to delete.
  contracts: RegisteredContract[];
  byKey: Map<string, RegisteredContract>;
}

/// The default token, or a refusal naming the reason.
///
/// A FUNCTION RATHER THAN `modules.tokens[0]` AT EACH CALL SITE, and the
/// difference is what happens on a names-only deployment: the indexing form
/// yields `undefined` and fails later, somewhere else, as a property access on
/// undefined. This fails here, with a code the route layer already knows how to
/// turn into a 404 and a persona-safe refusal.
export function defaultToken(m: Modules): TokenModule {
  const t = m.tokens[0];
  if (!t) throw new HttpError('module_not_deployed', 'this deployment has no token module');
  return t;
}

export function requireNames(m: Modules): NamesModule {
  if (!m.names) throw new HttpError('module_not_deployed', 'this deployment has no names module');
  return m.names;
}

/// The contract behind a key, or a refusal a persona may see.
///
/// `unknown_contract` rather than `module_not_deployed`: the two say different
/// things and only one of them is the caller's business. `module_not_deployed`
/// is withheld from personas because it describes the deployment's SHAPE - what
/// the operator chose to run - whereas which keys exist is the registry, which
/// the `contracts` tool lists in full to anyone who asks.
/// The token a request names, by manifest KEY or by SYMBOL, case-insensitively -
/// or the default token when it names none.
///
/// ONE RESOLVER, and every caller goes through it: request body or query
/// string, writes or reads. Two would be two answers to one question the first
/// time somebody added a rule to one of them - and the rule most likely to be
/// added twice and spelled differently is precisely this one, case-insensitivity.
///
/// BOTH NAMESPACES, because a persona reads SYMBOLS in every reply - balances,
/// history entries, refusal messages - and must be able to write back what it
/// read. A resolver taking only keys would answer "unknown_token" to the exact
/// string the service had just shown it. Symbols are unique by construction:
/// buildModules refuses a deployment whose tokens report the same symbol.
///
/// THE KEY NAMESPACE WINS when a key and a symbol collide across two tokens.
/// The key is the manifest's own name and is what chain-svc stores in
/// `stage_spend` and `intents`, so resolving to anything else would mean the
/// bookkeeping and the request disagreed about which token moved. A manifest
/// that creates the ambiguity is the manifest's to fix.
export function resolveToken(m: Modules, keyOrSymbol: unknown): TokenModule {
  // The tokenless case answers FIRST and answers differently. "this deployment
  // has no token module" is its shape, which is withheld from personas;
  // "no such token" is its registry, which they may have. One code for both
  // would have a names-only deployment tell a persona its currency does not
  // exist.
  if (m.tokens.length === 0) {
    throw new HttpError('module_not_deployed', 'this deployment has no token module');
  }
  if (keyOrSymbol === undefined || keyOrSymbol === null || keyOrSymbol === '') {
    return defaultToken(m);
  }
  if (typeof keyOrSymbol !== 'string') {
    throw new HttpError('invalid_request', 'token must be a string: a manifest key or a symbol');
  }

  const wanted = keyOrSymbol.toLowerCase();
  // `.toLowerCase()` ON THE KEY SIDE IS UNREACHABLE TODAY, and is kept. A
  // manifest key must match MANIFEST_KEY (`^[a-z][a-z0-9]{0,15}$`), so every
  // key is already lower case and comparing the lowered input to the raw key
  // gives the same answer - a mutation removing it SURVIVES the suite, and that
  // is correct rather than a coverage gap: the isolating test would need a
  // mixed-case key, which loadDeployment refuses. It stays because the day
  // MANIFEST_KEY widens, this is the line that would otherwise start answering
  // `unknown_token` to a key the manifest accepted.
  //
  // The SYMBOL side is NOT in that position: a symbol is read from the chain,
  // is any case the contract chose, and its mutant is killed by a fixture whose
  // symbol is not its key in upper case.
  const byKey = m.tokens.find((t) => t.key.toLowerCase() === wanted);
  if (byKey) return byKey;
  const bySymbol = m.tokens.find((t) => t.symbol.toLowerCase() === wanted);
  if (bySymbol) return bySymbol;

  // The detail LISTS what exists, because the caller is a model and the whole
  // point of a persona-facing refusal is that it can fix its own call from it.
  throw new HttpError(
    'unknown_token',
    `no token "${keyOrSymbol}" in this deployment; it has ` +
      m.tokens.map((t) => `${t.key} (${t.symbol})`).join(', '),
  );
}

export function requireContract(m: Modules, key: string): RegisteredContract {
  const found = m.byKey.get(key);
  if (!found) throw new HttpError('unknown_contract', `no contract "${key}" in this deployment`);
  return found;
}

/// Builds the live view of a deployment: every token's symbol and decimals read
/// FROM THE CHAIN, in manifest order.
///
/// A SEAM RATHER THAN INLINE CODE IN THE ENTRYPOINT, for the reason this module
/// has already paid once elsewhere: a control that is correct and correctly fed
/// can still be dormant if the wiring hands it a constant, and the entrypoint is
/// the one place no test reaches. `read` is structural so a test can supply two
/// tokens without a chain.
///
/// IT FAILS CLOSED IN BOTH DIRECTIONS AND NEITHER IS INCIDENTAL:
///
///   - A token whose `symbol()`/`decimals()` cannot be read STOPS THE BOOT.
///     The permissive alternative - a default symbol, or dropping the instance -
///     would serve money endpoints against a contract nobody can describe.
///   - Two tokens reporting the SAME symbol stop the boot. The manifest forbids
///     it, but the manifest is a request and the chain is the answer: the
///     contract's symbol is what a persona sees in a refusal and in history, so
///     two instances sharing one is two different moneys with one name.
/// The ABI table is a PARAMETER for the same reason `read` is. `ABIS` is
/// generated from a forge build, so a test that wanted to exercise a custom
/// contract entry would otherwise have to add a real contract to src/ and build
/// it - which would make this a test of the build rather than of the registry.
export async function buildModules(
  deployment: Deployment,
  read: (address: Address) => Promise<{ symbol: string; decimals: number }>,
  abis: Record<string, Abi> = ABIS,
): Promise<Modules> {
  const tokens: TokenModule[] = [];
  let names: NamesModule | undefined;
  let converter: ConverterModule | undefined;
  const contracts: RegisteredContract[] = [];
  const byKey = new Map<string, RegisteredContract>();

  /// The key a caller addresses this entry by. Tokens and custom contracts
  /// carry their own; the singletons are addressed by their kind, because that
  /// is what the manifest writes for them - it gives them no key at all.
  const keyFor = (m: (typeof deployment.modules)[number]): string => m.key ?? m.kind;

  for (const m of deployment.modules) {
    const abi = abis[m.contract];
    if (!abi) {
      // A deployment can outlive the ABI file: add a contract, deploy it, do
      // not regenerate. Booting anyway moves the failure to the first call to
      // that contract - at request time, inside viem's encoder, in front of a
      // persona - instead of at boot in front of the operator who deployed it.
      throw new Error(
        `chain-svc: no ABI for contract "${m.contract}"; regenerate abi.ts ` +
          `(cd svc && bun run scripts/generate-abi.ts)`,
      );
    }
    const registered: RegisteredContract = {
      key: keyFor(m),
      kind: m.kind,
      name: m.contract,
      address: m.address,
      abi,
    };
    contracts.push(registered);
    byKey.set(registered.key, registered);
  }

  for (const m of deployment.modules) {
    if (m.kind === 'token') {
      let meta: { symbol: string; decimals: number };
      try {
        meta = await read(m.address);
      } catch (err) {
        throw new Error(
          `chain-svc: token "${m.key}" at ${m.address}: symbol()/decimals() unreadable - ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const clash = tokens.find((t) => t.symbol === meta.symbol);
      if (clash) {
        throw new Error(
          `chain-svc: tokens "${clash.key}" and "${m.key}" both report symbol ${meta.symbol}`,
        );
      }
      tokens.push({ key: m.key as string, address: m.address, symbol: meta.symbol, decimals: meta.decimals });
    } else if (m.kind === 'names') {
      names = { address: m.address, tld: m.tld as string };
    } else if (m.kind === 'converter') {
      // Address only, no chain read: its pairs live on the contract, and what
      // is callable on it is the allowlist's business, not the registry's.
      converter = { address: m.address };
    } else if (m.kind === 'contract') {
      // NO TYPED SLOT, and none is missing. A custom contract is reached
      // through `byKey` alone - that is what "no chain-svc code per feature"
      // means - so the flat view above is the whole of its registration.
    }
    // No else: a kind this build does not know is refused by loadDeployment
    // before it reaches here. It is NOT silently folded into `names`, which is
    // what a two-way branch would have done to the next module kind added.

  }

  return { tokens, names, converter, contracts, byKey };
}

/// The boot line's module summary: `token:play(PLAY, 18 dp)@0x…, names(.play)@0x…`.
///
/// An operator reading one line at start-up should be able to answer "what is on
/// this chain, and which token is the default?" without a second command. The
/// default is first because the list is in manifest order and that is what makes
/// it the default.
export function describeModules(m: Modules): string {
  const parts = m.tokens.map((t) => `token:${t.key}(${t.symbol}, ${t.decimals} dp)@${t.address}`);
  if (m.names) parts.push(`names(.${m.names.tld})@${m.names.address}`);
  if (m.converter) parts.push(`converter@${m.converter.address}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}
