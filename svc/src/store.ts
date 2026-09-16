// chain-svc's local durable state (spec S4): the things that have no on-chain
// home. Three of them, each here for a specific reason:
//
//   memos   - ERC-20 `transfer` carries no memo field, but /history must return
//             one, so the memo is joined on by txHash after the fact.
//   frozen  - RETIREMENT, under the name the table was created with. It is the
//             single source of truth for whether a wallet may spend, and
//             /sign-transfer checks ONLY this. The per-agent POLICY_FILE that
//             wallet-mcp reads is a local fast-path copy; if the two ever
//             disagree, this table wins (spec S4). The NAME is kept because
//             renaming a column is a migration and the table's meaning did not
//             change - what changed at v0.8.0 is that nothing else writes it.
//   outbox  - hub-core does not exist until C5, so chain events are buffered
//             here and retried rather than dropped.
//
// RUNTIME NOTE: `bun:sqlite` makes this package bun-only. Spec S4 says svc and
// wallet-mcp are "Node-22-compatible ESM ... either bun or node runs them",
// which cannot hold together with a sqlite requirement: node's `node:sqlite` is
// behind --experimental-sqlite on 22. chain-svc runs in its own image, which is
// built on bun, so this is contained - but it is a real conflict in the spec
// and is flagged in the C2a PR rather than papered over.

import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/// Bounded so a hub-core that is down (or absent, pre-C5) cannot fill the disk.
/// Oldest are dropped first and the count is returned so the caller can log it:
/// a silently truncated audit trail is worse than a noisy one.
export const MAX_BUFFERED_EVENTS = 10_000;

export interface MemoRecord {
  txHash: string;
  memo: string | null;
  intentId: string | null;
  fromAgentId: string | null;
}

export type Reservation =
  | { outcome: 'reserved'; txHash: null }
  /// WHICH LIMIT TRIPPED, because two different ones produce this outcome and
  /// the caller's message has to name the one that fired.
  ///
  ///   'stage_amount'  the WALLET's per-stage spend bound, from its policy
  ///   'entry_calls'   the ENTRY's per-stage call count, from calls.json
  ///
  /// They are not interchangeable to an operator: one is money the wallet may
  /// move, the other is how many times a function may be invoked, and they are
  /// configured in different files by different people.
  | { outcome: 'over_stage_cap'; txHash: null; limit: 'stage_amount' | 'entry_calls' }
  | { outcome: 'duplicate'; txHash: string | null };

import { migrate } from './migrate.ts';
import type { DeploymentIdentity } from './deployment.ts';
import { UNLIMITED, type StageCap } from './policy.ts';
import type { WalletKind } from './policy.ts';

