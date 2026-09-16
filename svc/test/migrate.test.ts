// Schema migration and the ledger-lifetime control.
//
// The fixtures here are STALE STORES, built column by column rather than by an
// older copy of the schema, because the defect being guarded is precisely that
// `CREATE TABLE IF NOT EXISTS` records nothing about the shape it created: a
// store stamped v0 may or may not have any given column, and which one it has
// depends only on which build first created its volume.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/// This package's root, for the child script the two-process trial spawns.
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

import { Store } from '../src/store.ts';
import { Keystore } from '../src/keystore.ts';
import {
  SCHEMA_VERSION,
  SchemaError,
  ADDITIVE_COLUMNS,
  classifiedColumns,
  assertLedgerLifetimeIntact,
  assertLedgerNotRestored,
  gatherLifetimeFacts,
  LedgerWipeError,
  LEDGER_RESET_NOTICE,
  FREEZE_RECOVERY_ADVICE,
} from '../src/migrate.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chain-migrate-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const dbPath = () => join(dir, 'store.sqlite');

function userVersion(path: string): number {
  const db = new Database(path);
  const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  db.close();
  return v;
}

function columns(path: string, table: string): string[] {
  const db = new Database(path);
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

/// A store as an EARLIER build left it: `intents` without any of the columns
/// added since. This is the shape that produced `no such column: topic`.
function writeAncestralStore(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE intents (
    intent_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, stage TEXT NOT NULL,
    amount TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL)`);
  db.close();
}

describe('schema migration', () => {
  it('stamps a fresh store at the current version', () => {
    const s = new Store(dbPath());
    s.close();
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // The measured production failure: a persisted volume from before `topic`.
  // Before the migration this threw `no such column: topic` at the first query
  // to name it - long after startup had reported success.
  it('adds the missing columns to a store an older build created', () => {
    writeAncestralStore(dbPath());
    expect(columns(dbPath(), 'intents')).not.toContain('topic');

    const s = new Store(dbPath());
    const r = s.reserve({
      token: 'play',
      intentId: 'i1', agentId: 'orch:a', stage: s.currentStage(),
      amount: 10n, stageCap: { cap: 100n }, topic: '0xdead',
    });
    s.close();

    expect(r.outcome).toBe('reserved');
    for (const a of ADDITIVE_COLUMNS.filter((c) => c.table === 'intents')) {
      expect(columns(dbPath(), 'intents')).toContain(a.column);
    }
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // THE MONEY-RELEVANT ONE. The whole reason a migration exists rather than a
  // documented wipe: the consumed intent ids have to survive the upgrade, or
  // the upgrade IS the double-spend it was meant to avoid.
  it('carries consumed intent ids through the upgrade, so a replay still refuses', () => {
    writeAncestralStore(dbPath());
    const old = new Database(dbPath());
    old.query(
      `INSERT INTO intents (intent_id, agent_id, stage, amount, tx_hash, created_at)
       VALUES ('already-paid', 'orch:a', 's1', '5', '0xPAID', 0)`,
    ).run();
    old.close();

    const s = new Store(dbPath());
    const replay = s.reserve({
      intentId: 'already-paid', agentId: 'orch:a', stage: 's1', amount: 5n, stageCap: { cap: 100n }, token: 'play',
    });
    s.close();

    expect(replay).toEqual({ outcome: 'duplicate', txHash: '0xPAID' });
  });

  // THE FIRST SCHEMA CHANGE AFTER THE MIGRATION SHIPPED, and the case the
  // original gate got wrong: a store stamped v1 by the previous release skipped
  // the reconciliation entirely, because it was gated on `version === 0`. It
  // would have needed a numbered migration adding the same column the baseline
  // adds - two mechanisms owning one list of columns.
  it('upgrades a store stamped by the PREVIOUS release, not just a legacy one', () => {
    const s1 = new Store(dbPath());
    s1.close();
    const db = new Database(dbPath());
    db.exec('PRAGMA user_version = 1');            // as the previous release left it
    db.exec('ALTER TABLE spawns DROP COLUMN bare_id_count'); // ...without v2's column
    db.close();

    expect(columns(dbPath(), 'spawns')).not.toContain('bare_id_count');
    const s2 = new Store(dbPath());
    s2.close();

    expect(columns(dbPath(), 'spawns')).toContain('bare_id_count');
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // v0 IS AMBIGUOUS. A store created by a build that already had `topic` is
  // also stamped 0, and a baseline replaying a fixed history would either fail
  // on it or skip a column the other kind of v0 store needs.
  it('handles a v0 store that ALREADY has the added columns', () => {
    const s1 = new Store(dbPath());
    s1.close();
    const db = new Database(dbPath());
    db.exec('PRAGMA user_version = 0'); // a current shape, stamped as legacy
    db.close();

    expect(() => { new Store(dbPath()).close(); }).not.toThrow();
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // §8.6. v5 -> v6: the call op's storage, and both mechanisms in one step.
  //
  // ADDITIVE, NOT NUMBERED, and that distinction is the one increment 2 paid
  // for: the numbered mechanism exists for RESHAPING a table with a backfill,
  // and a numbered migration guarded on the VERSION rather than on the schema
  // fired against a fresh store that never had the old column. Three nullable
  // columns and a new table are neither a reshape nor a backfill, so they go
  // through the two mechanisms that were built for them.
  it('adds the call columns and the call_counts table to a v5 store', () => {
    const s1 = new Store(dbPath());
    s1.close();
    const db = new Database(dbPath());
    // A store as the PREVIOUS release left it: stamped 5, without any of v6.
    db.exec('PRAGMA user_version = 5');
    db.exec('ALTER TABLE intents DROP COLUMN call_contract');
    db.exec('ALTER TABLE intents DROP COLUMN call_function');
    db.exec('ALTER TABLE intents DROP COLUMN call_args_hash');
    db.exec('DROP TABLE call_counts');
    db.close();

    const s2 = new Store(dbPath());
    s2.close();

    expect(columns(dbPath(), 'intents')).toContain('call_contract');
    expect(columns(dbPath(), 'intents')).toContain('call_function');
    expect(columns(dbPath(), 'intents')).toContain('call_args_hash');
    expect(columns(dbPath(), 'call_counts').sort()).toEqual([
      'agent_id',
      'contract',
      'count',
      'function',
      'stage',
    ]);
    // SCHEMA_VERSION, not 6: this test is about the v5 -> v6 step landing, and
    // a store that then runs the v7 step is stamped 7. Pinning the literal
    // would make it a test about how many migrations exist rather than about
    // whether this one applied - which is the same mistake the v4->v5 pair
    // carried until the call increment.
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  it('leaves the three new columns NULL on rows that predate them', () => {
    // A sign-transfer intent has no call, and so does every intent written
    // before v6. Null is the true value for both, which is why the columns are
    // nullable with no default: a default would turn "this was not a call" and
    // "we did not record it" into the same answer.
    const s1 = new Store(dbPath());
    s1.reserve({ intentId: 'i-1', agentId: 'orch:a', stage: 's1', amount: 1n, stageCap: null, token: 'play' });
    s1.close();

    const db = new Database(dbPath());
    const row = db.query('SELECT call_contract, call_function, call_args_hash FROM intents').get() as
      | Record<string, unknown>
      | null;
    db.close();
    expect(row).toEqual({ call_contract: null, call_function: null, call_args_hash: null });
  });

  it('a second boot on a migrated store changes nothing', () => {
    // The migration is idempotent or it is not a migration: every restart runs
    // it, and a step that is not a no-op the second time would corrupt on the
    // first restart rather than on the first upgrade.
    const s1 = new Store(dbPath());
    s1.close();
    const before = [columns(dbPath(), 'intents').sort(), columns(dbPath(), 'call_counts').sort()];
    const s2 = new Store(dbPath());
    s2.close();
    expect([columns(dbPath(), 'intents').sort(), columns(dbPath(), 'call_counts').sort()]).toEqual(
      before,
    );
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // The rollback direction. An older binary against a newer store must refuse
  // by name rather than discover it at the first unknown column.
  it('refuses a store written by a NEWER binary, naming the cause', () => {
    const db = new Database(dbPath(), { create: true });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    let err: unknown;
    try { new Store(dbPath()); } catch (e) { err = e; }

    expect(err).toBeInstanceOf(SchemaError);
    expect((err as SchemaError).code).toBe('store_schema_ahead');
    expect((err as SchemaError).message).toContain(`v${SCHEMA_VERSION + 1}`);
    expect((err as SchemaError).message).toContain(LEDGER_RESET_NOTICE);
  });

  // "Before any write" is the actual requirement, not "before any query": a
  // binary that creates tables on its way to refusing has already modified a
  // store it admits it cannot read.
  it('writes NOTHING to a store it refuses', () => {
    const db = new Database(dbPath(), { create: true });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    try { new Store(dbPath()); } catch { /* expected */ }

    const after = new Database(dbPath());
    const tables = after.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as { name: string }[];
    after.close();
    expect(tables).toEqual([]);
  });

  // The index is part of the schema contract and its creation is now sequenced
  // by the migration, so it needs an assertion of its own: a functional test
  // cannot see a missing index, because every query still returns the right
  // answer without it. Only slower.
  it('builds the topic index, on a fresh store and on a migrated one', () => {
    for (const seed of [() => {}, () => writeAncestralStore(dbPath())]) {
      rmSync(dbPath(), { force: true });
      seed();
      new Store(dbPath()).close();
      const db = new Database(dbPath());
      const idx = db.query(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'intents_topic'`,
      ).get();
      db.close();
      expect(idx).not.toBeNull();
    }
  });

  // The forcing function for the NEXT person to add a column. Without it, a
  // column added to the DDL and not to ADDITIVE_COLUMNS ships green and breaks
  // only on somebody's persisted volume.
  it('classifies every column in the live schema as original or additive', () => {
    const s = new Store(dbPath());
    s.close();
    const db = new Database(dbPath());
    const tables = (db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as { name: string }[]).map((t) => t.name);

    const live = new Set<string>();
    for (const t of tables) {
      for (const c of db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]) {
        live.add(`${t}.${c.name}`);
      }
    }
    db.close();

    const classified = classifiedColumns();
    const unclassified = [...live].filter((c) => !classified.has(c)).sort();
    const stale = [...classified].filter((c) => !live.has(c)).sort();
    expect(unclassified).toEqual([]);
    expect(stale).toEqual([]);
  });
});

