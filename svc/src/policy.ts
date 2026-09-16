// Server-side enforcement of a wallet's spending policy (spec S5, ruled).
//
// wallet-mcp keeps its own copy of these checks as the model-facing fast path -
// it produces the readable refusal the persona sees - but the AUTHORITY is
// here, for the same reason `frozen` is: wallet-mcp runs inside a persona that
// is designed to be socially engineered, so a check that lives only there is a
// convenience, not a boundary. A compromised persona bypasses it by calling
// chain-svc directly, which is exactly what was demonstrated before this file.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './errors.ts';
import { keyFileName } from './validate.ts';

/// THE ONE PLACE THE WALLET KINDS ARE LISTED.
///
/// It used to be four: this union, the array `loadPolicyDefaults` iterates, the
/// three-way equality in `Spawner.parseKind`, and the PROSE of parseKind's
/// rejection message. Adding a kind meant finding all four, and the fourth is
/// prose - so the natural failure was a validator that accepted the new kind
/// beside a message still telling callers it was invalid. A message that
/// disagrees with the condition it explains is worse than no message: it sends
/// the caller to fix input that was already correct.
///
/// Everything downstream derives from this array, including the message, so a
/// kind is added in ONE edit and the code cannot disagree with itself about
/// what it accepts.
export const WALLET_KINDS = ['org', 'agent', 'burner'] as const;

export type WalletKind = (typeof WALLET_KINDS)[number];

/// A type guard rather than an equality chain, so the CHECK and the LIST cannot
/// drift apart. Widening `unknown` here is deliberate: the caller has parsed
/// JSON and holds no type at all yet.
export function isWalletKind(value: unknown): value is WalletKind {
  return (WALLET_KINDS as readonly unknown[]).includes(value);
}

/// The caps written into an agent's policy file at spawn, which wallet-mcp
/// enforces (spec S5).
/// A cap, as a whole-VEE amount. NUMBER OR DECIMAL STRING, because a cap IS an
/// amount and every other amount on these wires is a decimal string (ruled
/// ruled). A number is accepted for the same reason it is on `vee`: an integer
/// is exactly representable, and a config author writes 25 as readily as "25".
///
/// Never compared as a float. `Number("12.5") > max_per_tx` would reintroduce,
/// inside the check, the imprecision the string form exists to prevent - see
/// veeToWei.
export type VeeCap = number | string;

/// What one wallet may spend of ONE token.
///
/// BOTH FIELDS OPTIONAL as of v0.8.0. Absence is not a hole to fail closed on -
/// it is the answer "nobody wrote a bound", and chain-svc enforces only rules
/// someone has written. The two bounds are independent: a written `max_per_tx`
/// with no `max_per_stage` bounds each transaction and nothing per stage.
///
/// FAIL CLOSED ON GARBAGE, OPEN ON SILENCE. A field that is PRESENT and
/// unreadable still refuses at the point of use - see `capsFor`. The two are
/// different facts and the previous release conflated them, because when
/// absence already refused there was nothing for garbage to be distinguished
/// from.
export interface TokenCaps {
  max_per_tx?: VeeCap;
  max_per_stage?: VeeCap;
}

/// The rules someone has WRITTEN for one wallet. Every field is optional, and
/// absence means no rule.
///
/// THIS REVERSES v0.5.0's RULE, deliberately and at the owner's decision.
/// "A token with no entry cannot be spent" was the fail-closed reading of
/// silence, and the argument for it was that an absent cap read as "no limit"
/// is the reading that costs money. What changed is not the risk calculus but
/// what this service IS: a tool surface that enforces only what someone wrote,
/// with the rules that must survive a bypass living in the contracts. A service
/// that refuses on silence is acting on its own initiative, which is the thing
/// v0.8.0 removes.
///
/// WHAT SURVIVES OF THE OLD RULE, and it is the half that was actually load
/// bearing: a cap that is WRITTEN and unusable still refuses. Fail closed on
/// garbage, open on silence. The previous release could not tell those apart
/// because absence already refused, so garbage had nothing to be distinguished
/// FROM.
///
/// A WRITTEN EMPTY LIST KEEPS ITS WRITTEN MEANING. `allow: []` denies every
/// counterparty, as it always has; `deny: []` denies none. Absent and empty are
/// different documents and stay different answers - which is the same rule
/// `kinds` gets in the allowlist, for the same reason.
export interface AgentPolicy {
  /// KEYED BY TOKEN KEY, not by symbol: this is chain-svc's own bookkeeping,
  /// and `stage_spend` and `intents` store the key. A symbol is what a persona
  /// reads and writes; `resolveToken` is where the two meet, once.
  caps?: Record<string, TokenCaps>;
  allow?: string[];
  deny?: string[];
}

