// The model-facing policy check (spec S5).
//
// AUTHORITY LIVES IN CHAIN-SVC, NOT HERE. This process runs inside a persona
// that is designed to be socially engineered, so every check below is a
// convenience: it gives the model a readable refusal without a round trip, and
// it owns `duplicate_intent`, which only this side can see. chain-svc enforces
// the same caps on /sign-transfer and wins any disagreement - the same rule as
// `frozen`. Do not "optimise" the server-side check away on the grounds that
// this one exists.

import { readFileSync } from 'node:fs';

/// The refusal strings a model reads (spec S5). They are part of the tool
/// contract, so they are stable and lowercase.
export type Refusal =
  | 'over_max_per_tx'
  /// §1b. The policy sets NO cap for this token, so no amount can be spent - as
  /// distinct from `over_max_per_tx`, where a smaller one could. A SPLIT, not an
  /// addition: `over_max_per_tx` keeps its other meaning.
  ///
  /// A CODE IS AN INSTRUCTION, not merely a description. The old code was
  /// defensible as a description - the per-transaction bound refusing, with the
  /// bound at zero because nobody set one - and wrong as an instruction: it
  /// tells a persona to try less when no amount can work.
  | 'no_cap_set'
  | 'over_stage_cap'
  | 'counterparty_denied'
  | 'unknown_name'
  /// A bare `to` that is BOTH a registered name and a peer in this wallet's own
  /// namespace (§5). A DISTINCT reason, not folded into `unknown_name`: the
  /// name resolved twice, not zero times, and telling a persona "no wallet is
  /// registered as toby" when two are would send it looking for the wrong
  /// thing. Refusing rather than guessing is what stops a vanity squat
  /// redirecting in-namespace payments.
  | 'ambiguous_name'
  | 'duplicate_intent'
  // Not a policy refusal: the send may have happened. Kept in this union
  // because it is a reason the model sees, and the model must be able to tell
  // it apart from every refusal that means "nothing moved".
  | 'intent_unresolved'
  /// The caller's own input was malformed - a name that cannot be a name, an
  /// amount that cannot be an amount. Persona-facing because it is a fact about
  /// what the persona just typed: it can already learn it by trying again, and
  /// telling it is the difference between a model that corrects itself and one
  /// that retries the same bad string against an opaque "error".
  | 'invalid_name'
  | 'invalid_amount'
  /// No contract with that key in this deployment. A fact about the PUBLIC
  /// registry, like `unknown_name`: the `contracts` tool lists exactly what
  /// exists, so refusing to say which keys are real would only make a persona
  /// guess at a menu it can already read.
  | 'unknown_contract'
  /// This wallet may not call that function on that contract. ONE REASON FOR
  /// BOTH CAUSES - no allowlist entry at all, and an entry that does not
  /// include this wallet's kind - deliberately: distinguishing them would tell
  /// a persona what OTHER kinds of wallet are permitted to do.
  | 'function_not_allowed'
  /// No token by that key or symbol in this deployment. A fact about the PUBLIC
  /// registry, like `unknown_contract` and `unknown_name`: a persona reads token
  /// SYMBOLS in every balance and every history entry, so refusing to say which
  /// ones exist would refuse it the vocabulary the service itself taught it.
  | 'unknown_token'
  /// The arguments did not match the function's ABI, with the index and the
  /// expected type. A fact about what the persona just typed, like
  /// `invalid_amount`, and the detail is what lets a model fix its own call
  /// instead of retrying the same one.
  | 'bad_args'
  /// The call was mined and the contract reverted. The persona must know its
  /// call did nothing, or it will assume success and act on it; the REASON is
  /// withheld, because a revert string is the contract's internal state and
  /// says more about the game's machinery than a player should read.
  | 'revert';

