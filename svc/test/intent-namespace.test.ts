// FINDING 1: an intent id is namespaced by the wallet that reserved it.
//
// An intent id is a string the CALLER chooses. The `intents` table keyed on it
// alone, so one wallet's choice collided with another's - and the collision was
// not a refusal, it was a SUCCESS report for a transfer that never happened:
//
//   alice sends 5 to orch:dest with intentId "payment-1"  -> txHash 0xf3c2…9a60
//   bob   sends 99 to orch:alice reusing "payment-1"      -> 200, the SAME hash,
//                                                            bob's own canonical,
//                                                            bob's balance unchanged
//
// The PK is the smallest part of it. Once ids are non-unique, every query keyed
// on the id alone is ambiguous, and a PARTIAL application is worse than the
// collision: `completeIntent` would stamp one wallet's tx hash onto another's
// open reservation, and `release` would cancel another wallet's. So this file
// asserts the coordinate at every site rather than the key alone.

import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION } from '../src/migrate.ts';
import { intentTopic } from '../src/treasury.ts';

const cap = { cap: 10n ** 24n };
const ALICE = 'orch:alice';
const BOB = 'orch:bob';
const ID = 'payment-1';

/// One reservation, with everything a site might read off the row, so each test
/// below can vary ONE coordinate rather than build a fixture of its own.
const put = (s: Store, agentId: string, intentId: string, amount: bigint, extra: Record<string, unknown> = {}) =>
  s.reserve({
    intentId,
    agentId,
    stage: 's1',
    amount,
    stageCap: cap,
    token: 'play',
    ...extra,
  } as Parameters<Store['reserve']>[0]);

// A PROPERTY OF THIS FINDING THAT SURPRISED ME, recorded because the next
// person will mutate the same line and reach the same confusion.
//
// Reverting the DECLARED key in store.ts to `intent_id TEXT PRIMARY KEY` leaves
// every row in this file green. Not because they are weak: the v8 step's guard
// is on the KEY (`primaryKeyOf(intents) === 'intent_id'`), so a store created
// from the reverted declaration matches it, the step fires, and the table is
// rebuilt with the composite key before anyone can use it. Measured:
//
//   declared PK reverted, fresh store ends with PK: agent_id,intent_id
//
// So the declaration is self-healing and the tests below pin the parts that can
// actually break: the queries, the migration, and the index. A reader should
// know the declared DDL is documentation of intent here rather than the only
// thing standing between two wallets and one row.
describe('two wallets may use one intent id string', () => {
  // THE REVIEWER'S REPRO, at the store. Both directions, because "bob may use
  // alice's string" and "alice may later use bob's" are the same rule read from
  // opposite ends and only one of them is the order the bug was found in.
  it("bob's reserve of alice's id is a fresh reservation, not a duplicate", () => {
    const s = new Store(':memory:');
    expect(put(s, ALICE, ID, 5n).outcome).toBe('reserved');
    expect(put(s, BOB, ID, 99n).outcome).toBe('reserved');
    // ...and each is a duplicate of ITSELF, so the idempotency guarantee is not
    // what was traded away to get this.
    expect(put(s, ALICE, ID, 5n).outcome).toBe('duplicate');
    expect(put(s, BOB, ID, 99n).outcome).toBe('duplicate');
    s.close();
  });

  it("alice's later use of a string bob used is her own fresh reservation", () => {
    const s = new Store(':memory:');
    expect(put(s, BOB, 'job-7', 1n).outcome).toBe('reserved');
    expect(put(s, ALICE, 'job-7', 1n).outcome).toBe('reserved');
    s.close();
  });

  // A DUPLICATE ANSWERS WITH ITS OWN HASH. The collision's damage was not the
  // word "duplicate", it was being handed somebody else's transaction.
  it('a replay gets its OWN txHash back, never the other wallet\'s', () => {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 5n);
    put(s, BOB, ID, 99n);
    s.completeIntent(ALICE, ID, '0xalice');
    s.completeIntent(BOB, ID, '0xbob');
    expect(put(s, ALICE, ID, 5n)).toEqual({ outcome: 'duplicate', txHash: '0xalice' });
    expect(put(s, BOB, ID, 99n)).toEqual({ outcome: 'duplicate', txHash: '0xbob' });
    s.close();
  });
});

