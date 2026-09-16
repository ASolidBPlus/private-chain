// ONE DOCUMENT, TWO READS, ONE ANSWER.
//
// Every other agreement test in this repo compares a FUNCTION to a FUNCTION:
// `matchesPattern` to `matchesPattern`, `capsFor` to `capsRefusal`,
// `resolveToken` to `resolveTokenOrRefusal`. None of them compares the two
// READS OF ONE FILE - which is the thing an operator actually writes, and the
// only place a divergence is visible to the person who caused it.
//
// The gap was not theoretical. Feeding seven documents to both reads side by
// side found, in about a minute, a rule §1 stated twice and differently: one
// mistyped cap made chain-svc call the whole file unreadable (every token
// refused) while wallet-mcp refused that token alone. Both halves were faithful
// to a sentence in the spec. Ruled field-level, and this file is what stops the
// next such rule from being read two ways without anyone noticing.
//
// It lives in svc/test because only this suite may import both packages:
// wallet-mcp's sole reference to chain-svc is `import type`, which is erased,
// and the zero-runtime-dependency property that buys is load-bearing (org-core
// runs `Wallet` with chain-svc absent). A test under wallet-mcp importing
// chain-svc would still be a second place the dependency exists.
//
// IN ITS OWN FILE, not beside the others: it is the agreement most likely to be
// red across a handover, and a red that fails a MODULE hides every unrelated
// row in it.

import { describe, it, expect, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPolicyFile } from '../src/policy.ts';
import { keyFileName } from '../src/validate.ts';
import { readPolicy, isUnreadable } from '../../wallet-mcp/src/policy.ts';

const DEFAULT_TOKEN = 'play';

/// What both sides should make of a document. Compared as CAPS plus the two
/// lists rather than as whole objects, because the two packages carry different
/// incidental fields (`agentId` rides along on one path and not the other) and
/// this test is about the RULES, not the envelope.
interface Expected {
  caps?: Record<string, unknown>;
  allow?: string[];
  deny?: string[];
  unreadable?: true;
  /// A THIRD STATE, spelled explicitly. See `rules()`.
  absent?: true;
}