// THE FACTS, not just the decision. The control above is a pure function over
// three booleans and is thoroughly pinned - which proves nothing about whether
// the values handed to it are the ones it names. An inverted `intentsEmpty` or
// a keystore count that never counts would leave every test above green and
// the control permanently off.
describe('the facts the control is given', () => {
  it('intentsEmpty is true on a fresh store and false once an id is consumed', () => {
    const s = new Store(dbPath());
    expect(s.intentsEmpty()).toBe(true);
    s.reserve({ intentId: 'i1', agentId: 'orch:a', stage: s.currentStage(), amount: 1n, stageCap: { cap: 10n }, token: 'play' });
    expect(s.intentsEmpty()).toBe(false);
    s.close();
  });

  // A store wiped beneath a live game is EMPTY, not absent - the file is
  // recreated by the next start. So the true case has to hold for a store that
  // exists and has tables, which is what makes it indistinguishable from a
  // fresh install WITHOUT the keystore conjunct.
  it('intentsEmpty stays true when other tables have rows', async () => {
    const s = new Store(dbPath());
    await s.markSpawned('orch:a', '0x1111111111111111111111111111111111111111', null);
    expect(s.intentsEmpty()).toBe(true);
    s.close();
  });

  // THE FACT THAT SEPARATES A WIPE FROM A RESTART, and the one whose absence
  // made `compose down && compose up` refuse to start. The reopen IS the
  // scenario: same file, new process, no transfer ever made in this game.
  it('walletsRecorded survives a restart that keeps the volume, while intents stays empty', () => {
    const p = dbPath();
    const s = new Store(p);
    expect(s.walletsRecorded()).toBe(0);
    s.markSpawned('orch:a', '0x1111111111111111111111111111111111111111', null);
    s.markSpawned('orch:b', '0x2222222222222222222222222222222222222222', null);
    expect(s.walletsRecorded()).toBe(2);
    s.close();

    const again = new Store(p);
    expect(again.walletsRecorded()).toBe(2);
    expect(again.intentsEmpty()).toBe(true); // the reason intents cannot answer this
    again.close();
  });

  // A WIPED store is recreated EMPTY, not absent - so the zero has to come from
  // a store that exists and has tables, which is the state being detected.
  it('walletsRecorded is zero on a store that was recreated from nothing', () => {
    const s = new Store(dbPath());
    expect(s.walletsRecorded()).toBe(0);
    s.close();
  });

  it('agentCount counts key files, and is zero with no directory at all', async () => {
    const ks = new Keystore(join(dir, 'no-such-keystore'), 'secret-secret-secret-secret');
    expect(await ks.agentCount()).toBe(0);
    await ks.create('orch:a');
    await ks.create('orch:b');
    expect(await ks.agentCount()).toBe(2);
  });

  // 0 IS NOT A NEUTRAL ANSWER: it is the exact value that switches the control
  // off. So an UNREADABLE keystore must not answer the same as an ABSENT one.
  //
  // This is the fact that failed open while its two siblings failed closed, and
  // the asymmetry pointed the wrong way: the scenario that trips the control is
  // an operator doing volume surgery, which is exactly when a neighbouring
  // volume can also fail to attach. The precondition broke in the same incident
  // the control exists to detect.
  it('PROPAGATES an unreadable keystore instead of reporting zero agents', async () => {
    const kdir = join(dir, 'locked');
    const ks = new Keystore(kdir, 'secret-secret-secret-secret');
    await ks.create('orch:a');
    chmodSync(kdir, 0o000);
    try {
      // The bare catch returned 0 here, which reads as "a fresh install".
      await expect(ks.agentCount()).rejects.toThrow();
    } finally {
      chmodSync(kdir, 0o700); // or the fixture cannot be cleaned up
    }
  });
});