// ONE ROW PER SITE. Each takes the coordinate now; each of these fails if one
// of them stops taking it. They are separate rows rather than one because a
// single test naming several sites reports the first failure and hides the rest
// - and a partial application is exactly what this finding warns about.
describe('every read and write of an intent takes the wallet', () => {
  /// Two wallets holding one id string, with distinguishable values on each
  /// row, so a site reading the wrong row reads a WRONG VALUE rather than a
  /// missing one. Absence would pass a test written against `toBeNull`.
  function bothHoldTheSameId(): Store {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 5n, { token: 'play', idSource: 'caller', call: undefined });
    put(s, BOB, ID, 99n, { token: 'gold', idSource: 'server' });
    return s;
  }

  it('completeIntent stamps the hash on the caller\'s row only', () => {
    const s = bothHoldTheSameId();
    s.completeIntent(ALICE, ID, '0xalice');
    expect(s.intentTxHash(ALICE, ID)).toBe('0xalice');
    expect(s.intentTxHash(BOB, ID)).toBeNull(); // bob's reservation is still open
    s.close();
  });

  it('intentTxHash reads the caller\'s row', () => {
    const s = bothHoldTheSameId();
    s.completeIntent(BOB, ID, '0xbob');
    expect(s.intentTxHash(BOB, ID)).toBe('0xbob');
    expect(s.intentTxHash(ALICE, ID)).toBeNull();
    s.close();
  });

  it('intentToken reads the caller\'s row', () => {
    const s = bothHoldTheSameId();
    expect(s.intentToken(ALICE, ID)).toBe('play');
    expect(s.intentToken(BOB, ID)).toBe('gold');
    s.close();
  });

  it('intentIdSource reads the caller\'s row', () => {
    const s = bothHoldTheSameId();
    expect(s.intentIdSource(ALICE, ID)).toBe('caller');
    expect(s.intentIdSource(BOB, ID)).toBe('server');
    s.close();
  });

  it('intentRecord reads the caller\'s row', () => {
    const s = bothHoldTheSameId();
    s.completeIntent(BOB, ID, '0xbob');
    expect(s.intentRecord(ALICE, ID)?.agentId).toBe(ALICE);
    expect(s.intentRecord(ALICE, ID)?.txHash).toBeNull();
    expect(s.intentRecord(BOB, ID)?.txHash).toBe('0xbob');
    s.close();
  });

  it('intentCall reads the caller\'s row', () => {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 5n, { call: { contract: 'converter', function: 'convert', argsHash: '0xa' } });
    put(s, BOB, ID, 99n, { call: { contract: 'shop', function: 'buy', argsHash: '0xb' } });
    expect(s.intentCall(ALICE, ID)?.function).toBe('convert');
    expect(s.intentCall(BOB, ID)?.function).toBe('buy');
    s.close();
  });

  it('release frees the caller\'s reservation only', () => {
    const s = bothHoldTheSameId();
    s.release(ALICE, ID);
    expect(put(s, ALICE, ID, 5n).outcome).toBe('reserved'); // freed
    expect(put(s, BOB, ID, 99n).outcome).toBe('duplicate'); // untouched
    s.close();
  });

  it('backdateIntentForTest moves the caller\'s row only', () => {
    const s = bothHoldTheSameId();
    const db = (s as unknown as { db: Database }).db;
    const at = (agent: string) =>
      (db.query(`SELECT created_at FROM intents WHERE agent_id = ? AND intent_id = ?`)
        .get(agent, ID) as { created_at: number }).created_at;
    const bobBefore = at(BOB);
    s.backdateIntentForTest(ALICE, ID, 1_000);
    expect(at(ALICE)).toBe(1_000);
    expect(at(BOB)).toBe(bobBefore);
    s.close();
  });

  // The tenth site is `reserve`'s own duplicate lookup, asserted by the three
  // rows in the block above - it is the site the whole finding is named for.
});