export interface OutboundEvent {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
}

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    // FINDING 13: WAIT FOR A BUSY WRITER RATHER THAN THROWING AT IT.
    //
    // WAL keeps readers out of a writer's way; it does not make two WRITERS
    // wait. Without a busy timeout, sqlite answers SQLITE_BUSY IMMEDIATELY -
    // so two processes opening this store at once (the service and a CLI, or a
    // restart overlapping its predecessor) had the second one throw during
    // MIGRATION, which is the one moment the store is half-shaped.
    //
    // Five seconds because the thing being waited for is a migration, not a
    // request: a numbered step rewrites a table and then stamps a version, and
    // a caller that gives up at 100ms gives up in the middle of that.
    //
    // FIRST, AND THE ORDER IS THE FIX RATHER THAN A TIDY-UP. It was set after
    // the line below, and `PRAGMA journal_mode = WAL` TAKES AN EXCLUSIVE LOCK
    // to rewrite the header - so the second process died on the pragma that
    // configures the store, one statement before the timeout that would have
    // let it wait:
    //
    //   SQLiteError: database is locked   at PRAGMA journal_mode = WAL
    //
    // Found because the ten-trial test flaked rather than failed - roughly one
    // run in three - which is the shape a race has when the window is a single
    // statement wide.
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL so a reader (/history) is never blocked by the events writer.
    this.db.exec('PRAGMA journal_mode = WAL');
    // Ordering is migrate()'s to enforce, not this constructor's - see migrate.ts.
    migrate(this.db, () => this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        tx_hash       TEXT PRIMARY KEY,
        memo          TEXT,
        -- Denormalised for /history only. This column is NOT the dedupe key and
        -- never was: it is written AFTER the transfer, so a crash between the
        -- two loses it, and it is the 'intents' table below - written BEFORE -
        -- that decides whether a send may happen at all.
        intent_id     TEXT,
        from_agent_id TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spawns (
        agent_id   TEXT PRIMARY KEY,
        address    TEXT NOT NULL,
        -- The kind ENFORCED at spawn (the post-parseKind value), or NULL for a
        -- wallet spawned before this column existed. Nothing can reconstruct it
        -- afterwards: org and agent take the identical registration branch, and
        -- caps are a patch over tunable defaults. See migrate.ts for why NULL
        -- must stay NULL.
        kind       TEXT,
        -- §5's bare-id detector. Counts, never accumulates: a log of every bare
        -- send would be keyed on caller behaviour and grow forever, and the
        -- retention rule forbids exactly that. A counter bounded by this table has
        -- no retention window to get wrong.
        bare_id_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frozen (
        agent_id  TEXT PRIMARY KEY,
        frozen_at INTEGER NOT NULL
      );
      -- One live credential per wallet. Rotation REPLACES the row, which is
      -- what revokes the old token: there is no list of valid-but-superseded
      -- tokens to forget to clean up.
      CREATE TABLE IF NOT EXISTS wallet_tokens (
        agent_id   TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        issued_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_tokens_hash ON wallet_tokens (token_hash);
      -- The stage cap resets when the stage changes, so spend is tracked PER
      -- stage rather than being zeroed on transition: a late-arriving transfer
      -- from the previous stage cannot then overdraw the new one.
      -- An intent is RESERVED before the money moves and is never deleted.
      -- A second attempt under the same id BY THE SAME WALLET cannot insert:
      -- that is the idempotency guarantee, and it lives on the side that cannot
      -- forget rather than in the persona's JSON ledger, which is only written
      -- after a successful response and so is empty in exactly the case it
      -- exists for.
      -- THE KEY IS (agent_id, intent_id), NOT intent_id (v8, finding 1). An
      -- intent id is a string the CALLER chooses, so a globally unique key made
      -- one wallet's choice of the string collide with another's: bob reserving
      -- "payment-1" after alice got back alice's txHash and alice's money moved
      -- nothing. Measured on a live stack before the fix - bob's send answered
      -- 200 with alice's hash and bob's own canonical, and bob's balance did
      -- not change.
      --
      -- Another wallet's id is simply a different row. No new refusal word and
      -- no oracle: nothing tells bob that alice used the string, because
      -- nothing should.
      CREATE TABLE IF NOT EXISTS intents (
        intent_id  TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        stage      TEXT NOT NULL,
        amount     TEXT NOT NULL,
        tx_hash    TEXT,
        -- The stage budget this intent HOLDS, in wei, or '0' when it took no
        -- hold (a platform-scope transfer). RECORDED rather than inferred: the
        -- refund used to be keyed on whether the DELETE removed a row, which
        -- was correct while every reservation held its amount and stopped being
        -- correct the moment capWei:null made 'an intent row exists'
        -- independent of 'a hold was taken'. Releasing a no-hold reservation
        -- refunded budget never taken, and the zero-clamp turned that overshoot
        -- into wiping the wallet's real spend.
        held_wei   TEXT NOT NULL DEFAULT '0',
        -- keccak256(bytes(intent_id)), the form the chain logs. Stored rather
        -- than derived on demand so the sweep can join an IntentTransfer back
        -- to the intent that authorised it, and so the derivation lives in ONE
        -- place (Treasury.intentTopic) rather than being repeated here.
        topic      TEXT,
        -- COUNT, DON'T ACCUMULATE. The number of IntentTransfer emissions the
        -- tail has seen for this intent, with the first one recorded inline.
        --
        -- A table of every emission would be keyed on CHAIN HISTORY and grow
        -- forever, and no retention window is safe for it: a second emission
        -- can arrive arbitrarily late, and that lateness IS the detector's
        -- premise. A counter is bounded by this table - growth already
        -- accepted - and has no window to get wrong.
        emissions  INTEGER NOT NULL DEFAULT 0,
        first_tx   TEXT,
        first_from TEXT,
        -- NO CURRENT CONSUMER. The chain head observed BEFORE the reservation.
        -- Nothing reads this column: the sweep's negative branch did, and the
        -- #34 NO-GO removed it. Kept because the reservation strictly precedes
        -- the broadcast, so tx_block >= head-at-reserve makes it a sound FLOOR
        -- for the recorded future nonce-based branch - and that value is
        -- IRRECOVERABLE if it is not stamped at reserve time. See the
        -- reservedAtBlock comment on reserve().
        reserved_at_block TEXT,
        -- Whether the intent id was CALLER-SUPPLIED or SERVER-GENERATED.
        -- Recorded because the anomaly needs it: a foreign emission under a
        -- model-chosen id is a guessable id being guessed, and under a
        -- a chain-svc:<uuid> it is not - different stories, and a facilitator
        -- should not need a second lookup to tell them apart.
        id_source  TEXT,
        -- WHAT THIS INTENT WAS RESERVED FOR, when it was a generic call:
        -- the registry key, the function name, and a hash of the validated
        -- wire arguments. Null for a sign-transfer or fund intent, which is
        -- the true value rather than a gap - see ADDITIVE_COLUMNS.
        --
        -- The hash is what makes a replay decidable. chain-svc answers a
        -- repeated intent id with the ORIGINAL transaction hash, which is
        -- correct only if the repeat is the same call; a repeat under the same
        -- id with different arguments is a different call wearing a used id,
        -- and returning the first call's hash would tell the caller their
        -- second call succeeded.
        call_contract  TEXT,
        call_function  TEXT,
        call_args_hash TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, intent_id)
      );
      -- Only ever holds the SECOND and later emissions for one intent, so it is
      -- small by construction rather than by pruning.
      CREATE TABLE IF NOT EXISTS intent_anomalies (
        topic      TEXT NOT NULL,
        tx_hash    TEXT NOT NULL,
        from_addr  TEXT,
        seen_at    INTEGER NOT NULL,
        PRIMARY KEY (topic, tx_hash)
      );
      -- HOW MANY TIMES THIS WALLET HAS CALLED THIS ENTRY THIS STAGE.
      --
      -- Keyed by (wallet, stage, contract, function) rather than by intent,
      -- because the question it answers is "how many more may I make", and a
      -- table of intents would have to be counted per request. Bounded by the
      -- stage: a new stage is new rows, and the old ones are history.
      --
      -- WRITTEN ONLY FOR ENTRIES THAT DECLARE maxPerStage. An entry with no
      -- limit writes no row and reads none: a counter nothing enforces is a
      -- table that grows for the sake of it, and a row whose absence is
      -- meaningful is easier to reason about than a row whose value is ignored.
      CREATE TABLE IF NOT EXISTS call_counts (
        agent_id TEXT NOT NULL,
        stage    TEXT NOT NULL,
        contract TEXT NOT NULL,
        function TEXT NOT NULL,
        count    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, stage, contract, function)
      );
      -- KEYED BY TOKEN AS WELL, since caps are per token: one wallet spending
      -- two currencies in one stage is two rows, and under the old key the
      -- second would have replaced the first - silently, and in the direction
      -- that frees budget.
      CREATE TABLE IF NOT EXISTS stage_spend (
        agent_id TEXT NOT NULL,
        stage    TEXT NOT NULL,
        token    TEXT NOT NULL,
        spent    TEXT NOT NULL,
        PRIMARY KEY (agent_id, stage, token)
      );
      -- WHICH CHAIN THIS STORE BELONGS TO (spec S4: the store and the chain
      -- state share one lifetime). Recorded on the first boot that sees a
      -- deployment, and compared on every boot after.
      --
      -- The pair goes wrong in BOTH directions and we only detected one. #52
      -- refuses when the STORE is wiped beside a live chain; this is the same
      -- two artefacts the other way round - the chain replaced while the store
      -- survives - which leaves every spawn marker pointing at names that no
      -- longer exist on the new registry, and every wallet permanently
      -- unresolvable with no repair path.
      --
      -- IDENTITY, NOT NAMES. The obvious check - a spawn marker whose canonical
      -- name is unregistered - is the STEADY STATE OF A BURNER, which registers
      -- no names by design while still getting a marker. This asks the only
      -- question that matters instead: are these the same two artefacts they
      -- were? That also catches a chain SWAP, which a name check never could.
      -- v5: one JSON column instead of two address columns, because a
      -- deployment is now a LIST of modules and a column per contract cannot
      -- express one. A fresh store gets this shape directly; a v4 store is
      -- carried across by the numbered migration in migrate.ts, and §8 asserts
      -- the two land on the same PRAGMA table_info.
      CREATE TABLE IF NOT EXISTS deployment (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        chain_id       TEXT NOT NULL,
        modules_json   TEXT NOT NULL,
        recorded_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stage_state (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        stage TEXT NOT NULL
      );
      -- How far the log tail has read. Persisted so a restart resumes rather
      -- than replaying every Transfer since genesis into the outbox.
      CREATE TABLE IF NOT EXISTS cursors (
        name  TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL
      );
      -- ONE ROW, AND A NUMBER THAT ONLY EVER GOES UP (finding 22).
      --
      -- reservations counts every intent this store has ever RESERVED. Not how
      -- many exist: release deletes rows, and a count of what is present goes
      -- DOWN in the ordinary course of business. This is the fact a restored
      -- backup cannot fake, and the reason it is a counter rather than
      -- MAX(rowid) - sqlite reuses the top rowid when the highest row is
      -- deleted, so the obvious measure falls when a wallet merely releases its
      -- most recent reservation.
      --
      -- (No backticks in this block: it is inside a JS template literal, and a
      -- backtick in a SQL comment ends the string. Cost me the same five
      -- minutes in the v8 migration.)
      --
      -- The CHECK pins it to one row: a second row would make "the counter" a
      -- question with two answers, and the comparison at boot reads it as a
      -- scalar.
      CREATE TABLE IF NOT EXISTS ledger_facts (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        reservations INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO ledger_facts (id, reservations) VALUES (1, 0);
    `), () => this.db.exec(`
      CREATE INDEX IF NOT EXISTS intents_topic ON intents (topic);
    `));
  }

  /// Whether any intent id has ever been consumed. Read once at startup by the
  /// ledger-lifetime control: an empty ledger beside a live game is the
  /// signature of a store-only wipe. See migrate.ts.
  intentsEmpty(): boolean {
    return this.db.query(`SELECT 1 FROM intents LIMIT 1`).get() === null;
  }

  /// How many wallets this store remembers spawning. The second half of the
  /// ledger-lifetime control's store fact: `intentsEmpty` is true for a wiped
  /// store AND for a live game that has not transferred yet, and only this
  /// tells them apart. See migrate.ts.
  ///
  /// `spawns` rather than `deployment`, `outbox` or `cursors`, and the reason
  /// is ordering, not taste: index.ts records the deployment BEFORE it runs the
  /// control, so a wiped store already has a deployment row by the time the
  /// question is asked. A table the boot path writes cannot answer whether the
  /// boot found anything. `spawns` is written only by a spawn request.
  walletsRecorded(): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM spawns`).get() as { n: number }).n;
  }

  /// EVERY INTENT THIS STORE HAS EVER RESERVED, monotonically (finding 22).
  ///
  /// Never how many exist. `release` deletes rows and this number does not
  /// move, which is what makes it comparable against a copy kept OUTSIDE the
  /// store: if the file goes back in time and the copy does not, the two
  /// disagree, and nothing an operator does in the normal course of a game can
  /// produce that disagreement.
  reservationsEverMade(): number {
    const row = this.db.query(`SELECT reservations FROM ledger_facts WHERE id = 1`).get() as
      | { reservations: number }
      | null;
    // A store older than this table reads as zero rather than throwing: the
    // guard starts protecting from the first boot that has it, which is the
    // honest answer for a history it never recorded.
    return row?.reservations ?? 0;
  }

  close(): void {
    this.db.close();
  }

  // --- memos -------------------------------------------------------------

  recordMemo(rec: MemoRecord): void {
    this.db
      .query(
        `INSERT INTO memos (tx_hash, memo, intent_id, from_agent_id, created_at)
         VALUES ($tx, $memo, $intent, $from, $now)
         ON CONFLICT(tx_hash) DO NOTHING`,
      )
      .run({
        $tx: rec.txHash.toLowerCase(),
        $memo: rec.memo,
        $intent: rec.intentId,
        $from: rec.fromAgentId,
        $now: Date.now(),
      });
  }

  memosFor(txHashes: string[]): Map<string, MemoRecord> {
    const out = new Map<string, MemoRecord>();
    if (txHashes.length === 0) return out;
    const placeholders = txHashes.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT tx_hash, memo, intent_id, from_agent_id FROM memos WHERE tx_hash IN (${placeholders})`)
      .all(...txHashes.map((h) => h.toLowerCase())) as Array<{
      tx_hash: string;
      memo: string | null;
      intent_id: string | null;
      from_agent_id: string | null;
    }>;
    for (const r of rows) {
      out.set(r.tx_hash, { txHash: r.tx_hash, memo: r.memo, intentId: r.intent_id, fromAgentId: r.from_agent_id });
    }
    return out;
  }

  // --- spawns ------------------------------------------------------------
  // Written only once every step of a spawn has succeeded. A key file alone is
  // NOT proof of a finished spawn: if the process dies between writing the key
  // and funding the wallet, a retry that trusted the key file would return a
  // wallet with no money and no name, reporting success.

  /// `kind` is REQUIRED rather than optional, and `null` is a legitimate value.
  ///
  /// Optional would leave a silent forget-path: a future caller that omitted it
  /// would write NULL, which reads as "spawned before the column existed" - a
  /// false statement about when, produced by an oversight. Required forces every
  /// site to say what it means, and a fixture passing `null` is stating
  /// truthfully that it recorded no kind.
  markSpawned(agentId: string, address: string, kind: WalletKind | null): void {
    this.db
      .query(
        `INSERT INTO spawns (agent_id, address, kind, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO NOTHING`,
      )
      .run(agentId, address, kind, Date.now());
  }

  /// The wallet row, for the platform-scope read. Null when nothing was ever
  /// spawned under that id.
  ///
  /// `kind` is `WalletKind | null` and the null is NOT filled in here or
  /// anywhere downstream - a consumer seeing null learns that this wallet
  /// predates the column, which is a different fact from any kind it might
  /// plausibly have been.
  walletRow(agentId: string): { address: string; kind: WalletKind | null; bareIdCount: number } | null {
    const row = this.db
      .query(`SELECT address, kind, bare_id_count FROM spawns WHERE agent_id = ?`)
      .get(agentId) as { address: string; kind: string | null; bare_id_count: number } | null;
    if (!row) return null;
    return {
      address: row.address,
      kind: row.kind === null ? null : (row.kind as WalletKind),
      bareIdCount: row.bare_id_count,
    };
  }

  spawnedAddress(agentId: string): string | null {
    const row = this.db.query(`SELECT address FROM spawns WHERE agent_id = ?`).get(agentId) as
      | { address: string }
      | null;
    return row?.address ?? null;
  }

  /// The reverse of `spawnedAddress`: which agent a wallet address belongs to.
  ///
  /// Only reached on a deployment with NO names module, where it is the whole
  /// of `reverseOf`. Equality is exact rather than case-insensitive because
  /// both sides are viem `Address` values: `markSpawned` stores what the
  /// keystore produced, and the callers pass what a contract read returned,
  /// and viem checksums both. A `lower(address)` comparison here would read as
  /// defensive and would instead hide the day that stops being true.
  agentIdForAddress(address: string): string | null {
    const row = this.db.query(`SELECT agent_id FROM spawns WHERE address = ?`).get(address) as
      | { agent_id: string }
      | null;
    return row?.agent_id ?? null;
  }

  // --- which chain this store belongs to (spec S4) --------------------------

  /// The deployment this store was first used against, or null on a store that
  /// has never seen one.
  recordedDeployment(): DeploymentIdentity | null {
    const row = this.db
      .query(`SELECT chain_id, modules_json FROM deployment WHERE id = 1`)
      .get() as { chain_id: string; modules_json: string } | null;
    return row
      ? { chainId: row.chain_id, modules: JSON.parse(row.modules_json) as DeploymentIdentity['modules'] }
      : null;
  }

  /// Written ONCE, on the first boot that sees a deployment. Never updated by
  /// an acknowledgement: acknowledging a disagreement permits a boot, it does
  /// not make the two artefacts agree. Updating it is repair's job, at the
  /// point where "these now agree" becomes a true statement.
  recordDeployment(id: DeploymentIdentity): void {
    this.db
      .query(
        `INSERT INTO deployment (id, chain_id, modules_json, recorded_at)
         VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(id.chainId, JSON.stringify(id.modules), Date.now());
  }

  // --- the bare-id detector (spec S5) --------------------------------------

  /// Counts one wallet-scope `to` that had no colon and was NOT an exactly
  /// registered name.
  ///
  /// THIS EXISTS BECAUSE §5 DELETED A DETECTOR. `unknown_name` used to be the
  /// only signal that a persona addresses peers by the id it SEES rather than
  /// the id the registry HOLDS; accepting the untaught form silences it, and a
  /// persona that never learns would then produce no signal at all. Same shape
  /// as on-chain dedupe silencing `chain.anomaly` (§4): the change cannot stop
  /// the behaviour, only stop recording it.
  ///
  /// REMOVING THIS COUNTER DELETES THE DETECTOR. It is not dead weight because
  /// nothing in the service reads it - the facilitator does.
  ///
  /// It counts the BEHAVIOUR, not one of its outcomes: a bare `to` counts
  /// whether the namespace fallback then succeeded, was skipped for shape, or
  /// failed - so it keeps firing exactly as `unknown_name` did, and a
  /// mixed-case persona stays visible. It does NOT count a legitimate
  /// colon-less alias or platform name (`treasury.play`), because those are an
  /// exact hit and using them is correct.
  countBareId(agentId: string): void {
    this.db
      .query(`UPDATE spawns SET bare_id_count = bare_id_count + 1 WHERE agent_id = ?`)
      .run(agentId);
  }

  bareIdCount(agentId: string): number {
    const row = this.db
      .query(`SELECT bare_id_count FROM spawns WHERE agent_id = ?`)
      .get(agentId) as { bare_id_count: number } | null;
    return row?.bare_id_count ?? 0;
  }

  // --- frozen ------------------------------------------------------------

  freeze(agentId: string): void {
    this.db
      .query(`INSERT INTO frozen (agent_id, frozen_at) VALUES (?, ?) ON CONFLICT(agent_id) DO NOTHING`)
      .run(agentId, Date.now());
  }

  /// THERE IS NO `unfreeze`, AND THE ABSENCE IS THE POINT AT v0.8.0.
  ///
  /// There was one, and its own comment said `DELETE /wallets` "is not
  /// reversible by this". That stopped being true when retirement and the
  /// service-side freeze collapsed onto this one table: `unfreeze` deleted the
  /// row that `isRetired` reads, so it un-retired the wallet - while retirement
  /// also clears the wallet's aliases, which it could not give back. A wallet
  /// able to spend and unable to be paid.
  ///
  /// It was unreachable: no route and no caller, in src or in test. Deleted
  /// rather than documented, because a one-line un-retire in the store API of a
  /// release whose lock IS retirement is worth more than a true comment about
  /// it. The way back from retirement is a fresh spawn under a new id.

  isRetired(agentId: string): boolean {
    return this.db.query(`SELECT 1 AS present FROM frozen WHERE agent_id = ?`).get(agentId) != null;
  }

  // --- wallet credentials -------------------------------------------------

  setWalletTokenHash(agentId: string, tokenHash: string): void {
    this.db
      .query(
        `INSERT INTO wallet_tokens (agent_id, token_hash, issued_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET token_hash = excluded.token_hash, issued_at = excluded.issued_at`,
      )
      .run(agentId, tokenHash, Date.now());
  }

  hasWalletToken(agentId: string): boolean {
    return this.db.query(`SELECT 1 FROM wallet_tokens WHERE agent_id = ?`).get(agentId) != null;
  }

  /// The principal a wallet token identifies, or null if it is not a live one.
  agentForTokenHash(tokenHash: string): string | null {
    const row = this.db.query(`SELECT agent_id FROM wallet_tokens WHERE token_hash = ?`).get(tokenHash) as
      | { agent_id: string }
      | null;
    return row?.agent_id ?? null;
  }

  // --- stage and per-stage spend ------------------------------------------

  currentStage(): string {
    const row = this.db.query(`SELECT stage FROM stage_state WHERE id = 1`).get() as { stage: string } | null;
    return row?.stage ?? 'default';
  }

  setStage(stage: string): void {
    this.db
      .query(`INSERT INTO stage_state (id, stage) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET stage = excluded.stage`)
      .run(stage);
  }

  /// What this wallet has spent OF THIS TOKEN in this stage.
  ///
  /// The token is a required coordinate, not an optional filter. A total that
  /// summed two currencies would be a number in no unit at all - and the one it
  /// would be compared against is a cap denominated in one of them.
  spentThisStage(agentId: string, stage: string, token: string): bigint {
    const row = this.db.query(`SELECT spent FROM stage_spend WHERE agent_id = ? AND stage = ? AND token = ?`).get(agentId, stage, token) as
      | { spent: string }
      | null;
    return row ? BigInt(row.spent) : 0n;
  }

  /// What a reservation attempt did.
  ///
  ///   reserved       - the caller owns this intent and may broadcast.
  ///   over_stage_cap - the cap would be exceeded; NOTHING was written.
  ///   duplicate      - this intent id was already reserved. `txHash` is the
  ///                    result of the original send if it completed, and null
  ///                    if it did not - which is not a failure to retry but a
  ///                    reconciliation: the first attempt may have broadcast.
  ///
  /// Atomically RESERVE `amount` against the stage cap.
  ///
  /// The check and the record are one step on purpose. They used to be two: the
  /// caller read the running total, did four awaits (name resolution, a scrypt
  /// keystore load, the chain write, the receipt wait) and then wrote the new
  /// total. Every concurrent send therefore read the same pre-spend figure and
  /// every one passed the cap - measured by sec-reviewer-2 at three concurrent
  /// 100-VEE sends against a 100/stage cap: three accepted, 300 recorded, three
  /// on chain, while the sequential fourth correctly refused. A cap enforced by
  /// a check-then-act is not a cap, it is a race the honest caller loses.
  ///
  /// @returns false if the reservation would exceed the cap, in which case
  /// nothing was written.
  reserve(args: {
    intentId: string;
    /// keccak256 of the intent id, as the chain logs it. See the `topic` column.
    topic?: string;
    /// The chain head observed BEFORE this reservation. See the column.
    reservedAtBlock?: bigint;
    /// 'caller' or 'server'. See the `id_source` column.
    idSource?: 'caller' | 'server';
    agentId: string;
    stage: string;
    amount: bigint;
    /// §1b. THE STAGE BOUND, IN THREE EXPLICIT STATES - because "no bound" and
    /// "no stage" are different facts and used to share one sentinel:
    ///
    ///   { cap: bigint }      bound AND record. A wallet with a finite cap.
    ///   { cap: 'unlimited' } RECORD WITHOUT BOUNDING. A wallet that chose no
    ///                        bound; the spend is still an audit fact.
    ///   null                 NEITHER. Platform scope, which has no stage at
    ///                        all - the treasury's spends are nobody's budget,
    ///                        and an operator reset refused as over_stage_cap
    ///                        mid-game would be a bad failure.
    ///
    /// MEASURED BEFORE THIS EXISTED: the `stage_spend` write was guarded on the
    /// cap itself, so recording and bounding were one branch and `capWei: null`
    /// skipped both. An "unlimited" cap implemented that way would have made a
    /// wallet's unlimited spends ABSENT FROM THE AUDIT TRAIL rather than
    /// unbounded - and invisible, because every cap test passes when nothing is
    /// over any cap.
    ///
    /// A DISCRIMINATED VALUE RATHER THAN A SENTINEL so the call site has to say
    /// which "no bound" it means, and still a PARAMETER rather than a second
    /// method so both halves stay in one transaction.
    stageCap: StageCap;
    /// WHICH TOKEN this reservation is denominated in - the manifest KEY, which
    /// is what `stage_spend` and `intents` store. Required rather than
    /// defaulted to the first token: a caller that has not decided which
    /// currency is moving has not decided what its cap means, and a default
    /// would make that omission look like a decision.
    token: string;
    /// A GENERIC CALL rather than a transfer (§3.2.7). Present for `call` and
    /// `admin-call` intents and absent for `sign-transfer` and `fund`, which is
    /// why the three columns are nullable: null is the true value, not a gap.
    ///
    /// A THIRD HALF OF THE SAME DECISION, for the same reason `stageCap` is a
    /// parameter: "may this call happen" is one question, and counting it in a
    /// second transaction would admit a window where the intent is taken and
    /// the count is not, or the reverse.
    call?: {
      contract: string;
      function: string;
      /// sha256 of the canonical JSON of the validated wire arguments. What
      /// makes a replay decidable: the same id with different arguments is a
      /// different call wearing a used id, not a duplicate.
      argsHash: string;
      /// The entry's per-stage limit, or absent for no limit - in which case no
      /// `call_counts` row is written and none is read.
      maxPerStage?: number;
    };
  }): Reservation {
    const { intentId, topic, reservedAtBlock, idSource, agentId, stage, amount, stageCap, call, token } =
      args;
    // The two halves, read off the three states once. `bound` is what refuses;
    // `records` is whether the spend is an audit fact. They are equal for a
    // finite cap and deliberately differ for the other two.
    const bound = stageCap !== null && stageCap.cap !== UNLIMITED ? stageCap.cap : null;
    const records = stageCap !== null;

    // ONE transaction covering BOTH the intent and the cap, because they are
    // one decision: "may this send happen". Two transactions would admit a
    // window where the intent is taken and the budget is not, or the reverse.
    const attempt = this.db.transaction((): Reservation => {
      // BOTH COORDINATES (v8, finding 1). Keyed on the id alone, bob's reserve
      // of a string alice had used found ALICE's row and answered `duplicate`
      // with her txHash - bob's send reported success, moved nothing, and
      // handed him a hash of somebody else's transfer.
      const existing = this.db
        .query(`SELECT tx_hash FROM intents WHERE agent_id = ? AND intent_id = ?`)
        .get(agentId, intentId) as { tx_hash: string | null } | null;
      if (existing) return { outcome: 'duplicate', txHash: existing.tx_hash };

      // Re-read INSIDE the transaction: a value read before it began is the
      // same stale figure the check-then-act acted on.
      //
      // THIS IS WHERE THE TIE-BREAK IS DECIDED. Two limits produce
      // `over_stage_cap` - this stage AMOUNT and the per-entry call COUNT below
      // - and when both would trip, the caller reports whichever is tested
      // first. That is this one. `Treasury.call` names the limit from
      // `reservation.limit`, so reordering these two checks silently changes
      // what an operator is told to go and edit; a test asserts the amount wins
      // and says it is asserting the order rather than a preference.
      const current = this.spentThisStage(agentId, stage, token);
      if (bound !== null && current + amount > bound) {
        return { outcome: 'over_stage_cap', txHash: null, limit: 'stage_amount' };
      }

      // The per-entry limit, read inside the same transaction and for the same
      // reason. BEFORE any write, so a refusal consumes nothing - least of all
      // the intent id, which a caller may reasonably retry next stage. An id
      // consumed by a refusal would answer `duplicate` with a null txHash,
      // which reads as `intent_unresolved`: "it may have been sent".
      const counted = call?.maxPerStage !== undefined;
      const usedThisStage = counted
        ? this.callCount(agentId, stage, call!.contract, call!.function)
        : 0;
      if (counted && usedThisStage + 1 > call!.maxPerStage!) {
        return { outcome: 'over_stage_cap', txHash: null, limit: 'entry_calls' };
      }

      this.db
        .query(
          `INSERT INTO intents (intent_id, agent_id, stage, amount, tx_hash, held_wei, topic,
                                reserved_at_block, id_source, call_contract, call_function,
                                call_args_hash, token, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intentId,
          agentId,
          stage,
          amount.toString(),
          // HELD against the stage, so `release` refunds it. An unlimited cap
          // records the spend, so it holds; platform scope records nothing, so
          // it holds nothing.
          records ? amount.toString() : '0',
          topic ?? null,
          reservedAtBlock === undefined ? null : reservedAtBlock.toString(),
          idSource ?? null,
          call?.contract ?? null,
          call?.function ?? null,
          call?.argsHash ?? null,
          token,
          Date.now(),
        );
      // FINDING 22. THE COUNTER GOES UP HERE AND NOWHERE ELSE, inside the same
      // transaction as the reservation - so it cannot record a reservation that
      // did not happen, and a reservation cannot happen without it.
      //
      // `release` does NOT decrement it. That is the whole point: a count of
      // live rows falls in the ordinary course of business, and a measure that
      // falls legitimately cannot distinguish "this store went backwards in
      // time" from "somebody released an intent".
      this.db.query(`UPDATE ledger_facts SET reservations = reservations + 1 WHERE id = 1`).run();
      if (counted) {
        this.db
          .query(
            `INSERT INTO call_counts (agent_id, stage, contract, function, count)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(agent_id, stage, contract, function)
               DO UPDATE SET count = excluded.count`,
          )
          .run(agentId, stage, call!.contract, call!.function, usedThisStage + 1);
      }
      // §1b. RECORDS, not bounds. An "unlimited" cap reaches here: the spend
      // is an audit fact whether or not anything refuses it, and skipping this
      // write along with the bound is the defect this three-state value exists
      // to make impossible to write by accident.
      if (records) {
        this.db
          .query(
            `INSERT INTO stage_spend (agent_id, stage, token, spent) VALUES (?, ?, ?, ?)
             ON CONFLICT(agent_id, stage, token) DO UPDATE SET spent = excluded.spent`,
          )
          .run(agentId, stage, token, (current + amount).toString());
      }
      return { outcome: 'reserved', txHash: null };
    });
    return attempt();
  }

  /// A FAILED INTENT MUST TOMBSTONE, NEVER DELETE - a standing invariant, not a
  /// note about the method that used to be here.
  ///
  /// There was a `failIntent` that called `release`, and `release` deletes the
  /// row. So marking an intent failed FREED ITS IDEMPOTENCY KEY, and the
  /// caller's correct retry under that id broadcast a second transfer. That is
  /// the double-charge this whole mechanism exists to prevent, and it was
  /// independent of the bug that triggered it: any future path that concludes
  /// "this did not land" and deletes the row reintroduces it.
  ///
  /// THE IDEMPOTENCY KEY'S LIFETIME IS THE GAME'S, REGARDLESS OF OUTCOME. A
  /// failed intent must keep its row and its id, give back only the HOLD, and
  /// answer a retry with a refusal. `release` is for the pre-broadcast case
  /// alone, where deleting is correct BECAUSE nothing was sent - the id was
  /// never spent against, so it is free to reuse.

  /// Records the result of a send against the intent that authorised it, so a
  /// retry can be answered with the original transaction rather than a second
  /// one.
  completeIntent(agentId: string, intentId: string, txHash: string): void {
    this.db
      .query(`UPDATE intents SET tx_hash = ? WHERE agent_id = ? AND intent_id = ?`)
      .run(txHash, agentId, intentId);
  }

  /// THERE IS DELIBERATELY NO TIMED SWEEP OF STALE HOLDS, and this is the
  /// second time that idea has been proposed and withdrawn - so here is why, to
  /// stop it being reinvented.
  ///
  /// A crash between the reservation and the recorded hash leaves an intent
  /// `reserved` with its stage budget held, and releasing that hold after a
  /// timeout looks like obvious hygiene. It is a CAP BYPASS. A `reserved`
  /// intent may have LANDED with its hash lost; releasing its hold hands back
  /// budget that was really spent, and lets the wallet spend it again. That is
  /// the one direction a cap must never err in.
  ///
  /// It is also the exact rule this file already enforces one screen up:
  /// release only on a failure that PROVABLY precedes the broadcast. A
  /// `reserved` intent is by definition not that. A sweep would have been the
  /// second release path the release rule exists to forbid, wearing a timer
  /// instead of a catch.
  ///
  /// So the hold is KEPT until the stage rolls over, which frees it because
  /// spend is keyed by (agent, stage). The wallet over-counts for a
  /// maybe-landed transfer. That is the conservative direction and it is the
  /// correct one.
  ///
  /// This becomes answerable, not merely conservative, once the token emits
  /// IntentTransfer: the sweep can then resolve each reserved intent by event
  /// scan - landed means confirm and KEEP the hold, provably not landed means
  /// fail and release - so hold release and intent resolution become one
  /// decision, because "did the transfer land?" is one question. ruled
  /// UTC; the contract change rides the post-#14 PR.

  /// The whole reservation row, for reconciliation (spec S4 "Intents").
  /// One wallet's intent, by BOTH coordinates.
  ///
  /// The ownership question stops being a comparison and becomes the lookup:
  /// asking under your own id can only ever return your own row. Before v8 the
  /// row came back by id alone and `getIntent` compared its `agent_id` to the
  /// principal - which, once two wallets can use one string, answers
  /// `unknown_intent` for a caller's OWN intent whenever somebody else's row is
  /// the one the id happens to find.
  intentRecord(agentId: string, intentId: string): {
    agentId: string;
    txHash: string | null;
    emissions: number;
    firstTx: string | null;
    firstFrom: string | null;
  } | null {
    const row = this.db
      .query(
        `SELECT agent_id, tx_hash, emissions, first_tx, first_from
         FROM intents WHERE agent_id = ? AND intent_id = ?`,
      )
      .get(agentId, intentId) as
      | { agent_id: string; tx_hash: string | null; emissions: number; first_tx: string | null; first_from: string | null }
      | null;
    return row
      ? {
          agentId: row.agent_id,
          txHash: row.tx_hash,
          emissions: row.emissions,
          firstTx: row.first_tx,
          firstFrom: row.first_from,
        }
      : null;
  }

  /// Records one IntentTransfer against the intent that authorised it, and
  /// answers whether THIS emission makes the intent anomalous.
  ///
  /// Only emissions matching an intent WE RESERVED are counted (ruled).
  /// An id nobody here reserved is another party's traffic on a shared chain,
  /// or a direct caller moving their own funds under a self-chosen id - neither
  /// is the game's double-spend, which is reusing a RESERVED allotment to land
  /// the same authorised spend twice. The split-brain case stays inside the
  /// scope: a retry carries the idempotency key, so BOTH stores reserve the
  /// same intent id and each one's count reaches two.
  ///
  /// Idempotent on (topic, txHash): the tail can re-see a block without
  /// double-counting, which matters because the cursor is only advanced after
  /// a successful pass.
  recordEmission(args: {
    topic: string;
    txHash: string;
    from: string | null;
    /// Whether the contract that emitted this is the one THIS INTENT WAS ISSUED
    /// FOR. Required rather than defaulted, so a new caller cannot silently
    /// claim it was.
    ///
    /// RENAMED FROM `isDefaultToken` BY THE CALL INCREMENT, and the rename is
    /// the whole change - the meaning was always this one, and "the default
    /// token" was merely the only expected emitter there could be while every
    /// intent was a transfer. Now an intent may be a CALL, and its expected
    /// emitter is the contract it was reserved for. The caller computes it
    /// (events.ts), because only the caller knows the registry; `foreign_token`
    /// keeps its name because the meaning is unchanged: an emission from a
    /// contract other than the one this intent was issued for.
    isExpectedEmitter: boolean;
  }): {
    anomalous: boolean;
    /// `repeat_emission` - two or more for one intent; `foreign_sender` - an
    /// emission under our intent id from an address that is not the reserving
    /// wallet; `foreign_token` - an emission from a token instance this intent
    /// was not issued for. Different causes, different instructions to the
    /// facilitator.
    reason: 'repeat_emission' | 'foreign_sender' | 'foreign_token';
    agentId: string;
    /// 'caller', 'server', or null for a row written before the column existed.
    idSource: string | null;
    emissions: number;
    transfers: Array<{ txHash: string; from: string | null }>;
  } | null {
    const { topic, txHash, from, isExpectedEmitter } = args;
    const apply = this.db.transaction(() => {
      const intent = this.db
        .query(`SELECT intent_id, agent_id, emissions, first_tx, first_from, id_source FROM intents WHERE topic = ?`)
        .get(topic) as
        | {
            intent_id: string;
            agent_id: string;
            emissions: number;
            first_tx: string | null;
            first_from: string | null;
            id_source: string | null;
          }
        | null;
      if (!intent) return null; // not an intent this store reserved

      // Already counted this exact emission.
      if (intent.first_tx === txHash) return null;
      const already = this.db
        .query(`SELECT 1 AS present FROM intent_anomalies WHERE topic = ? AND tx_hash = ?`)
        .get(topic, txHash);
      if (already) return null;

      // AFTER the three early returns above and BEFORE the emissions count,
      // and the position is the whole behaviour:
      //
      //   - after `!intent`, so an emission under an id THIS STORE NEVER
      //     RESERVED is not an anomaly. Every ordinary transfer of a second
      //     token - and now every event of every registered contract - would
      //     otherwise be one.
      //   - after the first-tx and intent_anomalies dedupes, so one foreign
      //     emission is reported ONCE rather than on every poll that sees it.
      //   - before the emissions count, so it is flagged whether or not this is
      //     the first sighting of the id.
      if (!isExpectedEmitter) {
        this.db
          .query(`INSERT INTO intent_anomalies (topic, tx_hash, from_addr, seen_at) VALUES (?, ?, ?, ?)`)
          .run(topic, txHash, from, Date.now());
        return {
          anomalous: true,
          reason: 'foreign_token' as const,
          agentId: intent.agent_id,
          idSource: intent.id_source,
          emissions: intent.emissions,
          transfers: [{ txHash, from }],
        };
      }

      if (intent.emissions === 0) {
        this.db
          .query(`UPDATE intents SET emissions = 1, first_tx = ?, first_from = ? WHERE topic = ?`)
          .run(txHash, from, topic);

        // A FIRST emission is normal - unless it came from somewhere else.
        // `transferWithIntent` is permissionless, so an IntentTransfer under
        // our id from an address that is not the reserving wallet is somebody
        // spending against our intent, not our transfer landing. That is an
        // anomaly on the first emission, and it is why the positive branch of
        // the sweep must constrain the sender as well as the id.
        const wallet = this.spawnedAddress(intent.agent_id);
        if (wallet && from && from.toLowerCase() !== wallet.toLowerCase()) {
          return {
            anomalous: true,
            reason: 'foreign_sender' as const,
            agentId: intent.agent_id,
            idSource: intent.id_source,
            emissions: 1,
            transfers: [{ txHash, from }],
          };
        }
        return null;
      }

      this.db
        .query(`INSERT INTO intent_anomalies (topic, tx_hash, from_addr, seen_at) VALUES (?, ?, ?, ?)`)
        .run(topic, txHash, from, Date.now());
      const emissions = intent.emissions + 1;
      this.db.query(`UPDATE intents SET emissions = ? WHERE topic = ?`).run(emissions, topic);

      const extras = this.db
        .query(`SELECT tx_hash, from_addr FROM intent_anomalies WHERE topic = ? ORDER BY seen_at`)
        .all(topic) as Array<{ tx_hash: string; from_addr: string | null }>;

      return {
        anomalous: true,
        reason: 'repeat_emission' as const,
        agentId: intent.agent_id,
        idSource: intent.id_source,
        emissions,
        transfers: [
          { txHash: intent.first_tx ?? '', from: intent.first_from },
          ...extras.map((e) => ({ txHash: e.tx_hash, from: e.from_addr })),
        ],
      };
    });
    return apply();
  }

  /// Ages a reservation, so a test can express a retention rule keyed on TIME
  /// rather than on stage. Test-only: every row a test creates is seconds old,
  /// so a wall-clock TTL is the one variant of "emission rows are immortal"
  /// that no ordinary fixture can reach.
  backdateIntentForTest(agentId: string, intentId: string, createdAt: number): void {
    this.db
      .query(`UPDATE intents SET created_at = ? WHERE agent_id = ? AND intent_id = ?`)
      .run(createdAt, agentId, intentId);
  }

  /// Intents this store reserved that have no recorded transaction, with the
  /// chain head observed before each reservation. The sweep's input.
  ///
  /// NO CURRENT CONSUMER. `reservedAtBlock` is recorded and read by nothing.
  ///
  /// Saying so plainly, because this comment used to claim it was "the lower
  /// bound that makes absence evidence" - true until the `#34` NO-GO removed
  /// the sweep's negative branch, which was its only reader. The writer, the
  /// column, the `observedHead` machinery feeding it, the SELECT and the
  /// justification all survived the removal of the thing they existed for.
  ///
  /// KEPT DELIBERATELY, and for a stronger reason than "a future branch might
  /// want it": the recorded future nonce-based negative branch needs the
  /// reserve-time head as its FLOOR - where scanning starts, the one thing a
  /// floor is for - and THAT VALUE IS IRRECOVERABLE IF NOT STAMPED AT RESERVE
  /// TIME. Deleting the column saves a write and throws away history that
  /// cannot be reconstructed later, so that PR would have to begin from a
  /// table which has never held one.
  ///
  /// It stays a sound floor because the reservation strictly precedes the
  /// broadcast: tx_block >= head at broadcast >= head at reserve. Null when the
  /// tail has not polled yet, and the future consumer must treat null as
  /// "cannot bound" rather than as zero - zero would make every absence look
  /// like evidence, which is the shape of the defect that removed the branch.
  unresolvedIntents(): Array<{
    intentId: string;
    topic: string | null;
    agentId: string;
    emissions: number;
    firstTx: string | null;
    firstFrom: string | null;
    reservedAtBlock: bigint | null;
  }> {
    // THE WORKING SET, not the whole table. Rows are NEVER deleted - the
    // idempotency key's lifetime is the game's - but the sweep only has work to
    // do for intents reserved in the CURRENT stage.
    //
    // A row whose stage has rolled over has already had its hold cleared by
    // construction, because stage spend is keyed by (agent_id, stage) and the
    // current stage's bucket is a different row. All that remains for it is a
    // best-effort positive resolve, which nobody is waiting on. Skipping it
    // bounds the sweep's COST without touching the table's contents: the table
    // still grows, and the id still answers `duplicate` for ever.
    //
    // A skip, not a retention delete. Those look similar and are opposites: one
    // stops doing work, the other destroys the record that makes a retry safe.
    const rows = this.db
      .query(
        `SELECT intent_id, topic, agent_id, emissions, first_tx, first_from, reserved_at_block
         FROM intents WHERE tx_hash IS NULL AND stage = ?`,
      )
      .all(this.currentStage()) as Array<{
      intent_id: string;
      topic: string | null;
      agent_id: string;
      emissions: number;
      first_tx: string | null;
      first_from: string | null;
      reserved_at_block: string | null;
    }>;
    return rows.map((r) => ({
      intentId: r.intent_id,
      topic: r.topic,
      agentId: r.agent_id,
      emissions: r.emissions,
      firstTx: r.first_tx,
      firstFrom: r.first_from,
      reservedAtBlock: r.reserved_at_block === null ? null : BigInt(r.reserved_at_block),
    }));
  }

  /// WHICH CONTRACT an intent was reserved for, found by the topic the chain
  /// logs rather than by the intent id.
  ///
  /// The event tail only ever holds a topic - `keccak256(intentId)` is what
  /// goes into the calldata and comes back in the log - so a lookup by id
  /// cannot serve it. Null means "a transfer intent, or none of ours", and the
  /// caller separates those by whether it found an intent at all.
  /// WHAT THE CHAIN'S LOG SHOULD HAVE COME FROM, by the topic it carries.
  ///
  /// ONE QUERY FOR BOTH COORDINATES, because they answer one question between
  /// them: a CALL intent expects its emission from the contract it named, and a
  /// TRANSFER intent expects it from the token it moved. Two queries would be
  /// two chances for a caller to use one and forget the other - and the one
  /// they would forget is the token, because it is the newer of the two.
  ///
  /// Null for an intent this store never reserved, which the caller separates
  /// from "reserved with no token" by looking at whether either field came back.
  intentRouting(topic: string): { callContract: string | null; token: string | null } | null {
    const row = this.db
      .query(`SELECT call_contract, token FROM intents WHERE topic = ?`)
      .get(topic) as { call_contract: string | null; token: string | null } | null;
    return row ? { callContract: row.call_contract, token: row.token } : null;
  }

  /// Which wallet reserved the intent the chain logged under this topic, for
  /// the anomaly payload. Null when the topic belongs to no reservation here -
  /// which is itself the interesting case, because it means the transfer came
  /// from somewhere this store has never seen.
  agentForIntentTopic(topic: string): string | null {
    const row = this.db.query(`SELECT agent_id FROM intents WHERE topic = ?`).get(topic) as
      | { agent_id: string }
      | null;
    return row?.agent_id ?? null;
  }

  /// Whether the intent id was CALLER-supplied or SERVER-generated.
  ///
  /// Exposed because the distinction is READ, not merely recorded: the anomaly
  /// payload carries it so an operator can tell a guessable id being guessed
  /// from a chain-svc uuid being quoted, which are different stories about how
  /// somebody learned it. A test that can see the column is what keeps the two
  /// from silently becoming one.
  /// The same row for a PLATFORM caller, which has no wallet coordinate to ask
  /// with - the route takes an id and nothing else.
  ///
  /// EXACTLY ONE OR NOTHING. If two wallets have used the string, this answers
  /// null and the operator gets the same `unknown_intent` as for an id nobody
  /// used. That is deliberate: returning either row would be picking one
  /// wallet's intent to represent both, and refusing differently would make the
  /// reply an existence oracle for the collision. Absence and ambiguity are one
  /// answer here for the same reason absence and not-yours already were.
  ///
  /// The consequence, stated rather than buried: an operator asking about an id
  /// two wallets used is told there is no such intent. Nothing calls this path
  /// today - wallet-mcp is the only caller of GET /intents/:id and it is always
  /// wallet scope - so this is a shape decision, not a behaviour change anybody
  /// is relying on. If the operator needs to name the wallet, that is a route
  /// parameter and a separate decision.
  intentRecordUnambiguous(intentId: string): {
    agentId: string;
    txHash: string | null;
    emissions: number;
    firstTx: string | null;
    firstFrom: string | null;
  } | null {
    const rows = this.db
      .query(
        `SELECT agent_id, tx_hash, emissions, first_tx, first_from
         FROM intents WHERE intent_id = ? LIMIT 2`,
      )
      .all(intentId) as Array<{
      agent_id: string;
      tx_hash: string | null;
      emissions: number;
      first_tx: string | null;
      first_from: string | null;
    }>;
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      agentId: row.agent_id,
      txHash: row.tx_hash,
      emissions: row.emissions,
      firstTx: row.first_tx,
      firstFrom: row.first_from,
    };
  }

  /// THE TOPIC THIS INTENT WAS RESERVED WITH, read back rather than re-derived.
  ///
  /// Every broadcast takes its bytes32 from here (v8, finding 1). The
  /// derivation changed at v8 - it is the hash of both coordinates now - so a
  /// store can hold rows written either side of it, and a broadcast that
  /// re-derived would put a topic on chain that the row does not carry. The
  /// emission would then match nothing, `recordEmission` would return null as
  /// for an intent this store never reserved, and the intent would sit on the
  /// reconciliation path for ever with a transfer that really happened.
  ///
  /// NULL MEANS NO ROW OR NO TOPIC, and the caller decides: an intent reserved
  /// before topics existed has none, and that is a different thing from a
  /// reservation that is not there at all.
  intentTopicOf(agentId: string, intentId: string): string | null {
    const row = this.db
      .query(`SELECT topic FROM intents WHERE agent_id = ? AND intent_id = ?`)
      .get(agentId, intentId) as { topic: string | null } | null;
    return row?.topic ?? null;
  }

  intentIdSource(agentId: string, intentId: string): string | null {
    const row = this.db
      .query(`SELECT id_source FROM intents WHERE agent_id = ? AND intent_id = ?`)
      .get(agentId, intentId) as
      | { id_source: string | null }
      | null;
    return row?.id_source ?? null;
  }

  /// WHICH TOKEN an intent was reserved in.
  ///
  /// Read by the event tail: the expected emitter for a transfer intent is that
  /// intent's OWN token, not the deployment's default - which is what makes a
  /// second token's IntentTransfer an ordinary emission and a cross-token one
  /// an anomaly.
  intentToken(agentId: string, intentId: string): string | null {
    const row = this.db
      .query(`SELECT token FROM intents WHERE agent_id = ? AND intent_id = ?`)
      .get(agentId, intentId) as
      | { token: string | null }
      | null;
    return row?.token ?? null;
  }

  intentTxHash(agentId: string, intentId: string): string | null {
    const row = this.db
      .query(`SELECT tx_hash FROM intents WHERE agent_id = ? AND intent_id = ?`)
      .get(agentId, intentId) as
      | { tx_hash: string | null }
      | null;
    return row?.tx_hash ?? null;
  }

  /// Give a reservation back — BOTH halves — when the send it was taken for
  /// PROVABLY did not happen.
  ///
  /// THE RELEASE RULE, and it is one rule for both halves on purpose: release
  /// only on a failure that provably PRECEDES the broadcast. Anything at or
  /// after it keeps the reservation and needs reconciliation against the chain.
  ///
  /// Reasoning about the two halves separately gives opposite answers, which is
  /// how this goes wrong: for the stage cap "release on error" reads obviously
  /// right, while for the intent releasing on error IS the double-spend —
  /// because "error" includes "it landed and the response was lost", which is
  /// the exact case an idempotency key exists for. The single rule is also the
  /// conservative direction for the cap: on an ambiguous outcome, keeping risks
  /// under-spending and releasing risks exceeding a boundary.
  ///
  /// If you find yourself writing a second release path that reasons about the
  /// intent separately from the cap, stop — that is the tell.
  /// Give a reservation back - BOTH halves - when the send it was taken for
  /// PROVABLY did not happen. See THE RELEASE RULE below.
  ///
  /// TAKES ONLY AN INTENT ID. Every other coordinate comes from the row: which
  /// wallet, which stage, how much was held. That is A1's principle finished
  /// rather than applied once - the first fix stopped trusting the caller's
  /// AMOUNT and went on trusting its idea of WHICH AGENT and WHICH STAGE, from
  /// the same SELECT that already knew both.
  ///
  /// Not reachable while `signTransfer` passes the same two variables to
  /// `reserve` and `release` - which is exactly where the previous guard sat
  /// before `capWei: null` existed. It separates for a second caller, for a
  /// caller whose stage moves mid-request (`currentStage()` can change once
  /// hub-core is configured), and for the scan-gated sweep, which by
  /// construction RECONSTRUCTS these coordinates instead of remembering them.
  release(agentId: string, intentId: string): void {
    const undo = this.db.transaction((): void => {
      const row = this.db
        .query(
          `SELECT agent_id, stage, held_wei, token, call_contract, call_function
           FROM intents WHERE agent_id = ? AND intent_id = ? AND tx_hash IS NULL`,
        )
        .get(agentId, intentId) as {
        agent_id: string;
        stage: string;
        held_wei: string;
        token: string | null;
        call_contract: string | null;
        call_function: string | null;
      } | null;
      if (!row) return;

      // FINDING 12: A HELD INTENT WITH NO TOKEN IS NOT RELEASABLE, and the
      // check has to run BEFORE the delete.
      //
      // The refund below already declined to give back a hold whose currency
      // the row does not name - correctly, since releasing it against a guess
      // would credit budget in a currency it was never taken in. But the DELETE
      // ran first, so the intent id was freed while its hold stayed consumed:
      // the wallet lost the budget permanently AND the id became reusable,
      // which is the worse half. The reservation stays whole instead.
      //
      // Reachable only for a row written before v7 whose backfill did not reach
      // it - which the migration refuses to produce - so this is a guard on a
      // state the code says cannot exist, kept because the cost of being wrong
      // about that is a silent permanent debit. Logged by ID so an operator who
      // meets it has something to act on.
      const heldWei = BigInt(row.held_wei);
      if (heldWei > 0n && row.token === null) {
        console.warn(
          `[chain-svc] intent ${intentId} of ${agentId} holds ${row.held_wei} wei in a currency ` +
            `its row does not name, so it cannot be released; the reservation is left standing. ` +
            `This row predates the per-token rekey and needs an operator.`,
        );
        return;
      }

      // The `tx_hash IS NULL` here is REDUNDANT with the SELECT above, which
      // already returned for a completed intent - deliberately kept, because it
      // is the statement that would do the damage if the guard above ever moved
      // or changed shape. A mutation that removes it survives, and that is
      // correct rather than a coverage gap: it describes a change the code
      // cannot express while the early return stands.
      this.db
        .query(`DELETE FROM intents WHERE agent_id = ? AND intent_id = ? AND tx_hash IS NULL`)
        .run(agentId, intentId);

      const held = heldWei;
      // THE TOKEN COMES FROM THE ROW, like every other coordinate `release`
      // uses. A caller supplying it could give back a hold against a currency
      // it was never taken in - which would leave the real hold standing and
      // credit budget in another.
      //
      // Null with a hold cannot reach here any more - the guard above returns
      // before the delete - so this pair is now "a zero hold, or a token to
      // release it in". Kept as a pair rather than narrowed to `held > 0n`,
      // because it is the statement that would do the damage if that guard ever
      // moved, exactly as the redundant `tx_hash IS NULL` below it is.
      if (held > 0n && row.token !== null) {
        this.releaseStageSpend(row.agent_id, row.stage, row.token, held);
      }

      // THE THIRD HALF, found the same way as the other two: from the row, not
      // from what the caller remembers. `release(intentId)` takes one
      // coordinate on purpose - a caller that supplies its own idea of which
      // entry was counted is a caller that can be wrong about it, and the row
      // is the only record of what was actually reserved.
      //
      // An entry with no limit wrote no row, so this decrements nothing and the
      // clamp handles it - as it does for an intent reserved before v6 and
      // released after the upgrade.
      if (row.call_contract !== null && row.call_function !== null) {
        this.releaseCallCount(row.agent_id, row.stage, row.call_contract, row.call_function);
      }
    });
    undo();
  }

  /// How many times this wallet has called this entry this stage. Zero when no
  /// row exists, which is also what an entry with no limit always reports.
  callCount(agentId: string, stage: string, contract: string, fn: string): number {
    const row = this.db
      .query(
        `SELECT count FROM call_counts
         WHERE agent_id = ? AND stage = ? AND contract = ? AND function = ?`,
      )
      .get(agentId, stage, contract, fn) as { count: number } | null;
    return row?.count ?? 0;
  }

  /// What an intent was reserved FOR, or null when it was a transfer.
  ///
  /// The replay check reads this: chain-svc answers a repeated intent id with
  /// the ORIGINAL transaction hash, which is right only if the repeat is the
  /// same call. A repeat under the same id with different arguments is a
  /// different call wearing a used id, and returning the first call's hash
  /// would tell the caller their second call had succeeded.
  intentCall(
    agentId: string,
    intentId: string,
  ): { contract: string; function: string; argsHash: string } | null {
    const row = this.db
      .query(
        `SELECT call_contract, call_function, call_args_hash
         FROM intents WHERE agent_id = ? AND intent_id = ?`,
      )
      .get(agentId, intentId) as
      | { call_contract: string | null; call_function: string | null; call_args_hash: string | null }
      | null;
    if (!row || row.call_contract === null || row.call_function === null) return null;
    return {
      contract: row.call_contract,
      function: row.call_function,
      argsHash: row.call_args_hash ?? '',
    };
  }

  /// PRIVATE, for the reason `releaseStageSpend` is: `release` is the one door
  /// the release rule guards, and a second public way to give a count back
  /// would be a second door past a guard that cannot see it.
  private releaseCallCount(agentId: string, stage: string, contract: string, fn: string): void {
    const current = this.callCount(agentId, stage, contract, fn);
    // CLAMPED AT ZERO AND UNREACHABLE BY CONSTRUCTION, recorded as such rather
    // than left looking like a live defence - the same statement the stage-hold
    // clamp above carries, and for the same reason. A count row is only ever
    // written at 1 or above, and a release requires an UNCOMPLETED intent row
    // which the same transaction deletes, so there cannot be more releases than
    // reservations for one entry. A mutation that weakens this to `< 0`
    // SURVIVES the suite, and that is correct rather than a coverage gap: it
    // describes a state no sequence of calls can produce, and the isolating
    // test it would need would have to write that state directly, which would
    // be a test of SQLite rather than of this.
    if (current <= 0) return;
    this.db
      .query(
        `UPDATE call_counts SET count = ?
         WHERE agent_id = ? AND stage = ? AND contract = ? AND function = ?`,
      )
      .run(current - 1, agentId, stage, contract, fn);
  }

  /// PRIVATE, and that is load-bearing rather than tidiness. `release` is the
  /// one door the release rule guards, and `treasury.ts` has a test asserting
  /// exactly one `.release(` call outside the pre-broadcast branch. That guard
  /// cannot see `.releaseStageSpend(` - `.release(` is not a substring of it -
  /// so while this was public a second post-broadcast refund path could be
  /// added and the structural test would stay green. One door, one guard.
  private releaseStageSpend(agentId: string, stage: string, token: string, amount: bigint): void {
    const release = this.db.transaction((): void => {
      const current = this.spentThisStage(agentId, stage, token);
      // Clamped at zero, and now UNREACHABLE BY CONSTRUCTION rather than
      // defence against a live path - recorded because the previous comment
      // implied a reachability that no longer exists.
      //
      // It could fire while `release` took the amount from its CALLER: naming
      // more than was reserved drove the spend negative, and a negative spend
      // reads as the wallet owing budget, which admits MORE spending. A5 made
      // `release` derive the amount from the row, so the only caller now passes
      // exactly what was recorded and the subtraction cannot overshoot. Kept
      // because `releaseStageSpend` would be reachable again the moment
      // something else calls it with a figure of its own.
      const next = current > amount ? current - amount : 0n;
      this.db
        .query(
          `INSERT INTO stage_spend (agent_id, stage, token, spent) VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id, stage, token) DO UPDATE SET spent = excluded.spent`,
        )
        .run(agentId, stage, token, next.toString());
    });
    release();
  }

  // --- cursors ------------------------------------------------------------

  /// The highest chain head the tail has OBSERVED, distinct from the cursor.
  ///
  /// The cursor says how far the tail has PROCESSED; this says how far it has
  /// LOOKED. Only the second is a sound lower bound for a reservation, and the
  /// difference is exactly the window a transfer lands in:
  ///
  ///     tx_block >= head at broadcast >= head at reserve >= observed head
  ///
  /// `cursor_now > cursor_at_reserve` does NOT imply the tail passed the
  /// transaction's block. `cursor_now >= observed_head_at_reserve` does.
  ///
  /// NO CURRENT CONSUMER. The one caller is `treasury.ts`'s reserve, which
  /// stamps `reserved_at_block`, which nothing reads - see that column. The
  /// arithmetic above is what the value MEANS, not a dependency anything has
  /// today; it is kept because the floor is irrecoverable after the fact.
  observedHead(): bigint | null {
    return this.getCursor('chain-observed-head');
  }

  setObservedHead(block: bigint): void {
    const current = this.observedHead();
    if (current === null || block > current) this.setCursor('chain-observed-head', block);
  }

  getCursor(name: string): bigint | null {
    const row = this.db.query(`SELECT value FROM cursors WHERE name = ?`).get(name) as { value: string } | null;
    return row ? BigInt(row.value) : null;
  }

  setCursor(name: string, value: bigint): void {
    this.db
      .query(`INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`)
      .run(name, value.toString());
  }

  // --- outbox ------------------------------------------------------------

  /// @returns how many events were dropped to stay under the cap (0 normally).
  /// FINDING 28. ONE TRANSACTION, and `chain.anomaly` rows are never evicted.
  ///
  /// Two faults in three statements. The insert, the count and the delete ran
  /// separately, so two concurrent enqueues both counted a buffer that was
  /// already over, both computed the same excess, and the second deleted rows
  /// the first had already removed - evicting twice the overflow and taking
  /// live events with it.
  ///
  /// And the eviction took the OLDEST row whatever it was. `chain.anomaly` is
  /// the one event kind that means something went wrong - a double emission
  /// under an intent this store reserved - and it is also, by construction, the
  /// kind most likely to be sitting in a buffer that is overflowing, because
  /// whatever produced the flood produced it too. The detector's whole output
  /// was the first thing discarded.
  ///
  /// Anomalies are not exempt from the CAP, only from being chosen: if the
  /// buffer is nothing but anomalies the delete removes none and the buffer
  /// grows, which is the right failure - an operator with ten thousand
  /// anomalies queued has a problem that silence would not fix.
  enqueueEvent(kind: string, payload: unknown): number {
    return this.db.transaction((): number => {
      this.db
        .query(`INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)`)
        .run(kind, JSON.stringify(payload), Date.now());

      const count = (this.db.query(`SELECT COUNT(*) AS n FROM outbox`).get() as { n: number }).n;
      if (count <= MAX_BUFFERED_EVENTS) return 0;

      const excess = count - MAX_BUFFERED_EVENTS;
      const evicted = this.db
        .query(
          `DELETE FROM outbox WHERE id IN (
             SELECT id FROM outbox WHERE kind != 'chain.anomaly' ORDER BY id ASC LIMIT ?
           )`,
        )
        .run(excess);
      // WHAT WAS ACTUALLY REMOVED, not what was asked for. With anomalies
      // exempt the two can differ, and the caller logs this number - reporting
      // an eviction that did not happen would send an operator looking for
      // events that are still there.
      return Number(evicted.changes);
    })();
  }

  dueEvents(limit: number, now = Date.now()): OutboundEvent[] {
    return this.db
      .query(
        `SELECT id, kind, payload, attempts FROM outbox
         WHERE next_attempt_at <= ? ORDER BY id ASC LIMIT ?`,
      )
      .all(now, limit) as OutboundEvent[];
  }

  eventDelivered(id: number): void {
    this.db.query(`DELETE FROM outbox WHERE id = ?`).run(id);
  }

  /// Exponential backoff, capped: a sink that is down for an hour must not
  /// produce an hour of retry traffic, and must not stall forever either.
  eventFailed(id: number, now = Date.now()): void {
    const row = this.db.query(`SELECT attempts FROM outbox WHERE id = ?`).get(id) as { attempts: number } | null;
    if (!row) return;
    const attempts = row.attempts + 1;
    const delay = Math.min(2 ** Math.min(attempts, 10) * 1000, 5 * 60_000);
    this.db.query(`UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, now + delay, id);
  }

  pendingEventCount(): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM outbox`).get() as { n: number }).n;
  }
}
