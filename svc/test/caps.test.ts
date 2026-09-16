// §2. CAPS PER TOKEN.
//
// A wallet's caps stop being two numbers and become a map keyed by token key.
// The shape is the easy half; the rules around its EDGES are the half that
// decides whether money is bounded:
//
//   - a token with NO entry cannot be spent, because silence must fail closed
//     in money policy. The alternative - an absent cap meaning "no limit" - is
//     the one reading that costs money, and it is the reading a reader reaches
//     for first.
//   - `*` in a kind-defaults file is expanded to every DEPLOYED token key at
//     load, so a deployment that adds a token does not silently give every
//     wallet an unbounded new currency, nor a bounded-by-nothing one.
//   - an explicit key REPLACES the whole pair rather than merging field by
//     field, so "au gets a bigger max_per_tx" cannot accidentally inherit vee's
//     max_per_stage - two halves of one bound, from two different currencies.
//
// The legacy shape is read and migrated IN MEMORY rather than refused: a store
// full of v0.4.0 policy files is the ordinary upgrade, and refusing them would
// freeze every wallet in a running game.

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capsFor,
  isCap,
  isPolicy,
  normalisePolicy,
  UNLIMITED,
  stageCapWei,
  enforcePolicy,
  loadPolicyDefaults,
  mergePolicy,
  droppedPatternsLogged,
  WALLET_KINDS,
  type AgentPolicy,
} from '../src/policy.ts';
import { HttpError } from '../src/errors.ts';

const TOKENS = ['vee', 'au'];

function defaultsFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'caps-defaults-'));
  const path = join(dir, 'policy-defaults.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const KIND = (caps: unknown) => ({ caps, allow: ['*'], deny: [] });

const FILE = (over: Record<string, unknown> = {}) => ({
  org: KIND({ '*': { max_per_tx: '1000', max_per_stage: '5000' } }),
  agent: KIND({ '*': { max_per_tx: '100', max_per_stage: '500' } }),
  burner: KIND({ '*': { max_per_tx: '50', max_per_stage: '200' } }),
  ...over,
});

describe('capsFor', () => {
  const policy: AgentPolicy = {
    caps: { vee: { max_per_tx: '100', max_per_stage: '500' } },
    allow: ['*'],
    deny: [],
  };

  it('finds the caps for a token the wallet has', () => {
    expect(capsFor(policy, 'vee')).toEqual({ max_per_tx: '100', max_per_stage: '500' });
  });

  it('reads a token with NO entry as unbounded', () => {
    // FLIPPED at v0.8.0, and this row is the reversal itself. Silence used to
    // fail closed here on the argument that an absent cap read as "no limit" is
    // the reading that costs money. The owner reversed it: this service
    // enforces only rules someone wrote, and the rules that must survive a
    // bypass live in the contracts. Refusing on silence is acting on its own
    // initiative.
    expect(capsFor(policy, 'au')).toEqual({});
  });

  it('reads an EMPTY entry as an entry with no bounds, not as garbage', () => {
    // FLIPPED at v0.8.0. `{}` is an entry someone wrote and put no bounds in.
    // Under the old rule it refused because `isTokenCaps` required both fields,
    // so a shape defect and a value defect were one category; each field now
    // stands alone and neither is present, so neither bounds anything.
    expect(capsFor({ ...policy, caps: { au: {} } }, 'au')).toEqual({});
  });

  it('still refuses a field that is PRESENT and unreadable', () => {
    // The half that survives. COMPARE TO A VALUE on the detail: it must name
    // the FIELD, or a wallet with one typo between two currencies cannot tell
    // which of its spends is impossible.
    let err: unknown;
    try {
      capsFor({ ...policy, caps: { au: { max_per_tx: 'lots' } } }, 'au');
    } catch (e) {
      err = e;
    }
    expect((err as HttpError).code).toBe('no_cap_set');
    expect((err as HttpError).detail).toBe('max_per_tx for au is not a usable amount');
  });
});

// §1b. "unlimited" AS AN EXPLICIT CHOICE, and nothing else.
//
// The value space is the whole point. `"unlimited"` means someone decided; an
// ABSENT cap means nobody did, and those stay different answers. Everything
// else - a typo, an empty string, a null - is treated as ABSENT and refuses,
// because the fail-OPEN implementation (`not a number -> no bound`) turns
// `"unlimted"` into an uncapped wallet, and a typo is the likeliest way anyone
// ever writes a non-numeric cap.
describe('"unlimited" in isCap', () => {
  it('accepts exactly "unlimited"', () => {
    expect(isCap(UNLIMITED)).toBe(true);
    expect(isCap('unlimited')).toBe(true);
  });

  it('refuses every OTHER non-numeric string, so a typo is not an uncapped wallet', () => {
    // COMPARE TO A VALUE at each: these are the strings a broader predicate
    // would have admitted, and each one of them is a wallet with no bound.
    for (const bad of ['unlimted', 'UNLIMITED', 'Unlimited', 'unlimited ', ' unlimited', '', 'none', 'inf']) {
      expect(isCap(bad)).toBe(false);
    }
  });

  it('still accepts amounts, and still refuses zero and negatives', () => {
    // The regex must remain the gate for everything that is not the one exact
    // string - if the new clause had widened it, this row would pass anyway
    // and the row above is what notices.
    expect(isCap('25')).toBe(true);
    expect(isCap('0')).toBe(false);
    expect(isCap('-1')).toBe(false);
    expect(isCap(null)).toBe(false);
    expect(isCap(undefined)).toBe(false);
  });
});

describe('loadPolicyDefaults with per-token caps', () => {
  it('expands * to every deployed token key', () => {
    const d = loadPolicyDefaults(defaultsFile(FILE()), 'play', TOKENS, () => {});
    expect(Object.keys(d.agent.caps!).sort()).toEqual(['au', 'vee']);
    expect(d.agent.caps!.vee).toEqual({ max_per_tx: '100', max_per_stage: '500' });
    expect(d.agent.caps!.au).toEqual({ max_per_tx: '100', max_per_stage: '500' });
  });

  it('lets an explicit key REPLACE the pair, not merge into it', () => {
    // Field-by-field merging is the trap: "au gets a bigger max_per_tx" would
    // silently inherit vee's max_per_stage, and the wallet would carry two
    // halves of one bound taken from two different currencies.
    const d = loadPolicyDefaults(
      defaultsFile(
        FILE({
          agent: KIND({
            '*': { max_per_tx: '100', max_per_stage: '500' },
            au: { max_per_tx: '1000', max_per_stage: '9000' },
          }),
        }),
      ),
      'play',
      TOKENS,
      () => {},
    );
    expect(d.agent.caps!.vee).toEqual({ max_per_tx: '100', max_per_stage: '500' });
    expect(d.agent.caps!.au).toEqual({ max_per_tx: '1000', max_per_stage: '9000' });
  });

  it('refuses an explicit key that is not a deployed token', () => {
    // At LOAD, where the operator who wrote it is looking. A key naming a token
    // that is not there is a cap that will never be consulted, and the author
    // believes it will.
    expect(() =>
      loadPolicyDefaults(
        defaultsFile(FILE({ agent: KIND({ '*': { max_per_tx: '1', max_per_stage: '2' }, xau: { max_per_tx: '1', max_per_stage: '2' } }) })),
        'play',
        TOKENS,
        () => {},
      ),
    ).toThrow(/caps names "xau", not a deployed token/);
  });

  it('refuses a caps key that is a glob other than *', () => {
    // EXACTLY TWO KEY FORMS, `*` and a token key. A third - `a*`, `*u` - would
    // make the file a pattern language, and the one place this system has a
    // pattern language (allow/deny) is the one place it has needed a rule about
    // what a pattern that matches nothing means.
    expect(() =>
      loadPolicyDefaults(
        defaultsFile(FILE({ agent: KIND({ 'a*': { max_per_tx: '1', max_per_stage: '2' } }) })),
        'play',
        TOKENS,
        () => {},
      ),
    ).toThrow(/caps names "a\*"/);
  });

  it('refuses a kind whose caps set no token at all', () => {
    // An empty caps map is a wallet that can spend nothing. That may be
    // deliberate for a kind, but it is not something to arrive at by leaving a
    // key out of a file, so it has to be written as such.
    expect(() =>
      loadPolicyDefaults(defaultsFile(FILE({ agent: KIND({}) })), 'play', TOKENS, () => {}),
    ).toThrow(/agent/);
  });

  it('refuses a cap that is PRESENT and not a usable amount', () => {
    // `{ max_per_stage: '5' }` LEFT THIS LIST at v0.8.0 and is asserted below
    // instead: an absent `max_per_tx` is not a bad value, it is no bound, and
    // keeping it here would have been the fail-closed-on-silence rule surviving
    // in the one place nobody looked.
    for (const bad of [{ max_per_tx: '0', max_per_stage: '5' }, { max_per_tx: '-1', max_per_stage: '5' }, { max_per_tx: 'lots', max_per_stage: '5' }]) {
      expect(() =>
        loadPolicyDefaults(defaultsFile(FILE({ agent: KIND({ '*': bad }) })), 'play', TOKENS, () => {}),
      ).toThrow();
    }
  });

  it('LOADS a defaults entry that bounds only one of the two', () => {
    const d = loadPolicyDefaults(
      defaultsFile(FILE({ agent: KIND({ '*': { max_per_stage: '5' } }) })),
      'play',
      TOKENS,
      () => {},
    );
    // Bounds the stage and says nothing about a single transaction - which is a
    // coherent thing for an operator to write and was refused as malformed
    // until each field stood alone.
    expect(d.agent.caps!.vee).toEqual({ max_per_stage: '5' });
  });

  it('still drops TLD patterns on a names-less deployment', () => {
    // The {tld} substitution is UNCHANGED and lives beside the caps expansion
    // rather than inside it: they answer different questions and the first has
    // its own rule about what a pattern matching nothing means.
    //
    // SAVED AND RESTORED, not merely cleared. `droppedPatternsLogged` is
    // PROCESS-WIDE and another file's test asserts the once-per-process
    // property across two of its own loads - so a bare `clear()` here makes
    // that test pass or fail depending on which file bun happened to run in
    // between. Owning the state means putting it back.
    const saved = [...droppedPatternsLogged];
    droppedPatternsLogged.clear();
    const lines: string[] = [];
    const d = loadPolicyDefaults(
      defaultsFile(FILE({ agent: { caps: { '*': { max_per_tx: '1', max_per_stage: '2' } }, allow: ['*.{tld}'], deny: ['treasury.{tld}'] } })),
      undefined,
      TOKENS,
      (m) => lines.push(m),
    );
    expect(d.agent.allow).toEqual([]);
    expect(lines.join('\n')).toMatch(/names a TLD/);

    droppedPatternsLogged.clear();
    for (const p of saved) droppedPatternsLogged.add(p);
  });

  it('expands to NOTHING on a deployment with no tokens, without inventing one', () => {
    // A names-only deployment has no token to cap. The caps map is empty, and
    // every spend is refused by capsFor - which is correct, because there is
    // nothing to spend.
    const d = loadPolicyDefaults(defaultsFile(FILE()), 'play', [], () => {});
    expect(d.agent.caps!).toEqual({});
  });
});

describe('the legacy policy shape', () => {
  const legacy = { max_per_tx: '100', max_per_stage: '500', allow: ['*.play'], deny: ['treasury.play'] };

  it('is read as caps for the DEFAULT token', () => {
    // A store full of v0.4.0 policy files is the ordinary upgrade. Refusing
    // them would freeze every wallet in a running game, and inventing a
    // per-token split would invent a bound nobody wrote.
    const p = normalisePolicy(legacy, 'vee');
    expect(p.caps).toEqual({ vee: { max_per_tx: '100', max_per_stage: '500' } });
    expect(p.allow).toEqual(['*.play']);
  });

  it('leaves a new-shape policy alone', () => {
    const modern = { caps: { au: { max_per_tx: '1', max_per_stage: '2' } }, allow: [], deny: [] };
    expect(normalisePolicy(modern, 'vee')).toEqual(modern);
  });

  it('refuses a document that is not a document, and a caps map that is not a map', () => {
    // `{ allow: [], deny: [] }` LEFT THIS LIST at v0.8.0 - it is a document
    // with rules and no bounds, which is exactly what §1 invites an operator to
    // write. It threw until now, and because `readPolicyFile` calls this inside
    // its try, the throw became the unreadable marker: a valid permissive file
    // turned into a wallet that refused every spend.
    for (const bad of [{ caps: 'lots', allow: [], deny: [] }, null, 'policy', []]) {
      expect(() => normalisePolicy(bad, 'vee')).toThrow();
    }
    // ...and the one that moved, asserted as what it now means.
    expect(normalisePolicy({ allow: [], deny: [] }, 'vee')).toEqual({ allow: [], deny: [] });
  });

  it('prefers caps when a file somehow carries both shapes', () => {
    // A half-migrated file: written by a new binary, edited by hand from an old
    // example. The NEW shape wins, because it is the one that can express what
    // the old one cannot, and silently preferring the legacy pair would discard
    // every token but the default.
    const both = { ...legacy, caps: { au: { max_per_tx: '7', max_per_stage: '9' } } };
    expect(normalisePolicy(both, 'vee').caps).toEqual({ au: { max_per_tx: '7', max_per_stage: '9' } });
  });
});

describe('mergePolicy with caps', () => {
  const defaults: AgentPolicy = {
    caps: { vee: { max_per_tx: '100', max_per_stage: '500' }, au: { max_per_tx: '10', max_per_stage: '50' } },
    allow: ['*.play'],
    deny: ['treasury.play'],
  };

  it('falls to the kind defaults when no policy is supplied', () => {
    expect(mergePolicy(undefined, defaults)).toEqual(defaults);
  });

  it('takes a supplied caps map WHOLE, replacing the defaults', () => {
    // The same rule as the defaults file's explicit key, one level up: a
    // supplied caps map is what this wallet may spend, not an amendment to what
    // its kind may. Merging would let a caller widen one token by naming
    // another.
    const merged = mergePolicy({ caps: { au: { max_per_tx: '1', max_per_stage: '2' } } }, defaults);
    expect(merged.caps!).toEqual({ au: { max_per_tx: '1', max_per_stage: '2' } });
    expect(merged.allow).toEqual(['*.play']);
  });

  it('accepts the legacy pair from a caller and reads it as the default token', () => {
    const merged = mergePolicy({ max_per_tx: '7' }, defaults, 'vee');
    expect(merged.caps!.vee).toEqual({ max_per_tx: '7', max_per_stage: '500' });
    // The OTHER token's defaults survive: a caller writing the legacy shape is
    // saying something about the default token, not about every token.
    expect(merged.caps!.au).toEqual({ max_per_tx: '10', max_per_stage: '50' });
  });

  it('refuses a cap that is not an amount, in either shape', () => {
    expect(() => mergePolicy({ max_per_tx: 25.5 }, defaults, 'vee')).toThrow(HttpError);
    expect(() => mergePolicy({ caps: { vee: { max_per_tx: 25.5, max_per_stage: '5' } } }, defaults)).toThrow(
      HttpError,
    );
  });

  it('refuses caps naming a token with no pair', () => {
    expect(() => mergePolicy({ caps: { vee: 'lots' } }, defaults)).toThrow(HttpError);
  });
});

// §1b. THE PROPERTY, NOT THE INSTANCE (the wallet-mcp lane's finding, 00:22Z).
//
// The defect this closes was not "unlimited fails to skip a bound". It was that
// a value `isCap` ACCEPTS was unusable by the code that consumes it: at
// c23a5b6, `isCap('unlimited')` was true and `capToWei('unlimited', 18)` threw
// a SyntaxError - not an unbounded wallet and not a bounded one, a crash on the
// money path that is not an HttpError and surfaces as a 500.
//
// So the assertion is about the PAIR. A test naming "unlimited" would have gone
// green the moment the two consumers were taught about it and said nothing
// about the next special value somebody adds. This one stays true.
// THE SAME PROPERTY ONE LEVEL UP, at the document rather than the field: every
// shape `isPolicy` accepts must be usable by `normalisePolicy`.
//
// Handed to me by the wallet-mcp lane rather than found here, and it is the
// right instrument: the three instances they reported were five, and a test
// naming today's shapes says nothing about the next one somebody writes.
//
// WHY THE PAIR MATTERS MORE THAN IT DID. The two were allowed to disagree while
// a document `normalisePolicy` threw on became "no policy" and fell back to the
// kind defaults - wrong, but bounded. At v0.8.0 that throw lands in
// `readPolicyFile`'s catch and becomes the UNREADABLE marker, so a disagreement
// turns a valid permissive document into a wallet that refuses every spend.
describe('every document isPolicy accepts is usable by normalisePolicy', () => {
  const ACCEPTED: Array<[string, unknown]> = [
    ['allow and deny with no caps at all', { allow: ['*.play'], deny: ['treasury.play'] }],
    ['an empty document', {}],
    ['the legacy pair, both halves', { allow: [], deny: [], max_per_tx: '100', max_per_stage: '500' }],
    ['the legacy pair, max_per_tx alone', { allow: [], deny: [], max_per_tx: '100' }],
    ['the legacy pair, max_per_stage alone', { allow: [], deny: [], max_per_stage: '500' }],
    ['the new shape, both bounds', { caps: { play: { max_per_tx: '1', max_per_stage: '2' } } }],
    ['the new shape, one bound', { caps: { play: { max_per_tx: '1' } } }],
    ['the new shape, an empty entry', { caps: { play: {} } }],
    ['"unlimited" in an entry', { caps: { play: { max_per_tx: 'unlimited' } } }],
    ['allow written empty', { allow: [], deny: [] }],
  ];

  it('has a fixture the gate actually accepts, or it proves nothing', () => {
    // THE GUARD ON THE GUARD. A shape that stopped being accepted would be
    // skipped by the loop below and pass vacuously - the empty-set failure that
    // is how a property test quietly stops testing its property.
    for (const [name, doc] of ACCEPTED) expect([name, isPolicy(doc)]).toEqual([name, true]);
    expect(ACCEPTED.length).toBeGreaterThan(6);
  });

  it('never throws on one', () => {
    for (const [name, doc] of ACCEPTED) {
      // The name rides in the assertion so a failure says WHICH shape, rather
      // than making the reader count loop iterations.
      let outcome = 'ok';
      try {
        normalisePolicy(doc, 'play');
      } catch (err) {
        outcome = `THREW ${(err as HttpError).code}: ${(err as HttpError).detail}`;
      }
      expect([name, outcome]).toEqual([name, 'ok']);
    }
  });

  it('still refuses a document the gate refuses', () => {
    // COMPARE TO A VALUE at the other end: without this the property would hold
    // for a `normalisePolicy` that threw on nothing at all.
    // A GARBAGE VALUE IS NOT A SHAPE FAILURE as of the field-level ruling: the
    // document parses, and `capsFor` refuses that field for that token at the
    // point of use while the wallet's other tokens keep their bounds. The gate
    // refuses documents it cannot READ, and a cap value is never shape.
    expect(isPolicy({ caps: { play: { max_per_tx: 'lots' } } })).toBe(true);
    for (const bad of [{ allow: 'everyone' }, { caps: 'lots' }, { caps: { play: 'lots' } }, [], 'policy']) {
      expect(isPolicy(bad)).toBe(false);
    }
    expect(() => normalisePolicy({ allow: 'everyone' }, 'play')).toThrow(HttpError);
  });
});

describe('every value isCap accepts is usable by everything that consumes a cap', () => {
  const ACCEPTED = ['1', '25', '1000000', '0.5', '25.000000000000000001'.slice(0, 20), UNLIMITED, 100, 1];

  it('has a fixture that is actually accepted, or it proves nothing', () => {
    // THE GUARD ON THE GUARD. If a value in the list stopped being accepted,
    // the loop below would skip it and pass vacuously - the empty-set failure,
    // which is how a property test quietly stops testing its property.
    for (const v of ACCEPTED) expect(isCap(v, 18)).toBe(true);
    expect(ACCEPTED.length).toBeGreaterThan(4);
  });

  it('never makes a consumer throw anything but an HttpError', () => {
    for (const cap of ACCEPTED) {
      const policy: AgentPolicy = {
        caps: { play: { max_per_tx: cap, max_per_stage: cap } },
        allow: ['*'],
        deny: [],
      };
      // Both consumers, because they guard independently and either could be
      // the one that was never taught.
      for (const call of [
        () => stageCapWei(policy, 'play', 18),
        () =>
          enforcePolicy({
            policy,
            to: 'alpha.play',
            amount: 1n,
            decimals: 18,
            symbol: 'PLAY',
            tokenKey: 'play',
          }),
      ]) {
        try {
          call();
        } catch (err) {
          // An HttpError is a REFUSAL and a legitimate outcome - a cap of "1"
          // refuses an amount over it. Anything else is the code meeting a
          // value it was never taught, which is the class this test exists for.
          expect(err).toBeInstanceOf(HttpError);
        }
      }
    }
  });
});

// THE SHIPPED EXAMPLE LOADS, and this row exists because nothing else loads it.
//
// `policy-defaults.example.json` became opt-in at v0.8.0: the service reads it
// only when POLICY_DEFAULTS_FILE points at it, and nothing in this repo does.
// A file that ships as the documented starting point and is parsed by no test
// rots silently - and the unknown-key rule above is exactly the kind of change
// that would rot it, since a key the example uses and the loader does not know
// is now a refusal rather than a no-op.
describe('the shipped policy defaults example', () => {
  it('loads clean through loadPolicyDefaults', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'policy-defaults.example.json');
    const tokenKeys = ['play', 'gold'];
    const defaults = loadPolicyDefaults(path, 'play', tokenKeys, () => {});
    // NOT just "it did not throw": every kind is present andcarries the
    // three fields the type promises, so a loader that silently returned an
    // empty object would fail here.
    for (const kind of WALLET_KINDS) {
      expect(defaults[kind]).toBeDefined();
      expect(Array.isArray(defaults[kind].allow)).toBe(true);
      expect(Array.isArray(defaults[kind].deny)).toBe(true);
    }
  });

  // `_comment` is the file's documented stand-in for JSON's missing comment
  // syntax, and it works because the loader INDEXES the top level by
  // WALLET_KINDS rather than enumerating it. The unknown-key rule is applied at
  // the FIELD levels only, for exactly this reason.
  it('tolerates _comment at the top level, which is a map and not a field level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'defaults-'));
    const path = join(dir, 'd.json');
    writeFileSync(path, JSON.stringify({
      _comment: 'the game owner tunes these',
      org: { caps: { play: { max_per_tx: '1', max_per_stage: '2' } }, allow: ['*'], deny: [] },
      agent: { caps: { play: { max_per_tx: '1', max_per_stage: '2' } }, allow: ['*'], deny: [] },
      burner: { caps: { play: { max_per_tx: '1', max_per_stage: '2' } }, allow: ['*'], deny: [] },
    }));
    expect(() => loadPolicyDefaults(path, 'play', ['play'], () => {})).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an unknown key inside a KIND, naming it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'defaults-'));
    const path = join(dir, 'd.json');
    const good = { caps: { play: { max_per_tx: '1', max_per_stage: '2' } }, allow: ['*'], deny: [] };
    writeFileSync(path, JSON.stringify({
      org: { ...good, alloww: ['*'] },
      agent: good,
      burner: good,
    }));
    expect(() => loadPolicyDefaults(path, 'play', ['play'], () => {})).toThrow(/unknown key "alloww"/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an unknown key inside a TOKEN entry, naming the token and the key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'defaults-'));
    const path = join(dir, 'd.json');
    const good = { caps: { play: { max_per_tx: '1', max_per_stage: '2' } }, allow: ['*'], deny: [] };
    writeFileSync(path, JSON.stringify({
      org: { ...good, caps: { play: { max_per_tx: '1', max_per_stage_typo: '2' } } },
      agent: good,
      burner: good,
    }));
    expect(() => loadPolicyDefaults(path, 'play', ['play'], () => {}))
      .toThrow(/token "play": unknown key "max_per_stage_typo"/);
    rmSync(dir, { recursive: true, force: true });
  });
});