const DOCUMENTS: Array<{ what: string; body: unknown; expect: Expected }> = [
  // ── Readable, and the rules they carry ────────────────────────────────
  {
    what: 'a legacy pair, both halves',
    body: { allow: ['*'], deny: [], max_per_tx: '100', max_per_stage: '500' },
    expect: { caps: { play: { max_per_tx: '100', max_per_stage: '500' } }, allow: ['*'], deny: [] },
  },
  {
    // EITHER HALF ALONE IS A POLICY. Spelling never decides what a document
    // means: this is the same rule the new shape's half-written entry has.
    what: 'a legacy pair, max_per_tx alone',
    body: { allow: ['*'], deny: [], max_per_tx: '100' },
    expect: { caps: { play: { max_per_tx: '100' } }, allow: ['*'], deny: [] },
  },
  {
    what: 'a legacy pair, max_per_stage alone',
    body: { allow: ['*'], deny: [], max_per_stage: '500' },
    expect: { caps: { play: { max_per_stage: '500' } }, allow: ['*'], deny: [] },
  },
  {
    // Rules about counterparties and none about amounts. §1 makes this
    // writable; it used to throw in the parse while the gate accepted it.
    what: 'lists and no caps at all',
    body: { allow: ['*.play'], deny: ['treasury.play'] },
    expect: { allow: ['*.play'], deny: ['treasury.play'] },
  },
  {
    what: 'an empty document',
    body: {},
    expect: {},
  },
  {
    what: 'a half-written entry in the new shape',
    body: { allow: ['*'], deny: [], caps: { play: { max_per_tx: '1' } } },
    expect: { caps: { play: { max_per_tx: '1' } }, allow: ['*'], deny: [] },
  },
  {
    // ABSENT AND EMPTY DIFFER, and only for `allow`. No list written means no
    // rule about counterparties; a written empty list denies everyone.
    what: 'no allow list, a written deny list',
    body: { deny: ['treasury.play'] },
    expect: { deny: ['treasury.play'] },
  },
  {
    what: 'a written empty allow list',
    body: { allow: [], deny: [] },
    expect: { allow: [], deny: [] },
  },

  // ── THE SECURITY REVIEWER'S FOUR PROBES, as named rows ────────────────
  //
  // At 60da6e4 all four of these returned null from wallet-mcp's `readPolicy`,
  // which under §1 reads as NO RULES WRITTEN - so a caps-only document's bound,
  // a written deny-everyone, an unreadable file and a legacy pair each meant
  // "unbounded" on the fast path while chain-svc enforced them. Named
  // individually rather than folded into the rows above, because a probe that
  // found a defect is worth keeping in the shape it was found in: the next
  // reader can check the finding without reconstructing it.
  {
    what: 'a caps-only document with no lists (reviewer probe 1)',
    body: { caps: { play: { max_per_tx: '100' } } },
    expect: { caps: { play: { max_per_tx: '100' } } },
  },
  {
    // The bare written empty list, with no `deny` beside it - the reviewer's
    // exact document. `allow: []` denies everyone and is a decision someone
    // made; read as null it denied no one.
    what: 'a bare written empty allow list (reviewer probe 2)',
    body: { allow: [] },
    expect: { allow: [] },
  },
  {
    what: 'a legacy pair with no lists at all (reviewer probe 4)',
    body: { max_per_tx: '25', max_per_stage: '100' },
    expect: { caps: { play: { max_per_tx: '25', max_per_stage: '100' } } },
  },
  {
    what: '"unlimited" as a written bound',
    body: { allow: ['*'], deny: [], caps: { play: { max_per_tx: 'unlimited' } } },
    expect: { caps: { play: { max_per_tx: 'unlimited' } }, allow: ['*'], deny: [] },
  },

  // ── A garbage VALUE is field-level, not file-level (ruled) ────────────
  {
    // THE ROW THAT FOUND THE DIVERGENCE. A cap value that is present and
    // unusable is garbage for THAT FIELD: the document still reads, and the
    // refusal happens at the point of use, for that token only. Bricking a
    // two-token wallet over one mistyped field is the service deciding more
    // than it was told.
    what: 'a garbage cap value beside a good one',
    body: { allow: ['*'], deny: [], caps: { play: { max_per_tx: 'lots' }, au: { max_per_tx: '5' } } },
    expect: {
      caps: { play: { max_per_tx: 'lots' }, au: { max_per_tx: '5' } },
      allow: ['*'],
      deny: [],
    },
  },

  // ── A KEY THE DOCUMENT HAS NEVER HAD IS A WRONG SHAPE ────────────────
  //
  // v0.8.0 closed mistyped VALUES and left KEYS free-form, which was the one
  // fail-open direction it did not shut: a misspelled bound is read as ABSENT,
  // and absent means NO bound. The typo widens, silently, and the file still
  // looks right to whoever wrote it.
  {
    what: 'an entry with only an unknown key',
    body: { caps: { play: { max_per_tx_typo: '5' } } },
    expect: { unreadable: true },
  },
  {
    // THE WORSE ONE, because it looks like it works: the known half binds, the
    // typo'd half does not, and the wallet carries one bound where its author
    // wrote two.
    what: 'an entry with a known key and an unknown one',
    body: { caps: { play: { max_per_tx: '5', max_per_stage_typo: '50' } } },
    expect: { unreadable: true },
  },
  { what: 'an unknown top-level key', body: { capz: { play: { max_per_tx: '5' } } }, expect: { unreadable: true } },

  // ── AND THE SHAPE THE INSTALLED BASE IS ACTUALLY IN ──────────────────
  //
  // THE ROW THAT WOULD HAVE CAUGHT THE FIRST DRAFT OF THE RULE. Every file
  // v0.7.0's spawn wrote looks exactly like this: `agentId` because
  // `writePolicyFile` stamps it, and `frozen` because the service-side freeze
  // lived in the document. A known set without those two marks the entire
  // installed base unreadable - which is the write-path defect (the service
  // refusing a document it wrote itself) arriving through a second door.
  //
  // `agentId` is KNOWN and `frozen` is TOLERATED AND DISCARDED: it is read past
  // and never carried forward, so the wallet gets its caps and nothing else.
  {
    what: 'a file in the exact shape the v0.7.0 spawn wrote (reviewer probe 5)',
    body: { agentId: 'orch:legacy', caps: { play: { max_per_tx: '100' } }, allow: ['*'], deny: [], frozen: false },
    expect: { caps: { play: { max_per_tx: '100' } }, allow: ['*'], deny: [] },
  },

  // ── Unreadable: the SHAPE is wrong, not a value ───────────────────────
  { what: 'not an object', body: ['not', 'a', 'policy'], expect: { unreadable: true } },
  {
    // AN EMPTY STRING IS NOT A NAME. The mirror dropped the length check the
    // boundary has, so this document read as unreadable on one side and as a
    // policy with a nonsense pattern on the other - two different refusals
    // downstream from one file.
    what: 'an empty string in a name list',
    body: { allow: [''] },
    expect: { unreadable: true },
  },
  {
    // A GARBAGE ENTRY IS NOT A GARBAGE VALUE. The ruling put a bad cap VALUE at
    // field level, refusing its own token; an entry that is not an object at
    // all is not a value, it is a malformed document. `caps` being an object
    // says nothing about what is in it, and the mirror checked only the map.
    what: 'a cap entry that is not an object',
    body: { caps: { play: 'nope' } },
    expect: { unreadable: true },
  },
  { what: 'allow is not a list', body: { allow: 'everyone' }, expect: { unreadable: true } },
  { what: 'caps is not an object', body: { caps: [] }, expect: { unreadable: true } },
];

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'doc-agree-'));
});