/// §1b. The one cap value that is not an amount, spelled once.
///
/// MIRRORS `UNLIMITED` in svc/src/policy.ts and must equal it character for
/// character. NOT IMPORTED from there: wallet-mcp's only reference to chain-svc
/// is `import type`, which is erased, so this package keeps ZERO RUNTIME
/// DEPENDENCY on chain-svc and still runs with it absent (org-core imports this
/// as a library). A value import would be the first one and would end that.
///
/// So this is the `matchesPattern` arrangement again - two spellings of one
/// constant, and a test in svc/test that they agree, because that suite may
/// import both. A fourth spelling anywhere would be an uncapped wallet that
/// looks capped.
export const UNLIMITED = 'unlimited';

/// BOTH FIELDS OPTIONAL as of v0.8.0, mirroring chain-svc. Absence is not a
/// hole to fail closed on - it is "nobody wrote a bound", and this layer must
/// answer what the boundary would answer or it is a divergence rather than a
/// pre-check.
export interface TokenCaps {
  max_per_tx?: number | string;
  max_per_stage?: number | string;
}

/// Is this a value a cap may take? EXACTLY `"unlimited"`, or an amount.
///
/// Mirrors chain-svc's `isCap`. The exact match is tested FIRST and never by a
/// broader predicate: `typeof v === 'string' && !isNumeric(v)` is the
/// implementation to reach for and the one to refuse, because it makes
/// `"unlimted"` an uncapped wallet and a typo is the likeliest way anyone ever
/// writes a non-numeric cap. Everything else stays invalid and reads as ABSENT,
/// which fails closed.
export function isCapAmount(value: unknown): boolean {
  if (value === UNLIMITED) return true;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  return Number(value) > 0;
}

export interface WalletPolicy {
  /// Present in every file chain-svc writes, and not required to read one: a
  /// hand-written policy is still a policy.
  agentId?: string;
  /// KEYED BY TOKEN KEY, never by symbol - chain-svc writes this file and its
  /// own bookkeeping stores the key. `resolveTokenOrRefusal` is where a key and
  /// a symbol meet, once.
  ///
  /// EVERY FIELD OPTIONAL, and absence means no rule - see `capsRefusal`.
  caps?: Record<string, TokenCaps>;
  allow?: string[];
  deny?: string[];
}

/// What a policy file read can say. THREE OUTCOMES, not two - mirroring
/// chain-svc's `PolicyRead`, which this is the fast-path copy of:
///
///   a WalletPolicy   the file exists and parses - these are the rules
///   null             no file - nobody wrote rules for this wallet
///   { unreadable,
///     reason }       a file exists and is not a policy - written garbage
///
/// The third used to collapse into the second. That was safe only while an
/// absent cap REFUSED downstream: the permissive answer here was bounded by a
/// fail-closed answer further on. With absence now meaning no limit (§1),
/// deferring on an unreadable file would make it the WIDEST policy a wallet can
/// have, and a corrupt byte would unbound a wallet silently.
/// THE MARKER CARRIES TWO STRINGS, FOR TWO AUDIENCES, and that split is a
/// disclosure control rather than a convenience:
///
///   `unreadable`  the PERSONA'S. Always the same words, whatever went wrong.
///   `reason`      the OPERATOR'S. Goes to the log sink and nowhere a persona
///                 can read it.
///
/// Why they cannot be one string: bun's parse error QUOTES the offending token,
/// so `{"deny": treasuryOnly}` comes back as `Unexpected identifier
/// "treasuryOnly"`. `no_cap_set` is persona-facing and its detail crosses with
/// it, so a single string would put an operator's counterparty name, pattern or
/// amount in front of a model. Naming the failing FIELD would do the same,
/// which is why the shape failures use the fixed string too.
export type PolicyRead = WalletPolicy | null | { unreadable: string; reason: string };

/// Is this read a marker rather than a policy? Mirrors chain-svc's predicate of
/// the same name, down to the name.
export function isUnreadable(r: PolicyRead): r is { unreadable: string; reason: string } {
  return r !== null && 'unreadable' in r;
}