/// The caps for one token, or the refusal that says there are none.
///
/// `no_cap_set` rather than `over_max_per_tx` (§1b). The old code was
/// defensible as a DESCRIPTION - the per-transaction bound refusing, with the
/// bound at zero because nobody set one - and wrong as an INSTRUCTION: it tells
/// a persona a smaller amount would succeed, when no amount can. A code is the
/// closed set a model switches on, so it has to be actionable, not merely true.
///
/// The DETAIL is unchanged and says which token, because a persona holding two
/// currencies cannot otherwise tell which of its spends is impossible.
export function capsFor(policy: AgentPolicy | null, tokenKey: string): TokenCaps {
  const caps = policy?.caps?.[tokenKey];
  // §1b, AT THE POINT OF USE. `isCap` on both fields, not `=== undefined`: a
  // value this code cannot read is treated as ABSENT, which is the same answer
  // silence gets and is what `capsRefusal` already does on the wallet side.
  //
  // WHY IT MATTERS EVEN THOUGH `isPolicy` GATES EVERY FILE READ. That gate's
  // consequence is the wrong one: a policy file carrying `'unlimted'` reads as
  // NO POLICY, so this service falls back to the KIND DEFAULTS - wider caps -
  // while wallet-mcp, which validates per cap, answers `no_cap_set`. The two
  // layers would then disagree about exactly the value class §1b was ruled on,
  // and disagree in the permissive direction here. Checking at the point of use
  // makes the answer the same whichever route the policy arrived by.
  //
  // THREE OUTCOMES PER FIELD, and they are not two:
  //
  //   absent        -> unlimited. Nobody wrote a bound.
  //   "unlimited"   -> unlimited. Somebody wrote that there is none.
  //   a valid amount-> that bound.
  //   anything else -> `no_cap_set`. Written and unusable.
  //
  // The first two reach the same behaviour by different routes and must stay
  // distinguishable in the DOCUMENT even though they agree here: `policySource`
  // and the reads report what was written, and an operator who wrote
  // "unlimited" said something an operator who wrote nothing did not.
  //
  // `isCap`'s default 18 places is deliberate and must stay permissive: a cap
  // the loader accepted at SIX places has at most six fraction digits, so it
  // satisfies eighteen. This must never refuse what validation allowed.
  if (!caps) return {};
  for (const field of ['max_per_tx', 'max_per_stage'] as const) {
    const value = caps[field];
    if (value !== undefined && !isCap(value)) {
      // FAIL CLOSED ON GARBAGE. The detail names the FIELD, because a wallet
      // holding two currencies with one typo between them cannot otherwise
      // tell which of its spends is impossible.
      throw new HttpError('no_cap_set', `${field} for ${tokenKey} is not a usable amount`);
    }
  }
  return caps;
}

export type PolicyDefaults = Record<WalletKind, AgentPolicy>;

/// The one wildcard the defaults file's `caps` may use. EXACTLY TWO KEY FORMS,
/// `*` and a deployed token key - a third would make this a pattern language,
/// and the one place this system already has one (allow/deny) is the one place
/// it has needed a rule about what a pattern matching nothing means.
const CAPS_WILDCARD = '*';

/// Is this an entry someone could have written? BOTH FIELDS OPTIONAL as of
/// v0.8.0, and a PRESENT field must still be usable.
///
/// It used to require both, which made "a shape defect" and "a value defect"
/// one category - so an entry bounding only the per-transaction amount was
/// refused as malformed rather than read as what it plainly says. Each field
/// stands alone now; `{}` is an entry with no bounds, and `{max_per_tx: 'lots'}`
/// is still refused because the field is there and unreadable.
/// SHAPE ONLY. Is this an OBJECT that could be an entry? The VALUES are
/// `capsFor`'s business - its fourth outcome, `no_cap_set` at the point of use.
///
/// It used to validate values too, and that made one typo'd cap fail the whole
/// DOCUMENT: `isPolicy` runs this over every entry, so a wallet holding two
/// tokens lost both because one was mistyped. wallet-mcp validated per cap and
/// bounded only the affected token, and the divergence was found by reading the
/// two file READS side by side - which nothing compared, because every
/// agreement test we had compares a function to a function.
///
/// Ruled per-FIELD: a present-but-unusable value is garbage for its own field
/// and no more. The blast radius is the whole of the difference - one mistyped
/// cap either bricks a two-token wallet or bounds one token and leaves the
/// other alone - and the narrower answer is also the more informative one,
/// because `capsFor`'s detail names the field.
/// SHAPE *AND* VALUES, for the two places an OPERATOR is looking when it runs:
/// the kind-defaults file at boot, and a platform-scope PATCH body.
///
/// The FILE path deliberately does not use this. A per-wallet file is read on
/// every send, long after whoever wrote it has gone, and a bad value there is
/// scoped to its own field by `capsFor`. Here the author is present and the
/// refusal is the fastest way to tell them - the same reason `calls.json`
/// refuses at load rather than at call time.
function isUsableCaps(value: unknown): value is TokenCaps {
  if (!isTokenCaps(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    (c.max_per_tx === undefined || isCap(c.max_per_tx)) &&
    (c.max_per_stage === undefined || isCap(c.max_per_stage))
  );
}

/// EVERY KEY A POLICY DOCUMENT MAY CARRY, per level (finding: unknown keys).
///
/// v0.8.0 closed mistyped VALUES - a cap that is present and unusable refuses -
/// and left KEYS free-form, which is the one fail-open direction it did not
/// shut: `caps: { play: { max_per_tx_typo: '5' } }` reads as an entry with NO
/// bounds, unbounded for that token, in both layers, consistently. The typo
/// WIDENS, silently, and the file still looks right to whoever wrote it.
///
/// FIELD LEVELS ARE CLOSED; MAP LEVELS ARE NOT. `caps` is keyed by TOKEN, and
/// a deployment's token keys are its own - enumerating them here would refuse
/// every real document. The distinction is the rule: a level whose keys are a
/// fixed vocabulary is checked, a level whose keys are data is indexed.
///
/// `agentId` IS KNOWN, not tolerated-and-ignored: `writePolicyFile` stamps it
/// on every file this service writes, so a rule without it would mark the
/// entire installed base unreadable and re-create the write-path defect through
/// a second door. `frozen` IS tolerated: every file written before v0.8.0
/// carries `frozen: false`, and refusing those would do the same.
const POLICY_KEYS = new Set(['agentId', 'caps', 'allow', 'deny', 'max_per_tx', 'max_per_stage']);
/// Written by a version that had a service-side freeze. Read and DISCARDED -
/// `normalisePolicy` never carries it forward - but its presence is not an
/// error, because the alternative is bricking every wallet spawned before
/// v0.8.0.
const POLICY_KEYS_TOLERATED = new Set(['frozen']);
/// One token's bounds. A closed field level: these are the only two bounds
/// there are, and a third spelling of either is the defect this rule exists for.
const TOKEN_CAPS_KEYS = new Set(['max_per_tx', 'max_per_stage']);

/// Are all of this object's keys ones the level knows?
function keysKnown(value: Record<string, unknown>, known: Set<string>, tolerated?: Set<string>): boolean {
  return Object.keys(value).every((k) => known.has(k) || tolerated?.has(k) === true);
}

/// The unknown keys of an object, for a message that can name them.
export function unknownKeysOf(
  value: Record<string, unknown>,
  known: Set<string>,
  tolerated?: Set<string>,
): string[] {
  return Object.keys(value).filter((k) => !known.has(k) && tolerated?.has(k) !== true);
}

function isTokenCaps(value: unknown): value is TokenCaps {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // SHAPE ONLY, still: a VALUE that is present and unusable is field-level
  // garbage and refuses at the point of use, for that token alone. A KEY the
  // entry has never had is a wrong shape, and shape failures are file-level.
  return keysKnown(value as Record<string, unknown>, TOKEN_CAPS_KEYS);
}

/// Turns the defaults file's `caps` into one entry per DEPLOYED token.
///
/// `*` is copied to every deployed key; an explicit key REPLACES the whole pair
/// for that token rather than merging into it, because field-by-field merging
/// is the trap: "au gets a bigger max_per_tx" would silently inherit the
/// wildcard's max_per_stage, and the wallet would carry two halves of one bound
/// taken from two different currencies.
///
/// SEPARATE FROM the `{tld}` substitution beside it rather than folded into it.
/// They answer different questions - which tokens a cap covers, and what a
/// pattern with no TLD can match - and the second has its own rule about a
/// pattern that matches nothing, which this one must not inherit.
function expandCaps(raw: unknown, tokenKeys: string[], kind: string, path: string): Record<string, TokenCaps> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`chain-svc: policy defaults at ${path}: "${kind}" has no caps object`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    // An empty caps map is a wallet that can spend nothing. That may be
    // deliberate for a kind, but it is not something to arrive at by leaving a
    // key out of a file, so it has to be written rather than defaulted into.
    throw new Error(`chain-svc: policy defaults at ${path}: "${kind}" sets no caps`);
  }

  const out: Record<string, TokenCaps> = {};
  let wildcard: TokenCaps | undefined;
  for (const [key, value] of entries) {
    if (!isUsableCaps(value)) {
      throw new Error(
        `chain-svc: policy defaults at ${path}: "${kind}" caps "${key}" is not ` +
          `{max_per_tx, max_per_stage} of usable amounts`,
      );
    }
    if (key === CAPS_WILDCARD) {
      wildcard = value;
      continue;
    }
    if (!tokenKeys.includes(key)) {
      // At LOAD, where the operator who wrote it is looking. A key naming a
      // token that is not deployed is a cap that will never be consulted, and
      // its author believes it will.
      throw new Error(
        `chain-svc: policy defaults at ${path}: "${kind}" caps names "${key}", not a deployed token`,
      );
    }
    out[key] = value;
  }

  if (wildcard) {
    for (const key of tokenKeys) {
      if (out[key] === undefined) out[key] = wildcard;
    }
  }
  return out;
}