/// Reduces either package's read to the rules it found, so the comparison is
/// between ANSWERS and not between envelopes.
function rules(read: unknown): Expected {
  // ABSENCE GETS ITS OWN VALUE, and this line is the finding.
  //
  // It used to return `{ unreadable: undefined }`, and `toEqual` IGNORES
  // undefined-valued keys - so a null read compared EQUAL to `{}`, and the row
  // for an empty document passed whether a side read `{}` as an empty policy or
  // as an absent file. That is exactly the collapse §4 exists to reverse, and
  // the row named for it could not fail: a mutant returning null for `{}` left
  // the whole suite green.
  //
  // Benign while `checkLocally` answers the same for both, and only until
  // something treats them differently - at which point the test that would have
  // said so is the one already passing. THREE STATES NEED THREE VALUES.
  if (read === null) return { absent: true };
  const r = read as Record<string, unknown>;
  if ('unreadable' in r) return { unreadable: true };
  return {
    ...(r.caps === undefined ? {} : { caps: r.caps as Record<string, unknown> }),
    ...(r.allow === undefined ? {} : { allow: r.allow as string[] }),
    ...(r.deny === undefined ? {} : { deny: r.deny as string[] }),
  };
}

describe('one document, two reads, one answer', () => {
  for (const [i, doc] of DOCUMENTS.entries()) {
    it(`agrees on ${doc.what}`, async () => {
      const agentId = `orch:doc${i}`;
      writeFileSync(join(dir, keyFileName(agentId)), JSON.stringify(doc.body));

      const svc = rules(await readPolicyFile(dir, agentId, DEFAULT_TOKEN));
      const mcp = rules(readPolicy(join(dir, keyFileName(agentId)), DEFAULT_TOKEN));

      // BOTH AGAINST THE EXPECTATION, not merely against each other. Two sides
      // that agree on the wrong answer is the failure a same-as-each-other
      // assertion cannot see, and it is the one this file would otherwise be
      // most prone to - the whole point is that both are written from one spec.
      expect(svc).toEqual(doc.expect.unreadable ? { unreadable: true } : doc.expect);
      expect(mcp).toEqual(doc.expect.unreadable ? { unreadable: true } : doc.expect);
    });
  }

  // A file nobody wrote is not a document at all, and both sides say so in the
  // same way: null, which under §1 means NO RULES WRITTEN rather than "defer".
  it('agrees that an absent file is absent, not unreadable', async () => {
    expect(await readPolicyFile(dir, 'orch:nobody', DEFAULT_TOKEN)).toBeNull();
    expect(readPolicy(join(dir, keyFileName('orch:nobody')), DEFAULT_TOKEN)).toBeNull();
  });

  // The REASON is a fixed string on both sides, and that is a disclosure
  // decision rather than a wording one: `no_cap_set` is persona-facing and its
  // detail crosses with it, while bun's parse error QUOTES the offending token
  // - `{"deny": treasuryOnly}` comes back as `Unexpected identifier
  // "treasuryOnly"`, an operator's counterparty name in front of a model.
  it('agrees on the unreadable REASON, and neither quotes the file', async () => {
    const agentId = 'orch:unparseable';
    writeFileSync(join(dir, keyFileName(agentId)), '{"allow": ["acme:secret"], "deny": treasuryOnly}');

    const svc = await readPolicyFile(dir, agentId, DEFAULT_TOKEN);
    const mcp = readPolicy(join(dir, keyFileName(agentId)), DEFAULT_TOKEN);

    // THE AGREEMENT IS OVER THE CONTRACT, NOT OVER THE DIAGNOSTICS.
    //
    // `unreadable` is the persona's and must be identical: it is what a model
    // switches on and reads back, and two layers wording it differently is the
    // drift every agreement test in this repo exists to stop.
    //
    // `reason` is the operator's, goes to a log on both sides and crosses
    // nowhere. Requiring the two to match character for character would be
    // over-constraining a diagnostic - it would forbid one layer from being
    // MORE useful than the other about a fault only it can see. So this asserts
    // the contract is one and the diagnostic is present, not that both readers
    // chose the same words.
    const svcM = svc as { unreadable: string; reason: string };
    const mcpM = mcp as { unreadable: string; reason: string };
    expect(svcM.unreadable).toBe('policy file unreadable');
    expect(mcpM.unreadable).toBe(svcM.unreadable);
    expect(svcM.reason.length).toBeGreaterThan(0);
    expect(mcpM.reason.length).toBeGreaterThan(0);
    expect(isUnreadable(mcp!)).toBe(true);
    // The control: the string the file contains does NOT appear in either
    // answer. Asserting the fixed string alone would pass against a reason that
    // happened to be fixed AND leaky in some other branch.
    // THE CONTROL, and it now has a second job: it must hold for the PERSONA'S
    // string specifically, since the operator's `reason` is allowed to be
    // anything. Asserting on the whole marker would pass a leak that lived only
    // in the half nobody shows a persona - and would fail a perfectly safe
    // operator reason that happened to quote the file, which is its purpose.
    for (const m of [svcM, mcpM]) {
      expect(m.unreadable).not.toContain('treasuryOnly');
      expect(m.unreadable).not.toContain('acme:secret');
    }
    // ...and the CONTROL ON THE CONTROL: at least one side's operator reason
    // DOES quote the file. Without this row the assertions above would pass on
    // a build where nothing quotes anything, and the test would no longer be
    // measuring that the split is what keeps the quote out of the persona's
    // half - it would be measuring that there is nothing to keep out.
    expect(svcM.reason + mcpM.reason).toContain('treasuryOnly');
  });
});