// THE WIRING. Each fact is carried from its real source to the control, and a
// constant substituted for any one of them leaves every test above green while
// the control is permanently off - the shape that left #34's sweep dormant
// through a merge.
describe('gathering the facts', () => {
  const deps = (over: Partial<{ empty: boolean; wallets: number; agents: number; code: string | undefined; ack: boolean; reservations: number; watermark: number }> = {}) => ({
    store: {
      intentsEmpty: () => over.empty ?? true,
      walletsRecorded: () => over.wallets ?? 0,
      reservationsEverMade: () => over.reservations ?? 0,
    },
    keystore: {
      agentCount: async () => over.agents ?? 2,
      ledgerWatermark: async () => ('watermark' in over ? over.watermark! : null),
    },
    getCode: async () => ('code' in over ? over.code : '0x6080'),
    acknowledged: over.ack ?? false,
  });

  it('carries each fact from its own source', async () => {
    expect(await gatherLifetimeFacts(deps())).toEqual({
      intentsEmpty: true, storeWallets: 0, keystoreAgents: 2, contractsDeployed: true, acknowledged: false,
      reservations: 0, watermark: null,
    });
    // FINDING 22's two halves come from DIFFERENT SOURCES, which is the whole
    // mechanism: the counter from the store, the mark from the keystore. A
    // gatherer that read both from one of them would compare a value with
    // itself and never fire.
    expect((await gatherLifetimeFacts(deps({ reservations: 9 }))).reservations).toBe(9);
    expect((await gatherLifetimeFacts(deps({ watermark: 12 }))).watermark).toBe(12);
    expect((await gatherLifetimeFacts(deps({ empty: false }))).intentsEmpty).toBe(false);
    expect((await gatherLifetimeFacts(deps({ wallets: 4 }))).storeWallets).toBe(4);
    expect((await gatherLifetimeFacts(deps({ agents: 7 }))).keystoreAgents).toBe(7);
    expect((await gatherLifetimeFacts(deps({ ack: true }))).acknowledged).toBe(true);
  });

  // An address with no code answers '0x', not undefined - the case a reset
  // chain actually produces, and the one a truthiness check would get wrong.
  it('reads an undeployed contract from the CHAIN, both empty forms', async () => {
    expect((await gatherLifetimeFacts(deps({ code: '0x' }))).contractsDeployed).toBe(false);
    expect((await gatherLifetimeFacts(deps({ code: undefined }))).contractsDeployed).toBe(false);
  });
});

// THE SHARED SENTENCE ITSELF, pinned separately from every message that embeds
// it. It is an interface: the CLI wrappers and the harness Reset log import it,
// and an operator's acknowledgement is only informed consent if it names ALL of
// what is destroyed. It understated the cost by half once already, so the
// completeness is a test rather than a convention.
describe('the reset notice', () => {
  // ASSERTED ON ITS OWN CONTENT, not merely "the message contains it".
  // `toContain(SOME_CONSTANT)` is vacuously true when the constant is empty -
  // the same sentinel family as `-1 < anything`: an absent value satisfies the
  // check. Emptying FREEZE_RECOVERY_ADVICE survived every other test in this
  // file until this one existed.
  it('the recovery advice tells the operator what to actually do', () => {
    // §3. The service-side lock is RETIREMENT, so the advice says re-retire.
    expect(FREEZE_RECOVERY_ADVICE).toContain('re-retire');
    expect(FREEZE_RECOVERY_ADVICE).toContain('no record of what it was');
    // AND IT NAMES THE OTHER LOCK, which this wipe does NOT destroy. Without
    // this line the advice would read as "everything protective is gone", and
    // an operator would re-do work the chain still remembers - or, worse,
    // believe a frozen attacker can spend again when it cannot.
    expect(FREEZE_RECOVERY_ADVICE).toContain('admin-call');
    expect(FREEZE_RECOVERY_ADVICE).toContain('a wipe cannot touch it');
  });

  it('names both costs, as consequences rather than actions', () => {
    expect(LEDGER_RESET_NOTICE).toContain('reservable again');
    expect(LEDGER_RESET_NOTICE).toContain('may spend again');
    // "reset"/"cleared" read as housekeeping. The sentence must say what
    // becomes POSSIBLE, which is what an operator has to weigh.
    expect(LEDGER_RESET_NOTICE).not.toMatch(/\bresets?\b|\bcleared\b/i);
  });
});

