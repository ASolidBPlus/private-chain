// Schema migration for the chain-svc store.
//
// WHY THIS EXISTS, and it is not a convenience. Before it, the store's schema
// was ten `CREATE TABLE IF NOT EXISTS` statements and nothing else: no
// `user_version`, no `ALTER TABLE`. IF NOT EXISTS creates a table that is
// absent and is silent about one that is present but SHAPED DIFFERENTLY, so a
// release that added a column started fine against a fresh volume and died on
// a persisted one - at the first query to name the column, with
// `no such column: topic`, long after startup succeeded.
//
// THE COST OF THAT WAS NOT AN OUTAGE. `intents` is the idempotency ledger: the
// reservation is what makes a same-id retry answer `duplicate` instead of
// sending a second transfer. The only remedy for the dead container was to
// destroy the volume, and destroying it makes EVERY CONSUMED INTENT ID
// RESERVABLE AGAIN - against wallets whose keys survive on the keystore volume
// and whose balances survive on the chain's. So a missing migration was a
// double-spend path wearing an ops costume, and the error message was the part
// that chose the destructive remedy: it named the store, so the proportionate
// response was to delete the store and nothing else.
//
// THE RULE THIS ENCODES: a program that meets a state it was not built for
// REFUSES BY NAME AT THE BOUNDARY. It does not proceed and fail obscurely
// later. This is the same discipline as `assert old in s` in a mutation script
// - a rewrite that cannot find its anchor must stop rather than produce a file
// nobody asked for - applied one layer up, to a store whose shape this binary
// does not recognise. It is a designed refusal, not a defensive nicety, and it
// should not be relaxed for convenience: widening the check to "carry on and
// hope" restores exactly the failure it exists to prevent.

import type { Database } from 'bun:sqlite';

/// Bumped whenever the schema changes. A store stamped HIGHER than this was
/// written by a newer binary and is refused - see `migrate`.
export const SCHEMA_VERSION = 8;

export class SchemaError extends Error {
  constructor(
    readonly code: 'store_schema_ahead' | 'store_schema_unmigratable',
    message: string,
  ) {
    super(message);
    this.name = 'SchemaError';
  }
}

/// The columns present in the FIRST shipped schema, before `user_version`
/// existed. FROZEN - never add to this list. A column that has always been
/// there needs no migration; a column added from now on is an ADDITIVE entry,
/// and putting it here instead would claim a history it does not have and
/// break exactly the upgrade this module exists to make work.
const ORIGINAL_COLUMNS: ReadonlyArray<[string, string]> = [
  ['cursors', 'name'], ['cursors', 'value'],
  ['frozen', 'agent_id'], ['frozen', 'frozen_at'],
  ['intent_anomalies', 'topic'], ['intent_anomalies', 'tx_hash'],
  ['intent_anomalies', 'from_addr'], ['intent_anomalies', 'seen_at'],
  ['intents', 'intent_id'], ['intents', 'agent_id'], ['intents', 'stage'],
  ['intents', 'amount'], ['intents', 'tx_hash'], ['intents', 'created_at'],
  ['memos', 'tx_hash'], ['memos', 'memo'], ['memos', 'created_at'],
  ['outbox', 'id'], ['outbox', 'kind'], ['outbox', 'payload'],
  ['outbox', 'attempts'], ['outbox', 'next_attempt_at'], ['outbox', 'created_at'],
  ['spawns', 'agent_id'], ['spawns', 'address'], ['spawns', 'created_at'],
  ['stage_spend', 'agent_id'], ['stage_spend', 'stage'], ['stage_spend', 'spent'],
  ['stage_state', 'id'], ['stage_state', 'stage'],
  ['wallet_tokens', 'agent_id'], ['wallet_tokens', 'token_hash'], ['wallet_tokens', 'issued_at'],
];