describe('GET /intents/:id at the store level', () => {
  // The ownership question became the LOOKUP. Before, the row came back by id
  // alone and the route compared its agent_id to the principal - which answers
  // `unknown_intent` for a caller's OWN intent whenever the other wallet's row
  // is the one the id finds.
  it('a wallet asking under its own id can only ever get its own row', () => {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 5n);
    put(s, BOB, ID, 99n);
    expect(s.intentRecord(ALICE, ID)?.agentId).toBe(ALICE);
    expect(s.intentRecord(BOB, ID)?.agentId).toBe(BOB);
    s.close();
  });

  it('platform scope gets the row when exactly one wallet used the id', () => {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 5n);
    expect(s.intentRecordUnambiguous(ID)?.agentId).toBe(ALICE);
    s.close();
  });

  // AMBIGUITY ANSWERS LIKE ABSENCE, and that is the disclosure decision rather
  // than an oversight: returning either row would pick one wallet's intent to
  // stand for both, and refusing DIFFERENTLY would make the reply an oracle for
  // the collision.
  it('platform scope gets nothing when two wallets used it, exactly as for an id nobody used', () => {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 5n);
    put(s, BOB, ID, 99n);
    expect(s.intentRecordUnambiguous(ID)).toBeNull();
    expect(s.intentRecordUnambiguous('never-used')).toBeNull();
    s.close();
  });
});


/// Turn a current store back into a V7-SHAPED one: `intents` keyed on the id
/// alone, everything else identical, stamped 7.
///
/// THE OLD DDL IS SPELLED OUT, and it has to be. `CREATE TABLE … AS SELECT`
/// copies rows and DROPS EVERY CONSTRAINT, so a fixture built that way has no
/// primary key at all - which is not v7, and which the step's guard correctly
/// declines to touch. Written first that way, and both migration rows below
/// failed for that reason rather than for anything about the migration.
///
/// A third copy of the columns, deliberately: this one describes a shape no
/// live code declares any more, which is exactly what a historical fixture is.
/// The schema-equality row below is what keeps the OTHER two honest.
function stampBackToV7(p: string): void {
  const db = new Database(p);
  db.exec(`
    CREATE TABLE intents_v7 (
      intent_id  TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      stage      TEXT NOT NULL,
      amount     TEXT NOT NULL,
      tx_hash    TEXT,
      held_wei   TEXT NOT NULL DEFAULT '0',
      topic      TEXT,
      emissions  INTEGER NOT NULL DEFAULT 0,
      first_tx   TEXT,
      first_from TEXT,
      reserved_at_block TEXT,
      id_source  TEXT,
      call_contract  TEXT,
      call_function  TEXT,
      call_args_hash TEXT,
      created_at INTEGER NOT NULL,
      token      TEXT
    );
    INSERT INTO intents_v7 SELECT intent_id, agent_id, stage, amount, tx_hash, held_wei, topic,
                                  emissions, first_tx, first_from, reserved_at_block, id_source,
                                  call_contract, call_function, call_args_hash, created_at, token
                             FROM intents;
    DROP TABLE intents;
    ALTER TABLE intents_v7 RENAME TO intents;
    PRAGMA user_version = 7;
  `);
  db.close();
}