/// The one sentence a persona ever reads about an unreadable policy file.
/// Spelled identically on both sides so the same fault reads the same whichever
/// layer refuses it.
const UNREADABLE = 'policy file unreadable';

/// Read fresh on every send rather than cached: chain-svc rewrites this file
/// when a wallet's policy is patched or cleared, and a cached copy would keep
/// enforcing rules that no longer exist.
///
/// `defaultTokenKey` is for a LEGACY file only - a top-level `max_per_tx` /
/// `max_per_stage` pair with no `caps`, written before v0.5.0. A deployment with
/// no token has nothing for such a pair to be about, so it is optional.
export function readPolicy(path: string, defaultTokenKey?: string): PolicyRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // ABSENT IS ABSENT. No file means nobody wrote rules for this wallet, and
    // there is nothing for the fast path to object to. This is the only branch
    // that returns null, and it is the only one that should.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    // ONE STRING FOR EVERY SHAPE FAILURE, for the same reason: naming the field
    // that was wrong would report the operator's document back through a
    // persona-facing detail. Which field it was goes to the log.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { unreadable: UNREADABLE, reason: 'not a policy document' };
    }
    const p = parsed as Record<string, unknown>;
    // A KEY THIS DOCUMENT HAS NEVER HAD IS A WRONG SHAPE, and shape failures
    // are file-level. A mistyped key at this level is read as absent, which for
    // `caps` means unbounded.
    if (!keysKnown(p, POLICY_KEYS, POLICY_KEYS_TOLERATED)) {
      return { unreadable: UNREADABLE, reason: 'not a policy document' };
    }
    if (!isNameList(p.allow) || !isNameList(p.deny)) {
      return { unreadable: UNREADABLE, reason: 'not a policy document' };
    }

    if (p.caps !== undefined) {
      if (typeof p.caps !== 'object' || p.caps === null || Array.isArray(p.caps)) {
        return { unreadable: UNREADABLE, reason: 'not a policy document' };
      }
      // PER ENTRY, not just the map: `caps` being an object says nothing about
      // what is in it, and an entry that is not an object is a shape failure.
      if (
        !Object.values(p.caps as Record<string, unknown>).every(
          (e) => isCapEntry(e) && keysKnown(e as Record<string, unknown>, TOKEN_CAPS_KEYS),
        )
      ) {
        return { unreadable: UNREADABLE, reason: 'not a policy document' };
      }
      return withLists(p, { caps: p.caps as Record<string, TokenCaps> });
    }

    // THE LEGACY PAIR, read as the DEFAULT TOKEN'S caps - never as an unbounded
    // policy. This package used to return null for such a file and defer, which
    // was correct while null meant "defer"; under §1 null means NO RULES
    // WRITTEN, so the same return would read a pre-v0.5.0 wallet's written
    // bounds as no bounds at all. That is the two-layer divergence v0.6.0
    // closed, arriving through the door §1 opened rather than the one it shut.
    //
    // EITHER HALF ALONE IS A POLICY, exactly as a half-written entry is in the
    // new shape: `max_per_tx` alone bounds each transaction and leaves the stage
    // unbounded. Spelling never decides what a document means (ruled).
    if (p.max_per_tx !== undefined || p.max_per_stage !== undefined) {
      // A legacy pair on a deployment with no token has nothing to be about.
      // Same fixed string: the persona learns the file is unreadable, and the
      // operator learns why from the log.
      if (defaultTokenKey === undefined) {
        return { unreadable: UNREADABLE, reason: 'not a policy document' };
      }
      const legacy: TokenCaps = {};
      if (p.max_per_tx !== undefined) legacy.max_per_tx = p.max_per_tx as TokenCaps['max_per_tx'];
      if (p.max_per_stage !== undefined) legacy.max_per_stage = p.max_per_stage as TokenCaps['max_per_stage'];
      return withLists(p, { caps: { [defaultTokenKey]: legacy } });
    }

    // A DOCUMENT WITH NO CAPS IN IT is a thing an operator can now write: rules
    // about counterparties and none about amounts. It is not garbage and it is
    // not absence - it is a policy that bounds nothing.
    return withLists(p, {});
  } catch (err) {
    // TWO AUDIENCES, TWO STRINGS. The persona gets `UNREADABLE` and nothing
    // else, whatever went wrong; the operator gets the parse message verbatim.
    //
    // The split is the control. bun's parse error QUOTES A FRAGMENT OF THE
    // FILE - `{"deny": treasuryOnly}` comes back as `Unexpected identifier
    // "treasuryOnly"` - and `no_cap_set` is persona-facing with its detail
    // crossing alongside, so one string for both audiences would put an
    // operator's counterparty name, pattern or amount in front of a model.
    //
    // The operator's half carries the message rather than a class string
    // because it crosses nowhere: someone debugging a policy file wants the
    // position and the token, and a coarser string here would be safe and
    // useless while safety is already carried by the OTHER field.
    return {
      unreadable: UNREADABLE,
      reason: err instanceof Error ? err.message.split('\n')[0] : 'unparseable',
    };
  }
}