/// Every column added after the first schema, with the DDL to add it.
///
/// SQLite's `ALTER TABLE ADD COLUMN` cannot add a PRIMARY KEY or a UNIQUE
/// column, and a NOT NULL column must carry a DEFAULT - a constraint that is
/// the reason to keep migrations ADDITIVE rather than rewriting tables. Every
/// entry here is checked against the live schema by a test, so a column added
/// to the DDL without an entry fails the suite rather than a customer's
/// upgrade.
export const ADDITIVE_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'intents', column: 'held_wei', ddl: `TEXT NOT NULL DEFAULT '0'` },
  { table: 'intents', column: 'topic', ddl: 'TEXT' },
  { table: 'intents', column: 'emissions', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'intents', column: 'first_tx', ddl: 'TEXT' },
  { table: 'intents', column: 'first_from', ddl: 'TEXT' },
  { table: 'intents', column: 'reserved_at_block', ddl: 'TEXT' },
  { table: 'intents', column: 'id_source', ddl: 'TEXT' },
  { table: 'memos', column: 'intent_id', ddl: 'TEXT' },
  { table: 'memos', column: 'from_agent_id', ddl: 'TEXT' },
  // v2, §5: how many colon-less `to` values this wallet has sent that were not
  // exactly registered names. NOT NULL DEFAULT 0 so an existing wallet starts
  // at zero rather than null - a null counter would have to be treated as
  // "unknown", and the detector's whole job is to be readable at a glance.
  { table: 'spawns', column: 'bare_id_count', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  // v4, §4: the wallet kind that was ENFORCED at spawn.
  //
  // ⛔ NULLABLE, NO DEFAULT, AND `null` MUST STAY `null`. DO NOT BACKFILL THESE
  // FROM CAPS - not now, not as a tidy-up, not when the column looks
  // half-finished. Three reasons, and all three have to be wrong before a
  // backfill is safe:
  //
  //   1. STRUCTURAL. `org` and `agent` take the IDENTICAL branch in
  //      `spawn.ts` (`if (kind !== 'burner')`), so the registry cannot
  //      separate them by construction - no caller, no config, no exception.
  //   2. CONFIGURATION-DEPENDENT. The caps route works only while
  //      `policy-defaults.json` keeps two kinds' defaults distinct, and that
  //      file is operator-tunable game balance. If the owner tunes `org` and
  //      `agent` to coincide - a plausible balance decision, no code change -
  //      the inference dies silently, everywhere at once, and no test fails.
  //   3. COLLISION. Even while they differ, a supplied policy is a PATCH over
  //      the kind defaults (`mergePolicy`), so an override can coincide with
  //      another kind's default and the inference goes ACTIVELY WRONG rather
  //      than absent - an org reading as an agent, permanently, in the one
  //      column that exists to be believed.
  //
  // `parseKind` returns 'agent' for a missing value, so `NOT NULL DEFAULT
  // 'agent'` would be NEARLY right - which is exactly what makes it dangerous.
  // It would convert "we did not record this" into "this was an agent",
  // indistinguishable from a measurement, for every row that predates the
  // column. A consumer reading `null` learns the true thing: this wallet was
  // spawned before chain-svc recorded kinds.
  //
  // The deferred detection work that wants this column can check whether the
  // ambiguity is behind it with one query, per store, at USE rather than once:
  //     SELECT COUNT(*) FROM spawns WHERE kind IS NULL;      -- zero => available
  // Zero today does not stay zero: a store restored from an old backup
  // reintroduces null rows.
  { table: 'spawns', column: 'kind', ddl: 'TEXT' },

  // v6, §3.2.7: WHAT THIS INTENT WAS RESERVED FOR, durably and readably.
  //
  // NULLABLE WITH NO DEFAULT, and the three travel together. Null is the TRUE
  // value for a sign-transfer or fund intent - it was not a call - and also for
  // every intent written before v6, and a default would collapse "this was not
  // a call" and "we did not record it" into one answer. The same rule the
  // `kind` column above is written under.
  //
  // They are not decoration. Two things read them: the replay check, which
  // compares a repeated intent id against the call it was first reserved for
  // (a replay with different arguments is invalid_request, not a duplicate),
  // and `release`, which finds the call_counts row to give back FROM THE
  // INTENT'S OWN ROW rather than from what the caller remembers - the shape
  // `release(intentId)` already has for the stage hold.
  { table: 'intents', column: 'call_contract', ddl: 'TEXT' },
  { table: 'intents', column: 'call_function', ddl: 'TEXT' },
  { table: 'intents', column: 'call_args_hash', ddl: 'TEXT' },

  // v7, §2: WHICH TOKEN this intent moved.
  //
  // ADDITIVE AND BACKFILLED BY A NUMBERED STEP, which is the first pairing of
  // the two mechanisms and worth naming. The column is additive because adding
  // it needs no reshape; the BACKFILL is numbered because the value to fill it
  // with is not a constant - it is the deployment's default token key, read
  // from the deployment row at migration time - and an ADDITIVE_COLUMNS entry
  // carries a static DDL literal that cannot express that.
  //
  // Nullable for the same reason as every other additive column: ALTER TABLE
  // cannot add NOT NULL without a default, and a default here would be a
  // token name invented for rows written before tokens were named.
  { table: 'intents', column: 'token', ddl: 'TEXT' },
];

/// Columns that arrived with a TABLE created after the first schema.
///
/// A third bucket rather than a stretch of either existing one, because both
/// would have been a lie. ORIGINAL_COLUMNS is frozen and claims the column was
/// there from the start; ADDITIVE_COLUMNS carries the DDL to ALTER a column IN,
/// and `deployment.id` is a PRIMARY KEY, which ALTER TABLE cannot add at all -
/// so its entry there would be a statement that is false and, if the
/// reconciliation ever reached it, would fail.
///
/// It never does reach these: the reconciliation only visits tables that
/// already exist, and `createTables` makes a new table complete. So these need
/// no DDL - they need only to be CLASSIFIED, so the exhaustiveness test stays
/// exhaustive without anyone having to lie to it.
const NEW_TABLE_COLUMNS: ReadonlyArray<[string, string]> = [
  // v3, §4: which chain this store belongs to.
  ['deployment', 'id'],
  ['deployment', 'chain_id'],
  // v5: the two address columns became one JSON list. Named here, not in
  // ORIGINAL_COLUMNS, because `deployment` arrived at v3 and this shape at v5.
  ['deployment', 'modules_json'],
  ['deployment', 'recorded_at'],
  // v6, §3.2.7: per-entry call counting, one row per (wallet, stage, contract,
  // function). A NEW TABLE, so it arrives complete from `createTables` and
  // needs classifying rather than ALTERing - `count` has a NOT NULL default and
  // the primary key is composite, which ALTER TABLE cannot add.
  ['call_counts', 'agent_id'],
  ['call_counts', 'stage'],
  ['call_counts', 'contract'],
  ['call_counts', 'function'],
  ['call_counts', 'count'],
  // v7: stage_spend's primary key gains `token`. Classified here rather than in
  // ORIGINAL_COLUMNS because the column did not exist in the first schema, and
  // not in ADDITIVE_COLUMNS because ALTER TABLE cannot add a PRIMARY KEY
  // component - the numbered step recreates the table, so `createTables` makes
  // it complete on a fresh store and the reconciliation never visits it.
  ['stage_spend', 'token'],
  // FINDING 22: the ledger watermark's store half. A NEW TABLE, so it arrives
  // complete from `createTables` and is classified here rather than ALTERed -
  // `reservations` has a NOT NULL default and `id` is a primary key with a
  // CHECK, neither of which ALTER TABLE can add.
  //
  // NO NUMBERED STEP AND NO VERSION BUMP: an existing store gets the table
  // empty, the seed row sets the counter to 0, and the keystore has no
  // watermark yet - so the first boot after this ships ESTABLISHES the mark
  // rather than accusing anyone on a history the store never recorded.
  ['ledger_facts', 'id'],
  ['ledger_facts', 'reservations'],
];