/// Reads either policy shape and returns the current one.
///
/// The LEGACY shape - top-level `max_per_tx`/`max_per_stage` - becomes
/// `caps[<default token key>]`. A store full of v0.4.0 policy files is the
/// ordinary upgrade, and refusing them would freeze every wallet in a running
/// game; splitting them across tokens would invent a bound nobody wrote.
///
/// A file carrying BOTH shapes - written by a new binary, edited by hand from
/// an old example - keeps the NEW one: it is the shape that can express what
/// the old cannot, and preferring the legacy pair would discard every token but
/// the default.
/// A policy DOCUMENT as read from disk, in whichever shape it was written.
///
/// EVERY SHAPE `isPolicy` ACCEPTS MUST COME OUT OF HERE. The two were allowed
/// to disagree while a document this function threw on became "no policy" and
/// fell back to the kind defaults - wrong, but bounded. At v0.8.0 the throw
/// lands in `readPolicyFile`'s catch and becomes the UNREADABLE MARKER, so a
/// disagreement turns a valid permissive document into a wallet that refuses
/// every spend. Measured on 60da6e4: FIVE of the six shapes the gate accepts
/// threw here, including `{}` and the half-written entry §5.3 requires.
///
/// The property is asserted rather than the instances - see the pair test in
/// caps.test.ts, the same shape as isCap/capToWei one level up. A test naming
/// today's shapes says nothing about the next one somebody writes.
export function normalisePolicy(value: unknown, defaultTokenKey: string | undefined): AgentPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError('invalid_request', 'policy must be an object');
  }
  const p = value as Record<string, unknown>;
  // ABSENT LISTS ARE NOT MISSING LISTS. `allow` absent allows everything,
  // `deny` absent denies nothing; a PRESENT one must still be a list of names.
  if (p.allow !== undefined && !isNameList(p.allow)) {
    throw new HttpError('invalid_request', 'allow must be an array of non-empty strings');
  }
  if (p.deny !== undefined && !isNameList(p.deny)) {
    throw new HttpError('invalid_request', 'deny must be an array of non-empty strings');
  }
  const lists: AgentPolicy = {
    ...(p.allow === undefined ? {} : { allow: p.allow as string[] }),
    ...(p.deny === undefined ? {} : { deny: p.deny as string[] }),
  };

  if (p.caps !== undefined) {
    if (typeof p.caps !== 'object' || p.caps === null || Array.isArray(p.caps)) {
      throw new HttpError('invalid_request', 'caps must be an object keyed by token');
    }
    for (const [key, caps] of Object.entries(p.caps as Record<string, unknown>)) {
      if (!isTokenCaps(caps)) {
        throw new HttpError('invalid_request', `caps.${key} must be {max_per_tx, max_per_stage}`);
      }
    }
    return { caps: p.caps as Record<string, TokenCaps>, ...lists };
  }

  // THE LEGACY PAIR, TAKING EITHER HALF. It required both, so a file bounding
  // only the per-transaction amount threw - while the SAME intent in the new
  // shape (`caps: {play: {max_per_tx}}`) is read as "bound each transaction, no
  // stage bound". One operator intent, two answers, decided by which spelling
  // they happened to use.
  if (p.max_per_tx !== undefined || p.max_per_stage !== undefined) {
    for (const field of ['max_per_tx', 'max_per_stage'] as const) {
      if (p[field] !== undefined && !isCap(p[field])) {
        throw new HttpError('invalid_request', `${field} must be a usable amount`);
      }
    }
    if (defaultTokenKey === undefined) {
      throw new HttpError(
        'invalid_request',
        'a legacy policy names no token and this deployment has none to read it against',
      );
    }
    return {
      caps: {
        [defaultTokenKey]: {
          ...(p.max_per_tx === undefined ? {} : { max_per_tx: p.max_per_tx as VeeCap }),
          ...(p.max_per_stage === undefined ? {} : { max_per_stage: p.max_per_stage as VeeCap }),
        },
      },
      ...lists,
    };
  }

  // NO CAPS AT ALL is a document, not a defect: allow/deny rules and no bounds
  // is exactly what §1 invites an operator to write, and so is `{}`. This used
  // to be the final throw.
  return lists;
}