/// The fields every branch above carries through, so none of them can forget
/// one. `agentId` rides along when present; the lists keep written-versus-absent
/// intact, because `allow: []` and no `allow` mean different things.
function withLists(p: Record<string, unknown>, rest: Partial<WalletPolicy>): WalletPolicy {
  return {
    ...(typeof p.agentId === 'string' ? { agentId: p.agentId } : {}),
    ...rest,
    ...(p.allow === undefined ? {} : { allow: p.allow as string[] }),
    ...(p.deny === undefined ? {} : { deny: p.deny as string[] }),
  };
}

/// EVERY KEY A POLICY DOCUMENT MAY CARRY, per level. MIRRORS chain-svc's sets
/// and must agree with them - the document-level agreement test is what holds
/// the two together.
///
/// Field levels are closed; MAP levels are not. `caps` is keyed by token, and a
/// deployment's token keys are its own. `agentId` is KNOWN (chain-svc stamps it
/// on every file it writes) and `frozen` is TOLERATED (every file written before
/// v0.8.0 carries it) - a rule without those two marks the whole installed base
/// unreadable, which is the write-path defect arriving through a second door.
const POLICY_KEYS = new Set(['agentId', 'caps', 'allow', 'deny', 'max_per_tx', 'max_per_stage']);
const POLICY_KEYS_TOLERATED = new Set(['frozen']);
const TOKEN_CAPS_KEYS = new Set(['max_per_tx', 'max_per_stage']);

function keysKnown(value: Record<string, unknown>, known: Set<string>, tolerated?: Set<string>): boolean {
  return Object.keys(value).every((k) => known.has(k) || tolerated?.has(k) === true);
}

/// A list of names, or absent. Mirrors chain-svc's `isNameList` INCLUDING THE
/// LENGTH CHECK: an empty string is not a name, and a mirror that dropped it
/// gave `{"allow": [""]}` two answers - unreadable on the boundary, a policy
/// with a nonsense pattern here. Two different refusals downstream from one
/// document, which is the drift this package's copies exist to prevent.
function isNameList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0))
  );
}