export function classifiedColumns(): Set<string> {
  const all = new Set(
    [...ORIGINAL_COLUMNS, ...NEW_TABLE_COLUMNS].map(([t, c]) => `${t}.${c}`),
  );
  for (const a of ADDITIVE_COLUMNS) all.add(`${a.table}.${a.column}`);
  return all;
}

function tableExists(db: Database, table: string): boolean {
  return (
    db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table) !== null
  );
}

function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/// The PRIMARY KEY columns of a table, in key order.
///
/// `pk` in `table_info` is 0 for a non-key column and 1..n for the position
/// within a composite key, so this distinguishes `PRIMARY KEY (intent_id)` from
/// `PRIMARY KEY (agent_id, intent_id)` - which `columnsOf` cannot, both having
/// exactly the same columns. The v8 step turns on the KEY and not on a column,
/// so it needs a guard that can see one.
function primaryKeyOf(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  return rows
    .filter((r) => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name);
}

/// Applied AFTER the `CREATE TABLE IF NOT EXISTS` block, so a wholly-missing
/// table is already created at its current shape and only PRE-EXISTING tables
/// need reconciling.
/// `createSchema` is the `CREATE TABLE IF NOT EXISTS` block, taken as a thunk
/// rather than run by the caller beforehand, so that the ahead-check below
/// PROVABLY precedes every write to the file. A caller cannot get the order
/// wrong, because the order is not theirs to choose.
/// The first numbered migration. Everything before v5 was additive - new tables
/// and nullable columns - which `createTables()` and ADDITIVE_COLUMNS handle
/// between them. Reshaping a table is neither.
///
/// THE BACKFILL IS TOTAL AND THAT IS PROVABLE, not hopeful: every v4 store was
/// written by a chain-svc whose deployment row had exactly one token and one
/// registry, because that was the only shape that existed. So the two columns
/// map onto the two-entry list with no case left over and no data invented -
/// the key `vee` is the only key a v4 store could have meant.
const NUMBERED: ReadonlyArray<{
  to: number;
  /// WHETHER THE OLD SHAPE IS ACTUALLY THERE, not whether the version number
  /// suggests it should be. A fresh store is created by `createTables()` at the
  /// CURRENT shape and stamped 0 until the end of this function, so a guard of
  /// `version < to` fires this entry against a table that never had the column
  /// it reads - measured, `no such column: veebux`, on every fresh store.
  ///
  /// The version tells you what a store was WRITTEN BY. The schema tells you
  /// what it HAS. A reshaping migration needs the second.
  applies: (db: Database) => boolean;
  up: (db: Database) => void;
}> = [
  {
    to: 5,
    applies: (db) => tableExists(db, 'deployment') && columnsOf(db, 'deployment').has('veebux'),
    up: (db) => {
      db.exec(`
        CREATE TABLE deployment_v5 (
          id             INTEGER PRIMARY KEY CHECK (id = 1),
          chain_id       TEXT NOT NULL,
          modules_json   TEXT NOT NULL,
          recorded_at    INTEGER NOT NULL
        );
        INSERT INTO deployment_v5 (id, chain_id, modules_json, recorded_at)
          SELECT id,
                 chain_id,
                 json_array(
                   json_object('kind', 'token', 'key', 'vee', 'address', veebux),
                   json_object('kind', 'names', 'address', name_registry)
                 ),
                 recorded_at
            FROM deployment;
        DROP TABLE deployment;
        ALTER TABLE deployment_v5 RENAME TO deployment;
        PRAGMA user_version = 5;
      `);
    },
  },
  {
    to: 7,
    // GUARDED ON THE SCHEMA, never the version. A fresh store is created by
    // createTables() at the CURRENT shape and stamped 0 until the end of
    // `migrate`, so `version < 7` would fire this against a stage_spend that
    // already has the new key - which is how the v5 entry failed before it was
    // written this way, with `no such column: veebux` on every fresh store.
    applies: (db) => tableExists(db, 'stage_spend') && !columnsOf(db, 'stage_spend').has('token'),
    up: (db) => {
      // THE DEFAULT TOKEN IS READ, NEVER ASSUMED. It is the first token in
      // manifest order, which is the same rule every other consumer uses - and
      // it lives in the deployment row this store already carries.
      const row = db
        .query(`SELECT modules_json FROM deployment WHERE id = 1`)
        .get() as { modules_json: string } | null;
      const modules = row ? (JSON.parse(row.modules_json) as Array<Record<string, unknown>>) : [];
      const defaultKey = modules.find((m) => m.kind === 'token')?.key as string | undefined;

      if (defaultKey === undefined) {
        // REFUSES BY NAME RATHER THAN WRITING NULL INTO A PRIMARY KEY. A null
        // there produces rows no query naming a token can read back - a
        // corruption that reports itself as "no spend recorded", which reads as
        // a wallet with budget left. A store with spend to migrate and no
        // deployment row is a store whose history cannot be interpreted, and
        // that is an operator's decision, not this function's.
        throw new SchemaError(
          'store_schema_unmigratable',
          `store schema v6 -> v7 needs the deployment's default token to say which token ` +
            `the recorded spend was in, and this store has no deployment row to read it from. ` +
            `A store that has never seen a deployment has nothing to migrate: start chain-svc ` +
            `against its chain once, or restore a store from after its first boot. ` +
            `DO NOT delete the store volume: ${LEDGER_RESET_NOTICE}`,
        );
      }

      // FINDING 5: THE KEY IS BOUND, NEVER INTERPOLATED.
      //
      // It went in through `JSON.stringify` into a `db.exec` string. A token key
      // is operator input - it comes off the manifest - and JSON quoting is not
      // SQL quoting: JSON escapes a quote as \" where SQL wants ''.
      //
      // NOT EXPLOITABLE TODAY, and that is exactly the reason to change it.
      // `MANIFEST_KEY` is `^[a-z][a-z0-9]{0,15}$`, so a key cannot contain a
      // quote and the two spellings never part company. The interpolation is
      // therefore safe BECAUSE OF A RULE IN ANOTHER FILE - and it is the sort of
      // rule that gets widened (a key with a dash, a key with a dot) by someone
      // who has no reason to know a migration's string concatenation depends on
      // it. Binding removes the coupling rather than the symptom.
      //
      // `db.exec` cannot take parameters, so the statements are split: the DDL
      // and the drops stay in `exec`, and the two that carry the key become
      // prepared statements. SAME TRANSACTION - the caller wraps every numbered
      // step in one - so a crash between them leaves the store at v6 rather
      // than half rekeyed.
      db.exec(`
        CREATE TABLE stage_spend_v7 (
          agent_id TEXT NOT NULL,
          stage    TEXT NOT NULL,
          token    TEXT NOT NULL,
          spent    TEXT NOT NULL,
          PRIMARY KEY (agent_id, stage, token)
        );
      `);
      db.query(
        `INSERT INTO stage_spend_v7 (agent_id, stage, token, spent)
           SELECT agent_id, stage, ?, spent FROM stage_spend`,
      ).run(defaultKey);
      db.exec(`
        DROP TABLE stage_spend;
        ALTER TABLE stage_spend_v7 RENAME TO stage_spend;
      `);
      db.query(`UPDATE intents SET token = ? WHERE token IS NULL`).run(defaultKey);
      db.exec(`PRAGMA user_version = 7;`);
    },
  },
  {
    to: 8,
    // GUARDED ON THE KEY, not on a column and not on the version: the columns
    // are identical either side of this step, so `columnsOf` cannot tell them
    // apart, and a fresh store is created at the CURRENT shape and stamped 0
    // until the end of `migrate`.
    applies: (db) =>
      tableExists(db, 'intents') && primaryKeyOf(db, 'intents').join(',') === 'intent_id',
    up: (db) => {
      // THE KEY GAINS THE WALLET (finding 1). An intent id is a string the
      // CALLER chooses, so a globally unique key made one wallet's choice
      // collide with another's: bob reserving an id alice had used got back
      // ALICE's txHash, moved no money, and was told he had succeeded.
      //
      // A REBUILD rather than an ALTER, because sqlite cannot change a primary
      // key in place. Every column is carried across by name - no `SELECT *`,
      // which would silently reorder if the table's column order ever differs
      // from this list, and pair each value with the wrong column.
      //
      // NO DEDUPLICATION AND NONE POSSIBLE. Under the old key an id was unique
      // across the store, so there are no colliding rows to resolve: every
      // existing row moves unchanged and keeps its meaning. This migration
      // cannot lose an intent, and that is a property of the OLD key rather
      // than of the copy.
      //
      // The rows' `topic` is carried as it stands - keccak256(intent_id) for
      // everything written before v8. Broadcast reads the topic FROM THE ROW,
      // so a pre-v8 intent keeps working with no special case, and only intents
      // reserved from here on get the wallet-namespaced form.
      db.exec(`
        CREATE TABLE intents_v8 (
          intent_id  TEXT NOT NULL,
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
          -- LAST, because that is where a FRESH store has it: token is not in
          -- the declared DDL at all, it is an ADDITIVE column (v7), appended by
          -- the reconciliation that runs before this loop. Declaring it here in
          -- its alphabetical or logical place would give a migrated store a
          -- different column ORDER from a fresh one - invisible to every query,
          -- and exactly the drift the schema-equality test exists to catch.
          -- reserved_at_block is TEXT for the same reason: measured off a live
          -- table, not inferred from the name.
          token      TEXT,
          PRIMARY KEY (agent_id, intent_id)
        );
        INSERT INTO intents_v8 (intent_id, agent_id, stage, amount, tx_hash, held_wei, topic,
                                emissions, first_tx, first_from, reserved_at_block, id_source,
                                call_contract, call_function, call_args_hash, created_at, token)
          SELECT intent_id, agent_id, stage, amount, tx_hash, held_wei, topic,
                 emissions, first_tx, first_from, reserved_at_block, id_source,
                 call_contract, call_function, call_args_hash, created_at, token
            FROM intents;
        DROP TABLE intents;
        ALTER TABLE intents_v8 RENAME TO intents;
        PRAGMA user_version = 8;
      `);
      // `intents_topic` WENT WITH THE DROP, and this step does not rebuild it:
      // `createIndexes()` does, and it is called AFTER this loop for exactly
      // this reason (see `migrate`). Recreating it here would be a second place
      // that has to agree with the index list.
    },
  },
];