/// Loaded from policy-defaults.json rather than held as a constant here, so the
/// numbers are game balance the owner tunes and not something a builder chose
/// (ruled). Read once at startup and FAILS LOUDLY if missing or
/// malformed: a wallet spawned with no caps is an unbounded wallet, so this
/// must not fall back to something permissive.
/// Patterns in the defaults file are written with a `{tld}` placeholder
/// (`*.{tld}`, `treasury.{tld}`) because the suffix is DEPLOYMENT DATA now, not
/// a constant: a deployment declares its TLD in the manifest and the same
/// defaults file has to serve all of them.
///
/// Without a names module the placeholder cannot be filled, and a pattern with
/// no TLD can match nothing - so those entries are DROPPED at load rather than
/// kept as literals containing `{tld}`, which would be a rule that silently
/// matches nothing while reading as if it matches something.
///
/// Logged ONCE PER DISTINCT PATTERN PER PROCESS, not per agent and not per
/// send: on a names-less deployment every agent without its own policy file
/// inherits these, so a per-agent key would print the same fact once per
/// wallet, and `policyFor` re-reads the file on every send by design. Once per
/// process is the signal; once ever would need a store row, and a config
/// oddity does not earn one.
const TLD_PATTERN = /\{tld\}/;

/// EXPORTED so a test can clear it, and that is not a leak of internals - it is
/// the honest shape of "once per PROCESS". The property is about process state,
/// so a test asserting it has to own that state; leaving the set private made
/// the assertion depend on which other test file had already consumed the first
/// occurrence, which is a test that passes alone and fails in a suite.
export const droppedPatternsLogged = new Set<string>();

function fillPatterns(
  patterns: string[],
  tld: string | undefined,
  field: 'allow' | 'deny',
  warn: (message: string) => void,
): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!TLD_PATTERN.test(pattern)) {
      out.push(pattern);
      continue;
    }
    if (tld === undefined) {
      if (!droppedPatternsLogged.has(pattern)) {
        droppedPatternsLogged.add(pattern);
        warn(
          `[chain-svc] policy default ${field} pattern ${JSON.stringify(pattern)} names a TLD and ` +
            `this deployment has no names module, so it is dropped: it could match nothing. ` +
            `Nothing here can be addressed by name, so the rule has nothing to say.`,
        );
      }
      continue;
    }
    out.push(pattern.replace(TLD_PATTERN, tld));
  }
  return out;
}