// THE CALL SITE ITSELF, structurally - the repo's `.release(` idiom
// (spawn.test.ts), and deliberately so.
//
// ⚠ READ THIS BEFORE ADDING A GUARD HERE, AND DO NOT REACH FOR `indexOf`.
//
// One defect appeared at FOUR levels in this PR, and each fix reproduced it one
// layer out - every one a check that PASSES ON LESS THAN IT CLAIMS:
//
//   1. the control's wire had no test at all           (a constant at the call
//      site left the refusal dormant with the suite green)
//   2. the seam's structural types caught a LITERAL and accepted a plausible
//      STUB - the dangerous edit is the one that typechecks
//   3. this guard's block extraction used indexOf('})'), which cut the object
//      literal in half at the nested `getCode({...})` and read 3 of its 4 wires
//   4. the ordering guard below searched for the IDENTIFIER, which also appears
//      in the import, and so read 0 of 1 calls
//
// The common cause is not carelessness: each layer is a guard written quickly
// with the cheapest available string operation, AND `indexOf` IS PRECISELY THE
// OPERATION WHOSE FAILURE MODE IS SILENCE. It returns a number either way. A
// future guard here will reach for it again unless something says not to.
//
// TWO RULES THAT WOULD HAVE CAUGHT ALL FOUR:
//   - A COMPARISON WHOSE FAILURE VALUE IS ALSO ITS SUCCESS VALUE CANNOT BE A
//     CHECK. `indexOf`'s sentinel is -1, and -1 is less than everything, so
//     absence satisfies "comes before". Assert the index EXISTS, then compare.
//   - EVERY GUARD NEEDS A NULL MUTANT: delete the thing it guards and confirm
//     it reddens. Applied to the rest of this file it found one more of the
//     same family - `toContain(FREEZE_RECOVERY_ADVICE)` is vacuously true when
//     that constant is empty, so emptying it survived every test here.
//
// `gatherLifetimeFacts` was extracted BECAUSE a constant at the call site left
// the control dormant with the suite green. The structural parameter types then
// catch `intentsEmpty: false` - a LITERAL where a function belongs, TS2322.
// They do NOT catch `intentsEmpty: () => false`, `agentCount: async () => 0`,
// `getCode: async () => undefined` or `acknowledged: true`: each typechecks,
// each leaves 264 tests passing, and each disables the control.
//
// THE DANGEROUS EDIT IS THE ONE THAT TYPECHECKS. A literal substitution is what
// a mutation tester writes; a plausible STUB is what a developer writes when
// they extract, mock "temporarily", or refactor an entrypoint - and no test
// reaches index.ts to notice. So this asserts each fact is wired to its REAL
// source by name.
describe('the call site in index.ts', () => {
  it('wires every fact to its real source, not to a stub', async () => {
    const src = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
    const start = src.indexOf('gatherLifetimeFacts({');
    expect(start).toBeGreaterThan(-1);
    // Brace-balanced rather than up-to-the-first-`})`: the getCode wire contains
    // a nested object literal, so a naive slice cuts the block in half and drops
    // the very wire that follows it. (It did, first run - the guard was reading
    // three of the four facts and would have passed on a stubbed `acknowledged`.)
    let depth = 0;
    let end = start;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = src.slice(start, end);

    expect(block).toMatch(/\bstore,/);                              // the real Store
    expect(block).toMatch(/\bkeystore,/);                           // the real Keystore
    expect(block).toMatch(/getCode:\s*\(\)\s*=>\s*chain\.publicClient\.getCode\(/); // the real chain
    expect(block).toMatch(/acknowledged:\s*config\.acknowledgeLedgerReset/); // the real flag
  });

  // The refusal must precede anything that can move money. A control that runs
  // after the server is listening is a control that lost the race it exists for.
  //
  // TWO WAYS THIS ASSERTION WAS WRONG THE FIRST TIME, both of which made it
  // pass when the control was entirely absent:
  //
  // (1) It searched for `assertLedgerLifetimeIntact`, which also appears in the
  //     IMPORT at the top of the file - so it matched char 584 regardless of
  //     what happened to the call. THE IDENTIFIER IS NOT THE CALL SITE. Deleting
  //     the call, or moving it AFTER server.listen, both left it green.
  // (2) It compared indexOf results directly. indexOf's sentinel is -1, and
  //     `-1 < anything` is the SUCCESS condition - so ABSENCE READ AS CORRECT
  //     ORDERING. COMPARE TO A VALUE, NOT TO EMPTINESS: both indices have to
  //     exist before their order means anything.
  it('refuses BEFORE the server starts listening', async () => {
    const src = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
    const call = src.indexOf('gatherLifetimeFacts({'); // the call, not the import
    const listen = src.indexOf('server.listen');
    expect(call).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(call).toBeLessThan(listen);
  });
});

describe('the ledger lifetime control', () => {
  // Empty store + keys in the keystore + contracts on the chain. Each conjunct
  // rules out one legitimate way to arrive at an empty store, which is why
  // this is a proof rather than a heuristic.
  // The watermark pair is at rest here (0 and 0): these rows are about the WIPE
  // control, and finding 22's restore control has its own block below. Both at
  // zero is the fresh-install shape, which is the state that must not fire it.
  const wiped = {
    intentsEmpty: true, storeWallets: 0, keystoreAgents: 3, contractsDeployed: true, acknowledged: false,
    reservations: 0, watermark: 0,
  };

  it('refuses a store wiped beneath a live game', () => {
    expect(() => assertLedgerLifetimeIntact(wiped)).toThrow(LedgerWipeError);
  });

  it('names both consequences and the way out', () => {
    let err: unknown;
    try { assertLedgerLifetimeIntact(wiped); } catch (e) { err = e; }
    const msg = (err as Error).message;
    expect(msg).toContain(LEDGER_RESET_NOTICE);
    expect(msg).toContain(FREEZE_RECOVERY_ADVICE);
    expect(msg).toContain('--acknowledge-ledger-reset');
  });

  // A FRESH INSTALL. No keystore files, because no agent has ever been
  // spawned - the conjunct that makes an empty store legitimate here.
  it('starts normally on a fresh install', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, keystoreAgents: 0 })).not.toThrow();
  });

  // AN HONEST FULL RESET. Fresh anvil, contracts not yet deployed.
  it('starts normally when the chain was reset with the store', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, contractsDeployed: false })).not.toThrow();
  });

  it('does not refuse once any intent has been consumed', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, intentsEmpty: false })).not.toThrow();
  });

  // A LIVE GAME THAT HAS SIMPLY NOT SPENT YET - the false positive that sent
  // this back. `compose down` followed by `compose up` keeps every volume: the
  // store returns with its spawns, its outbox and its wallet tokens, and an
  // intents table that is empty because no transfer has happened YET. The old
  // comment here said this case was caught deliberately and referred to a note
  // below justifying it; there was no note below, and once the stack restarts
  // routinely (#83) the refusal fires on an ordinary restart.
  //
  // It is distinguished by THE STORE BEING PRESENT, which is what this conjunct
  // now reads - and nothing else changed, so each of the cases below still
  // rules out one legitimate way to arrive at an empty store.
  it('starts normally when the store still remembers the wallets it spawned', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, storeWallets: 4 })).not.toThrow();
  });

  // The NULL MUTANT for the new conjunct: one wallet is enough to prove the
  // store survived, and a `>= 1` that drifted to `> 1` would pass the case
  // above and refuse a one-agent game.
  it('one remembered wallet is already proof the store survived', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, storeWallets: 1 })).not.toThrow();
  });

  // The legitimate reset stays ONE documented step.
  it('the acknowledgement releases it', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, acknowledged: true })).not.toThrow();
  });

  // FINDING 21: releasing is not the same as going quiet. The flag lives in
  // compose or an env file, so it stays set for every restart after the one it
  // was typed for - a facilitator who acknowledged a wipe in October is running
  // an unguarded store in March with nothing to remind them. That is the same
  // shape as the refusal being routed around, arriving by a slower road.
  it('warns every boot while the acknowledgement is set, naming the notice and the advice', () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      assertLedgerLifetimeIntact({ ...wiped, acknowledged: true });
      assertLedgerLifetimeIntact({ ...wiped, acknowledged: true });
    } finally {
      console.warn = warn;
    }
    // EVERY boot, not the first: two calls, two lines.
    expect(lines).toHaveLength(2);
    // NAMING the constants rather than summarising them, so an operator reads
    // the same sentences the refusal would have shown. Asserted by content, so
    // a warning that said "acknowledged, carrying on" would fail.
    expect(lines[0]).toContain(LEDGER_RESET_NOTICE);
    expect(lines[0]).toContain(FREEZE_RECOVERY_ADVICE);
  });

  // THE CONTROL: a healthy store says nothing. Without it the row above passes
  // on a build that warns on every boot of every store, which would train an
  // operator to ignore the line that matters.
  it('control: an intact ledger warns about nothing', () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      assertLedgerLifetimeIntact({ ...wiped, intentsEmpty: false });
    } finally {
      console.warn = warn;
    }
    expect(lines).toEqual([]);
  });

  // The acknowledgement is the ONLY thing that releases a genuine wipe: a
  // mutant that returns early on any other conjunct alone would pass the tests
  // above and disable the control.
  it('the acknowledgement is not implied by any other fact', () => {
    expect(() => assertLedgerLifetimeIntact(wiped)).toThrow();
  });
});