/// Is this a cap ENTRY - an object - whatever is inside it? Mirrors chain-svc's
/// `isTokenCaps`, which is shape-only since v0.8.0.
///
/// THE LINE IS SHAPE VERSUS VALUE. A garbage VALUE (`max_per_tx: 'lots'`) is
/// field-level and refuses its own token at the point of use; an entry that is
/// not an object at all is not a value, it is a malformed document, and the
/// whole file is unreadable. Without this the mirror accepted
/// `caps: { play: 'nope' }` as a policy while the boundary called the file
/// garbage.
function isCapEntry(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/// `*` matches anything, `*.{tld}` a suffix, `acme:*` a prefix; anything else is
/// a literal. THE SAME RESTRICTED DIALECT AS chain-svc, character for
/// character, on purpose: two glob implementations that disagree would produce
/// a local "allowed" and a server-side refusal, which reads to a model as the
/// platform being broken - and in the other direction a local "allowed" over a
/// pattern the boundary reads as a literal.
///
/// The trailing-star form was added with chain-svc's (ruled). If you
/// change one of these, change both; `svc/test/policy.test.ts` asserts
/// they agree across allow AND deny.
///
/// Validation of malformed patterns lives in chain-svc, which WRITES this file.
/// This side only reads it, and a reader that re-validated could refuse a
/// policy the boundary accepted - which is the disagreement above, wearing a
/// different hat.
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/// The local pre-check. Returns a refusal the model can read, or null to mean
/// "nothing local objects" - never "approved", because approval is chain-svc's.
///
/// The stage cap is deliberately NOT checked here: it counts spends since the
/// last stage change, and this process has no stage source - hub-core's
/// /session needs a platform credential, which by design never reaches the
/// agent side. So `over_stage_cap` arrives from chain-svc and is surfaced
/// verbatim. Flagged for the spec: adding a stage source here would mean
/// giving the persona something it currently cannot see.
/// `vee` arrives as a DECIMAL STRING and is compared in wei, not as a float.
/// Comparing `Number("12.5") > max_per_tx` would reintroduce, in the check
/// itself, exactly the imprecision the string type exists to avoid.
/// Returns the canonical decimal string, or null if this is not a usable
/// amount. Deliberately NOT a parse-to-number-and-back: that is the rounding
/// this exists to prevent. A string is validated by shape and passed through
/// untouched, so "12.50" reaches chain-svc as "12.50".
export function normaliseVee(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const t = raw.trim();
    // Digits, optional single decimal point, at least one digit either side of
    // it. No exponent, no sign, no separators - chain-svc's parseVee is the
    // authority on the value and this only has to refuse what it cannot carry.
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    if (Number(t) <= 0) return null;
    return t;
  }
  // An INTEGER number is exactly representable, so tolerating it rounds
  // nothing. A non-integer is refused rather than stringified: 0.1 + 0.2 is
  // where money goes wrong quietly.
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  return null;
}

/// `decimals` is the default token's, read from chain-svc's /modules at startup -
/// not a hardcoded 18. Both amounts are scaled by the same figure, so the
/// comparison in `checkLocally` is exact whatever the token's precision.
export function veeToWei(vee: string, decimals: number): bigint {
  const [whole, frac = ''] = vee.split('.');
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
}

/// The local mirror of chain-svc's `capsFor`, and the counterpart its agreement
/// test asserts against.
///
/// RETURNS rather than throws - chain-svc's throws an `HttpError` this package
/// cannot import at runtime - so the test normalises one against the other. The
/// sentence is built the same way on both sides so they cannot drift into
/// refusing for the same reason with different words.
///
/// FAIL CLOSED ON GARBAGE, OPEN ON SILENCE (§1, reversing v0.5.0). A cap that
/// is WRITTEN and unusable still refuses; a cap nobody wrote is no bound. The
/// two reach different answers on purpose, and the paragraph this replaces said
/// the opposite - it was the rule until the owner reversed it, and a comment
/// kept past its ruling is how the next reader learns the wrong one.
export function capsRefusal(
  policy: WalletPolicy,
  tokenKey: string,
): { reason: Refusal; detail: string } | null {
  const caps = policy.caps?.[tokenKey];
  // A VALUE THIS SIDE CANNOT READ IS TREATED AS ABSENT, not as unlimited and
  // not as a crash. A typo, the empty string, null: each fails closed here with
  // the same answer silence gets. The empty string is the one that used to be
  // worst - `veeToWei('')` returns 0, so `max_per_tx: ''` refused every spend as
  // a bare `over_max_per_tx`: a bricked wallet whose message said the amount was
  // too large.
  //
  // PER CAP, NOT PER FILE. Rejecting the whole policy for one bad entry would
  // lose the local pre-check for every OTHER token because one was mistyped -
  // which defers more to chain-svc than the mistake warrants.
  // THREE OUTCOMES PER FIELD, the same table chain-svc's `capsFor` implements:
  // absent -> unbounded, "unlimited" -> unbounded, a valid amount -> that
  // bound, anything else -> no_cap_set naming the field.
  //
  // The two must agree VALUE FOR VALUE, not merely in spirit: this side is a
  // fast-path copy of a check whose authority is chain-svc, and a local answer
  // that differed would send a persona a refusal the boundary would not give,
  // or let one through the boundary then refuses.
  if (!caps) return null;
  for (const field of ['max_per_tx', 'max_per_stage'] as const) {
    const value = caps[field];
    if (value !== undefined && !isCapAmount(value)) {
      return { reason: 'no_cap_set', detail: `${field} for ${tokenKey} is not a usable amount` };
    }
  }
  return null;
}