describe('the v7 -> v8 rekey', () => {
  let dir: string;
  const path = () => join(dir, 'store.sqlite');
  const pk = (p: string): string[] => {
    const db = new Database(p);
    const rows = db.query(`PRAGMA table_info(intents)`).all() as { name: string; pk: number }[];
    db.close();
    return rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
  };
  const schemaOf = (p: string): string => {
    const db = new Database(p);
    const rows = db.query(`PRAGMA table_info(intents)`).all();
    db.close();
    return JSON.stringify(rows);
  };

  it('rekeys an existing store and keeps every row', () => {
    dir = mkdtempSync(join(tmpdir(), 'v8-'));
    // A v7 store, built by the real code path and then stamped back.
    const s = new Store(path());
    put(s, ALICE, ID, 5n);
    s.completeIntent(ALICE, ID, '0xalice');
    s.close();
    stampBackToV7(path());

    const after = new Store(path());
    expect(pk(path())).toEqual(['agent_id', 'intent_id']);
    // The row survived, with its hash - a migration that loses an intent turns
    // a completed transfer back into a spendable slot.
    expect(after.intentTxHash(ALICE, ID)).toBe('0xalice');
    // ...and the new key is live: bob may now use the same string.
    expect(put(after, BOB, ID, 99n).outcome).toBe('reserved');
    after.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // THE INDEX THE REBUILD DROPS. `DROP TABLE intents` takes `intents_topic`
  // with it, and `createIndexes()` used to run BEFORE the numbered loop - so
  // the index was built, dropped, and never rebuilt, leaving a topic lookup on
  // every emission unindexed until some later boot happened to recreate it.
  it('leaves intents_topic in place after the rebuild', () => {
    dir = mkdtempSync(join(tmpdir(), 'v8-'));
    const s = new Store(path());
    put(s, ALICE, ID, 5n);
    s.close();
    stampBackToV7(path());

    new Store(path()).close();
    const check = new Database(path());
    const idx = check.query(`SELECT name FROM sqlite_master WHERE type='index' AND name='intents_topic'`).all();
    check.close();
    expect(idx).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  // THE SECOND AUTHORITY, MADE SAFE. The step RETYPES the table's DDL, as the
  // v5 and v7 steps do, because sqlite cannot change a primary key in place.
  // Two declarations of one table is exactly the shape that drifts - so this
  // compares them. It caught two mistakes while being written: the step had
  // `reserved_at_block INTEGER` (it is TEXT) and put `token` in the middle (a
  // fresh store has it LAST, because it is an additive column).
  it('produces the same intents schema a fresh store has', () => {
    dir = mkdtempSync(join(tmpdir(), 'v8-'));
    const fresh = join(dir, 'fresh.sqlite');
    new Store(fresh).close();

    const migrated = join(dir, 'migrated.sqlite');
    const s = new Store(migrated);
    put(s, ALICE, ID, 5n);
    s.close();
    stampBackToV7(migrated);
    new Store(migrated).close();

    expect(schemaOf(migrated)).toBe(schemaOf(fresh));
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a store already keyed on both coordinates alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'v8-'));
    const s = new Store(path());
    put(s, ALICE, ID, 5n);
    s.close();
    expect(pk(path())).toEqual(['agent_id', 'intent_id']);
    new Store(path()).close();
    expect(pk(path())).toEqual(['agent_id', 'intent_id']);
    const db = new Database(path());
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    db.close();
    expect(v).toBe(SCHEMA_VERSION);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── PART TWO: the topic, and the paths that emit one ────────────────────────

describe('the topic is namespaced by the wallet too', () => {
  // A SEPARATOR WOULD COLLIDE, and the collision is reachable rather than
  // theoretical: admin-call reserves under the literal `platform`, and
  // `platform` is a valid org label. With `agent + ':' + id`, the pair
  // (`platform`, `alice:job-1`) and the pair (`platform:alice`, `job-1`) have
  // ONE preimage and therefore one topic - so an operator's admin-call and a
  // wallet's send would merge emissions and raise a false double-spend alarm,
  // or mask a real one. Hashing each coordinate to a fixed 32 bytes first makes
  // the concatenation unambiguous whatever either one contains.
  it('the construction that a separator would collide on gives two topics', () => {
    expect(intentTopic('platform', 'alice:job-1')).not.toBe(intentTopic('platform:alice', 'job-1'));
  });

  it('two wallets with one id string get two topics', () => {
    expect(intentTopic(ALICE, ID)).not.toBe(intentTopic(BOB, ID));
  });

  it('is stable for one pair, because the store joins emissions on it', () => {
    expect(intentTopic(ALICE, ID)).toBe(intentTopic(ALICE, ID));
  });

  // Two wallets, one id string, one emission each: two intents, one emission
  // apiece, and no anomaly. Under a shared topic the second emission counted
  // against the first intent and raised one.
  // `recordEmission` answers whether THIS emission makes the intent ANOMALOUS,
  // so null is the healthy answer and the counts are read off the rows. Written
  // the other way round first, asserting the returned record - which would have
  // been a test of a contract this function does not have.
  it('an emission lands on the wallet that reserved it, and raises no anomaly', () => {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 5n, { topic: intentTopic(ALICE, ID) });
    put(s, BOB, ID, 99n, { topic: intentTopic(BOB, ID) });

    expect(
      s.recordEmission({ topic: intentTopic(ALICE, ID), txHash: '0xa', from: '0xaaa', isExpectedEmitter: true }),
    ).toBeNull();
    expect(
      s.recordEmission({ topic: intentTopic(BOB, ID), txHash: '0xb', from: '0xbbb', isExpectedEmitter: true }),
    ).toBeNull();

    // ONE EACH, which is the fact a shared topic destroyed: both emissions
    // counted against whichever intent the topic found, so one intent read two
    // and raised a false double-spend while the other read none.
    expect(s.intentRecord(ALICE, ID)?.emissions).toBe(1);
    expect(s.intentRecord(BOB, ID)?.emissions).toBe(1);
    expect(s.intentRecord(ALICE, ID)?.firstTx).toBe('0xa');
    expect(s.intentRecord(BOB, ID)?.firstTx).toBe('0xb');
    s.close();
  });

  // THE CONTROL ON THAT ROW. Both wallets under ONE topic - which is what the
  // old derivation produced - and the second emission is an anomaly against the
  // first wallet's intent while the second's stays at zero.
  it('control: sharing a topic is exactly the failure, so the row above can fail', () => {
    const s = new Store(':memory:');
    const shared = intentTopic(ALICE, ID);
    put(s, ALICE, ID, 5n, { topic: shared });
    put(s, BOB, ID, 99n, { topic: shared });

    expect(s.recordEmission({ topic: shared, txHash: '0xa', from: '0xaaa', isExpectedEmitter: true })).toBeNull();
    const second = s.recordEmission({ topic: shared, txHash: '0xb', from: '0xbbb', isExpectedEmitter: true });
    expect(second).not.toBeNull();
    expect(second?.emissions).toBe(2);
    s.close();
  });
});

describe('a broadcast puts the row\'s topic on chain, never a fresh derivation', () => {
  // THE MIXED STORE IS THE POINT. Rows written before v8 carry
  // keccak256(intent_id); rows written after carry the hash of both. A
  // broadcast that re-derived would emit the NEW form for an OLD row, the
  // emission would match nothing, `recordEmission` would answer as for an
  // intent this store never reserved, and the transfer would really have
  // happened while the intent sat unresolved for ever.
  it('reads a pre-v8 topic back unchanged', () => {
    const s = new Store(':memory:');
    const legacy = ('0x' + '11'.repeat(32)) as `0x${string}`;
    put(s, ALICE, ID, 5n, { topic: legacy });
    expect(s.intentTopicOf(ALICE, ID)).toBe(legacy);
    // ...and it is NOT what today's derivation would produce, so the row is
    // doing the work rather than the two happening to agree.
    expect(s.intentTopicOf(ALICE, ID)).not.toBe(intentTopic(ALICE, ID));
    s.close();
  });

  it('answers null for a reservation that is not there, rather than a derivation', () => {
    const s = new Store(':memory:');
    expect(s.intentTopicOf(ALICE, 'never-reserved')).toBeNull();
    s.close();
  });
});

// FINDING 12: a held intent whose row does not name a currency is not
// releasable, and the check has to run BEFORE the delete.
describe('release will not free an id whose hold it cannot give back', () => {
  /// A row with a hold and a NULL token - the shape a pre-v7 backfill could
  /// leave behind, which the migration now refuses to produce. Written straight
  /// to the table because `reserve` cannot express it any more, which is the
  /// point: this guards a state the code says cannot exist, and the cost of
  /// being wrong about that is a silent permanent debit.
  function heldWithNoToken(): Store {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 100n);
    const db = (s as unknown as { db: Database }).db;
    db.query(`UPDATE intents SET token = NULL, held_wei = ? WHERE agent_id = ? AND intent_id = ?`)
      .run('100', ALICE, ID);
    return s;
  }

  it('leaves the reservation standing rather than freeing the id', () => {
    const s = heldWithNoToken();
    s.release(ALICE, ID);
    // THE ID IS STILL TAKEN. Before, the DELETE ran first and the refund then
    // declined - correctly - to give back a hold in a currency the row does not
    // name. So the wallet lost the budget permanently AND the id became
    // reusable, which is the worse half.
    expect(put(s, ALICE, ID, 100n).outcome).toBe('duplicate');
    s.close();
  });

  it('control: an ordinary held intent IS released, so the row above can fail', () => {
    const s = new Store(':memory:');
    put(s, ALICE, ID, 100n);
    s.release(ALICE, ID);
    expect(put(s, ALICE, ID, 100n).outcome).toBe('reserved');
    s.close();
  });
});