// §8.6. THE FIRST NUMBERED MIGRATION, and the first one that RESHAPES a table
// rather than adding to it.
//
// A v4 store's `deployment` row held two address columns, because a deployment
// was exactly one token and one registry. A v5 store holds a JSON list, because
// it can be any number of modules in a declared order.
describe('the v4 -> v5 deployment reshape', () => {
  /// A v4 `deployment` table, built by running the OLD DDL by hand rather than
  /// by checking out the old code: the point is to migrate the shape the
  /// previous release actually wrote, and reconstructing it here is what makes
  /// this a test of the migration rather than of `createTables()`.
  function v4Store(path: string, chainId = '31337'): void {
    const s = new Store(path); // current shape, then reshaped back to v4
    s.close();
    const db = new Database(path);
    db.exec(`
      DROP TABLE deployment;
      CREATE TABLE deployment (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        chain_id       TEXT NOT NULL,
        veebux         TEXT NOT NULL,
        name_registry  TEXT NOT NULL,
        recorded_at    INTEGER NOT NULL
      );
      INSERT INTO deployment (id, chain_id, veebux, name_registry, recorded_at)
        VALUES (1, '${chainId}', '0xVEE', '0xREG', 1700000000000);
      PRAGMA user_version = 4;
    `);
    db.close();
  }

  it('carries the two addresses into the module list, in order', () => {
    v4Store(dbPath());

    const s = new Store(dbPath());
    const recorded = s.recordedDeployment();
    s.close();

    expect(recorded).toEqual({
      chainId: '31337',
      modules: [
        // 'vee' is not a fixture here: it is what the BACKFILL writes, because
        // that is the only key a v4 store could have meant.
        { kind: 'token', key: 'vee', address: '0xVEE' },
        { kind: 'names', address: '0xREG' },
      ],
    });
  });

  // THE BACKFILL IS TOTAL AND THAT IS WHY IT IS SOUND: every v4 store was
  // written by a build whose deployment row could only ever be one token and
  // one registry, so `vee` is the only key it could have meant. Nothing is
  // invented; the shape is just restated.
  it('stamps the store at the current version, so a second boot does not refuse it', () => {
    // SCHEMA_VERSION, not a literal. This test is about the RELATIONSHIP
    // between what a migration stamps and what the binary accepts, and a
    // literal made it a test about the number instead: it went red on the v6
    // bump while the property it describes was still true. The literal that
    // SHOULD stay is the one below, on SCHEMA_VERSION itself - that one is a
    // tripwire whose whole job is to fire when somebody bumps the version.
    v4Store(dbPath());

    const first = new Store(dbPath());
    first.close();
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);

    // The refusal this guards against is "written by a NEWER chain-svc": with
    // SCHEMA_VERSION left behind the migration, the first boot would stamp the
    // higher number and the second would refuse the store it had just migrated.
    const second = new Store(dbPath());
    second.close();
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // A MIGRATED STORE AND A FRESH ONE MUST BE THE SAME STORE. Two paths reach
  // the v5 shape - `createTables()` for a new store and the numbered migration
  // for an old one - and nothing else would notice them drifting apart.
  it('lands on the same schema as a store created fresh', () => {
    v4Store(dbPath());
    const migrated = new Store(dbPath());
    migrated.close();
    const migratedColumns = columns(dbPath(), 'deployment');

    rmSync(dbPath(), { force: true });
    const fresh = new Store(dbPath());
    fresh.close();

    expect(migratedColumns).toEqual(columns(dbPath(), 'deployment'));
    expect(migratedColumns).toEqual(['id', 'chain_id', 'modules_json', 'recorded_at']);
  });

  // THE GUARD IS ON THE SCHEMA, NOT THE VERSION, and this is the case that
  // proves why. A fresh store is created at the v5 shape and stamped 0 until
  // the end of migrate(), so a `version < 5` guard fires the reshape against a
  // table that never had `veebux` - measured, `no such column: veebux`, on
  // every fresh store.
  // RE-ASSERTED AGAINST 5 EXPLICITLY, because the rule "a store from a newer
  // build is refused" is only meaningful relative to the CURRENT version, and
  // the v5 bump is exactly the kind of change that could have left the refusal
  // comparing against a stale constant.
  it('still refuses a store stamped by a build newer than this one', () => {
    const s = new Store(dbPath());
    s.close();
    const db = new Database(dbPath());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    // A TRIPWIRE, deliberately a literal: it exists to fire when somebody
    // bumps SCHEMA_VERSION, so they come and check that this file's v4 and v5
    // fixtures still describe the migration they think they do. Bumped to 7 by
    // the multi-token increment, which rekeys stage_spend by token - a NUMBERED
    // step, like the v4 -> v5 reshape below, which it leaves untouched.
    //
    // Bumped to 8 by finding 1, which rekeys `intents` on (agent_id, intent_id).
    // It fired, it was read, and the answer is that the v4 and v5 fixtures are
    // unaffected: they reshape `deployment`, a table v8 does not touch. The two
    // `toBe(7)` assertions below DID have to move - they asserted the version a
    // v6 store lands on, which is now 8 because both steps run - and they are
    // SCHEMA_VERSION now, because what they were ever about is "the store ends
    // up current", not "the store ends up at seven".
    expect(SCHEMA_VERSION).toBe(8);
    expect(() => new Store(dbPath())).toThrow(/newer/i);
  });

  it('does not run the reshape on a fresh store, which never had the old columns', () => {
    const s = new Store(dbPath());
    s.recordDeployment({ chainId: '31337', modules: [{ kind: 'token', key: 'play', address: '0xA' }] });
    const recorded = s.recordedDeployment();
    s.close();

    expect(recorded?.modules).toEqual([{ kind: 'token', key: 'play', address: '0xA' }]);
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });
});

// §2. v6 -> v7: caps become per token, so the two tables that record spending
// have to say WHICH token.
//
// TWO MECHANISMS IN ONE STEP, and this is the first time they are paired:
//
//   stage_spend  its PRIMARY KEY gains `token`. ALTER TABLE cannot change a
//                primary key, so this is a NUMBERED migration - recreate,
//                copy, rename - which is what the numbered mechanism exists
//                for and what ADDITIVE_COLUMNS cannot express.
//   intents      gains a nullable `token`, which IS additive - its DDL is a
//                static literal and cannot carry a dynamic default - and the
//                SAME numbered step backfills it, because the value to fill it
//                with is read from the deployment row at migration time.
//
// The guard is on the SCHEMA, never the version. A fresh store is created by
// createTables() at the CURRENT shape and stamped 0 until the end, so a guard
// of `version < 7` would fire this against a table that never had the old key -
// which is exactly how increment 2's numbered migration failed, with
// `no such column: veebux` on every fresh store.
describe('the v6 -> v7 per-token rekey', () => {
  /// A store as v6 left it: stage_spend keyed (agent_id, stage), intents with
  /// no token column, and a deployment row naming the default token.
  function v6Store(path: string, opts: { deployment?: boolean } = {}): void {
    const s = new Store(path);
    s.markSpawned('orch:a', '0x000000000000000000000000000000000000aaaa', 'agent');
    if (opts.deployment !== false) {
      s.recordDeployment({
        chainId: '31337',
        modules: [
          { kind: 'token', key: 'vee', address: '0xA' },
          { kind: 'token', key: 'au', address: '0xB' },
        ],
      });
    }
    s.close();

    const db = new Database(path);
    db.exec('PRAGMA user_version = 6');
    // Put the two tables back into their v6 shape.
    db.exec(`
      DROP TABLE stage_spend;
      CREATE TABLE stage_spend (
        agent_id TEXT NOT NULL,
        stage    TEXT NOT NULL,
        spent    TEXT NOT NULL,
        PRIMARY KEY (agent_id, stage)
      );
      INSERT INTO stage_spend (agent_id, stage, spent) VALUES ('orch:a', 's1', '500');
      ALTER TABLE intents DROP COLUMN token;
    `);
    db.exec(
      `INSERT INTO intents (intent_id, agent_id, stage, amount, held_wei, created_at)
       VALUES ('i-1', 'orch:a', 's1', '500', '500', 0)`,
    );
    db.close();
  }

  it('rekeys stage_spend and backfills BOTH tables with the default token', () => {
    v6Store(dbPath());
    const s = new Store(dbPath());
    s.close();

    const db = new Database(dbPath());
    // The default token is the FIRST in manifest order, which is the same rule
    // every other consumer uses - not a token chosen by this migration.
    expect(db.query('SELECT token, spent FROM stage_spend').get()).toEqual({
      token: 'vee',
      spent: '500',
    });
    expect(db.query('SELECT token FROM intents').get()).toEqual({ token: 'vee' });
    const key = db.query(`SELECT * FROM pragma_index_list('stage_spend')`).all();
    db.close();

    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
    expect(columns(dbPath(), 'stage_spend').sort()).toEqual(['agent_id', 'spent', 'stage', 'token']);
    expect(key.length).toBeGreaterThan(0);
  });

  it('keys stage_spend by (agent_id, stage, token) afterwards', () => {
    // THE POINT OF THE REKEY, asserted by writing rather than by reading the
    // schema: two tokens in one stage for one wallet are two rows, and under
    // the old key the second would have replaced the first.
    v6Store(dbPath());
    const s = new Store(dbPath());
    s.close();

    const db = new Database(dbPath());
    db.exec(
      `INSERT INTO stage_spend (agent_id, stage, token, spent) VALUES ('orch:a', 's1', 'au', '7')`,
    );
    const rows = db.query('SELECT token, spent FROM stage_spend ORDER BY token').all();
    db.close();
    expect(rows).toEqual([
      { token: 'au', spent: '7' },
      { token: 'vee', spent: '500' },
    ]);
  });

  it('REFUSES BY NAME when there is no deployment row to read a default from', () => {
    // NEVER NULL INTO A PRIMARY KEY. A store with no deployment row has no
    // default token to backfill FROM, and writing null would produce rows that
    // cannot be read back by any query that names a token - a corruption that
    // reports itself as "no spend recorded", which reads as a wallet with
    // budget left.
    v6Store(dbPath(), { deployment: false });
    expect(() => new Store(dbPath())).toThrow(/no deployment row/);
  });

  it('leaves a store that has already been rekeyed alone', () => {
    // Idempotent or it is not a migration: every restart runs it, and a step
    // that is not a no-op the second time corrupts on the first restart rather
    // than on the first upgrade. The guard is on the SCHEMA, so the second boot
    // sees the new key and does nothing.
    v6Store(dbPath());
    new Store(dbPath()).close();
    const after = columns(dbPath(), 'stage_spend').sort();
    new Store(dbPath()).close();
    expect(columns(dbPath(), 'stage_spend').sort()).toEqual(after);
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  it('does not run against a FRESH store, which never had the old key', () => {
    // The failure increment 2 paid for: a numbered migration guarded on the
    // VERSION fires against a fresh store created at the current shape, and
    // dies reading a column that never existed.
    expect(() => new Store(dbPath()).close()).not.toThrow();
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });
});

// FINDING 5: the v6 -> v7 step BINDS the token key rather than interpolating it.
//
// The reviewer's three-key run: three tokens, spend recorded in the pre-v7
// shape, migrated, and every row must come back under the DEFAULT key - the
// first in manifest order - with nothing lost and nothing renamed.
describe('the v6 -> v7 rekey binds its key', () => {
  let dir: string;
  const dbPath = () => join(dir, 'store.sqlite');
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'v7bind-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('carries every row across under the default key', () => {
    const s = new Store(dbPath());
    s.recordDeployment({
      chainId: '31337',
      modules: [
        { kind: 'token', key: 'play', address: '0xA' },
        { kind: 'token', key: 'gold', address: '0xB' },
        { kind: 'token', key: 'silver', address: '0xC' },
      ],
    });
    s.close();

    // A v6-shaped `stage_spend`: no token column, and rows to carry.
    const db = new Database(dbPath());
    db.exec(`
      DROP TABLE stage_spend;
      CREATE TABLE stage_spend (
        agent_id TEXT NOT NULL,
        stage    TEXT NOT NULL,
        spent    TEXT NOT NULL,
        PRIMARY KEY (agent_id, stage)
      );
      INSERT INTO stage_spend (agent_id, stage, spent) VALUES ('orch:a', 's1', '500');
      INSERT INTO stage_spend (agent_id, stage, spent) VALUES ('orch:b', 's1', '700');
      PRAGMA user_version = 6;
    `);
    db.close();

    new Store(dbPath()).close();

    const after = new Database(dbPath());
    const rows = after.query(`SELECT agent_id, stage, token, spent FROM stage_spend ORDER BY agent_id`).all();
    after.close();
    // THE DEFAULT KEY, ON EVERY ROW, with the spend intact. A step that lost a
    // row would give a wallet budget back; one that renamed it would make the
    // spend unreadable by any query naming a token, which reads as "no spend
    // recorded" and therefore as budget left.
    expect(rows).toEqual([
      { agent_id: 'orch:a', stage: 's1', token: 'play', spent: '500' },
      { agent_id: 'orch:b', stage: 's1', token: 'play', spent: '700' },
    ]);
  });
});

// FINDING 13: two processes opening one store at once.
//
// WAL keeps a reader out of a writer's way; it does not make two WRITERS wait.
// Without a busy timeout sqlite answers SQLITE_BUSY immediately, so the second
// process threw during MIGRATION - the one moment the store is half-shaped. And
// without `BEGIN IMMEDIATE` both read `user_version` as 6, both decide to
// migrate, and the second discovers the conflict half way through its own
// rewrite.
describe('two processes may open one store at once', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'race-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // TEN RUNS, because a race that fires one time in three passes once. Each run
  // is a fresh store with work to do: a v6-shaped stage_spend, so both
  // processes have a numbered step to race on rather than an empty migration.
  it('ten trials, zero throws, and both find a migrated store', async () => {
    const script = join(dir, 'open.ts');
    writeFileSync(
      script,
      `import { Store } from ${JSON.stringify(join(PKG, 'src', 'store.ts'))};\n` +
        `const s = new Store(process.argv[2]!);\n` +
        `process.stdout.write(String(s.currentStage() !== undefined));\n` +
        `s.close();\n`,
    );

    for (let i = 0; i < 10; i++) {
      const path = join(dir, `store-${i}.sqlite`);
      const seed = new Store(path);
      seed.recordDeployment({ chainId: '31337', modules: [{ kind: 'token', key: 'play', address: '0xA' }] });
      seed.close();
      const db = new Database(path);
      db.exec(`
        DROP TABLE stage_spend;
        CREATE TABLE stage_spend (
          agent_id TEXT NOT NULL, stage TEXT NOT NULL, spent TEXT NOT NULL,
          PRIMARY KEY (agent_id, stage)
        );
        PRAGMA user_version = 6;
      `);
      db.close();

      // BOTH STARTED BEFORE EITHER IS AWAITED, so they overlap. Awaiting the
      // first would serialise them and the test would measure nothing.
      const [a, b] = await Promise.all([
        Bun.spawn(['bun', 'run', script, path], { stdout: 'pipe', stderr: 'pipe' }),
        Bun.spawn(['bun', 'run', script, path], { stdout: 'pipe', stderr: 'pipe' }),
      ].map(async (p) => {
        const proc = await p;
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { out, err, code };
      }));

      // NAMED, not counted: a failure has to say which process and why.
      for (const [which, r] of [['a', a], ['b', b]] as const) {
        if (r.code !== 0) {
          throw new Error(`trial ${i} process ${which} exited ${r.code}:\n${r.err}`);
        }
      }
      expect(userVersion(path)).toBe(SCHEMA_VERSION);
    }
  }, 120_000);
});