/// `token` arrives as ONE value, not as a key and a decimals read separately.
/// Key, symbol and decimals are three facts about one token: sourced apart they
/// can drift to different tokens while each looks right, and only one of the
/// three is checkable by a value assertion. Passing the resolved token makes a
/// mixed-source amount unrepresentable rather than merely tested for.
export function checkLocally(
  policy: PolicyRead,
  to: string,
  amount: string,
  token: { key: string; decimals: number },
): { reason: Refusal; detail?: string } | null {
  // NO FILE: nobody wrote rules for this wallet, so there is nothing local to
  // object to. Not "approved" - chain-svc still decides - but this side has
  // nothing to say. Under §1 this is the common case rather than the odd one.
  if (policy === null) return null;

  // A FILE THAT EXISTS AND IS NOT A POLICY refuses every spend, and says why.
  // It used to fall into the branch above, which was safe only while an absent
  // cap refused downstream; with absence meaning no limit, deferring here would
  // make a corrupt file the widest policy a wallet can have.
  //
  // The REASON travels: an operator who mistyped a policy needs to know it was
  // the FILE and not the amount, and a persona that reads "policy file
  // unreadable" can say something useful to whoever can fix it.
  if (isUnreadable(policy)) {
    return { reason: 'no_cap_set', detail: policy.unreadable };
  }

  const capless = capsRefusal(policy, token.key);
  if (capless) return capless;
  // ABSENT ENTRY, ABSENT FIELD: no local refusal. `capsRefusal` has already
  // refused anything present-and-unreadable, so what remains is either a usable
  // bound or no bound at all.
  const caps = policy.caps?.[token.key] ?? {};

  // §1b. `"unlimited"` skips THIS bound and nothing else - the stage bound is
  // its own field and its own decision, and chain-svc is the authority on both
  // regardless. The spend is still recorded there; a skipped bound is not a
  // skipped audit.
  if (
    caps.max_per_tx !== undefined &&
    caps.max_per_tx !== UNLIMITED &&
    veeToWei(amount, token.decimals) > veeToWei(String(caps.max_per_tx), token.decimals)
  ) {
    return { reason: 'over_max_per_tx' };
  }
  // Deny beats allow. ABSENT `deny` denies nothing; ABSENT `allow` allows
  // everything; a WRITTEN `allow: []` allows nothing, which is the one place
  // absent and empty diverge and is the same divergence chain-svc keeps.
  if ((policy.deny ?? []).some((p) => matchesPattern(p, to))) return { reason: 'counterparty_denied' };
  if (policy.allow !== undefined && !policy.allow.some((p) => matchesPattern(p, to))) {
    return { reason: 'counterparty_denied' };
  }
  return null;
}