export function loadPolicyDefaults(
  path: string,
  tld: string | undefined,
  /// The DEPLOYED token keys, in manifest order. Needed because `*` means
  /// "every token this deployment has", which the file cannot know and this
  /// function can - and because an explicit key naming a token that is not
  /// there is refused rather than kept as a cap nothing will consult.
  tokenKeys: string[],
  warn: (message: string) => void = console.warn,
): PolicyDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`chain-svc: cannot read policy defaults at ${path}: ${(err as Error).message}`);
  }
  const out = {} as PolicyDefaults;
  for (const kind of WALLET_KINDS) {
    const entry = (parsed as Record<string, unknown>)?.[kind] as Record<string, unknown> | undefined;
    if (typeof entry !== 'object' || entry === null || !isNameList(entry.allow) || !isNameList(entry.deny)) {
      throw new Error(`chain-svc: policy defaults at ${path} have no valid "${kind}" entry`);
    }
    // A KIND'S ENTRY IS A CLOSED FIELD LEVEL, refused AT LOAD with the key
    // named - unlike a per-wallet file, which has no operator standing beside
    // it and gets the fixed unreadable marker instead.
    //
    // `agentId` is tolerated here for symmetry with the per-wallet document:
    // one rule fewer to remember, and it means nothing at this level anyway.
    //
    // THE TOP LEVEL OF THIS FILE IS NOT CHECKED, and that is deliberate. It is
    // a MAP keyed by kind, and the loop above INDEXES INTO IT by WALLET_KINDS
    // rather than enumerating it - which is why `_comment` has always worked,
    // the file's documented stand-in for JSON's missing comment syntax and
    // something the shipped example leans on. Enumerating it to check for
    // unknown keys would refuse that, and refuse a kind added by a newer build.
    const unknown = unknownKeysOf(entry, POLICY_KEYS, POLICY_KEYS_TOLERATED);
    if (unknown.length > 0) {
      throw new Error(
        `chain-svc: policy defaults at ${path}, entry "${kind}": unknown ` +
          `${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
          `A misspelled bound is read as absent, which since v0.8.0 means NO bound.`,
      );
    }
    if (entry.caps !== undefined && typeof entry.caps === 'object' && entry.caps !== null) {
      for (const [token, capsEntry] of Object.entries(entry.caps as Record<string, unknown>)) {
        if (typeof capsEntry !== 'object' || capsEntry === null || Array.isArray(capsEntry)) continue;
        const bad = unknownKeysOf(capsEntry as Record<string, unknown>, TOKEN_CAPS_KEYS);
        if (bad.length > 0) {
          throw new Error(
            `chain-svc: policy defaults at ${path}, entry "${kind}", token "${token}": unknown ` +
              `${bad.length === 1 ? 'key' : 'keys'} ${bad.map((k) => `"${k}"`).join(', ')}. ` +
              `A misspelled bound is read as absent, which since v0.8.0 means NO bound.`,
          );
        }
      }
    }
    out[kind] = {
      caps: expandCaps(entry.caps, tokenKeys, kind, path),
      allow: fillPatterns(entry.allow, tld, 'allow', warn),
      deny: fillPatterns(entry.deny, tld, 'deny', warn),
    };
  }
  return out;
}

/// A cap in wei, from either accepted form. One conversion for both, so a
/// number and its string spelling can never compare differently.
export function capToWei(cap: VeeCap, decimals: number): bigint {
  const text = typeof cap === 'number' ? String(cap) : cap;
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
}

/// Is this a usable cap? A positive integer, or a positive decimal string with
/// at most `decimals` places - the same shape `vee` takes on the wire.
///
/// `decimals` defaults to 18 for the SHAPE check alone, because a policy
/// document is validated at spawn and PATCH time on deployments that may have
/// no token at all. Without a token nothing can move, so a cap is stored as
/// given and never enforced; validating its shape against the commonest scale
/// is better than refusing to validate it, and better than inventing a scale
/// for a token that is not there.
export function isCap(value: unknown, decimals = 18): value is VeeCap {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  // §1b. EXACTLY `"unlimited"`, before the regex and never a broader test.
  //
  // The fail-open implementation is the one to reach for and the one to refuse:
  // `!isNumeric(v) -> no bound` makes `"unlimted"` an uncapped wallet, and a
  // typo in a policy file is the likeliest way anyone ever writes a
  // non-numeric cap. An exact match keeps the regex as the gate for every
  // other string, so an unrecognised value stays invalid and reads as ABSENT -
  // which fails closed, as `no_cap_set`.
  if (value === UNLIMITED) return true;
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(value)) return false;
  return capToWei(value, decimals) > 0n;
}

/// §1b. A reservation's stage bound, in three explicit states.
///
///   { cap: bigint }        bound AND record - a wallet with a finite cap
///   { cap: 'unlimited' }   record WITHOUT bounding - a wallet that chose none
///   null                   neither - platform scope, which has no stage
///
/// A DISCRIMINATED VALUE RATHER THAN A SENTINEL, so the call site has to say
/// which of the two "no bound" meanings it wants. They differ in the half that
/// is not the bound: one records the spend and the other has nothing to record.
export type StageCap = { cap: bigint | typeof UNLIMITED } | null;

/// §1b. The one cap value that is not an amount. A named constant rather than a
/// string literal at each site: three files test for it, and a fourth spelling
/// of it would be an uncapped wallet that looks capped.
export const UNLIMITED = 'unlimited';

const isNameList = (a: unknown): a is string[] =>
  Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length > 0);

/// A CALLER-SUPPLIED POLICY IS A PATCH OVER THE KIND DEFAULTS, not a complete
/// document. Every field is optional and an omitted one falls to the default
/// for the wallet's kind (spec S4.1: "caps may be omitted and fall to
/// chain-svc's agent defaults").
///
/// It used to demand all four, which produced an asymmetry nobody would design
/// on purpose and which broke the acme: sending NO policy succeeded and fell
/// to defaults, while sending a strictly MORE SPECIFIC one - `allow`/`deny`
/// with the caps left to the defaults, which is the harness's whole use - was
/// refused outright. Found by running the stack rather than
/// reading it.
export function mergePolicy(
  value: unknown,
  /// The base to merge onto, or NULL when there is none - no file and no kind
  /// default. A null base means the written fields stand alone, which is what
  /// a PATCH against a wallet with no rules produces.
  defaults: AgentPolicy | null,
  /// The default token's KEY, for reading a caller's legacy `max_per_tx` pair.
  /// Optional because a deployment may have no token at all, in which case a
  /// legacy pair has nothing to be about and is refused rather than guessed at.
  defaultTokenKey?: string,
): AgentPolicy {
  if (value === undefined || value === null) return defaults ?? {};
  if (typeof value !== 'object') {
    throw new HttpError('invalid_request', 'policy must be an object');
  }
  const p = value as Record<string, unknown>;

  for (const field of ['max_per_tx', 'max_per_stage'] as const) {
    if (p[field] !== undefined && !isCap(p[field])) {
      // invalid_amount, not invalid_request (ruled): a cap IS an amount,
      // and a caller that sent 25.5 has made an amount mistake, not a
      // malformed-request one. Same code `vee` gets for the same reason.
      throw new HttpError(
        'invalid_amount',
        `${field} must be a decimal string of whole units, e.g. "25"; an integer number is ` +
          `tolerated, a non-integer number is refused rather than rounded`,
      );
    }
  }
  for (const field of ['allow', 'deny'] as const) {
    if (p[field] !== undefined && !isNameList(p[field])) {
      throw new HttpError('invalid_request', `${field} must be an array of non-empty strings`);
    }
  }

  // A SUPPLIED CAPS MAP IS TAKEN WHOLE, replacing the kind's. The same rule as
  // the defaults file's explicit key, one level up: a caps map is what THIS
  // wallet may spend, not an amendment to what its kind may - and merging would
  // let a caller widen one token by naming another.
  //
  // The LEGACY pair is still accepted from a caller and read against the
  // default token, leaving the other tokens' defaults in place: a caller
  // writing the old shape is saying something about the default token, not
  // about every token.
  let caps = defaults?.caps;
  if (p.caps !== undefined) {
    if (typeof p.caps !== 'object' || p.caps === null || Array.isArray(p.caps)) {
      throw new HttpError('invalid_request', 'caps must be an object keyed by token');
    }
    for (const [key, value] of Object.entries(p.caps as Record<string, unknown>)) {
      if (!isUsableCaps(value)) {
        throw new HttpError('invalid_request', `caps.${key} must be {max_per_tx, max_per_stage}`);
      }
    }
    caps = p.caps as Record<string, TokenCaps>;
  } else if (p.max_per_tx !== undefined || p.max_per_stage !== undefined) {
    if (defaultTokenKey === undefined) {
      throw new HttpError(
        'invalid_request',
        'max_per_tx and max_per_stage name no token and this deployment has none to read them against',
      );
    }
    const existing = defaults?.caps?.[defaultTokenKey];
    caps = {
      ...defaults?.caps,
      [defaultTokenKey]: {
        max_per_tx: (p.max_per_tx as VeeCap) ?? existing?.max_per_tx,
        max_per_stage: (p.max_per_stage as VeeCap) ?? existing?.max_per_stage,
      },
    };
    if (!isUsableCaps(caps[defaultTokenKey])) {
      throw new HttpError('invalid_request', 'max_per_tx and max_per_stage must be usable amounts');
    }
  }

  // A WRITTEN FIELD REPLACES; AN UNWRITTEN ONE KEEPS THE BASE. With every field
  // optional, "unwritten" and "written as absent" are the same JSON, so a PATCH
  // cannot remove a field the base has - `clear: true` deletes the whole file,
  // which is the operation that means "no rules of my own".
  const merged: AgentPolicy = {
    ...(caps === undefined ? {} : { caps }),
    ...(p.allow !== undefined || defaults?.allow !== undefined
      ? { allow: (p.allow as string[]) ?? defaults!.allow }
      : {}),
    ...(p.deny !== undefined || defaults?.deny !== undefined
      ? { deny: (p.deny as string[]) ?? defaults!.deny }
      : {}),
  };
  if (merged.allow) assertPatternsUsable(merged.allow, 'allow');
  if (merged.deny) assertPatternsUsable(merged.deny, 'deny');
  return merged;
}

/// Still used to validate a policy FILE read back from disk, where a complete
/// document is what was written.
/// Is this a policy DOCUMENT? Every field optional as of v0.8.0, and a PRESENT
/// field must be usable.
///
/// It used to require `allow` AND `deny` AND either a caps map or the legacy
/// pair - a complete document or nothing. That mattered when a document this
/// predicate rejected became "no policy" and fell back to the kind defaults:
/// the gate had to be strict because its failure mode was permissive. At
/// v0.8.0 a file that exists and does not satisfy this is UNREADABLE and every
/// spend refuses, so the gate can say what a document actually is.
///
/// `{}` IS A VALID DOCUMENT: a wallet whose operator wrote no rules. That is
/// the shape `PATCH { clear: true }` is an alternative to, and the shape a
/// caller can PATCH one field onto.
export function isPolicy(value: unknown): value is AgentPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (!keysKnown(p, POLICY_KEYS, POLICY_KEYS_TOLERATED)) return false;
  if (p.allow !== undefined && !isNameList(p.allow)) return false;
  if (p.deny !== undefined && !isNameList(p.deny)) return false;
  // EITHER SHAPE IS A VALID DOCUMENT ON DISK. A store full of v0.4.0 policy
  // files is the ordinary upgrade, and a predicate that recognised only the new
  // shape would make every one of them unreadable - which now REFUSES rather
  // than widening, so the cost of missing one moved but did not vanish.
  if (p.caps !== undefined) {
    if (typeof p.caps !== 'object' || p.caps === null || Array.isArray(p.caps)) return false;
    return Object.values(p.caps as Record<string, unknown>).every(isTokenCaps);
  }
  // The legacy pair, when either half is written. Absent both, this is a
  // document with no caps in it, which is now a thing someone can write.
  if (p.max_per_tx === undefined && p.max_per_stage === undefined) return true;
  return (
    (p.max_per_tx === undefined || isCap(p.max_per_tx)) &&
    (p.max_per_stage === undefined || isCap(p.max_per_stage))
  );
}


/// The policy chain-svc enforces for an agent is the SAME file it writes for
/// wallet-mcp to read, so the boundary and the fast path cannot drift into
/// disagreeing about what the caps are.
/// What a policy file read can say. THREE OUTCOMES, not two:
///
///   an AgentPolicy   the file exists and parses - these are the rules
///   null             no file - nobody wrote rules for this wallet
///   { unreadable }   a file exists and does not parse - written garbage
///
/// The third used to collapse into the second, which was safe only while an
/// absent cap refused downstream.
/// `unreadable` is the PERSONA-facing string and is always the same words.
/// `reason` is the operator's, and goes to the log and to the platform-scope
/// PATCH refusal - never to a wallet-scope caller.
export type PolicyRead = AgentPolicy | null | { unreadable: string; reason: string };

/// Is this read a marker rather than a policy?
export function isUnreadable(r: PolicyRead): r is { unreadable: string; reason: string } {
  return r !== null && 'unreadable' in r;
}

export async function readPolicyFile(
  policyDir: string,
  agentId: string,
  /// The default token's key, for reading a LEGACY file. Optional: a
  /// deployment with no token has nothing for a legacy pair to be about, and a
  /// file in the new shape needs no default at all.
  defaultTokenKey?: string,
): Promise<PolicyRead> {
  let raw: string;
  try {
    raw = await readFile(join(policyDir, keyFileName(agentId)), 'utf8');
  } catch {
    // ABSENT IS ABSENT. No file means nobody wrote rules for this wallet, and
    // the caller falls through to the kind default or to nothing. This is the
    // only branch that returns null, and it is the only one that should.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPolicy(parsed)) {
      return { unreadable: 'policy file unreadable', reason: 'not a policy document' };
    }
    // MIGRATED IN MEMORY, NOT REWRITTEN HERE. A read is a read; the file is
    // rewritten in the new shape by the next `writePolicyFile`, which is a
    // write somebody asked for. Migrating on read would have every send
    // rewriting a file, and a read path that writes is a read path that can
    // fail for reasons the caller never asked about.
    return normalisePolicy(parsed, defaultTokenKey);
  } catch (err) {
    // A FILE THAT EXISTS AND DOES NOT PARSE IS WRITTEN GARBAGE AT FILE LEVEL,
    // and this is the one case v0.8.0 reverses in the OTHER direction from
    // everything else in the release.
    //
    // It used to return null - "we could not read the rules, defer to the
    // fallback" - which was defensible while an absent CAP refused: the
    // permissive answer here was bounded by a fail-closed answer downstream.
    // With absence meaning no limit, deferring would make an unreadable file
    // the WIDEST policy a wallet can have, and a corrupt byte would unbound a
    // wallet silently.
    //
    // So: absent -> null (no rules written), unreadable -> a marker every
    // spend refuses on. Fail closed on garbage, open on silence, at file level
    // exactly as at field level.
    // ONE FIXED STRING, and the reason never travels with it. This marker
    // becomes a PERSONA-facing detail: `no_cap_set` is persona-facing and its
    // detail crosses with it. Measured on both sides - bun answers
    // `JSON Parse error: Unexpected identifier "treasuryOnly"`, quoting an
    // operator's unquoted value verbatim, so a counterparty name or an amount
    // reaches a model through a refusal.
    //
    // Naming the failing FIELD would report the document back the same way, so
    // shape failures use the same string. The reason goes to the log sink,
    // which is the split `revert` already makes.
    return { unreadable: 'policy file unreadable', reason: err instanceof Error ? err.message.split('\n')[0] : 'unparseable' };
  }
}


/// The pattern dialect for allow and deny lists. THREE forms and no more:
///
///   `*`        matches anything
///   `*suffix`  matches any name ending `suffix`   (`*.play`)
///   `prefix*`  matches any name starting `prefix` (`acme:*`)
///   anything else is a LITERAL, compared whole.
///
/// Still deliberately not a general glob: the patterns come from a game config,
/// and a regex dialect nobody has specified is a way to write an allow rule
/// that silently matches more than its author meant. The trailing-star form was
/// added (ruled) because `acme:*` was needed and, until then, matched
/// NOTHING - it fell through to the literal comparison, so it was compared as
/// the seven-character string `acme:*`. In an allow list that refuses
/// everything, which is loud; in a DENY list it denies nothing, which is not.
///
/// A star anywhere else (`a*b`, `**`, `a*b*c`) is REFUSED AT POLICY LOAD rather
/// than silently treated as a literal - see assertPatternsUsable. A pattern
/// that looks like a glob and behaves like a string is the failure this dialect
/// exists to avoid, and the old code had exactly one of them.
///
/// wallet-mcp carries an identical copy. They must agree: wallet-mcp's
/// local refusal is the model-facing fast path and chain-svc's is the boundary,
/// and a pattern that means different things in the two is the drift the shared
/// policy file was written to prevent. `test/policy.test.ts` asserts agreement
/// across both lists.
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/// Refuses a pattern whose star is in a position this dialect does not
/// implement, so it fails at load with a name rather than at match time by
/// quietly matching nothing. Called for both `allow` and `deny`: a malformed
/// entry in `deny` is the dangerous one, because it fails silently open.
export function assertPatternsUsable(patterns: string[], field: 'allow' | 'deny'): void {
  for (const p of patterns) {
    const stars = p.split('*').length - 1;
    const usable = p === '*' || (stars === 1 && (p.startsWith('*') || p.endsWith('*'))) || stars === 0;
    if (!usable) {
      throw new HttpError(
        'invalid_request',
        `${field} pattern ${JSON.stringify(p)} is not supported: a star is allowed only as the ` +
          `whole pattern, a leading star (*.play), or a trailing star (acme:*)`,
      );
    }
  }
}

export function isDenied(policy: AgentPolicy | null, name: string): boolean {
  // ABSENT DENIES NOTHING; a WRITTEN empty list also denies nothing, and the
  // two agree here by accident rather than by design - `deny: []` is the
  // written statement "deny no one", which is what absence means too. They
  // differ only in what `GET /wallets/:id` reports back.
  return (policy?.deny ?? []).some((p) => matchesPattern(p, name));
}

export function isAllowed(policy: AgentPolicy | null, name: string): boolean {
  // ABSENT ALLOWS EVERYTHING; a WRITTEN `allow: []` allows NOTHING. This is the
  // one place absent and empty diverge, and the divergence is the point: an
  // operator who wrote an empty allow list said "this wallet pays no one", and
  // reading that as "no rule" would silently unbound the most restrictive
  // policy anyone can write.
  return policy?.allow === undefined || policy.allow.some((p) => matchesPattern(p, name));
}

/// §1b. The stage bound for a reservation, or `'unlimited'`.
///
/// NEVER NULL. Null is `reserve`'s third state and means "no stage at all"
/// (platform scope); a wallet with an `"unlimited"` stage cap HAS a stage and
/// its spends are recorded in it. Returning null here would collapse the two
/// and lose the audit fact - measured: `store.reserve` guarded the
/// `stage_spend` write on the cap itself, so `capWei: null` skipped the
/// recording along with the bound.
export function stageCapWei(policy: AgentPolicy | null, tokenKey: string, decimals: number): StageCap {
  // Through capsFor, so a token with no entry refuses HERE rather than
  // defaulting to an unbounded stage. The reservation would otherwise take a
  // hold against a cap nobody set.
  const cap = capsFor(policy, tokenKey).max_per_stage;
  // ABSENT AND "unlimited" REACH THE SAME STATE, and the state is still
  // `{ cap: 'unlimited' }` rather than `null` - the spend is RECORDED whether
  // or not it is bounded. `null` stays platform-only, which is the distinction
  // the three-state argument exists to keep.
  //
  // `capToWei` never sees the string.
  if (cap === undefined || cap === UNLIMITED) return { cap: UNLIMITED };
  return { cap: capToWei(cap, decimals) };
}

/// Throws the S5 refusal that applies, in the order S5 lists them, so the
/// reason a persona sees is stable rather than dependent on check ordering.
///
/// `over_stage_cap` is NOT raised here - it belongs to the atomic reservation
/// in the store, because a cap tested separately from the record it guards is
/// a check-then-act that every concurrent caller passes. See
/// `Store.reserveStageSpend`. (These two paragraphs sat on `stageCapWei`,
/// whose doc block had collected three headers; they describe this function.)
///
/// HOW THE DENY LIST IS MATCHED, and why it takes two passes.
///
/// A wallet holds MORE THAN ONE name by design - that is not an edge case, it
/// is what `POST /aliases` is for: `addAlias` calls
/// `registerFor(alias, wallet, wallet)`, so a vanity alias and the canonical
/// agent id resolve to the same address. Matching the deny list against the
/// string the caller typed therefore denied a NAME and not a WALLET. Measured
/// before the fix, with `deny: ["mark.play"]` - "mark.play" refused,
/// "orch:mark" ALLOWED, same wallet, no registrar write and no privilege.
///
/// This function closes it by NAME: deny matches the requested name OR the
/// canonical, so a deny naming the canonical cannot be dodged with an alias.
/// That is the ruled case and the common one, because `reverse[target]`
/// keeps the first-registered name as the canonical.
///
/// It CANNOT close a deny naming one alias while the caller uses another -
/// neither string matches the entry, and the canonical matches neither. That
/// case is closed by IDENTITY in `Treasury.assertNotDeniedByIdentity`, which
/// resolves each literal deny entry once and compares addresses. Both passes
/// exist because neither is sufficient: wildcards have no address to resolve,
/// and strings cannot see through an alias.
///
/// Guidance that follows from the residual: a deny entry should name a
/// CANONICAL id, never a vanity alias - an alias-named deny relies on the
/// identity pass, which fails open if the registry read fails.
export function enforcePolicy(args: {
  /// NULL means nobody wrote rules for this wallet: no bound, nothing denied,
  /// everything allowed. The zero-amount floor below is NOT policy and applies
  /// either way - it is a property of the rail, not a rule someone wrote.
  policy: AgentPolicy | null;
  to: string;
  /// The registry's primary name for the resolved address. Pass it: matching
  /// only `to` is the alias bypass this function used to have.
  canonical?: string;
  amount: bigint;
  /// The default token's scale and symbol. Passed rather than assumed: a cap
  /// is a decimal string in whole units, and comparing it to an amount needs
  /// the scale the amount was parsed at.
  decimals: number;
  symbol: string;
  /// WHICH TOKEN's caps to check against. The key, not the symbol: caps are
  /// keyed by the manifest's own name, and `resolveToken` is the one place a
  /// symbol becomes a key.
  tokenKey: string;
}): void {
  const { policy, to, canonical, amount, decimals, symbol, tokenKey } = args;

  // THE ZERO FLOOR IS NOT POLICY, and it runs ahead of everything that reads
  // one. A property of the rail: `parseVee` accepts "0" deliberately - it is a
  // parser and zero is a valid number - and a zero-amount sign-transfer burns
  // an intent id and emits a zero Transfer for nothing. That is true whether or
  // not an operator wrote any rules, and a direct caller with a wallet token
  // bypasses wallet-mcp's own refusal entirely.
  //
  // MOVED AHEAD AT v0.8.0. It sat below the cap checks, which was harmless
  // while every wallet had a policy - and would have become unreachable the
  // moment a null policy short-circuited them. A guard deleted by accident
  // rather than by decision, and nothing would have failed.
  if (amount <= 0n) {
    throw new HttpError('invalid_amount', 'the amount must be greater than zero');
  }
  // capsFor, not policy.max_per_tx: a wallet with no entry for this token
  // cannot spend it, and that refusal has to come from the same place every
  // other cap does.
  const caps = capsFor(policy, tokenKey);
  // §1b. `"unlimited"` skips the per-transaction bound, INDEPENDENTLY of the
  // stage bound - each field takes the value on its own. `capToWei` never sees
  // the string.
  const perTx =
    caps.max_per_tx === undefined || caps.max_per_tx === UNLIMITED
      ? null
      : capToWei(caps.max_per_tx, decimals);

  if (perTx !== null && amount > perTx) {
    throw new HttpError('over_max_per_tx', `max_per_tx is ${caps.max_per_tx} ${symbol}`);
  }

  // BOTH NAMES, and the two lists use them differently ON PURPOSE (ruled).
  //
  // DENY matches EITHER, so it is strictly harder to evade: a wallet holds more
  // than one name by design - `addAlias` registers an alias against the same
  // address - so denying `treasury.play` while `treasure.play` resolved to the
  // same wallet was a refusal and an allowance for one counterparty.
  //
  // ALLOW also matches either, and NOT the canonical alone, which is what a
  // literal reading of "evaluate against the resolved principal" would give.
  // Measured: the default agent allow list is `["*.{tld}"]` and canonical ids look
  // like `orch:bob`, so canonical-only matching refuses EVERY send to EVERY
  // agent wallet. Widening deny is the safe direction; narrowing allow is not.
  const names = canonical && canonical !== to ? [to, canonical] : [to];
  const denied = names.some((n) => isDenied(policy, n));
  const allowed = names.some((n) => isAllowed(policy, n));

  if (denied || !allowed) {
    throw new HttpError('counterparty_denied', `${to} is not an allowed counterparty`);
  }
}