// FINDING 22: A STORE THAT WENT BACKWARDS IN TIME.
//
// Invisible to every fact the wipe control reads: a backup restored onto a live
// game has wallets, keys, contracts and a non-empty intents table. Nothing
// fires, and the store quietly re-offers intent ids that have already paid.
//
// The mechanism is a comparison BETWEEN VOLUMES, because that is the only place
// the disagreement can exist. The spec's first form put the watermark inside the
// store, which cannot work: restore the file and the watermark is restored with
// it, and the two agree about a past that is no longer true.
describe('the ledger restore control', () => {
  const live = {
    intentsEmpty: false, storeWallets: 3, keystoreAgents: 3, contractsDeployed: true,
    acknowledged: false, reservations: 40, watermark: 40 as number | null,
  };

  it('starts when the store is at or ahead of the mark', () => {
    // AHEAD IS NORMAL, not suspicious: the counter grows during a run and the
    // mark is written at boot, so every healthy second boot has more
    // reservations than the mark it was compared against.
    expect(() => assertLedgerNotRestored({ ...live, reservations: 40, watermark: 40 })).not.toThrow();
    expect(() => assertLedgerNotRestored({ ...live, reservations: 57, watermark: 40 })).not.toThrow();
  });

  it('refuses a store restored under the keystore it was taken from, by name', () => {
    let err: unknown;
    try { assertLedgerNotRestored({ ...live, reservations: 12, watermark: 40 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LedgerWipeError);
    // BOTH NUMBERS IN THE MESSAGE. "Refuses" is not the requirement - an
    // operator has to be able to tell which volume went backwards, and the pair
    // is what says so.
    expect((err as Error).message).toContain('12');
    expect((err as Error).message).toContain('40');
    expect((err as Error).message).toContain(LEDGER_RESET_NOTICE);
  });

  // THE OTHER SIDE OF THE SAME ASYMMETRY (the reviewer's edge): the KEYSTORE is
  // the volume that changed. Every wallet the store remembers is then a wallet
  // nobody holds a key for.
  it('refuses a live ledger beside a keystore that has never seen it', () => {
    let err: unknown;
    try { assertLedgerNotRestored({ ...live, reservations: 40, watermark: null }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LedgerWipeError);
    expect((err as Error).message).toMatch(/keystore/i);
  });

  // ...AND A FRESH DEPLOYMENT HAS BOTH AT REST, which is the conjunct that
  // keeps the row above from firing on every new installation. Without this the
  // control would refuse the first boot of every deployment, which is the
  // failure mode that gets a control deleted rather than fixed.
  it('starts a fresh deployment, where the store has reserved nothing', () => {
    expect(() => assertLedgerNotRestored({ ...live, reservations: 0, watermark: null })).not.toThrow();
  });

  it('the acknowledgement releases it, as it releases the wipe control', () => {
    expect(() =>
      assertLedgerNotRestored({ ...live, reservations: 12, watermark: 40, acknowledged: true }),
    ).not.toThrow();
  });
});

// THE COUNTER ITSELF, against a real store - because the control above is only
// as good as the number it compares, and the whole reason this is a counter
// rather than MAX(rowid) is that the obvious measure FALLS on an ordinary
// release.
describe('the reservation counter only goes up', () => {
  const args = (intentId: string) => ({
    intentId, agentId: 'orch:a', stage: 's1', amount: 10n,
    stageCap: { cap: 10n ** 24n }, token: 'play',
  }) as Parameters<Store['reserve']>[0];

  it('counts every reservation', () => {
    const s = new Store(':memory:');
    expect(s.reservationsEverMade()).toBe(0);
    s.reserve(args('a'));
    s.reserve(args('b'));
    expect(s.reservationsEverMade()).toBe(2);
    s.close();
  });

  // THE ROW THE SPEC'S FIRST MECHANISM WOULD HAVE FAILED. `release` DELETEs the
  // row, and sqlite reuses the top rowid when the highest row goes - so
  // MAX(rowid) falls, and a control built on it refuses the next boot because a
  // wallet released its most recent reservation.
  it('does not fall when an intent is released', () => {
    const s = new Store(':memory:');
    s.reserve(args('a'));
    s.reserve(args('b'));
    s.release('orch:a', 'b');
    expect(s.reservationsEverMade()).toBe(2);
    // ...and the id is genuinely free again, so this is the ordinary path
    // rather than a release that did nothing.
    expect(s.reserve(args('b')).outcome).toBe('reserved');
    expect(s.reservationsEverMade()).toBe(3);
    s.close();
  });

  // A DUPLICATE IS NOT A RESERVATION. The counter measures what was TAKEN, and
  // counting refused attempts would let a caller inflate the mark by retrying.
  it('does not count a duplicate', () => {
    const s = new Store(':memory:');
    s.reserve(args('a'));
    expect(s.reserve(args('a')).outcome).toBe('duplicate');
    expect(s.reservationsEverMade()).toBe(1);
    s.close();
  });
});