export function migrate(
  db: Database,
  createTables: () => void,
  createIndexes: () => void,
): void {
  // FINDING 13: ONE WRITER AT A TIME, AND THE OTHER WAITS FOR A FINISHED STORE.
  //
  // `BEGIN IMMEDIATE` takes the write lock at the START of the transaction
  // rather than at the first write. The difference is the whole fix: with a
  // deferred transaction both processes read `user_version` as 6, both decide
  // to migrate, and the second discovers the conflict half way through its own
  // rewrite. With an immediate one the second process blocks on the lock (for
  // `busy_timeout`, set in the Store constructor), and when it gets in it reads
  // a version the first process already stamped - so it finds nothing to do.
  //
  // The whole of migrate() is inside it, INCLUDING the reads, because the read
  // that must not be stale is `user_version` itself.
  db.exec('BEGIN IMMEDIATE');
  try {
    migrateInTransaction(db, createTables, createIndexes);
    db.exec('COMMIT');
  } catch (err) {
    // A ROLLBACK THAT ITSELF THROWS MUST NOT REPLACE THE REAL ERROR. The
    // interesting failure is the one that got us here - a schema refusal names
    // what an operator has to do - and "cannot rollback, no transaction is
    // active" would bury it.
    try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw err;
  }
}

function migrateInTransaction(
  db: Database,
  createTables: () => void,
  createIndexes: () => void,
): void {
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;

  // Checked FIRST, before any write. An older binary against a newer store must
  // not create, alter or stamp anything on its way to discovering it cannot
  // read it - that is how a rollback corrupts quietly.
  if (version > SCHEMA_VERSION) {
    throw new SchemaError(
      'store_schema_ahead',
      `store schema v${version}, this binary expects v${SCHEMA_VERSION}. The store was ` +
        `written by a NEWER chain-svc; this one cannot read it. Run the newer binary, or ` +
        `restore a store from before the upgrade. DO NOT delete the store volume: ` +
        `${LEDGER_RESET_NOTICE}`,
    );
  }

  // Creates whatever is wholly absent - a fresh store, or a table added by a
  // later release - at its current shape. Only PRE-EXISTING tables can then be
  // the wrong shape, which is what the reconciliation below is for.
  createTables();

  // VERSION 0 IS AMBIGUOUS AND MUST NOT BE TREATED AS "THE ORIGINAL SCHEMA".
  // Every store that predates this module is stamped 0, whatever shape it is
  // in: `CREATE TABLE IF NOT EXISTS` silently varied with the code version and
  // recorded nothing, so a v0 store may already have `topic` or may not,
  // depending only on which build first created its volume. A numbered
  // migration assuming v0 means pre-topic would fail on half of them. So the
  // baseline INTROSPECTS and adds what is absent, rather than replaying a
  // history the store never recorded.
  //
  // AND IT RUNS FOR EVERY VERSION BELOW CURRENT, not only for 0. The first
  // schema change after this module shipped (§5's bare-id counter) showed why:
  // with the reconciliation gated on `version === 0`, a store already stamped
  // v1 would skip it and need a NUMBERED migration to add the same column the
  // baseline adds - two mechanisms that must agree about one list of columns,
  // which is the shape that put four copies of the wallet-kind list in this
  // codebase. Introspection is idempotent and additive-only, so running it at
  // every upgrade is correct for a store of ANY age and there is nothing for
  // the two paths to disagree about.
  if (version < SCHEMA_VERSION) {
    for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
      if (!tableExists(db, table)) continue;
      if (columnsOf(db, table).has(column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  // NUMBERED MIGRATIONS, applied in order for a store stamped BELOW each
  // entry's `to`. They run after createTables() and after the additive
  // reconciliation, so an entry can assume every table exists and every
  // additive column is present.
  //
  // Each stamps its own version as its last statement. The TRANSACTION is the
  // outer one now (finding 13), so a crash leaves the store at the version it
  // started from rather than at the last completed step - equally consistent,
  // and it resumes because the steps are guarded on the schema.
  for (const step of NUMBERED) {
    if (version >= step.to) continue;
    if (!step.applies(db)) continue;
    // NOT `db.transaction(...)` ANY MORE: the whole of `migrate` is already
    // inside one (see above), and sqlite has no nested transactions - bun's
    // wrapper would issue a SAVEPOINT at best and a second BEGIN at worst.
    //
    // The per-step atomicity it provided is now the outer transaction's. Not
    // stronger, and not weaker: a crash used to leave the store at the last
    // COMPLETED step and now leaves it at the version it started from. Both are
    // consistent states and both resume correctly on the next boot, because
    // every step is guarded on the SCHEMA rather than on the version - so
    // redoing the ones that already applied is a no-op.
    step.up(db);
  }

  // AFTER EVERYTHING, and the position moved at v8 rather than being tidied.
  //
  // It has always had to run after the additive reconciliation: `intents_topic`
  // indexes `topic`, a column the baseline may have just added, and creating it
  // alongside the tables made the migration die on the very store it exists to
  // repair with `no such column: topic`. That reason still holds.
  //
  // What v8 adds is the other end. A numbered step that REBUILDS a table drops
  // every index on it - `DROP TABLE intents` takes `intents_topic` with it - so
  // an index built before the loop is gone by the time the loop finishes, and
  // the store runs unindexed until some later boot happens to rebuild it. Here
  // that is a topic lookup on every emission.
  //
  // So: after the columns are settled AND after the tables are their final
  // shape. The thunk is `CREATE INDEX IF NOT EXISTS`, so it is a no-op on the
  // stores that never entered the loop.
  createIndexes();

  if (version !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/// THE SENTENCE. Every path that destroys the svc store prints exactly this -
/// the CLI wrappers, the harness UI's Reset log, and the refusals in this module
/// - so that what a wipe costs is stated in one place and cannot drift between
/// them into three descriptions of different severities.
///
/// IT NAMES BOTH COSTS, and that is load-bearing rather than thorough. It said
/// only the idempotency half first, on the reasoning that an acknowledged reset
/// is the fresh-game case where releasing the locks is intended. That reasoning
/// was wrong: the acknowledged reset is ALSO the path a facilitator takes to
/// recover from a failure mid-game - which is exactly when the lock is
/// load-bearing. AN ACKNOWLEDGEMENT THAT NAMES HALF THE DESTRUCTION IS NOT
/// INFORMED CONSENT.
///
/// SAYS RETIRED, NOT FROZEN, as of v0.8.0. The table is the same table and this
/// wipe destroys the same rows; what changed is that only `retire()` writes it
/// now, so "every frozen wallet may spend again" named a state nothing sets.
/// Freezing a LIVE wallet is the Token contract's and is not in this store at
/// all - a wipe cannot release one, and prose that implied it could would
/// overstate the damage in the same breath as understating it.
///
/// It names CONSEQUENCES, never actions. "Resets the ledger" reads as
/// housekeeping; "becomes reservable again" is the thing an operator has to
/// weigh. Do not soften either clause, and do not use half of it.
///
/// ONE COMPLETE CONSTANT RATHER THAN TWO CO-EQUAL ONES, deliberately. Splitting
/// it into a ledger sentence and a freeze sentence that every path must print
/// TOGETHER reintroduces the exact failure the single string exists to prevent:
/// a path that prints one of them understates the cost, and nothing catches it.
/// The nuance that wanted its own constant is advice for AFTER the wipe, not a
/// second half of the consent, so it lives in FREEZE_RECOVERY_ADVICE below -
/// additive, and its absence understates nothing.
export const LEDGER_RESET_NOTICE =
  'this deletes the idempotency ledger and every retirement: every consumed intent id ' +
  'becomes reservable again, and every retired wallet may spend again. An on-chain ' +
  'freeze is not in this store and survives the wipe';

/// The state of the three volumes that share one lifetime, as observed at
/// startup. Taken as plain facts rather than read in here, so the decision is
/// testable without a keystore directory, a chain or a store on disk.
export interface LifetimeFacts {
  /// The intents table has no rows: no intent id has ever been consumed, or
  /// none is remembered any more.
  intentsEmpty: boolean;
  /// How many wallets THIS STORE remembers spawning. The fact that separates a
  /// wiped store from a live game that has simply not spent yet - the two
  /// states `intentsEmpty` alone cannot tell apart, because a game's intents
  /// table is empty until its first transfer and stays empty across every
  /// restart until then.
  ///
  /// 0 is the RESTRICTIVE value here, not the permissive one, which is the
  /// opposite of `keystoreAgents` - so an error that produced a zero would fail
  /// closed. It still is not caught: the read is unwrapped like its siblings.
  storeWallets: number;
  /// How many agents the KEYSTORE holds keys for. Its own volume, untouched by
  /// a store-only wipe.
  keystoreAgents: number;
  /// Whether the chain this service is pointed at has the game's contracts on
  /// it. Its own volume too (anvil `--state`), so it also survives.
  contractsDeployed: boolean;
  /// The operator has stated they intend to end the game's idempotency
  /// lifetime. The one legitimate reason for this state to exist.
  acknowledged: boolean;
  /// FINDING 22. Every intent this STORE has ever reserved, monotonically -
  /// never how many exist, because `release` deletes rows.
  reservations: number;
  /// The highest value the KEYSTORE has seen that counter reach, or NULL when
  /// it has never recorded one. A different volume, which is the only thing
  /// that makes the comparison mean anything: a restored store brings its own
  /// counter back with it, and cannot bring this one.
  ///
  /// Null and zero are different facts. Null is a keystore that has not spoken
  /// yet; zero is one that has, and said the store had reserved nothing.
  watermark: number | null;
}

/// Gathers the three facts. A SEAM RATHER THAN INLINE CODE IN THE ENTRYPOINT,
/// because a control can be correct, correctly fed and still DORMANT if the
/// wiring hands it a constant - and the entrypoint is the one place a test
/// never reaches. This module has already paid that price once: #34's sweep
/// was reviewed, merged, and had no caller until #39.
///
/// Structural parameter types so a test can supply the three facts without a
/// chain, a keystore directory or a store on disk. They are not a guard on the
/// CALL SITE: they reject a literal where a function belongs and accept a
/// plausible stub, and the dangerous edit is the one that typechecks. The call
/// site is pinned structurally in migrate.test.ts instead.
///
/// ALL THREE FACTS FAIL CLOSED, and that is deliberate rather than incidental.
/// None of these calls is wrapped: a chain that will not answer `getCode`, a
/// store that will not open, and an UNREADABLE keystore all propagate and stop
/// startup. `agentCount` used to be the exception - a bare catch returned 0 for
/// every error, and 0 is precisely the value that switches this control off, so
/// the one fact an operator could break by accident was the one that disabled
/// the refusal silently. It now distinguishes ENOENT (no agent has ever been
/// spawned) from unreadable (an answer we do not have).
///
/// The rule for anyone adding a fourth fact: A FACT THIS CONTROL CANNOT
/// ESTABLISH MUST STOP STARTUP, NEVER DEFAULT TO THE PERMISSIVE VALUE. The
/// incident that trips this control is an operator doing volume surgery, which
/// is exactly when a neighbouring volume also fails to attach.
export async function gatherLifetimeFacts(deps: {
  store: { intentsEmpty(): boolean; walletsRecorded(): number; reservationsEverMade(): number };
  keystore: { agentCount(): Promise<number>; ledgerWatermark(): Promise<number | null> };
  /// `getCode` rather than the deployments file: the file records what was
  /// deployed ONCE, and the question is what is on the chain NOW. A file
  /// describing a chain that has since been reset is precisely the stale
  /// artefact this control must not be fooled by.
  getCode: () => Promise<string | undefined>;
  acknowledged: boolean;
}): Promise<LifetimeFacts> {
  const code = await deps.getCode();
  return {
    intentsEmpty: deps.store.intentsEmpty(),
    storeWallets: deps.store.walletsRecorded(),
    keystoreAgents: await deps.keystore.agentCount(),
    contractsDeployed: code !== undefined && code !== '0x',
    acknowledged: deps.acknowledged,
    // FINDING 22: the two halves of the watermark comparison, gathered here
    // with everything else so the control stays a pure function of facts.
    reservations: deps.store.reservationsEverMade(),
    watermark: await deps.keystore.ledgerWatermark(),
  };
}

export class LedgerWipeError extends Error {
  readonly code = 'ledger_wiped_beneath_live_game';
  constructor(message: string) {
    super(message);
    this.name = 'LedgerWipeError';
  }
}

/// THE ONE CONTROL THAT CATCHES A PATH NO WRAPPER CAN.
///
/// `docker volume rm <project>_svc-store` is not a compose invocation, so the
/// CLI wrappers never see it - and it is the command the old
/// `no such column: topic` steered an operator toward, because that message
/// named the store, so the proportionate response was to delete the store and
/// NOTHING ELSE. The blunt `down -v` is the survivable one: it takes the
/// keystore and the chain state too, so no wallet and no balance outlives it
/// and there is nothing left to replay. THE CAREFUL REMEDY IS THE DESTRUCTIVE
/// ONE.
///
/// What survives a store-only wipe is the whole hazard: the keystore is
/// file-per-agent, so a re-spawn returns THE SAME ADDRESS, and anvil persists,
/// so that address still holds THE SAME BALANCE - beside a ledger that has
/// forgotten every consumed intent id. Every id in the game becomes reservable
/// again against still-funded wallets - and every freeze is released, because
/// the `frozen` table lives in this store too and is the single source of
/// truth for whether a wallet may spend. The wipe undoes containment and
/// idempotency together, which is why the three volumes share one lifetime
/// rather than merely being wiped in the same breath.
///
/// So the asymmetry is detected from INSIDE, where no wrapper is needed. An
/// empty intents table beside a keystore that holds agent keys and a chain
/// that has the contracts on it is reachable ONLY by a ledger wipe on a live
/// game: a fresh install has no keystore files, and an honest full reset has
/// neither keys nor contracts. It is not a heuristic - each conjunct rules out
/// one legitimate way to arrive at an empty store.
///
/// It refuses rather than warns, and that is the ruling: the
/// loud-but-continuing failure is precisely what routed someone to
/// the wipe, and a warning at startup is read by nobody. The legitimate reset
/// is not obstructed - it IS the acknowledgement flag, one documented step.
/// A STORE THAT WENT BACKWARDS IN TIME while the keys beside it did not.
///
/// This is the restore case, and it is invisible to every fact above: a backup
/// restored onto a live game has wallets, has keys, has contracts, and has a
/// non-empty intents table. Nothing in the wipe control fires, and the store
/// quietly re-offers intent ids that have already paid.
///
/// The comparison is between volumes, because that is the only place the
/// disagreement can exist. Restore both from one backup and they AGREE - which
/// is correct, that is a consistent restore and it starts. Wipe both and they
/// are both zero, which is the existing full-reset path. Restore the store
/// alone, under the keystore it was taken from, and the store's counter is
/// behind a mark the keystore still remembers.
///
/// Checked BEFORE the wipe control below rather than after: a restored store is
/// a more specific diagnosis than an empty one, and an operator who is told the
/// wrong one goes looking in the wrong place.
export function assertLedgerNotRestored(facts: LifetimeFacts): void {
  if (facts.acknowledged) return;

  // THE KEYSTORE VANISHED UNDER A LIVE LEDGER - the same asymmetry as the wipe
  // control, from the other side. A store that has reserved intents beside a
  // keystore that has never recorded a mark means the keys were replaced while
  // the ledger stayed, and every wallet this store remembers is now a wallet
  // nobody holds a key for.
  //
  // A GENUINELY FRESH DEPLOYMENT HAS BOTH AT ZERO, which is why this is the one
  // conjunct: `reservations > 0` is what separates a new keystore from a lost
  // one, and the first boot after this ships has a counter of 0 whatever the
  // store's age, so nobody is accused on a history that was never recorded.
  if (facts.watermark === null) {
    if (facts.reservations === 0) return;
    throw new LedgerWipeError(
      `refusing to start: this store has reserved ${facts.reservations} intent(s), and the ` +
        `keystore beside it has no record of ever having seen this ledger. The KEYSTORE is the ` +
        `volume that changed: a fresh one under a live store, or a keystore volume that did not ` +
        `mount.\n` +
        `\n` +
        `Every wallet this store remembers is a wallet nobody now holds a key for - they cannot ` +
        `sign, and their balances are unreachable. ${LEDGER_RESET_NOTICE}.\n` +
        `\n` +
        `${FREEZE_RECOVERY_ADVICE}.\n` +
        `\n` +
        `Find the keystore volume that belongs with this store. If you meant to end this game, ` +
        `say so explicitly and start again with --acknowledge-ledger-reset (or ` +
        `CHAIN_SVC_ACKNOWLEDGE_LEDGER_RESET=1).`,
    );
  }

  if (facts.reservations >= facts.watermark) return;

  throw new LedgerWipeError(
    `refusing to start: this store has reserved ${facts.reservations} intent(s) in its whole ` +
      `history, and the keystore beside it remembers a store that had reached ${facts.watermark}. ` +
      `A counter that only ever goes up cannot fall, so this store is OLDER than the keys it is ` +
      `being used with - a backup restored under a live game, or a store volume from a different ` +
      `deployment.\n` +
      `\n` +
      `The wallets in that keystore still exist and still hold their balances, and ` +
      `${LEDGER_RESET_NOTICE}. Every intent id consumed between this store's backup and now is ` +
      `reservable again, and an id that has already paid can pay a second time.\n` +
      `\n` +
      `${FREEZE_RECOVERY_ADVICE}.\n` +
      `\n` +
      `If this is the store you meant to restore, the keystore beside it is the wrong one - find ` +
      `the keystore from the same backup. If you meant to end this game, say so explicitly and ` +
      `start again with --acknowledge-ledger-reset (or CHAIN_SVC_ACKNOWLEDGE_LEDGER_RESET=1).`,
  );
}

export function assertLedgerLifetimeIntact(facts: LifetimeFacts): void {
  if (facts.acknowledged) {
    // FINDING 21: THE ACKNOWLEDGEMENT IS NOT A DISMISSAL, and it warns EVERY
    // boot rather than the one it was typed for.
    //
    // It returned silently, so the flag's cost was paid once and then forgotten
    // - and the flag lives in compose or in an env file, where it stays set for
    // every restart afterwards. A facilitator who acknowledged a wipe in
    // October is running an unguarded store in March with nothing to remind
    // them, which is the same shape as the refusal this whole function replaced
    // being routed around.
    //
    // It names the notice and the advice rather than summarising them, so the
    // operator reads the same sentences the refusal would have shown - one
    // place for what a wipe costs, which is why LEDGER_RESET_NOTICE is a
    // constant at all.
    console.warn(
      `[chain-svc] LEDGER RESET ACKNOWLEDGED: this store starts without the idempotency and ` +
        `retirement history a wipe removed. ${LEDGER_RESET_NOTICE}. ${FREEZE_RECOVERY_ADVICE}. ` +
        `This warning repeats every boot for as long as the acknowledgement is set; clearing ` +
        `it once the game is healthy is what makes the next wipe loud again.`,
    );
    return;
  }
  if (!facts.intentsEmpty) return;
  // THE STORE IS STILL HERE. A store that survived the restart remembers the
  // wallets it spawned; a wiped one remembers nothing, because the file is
  // recreated empty. This is the conjunct that separates the wipe from a live
  // game that has not spent yet - `intentsEmpty` never could, and without it
  // `compose down && compose up` on an unspent game refused to start.
  if (facts.storeWallets > 0) return;
  if (facts.keystoreAgents === 0) return;
  if (!facts.contractsDeployed) return;

  throw new LedgerWipeError(
    `refusing to start: this store is EMPTY - no consumed intent id and no record of a ` +
      `single wallet it spawned - but this game is live: the keystore holds ` +
      `${facts.keystoreAgents} agent key(s) and the contracts are deployed on the chain. ` +
      `That combination is only reachable by deleting the store volume on its own (a fresh ` +
      `install has no keystore keys; a full reset has neither keys nor contracts; a restart ` +
      `that kept its volumes still remembers its wallets).\n` +
      `\n` +
      `Those wallets still exist and still hold their balances, and ${LEDGER_RESET_NOTICE}. ` +
      `An intent id that has already paid can pay a second time.\n` +
      `\n` +
      `The retirement half is the one to act on first: that table is in this store, so ` +
      `every retirement was released WITH NO RECORD THAT ONE EXISTED. Retiring is what ends ` +
      `a wallet's life in the game, and it is done in response to incidents - a second ` +
      `chain-svc writing to this chain, or somebody holding a wallet's key - which happens ` +
      `exactly when a service gets restarted and a store gets deleted. ` +
      `${FREEZE_RECOVERY_ADVICE}.\n` +
      `\n` +
      `If a transfer was already made under an id a persona may retry, RESTORE THE STORE ` +
      `rather than starting without it. If you meant to end this game, say so explicitly ` +
      `and start again with --acknowledge-ledger-reset (or ` +
      `CHAIN_SVC_ACKNOWLEDGE_LEDGER_RESET=1).`,
  );
}

/// Additive advice for a facilitator who is mid-incident rather than starting a
/// fresh game. NOT part of the consent sentence: the acknowledged reset is a
/// legitimate recovery path, and re-freezing afterwards is the step that path
/// silently loses. Printing it costs a fresh-game operator one line they can
/// ignore; omitting it costs a recovering one the fact they needed.
export const FREEZE_RECOVERY_ADVICE =
  'if you are recovering from a failure mid-game rather than starting a fresh one, ' +
  're-retire anything that was retired: the release leaves no record of what it was. ' +
  'To stop a LIVE wallet spending, freeze it on chain with admin-call - that is in the ' +
  'token, not in this store, and a wipe cannot touch it';
