// The chain event tail (spec S4): every movement of money becomes a game event
// without any agent having to report it honestly.
//
// Two halves, deliberately separate:
//   POLL     - read Transfer and Registered logs since the stored cursor and
//              put them in the outbox. Durable, so a restart resumes instead of
//              replaying from genesis.
//   DELIVER  - drain the outbox to hub-core. hub-core does not exist until C5,
//              so this must tolerate an absent or unreachable sink FOREVER:
//              events buffer and retry with backoff, are never dropped
//              silently, and can never take chain-svc down.

import { parseEventLogs, type Abi } from 'viem';
import { NameRegistryAbi, TokenAbi } from './abi.ts';
import type { Chain } from './chain.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { formatVee } from './validate.ts';

const CURSOR = 'chain-log-tail';
const DELIVER_BATCH = 50;

/// A hung sink must not become an unbounded socket queue. The interval fires
/// regardless of whether the last pass finished, so without BOTH a timeout and
/// a re-entrancy flag a stalled hub-core accumulates one in-flight POST per
/// tick - in the process that holds every wallet key. Backoff cannot help: it
/// lives in the catch, and a hang is not a rejection.
const SINK_TIMEOUT_MS = 5_000;

export class EventTail {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deliverTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private droppedTotal = 0;
  /// Re-entrancy guards. `setInterval` does not wait for the previous pass.
  private polling = false;
  private delivering = false;

  constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    private readonly store: Store,
  ) {}

  /// Reads new logs into the outbox. Returns how many events were enqueued.
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      return await this.poll();
    } finally {
      this.polling = false;
    }
  }

  private async poll(): Promise<number> {
    const latest = await this.chain.publicClient.getBlockNumber();
    // NO CURRENT CONSUMER, and this is where a reader meets the mechanism
    // first, so: this per-second write feeds `reserved_at_block`, which nothing
    // reads - not even the sweep below. It is recorded whether or not this pass
    // finds anything because the reserve-time head cannot be recovered
    // afterwards. See the `reservedAtBlock` comment on Store.reserve.
    this.store.setObservedHead(latest);
    const from = (this.store.getCursor(CURSOR) ?? -1n) + 1n;
    if (from > latest) return 0;

    // ONE QUERY PAIR PER TOKEN INSTANCE, and the names query only when the
    // deployment has a registry. The list is built from `modules` rather than
    // from two fixed addresses, so a second token is polled by the same code
    // that polls the first - and a names-less deployment issues no Registered
    // query at all rather than one against the zero address.
    const { tokens, names } = this.chain.modules;

    const [perToken, registrations] = await Promise.all([
      Promise.all(
        tokens.map(async (token) => {
          const [transfers, intents] = await Promise.all([
            this.chain.publicClient.getContractEvents({
              address: token.address,
              abi: TokenAbi,
              eventName: 'Transfer',
              fromBlock: from,
              toBlock: latest,
            }),
            this.chain.publicClient.getContractEvents({
              address: token.address,
              abi: TokenAbi,
              eventName: 'IntentTransfer',
              fromBlock: from,
              toBlock: latest,
            }),
          ]);
          return { token, transfers, intents };
        }),
      ),
      names
        ? this.chain.publicClient.getContractEvents({
            address: names.address,
            abi: NameRegistryAbi,
            eventName: 'Registered',
            fromBlock: from,
            toBlock: latest,
          })
        : Promise.resolve([]),
    ]);

    let enqueued = 0;
    for (const { token, transfers } of perToken) {
      for (const log of transfers) {
        const args = log.args as { from?: string; to?: string; value?: bigint };
        if (!args.from || !args.to || args.value === undefined) continue;
        this.enqueue('chain.transfer', {
          kind: 'chain.transfer',
          from: args.from,
          to: args.to,
          vee: formatVee(args.value, token.decimals),
          // THE ONE ADDITIVE FIELD this increment puts on the wire. Taken now
          // rather than with the second token's endpoints, because a reader
          // that has to infer which token an amount belongs to will infer it
          // from the default and be silently wrong the day a second one moves.
          // An added named field breaks no reader of named fields.
          token: token.symbol,
          txHash: log.transactionHash,
        });
        enqueued++;
      }
    }
    // TWO OR MORE IntentTransfers for ONE intent id is an INVARIANT VIOLATION,
    // not a race to be retried. chain-svc broadcasts at most once per
    // reservation - one reservation, one signature, one nonce - and a
    // re-broadcast of that same signed transaction can be included only once.
    // So a second emission means something bypassed the reservation.
    //
    // COUNTED IN THE STORE, NOT GROUPED IN THIS FUNCTION. Grouping here saw
    // only ONE POLL'S WINDOW, so two emissions seconds apart - the realistic
    // shape, since two chain-svc instances do not coordinate their timing -
    // were each a group of one and nothing was raised. Every test built both
    // emissions inside a single pollOnce against a stub whose head never moved,
    // so the boundary was not a variable in any of them.
    //
    // Never reconciled silently (ruled): the money moved, so the intent
    // is confirmed and the hold KEPT, and a facilitator is told.
    for (const { token, intents } of perToken) {
    for (const log of intents) {
      const args = log.args as { intentId?: string; from?: string };
      if (!args.intentId || !log.transactionHash) continue;

      const anomaly = this.store.recordEmission({
        topic: args.intentId,
        txHash: log.transactionHash,
        from: args.from ?? null,
        // Increment 2 issues intents for the DEFAULT token only, so an
        // IntentTransfer from any other instance quoting one of our ids is a
        // foreign token spending against our reservation - the same class as a
        // foreign sender, and detected the same way.
        // THE EXPECTED EMITTER FOR THIS INTENT, not "is this the default
        // token". They coincided while every intent was a transfer, and the
        // call increment separated them: an intent reserved for a CALL expects
        // its emission from the contract it was reserved for. Computed here
        // because only this side knows the registry.
        isExpectedEmitter: this.isExpectedEmitter(args.intentId, token.address),
      });
      if (!anomaly) continue;

      this.enqueueAnomaly(args.intentId, anomaly, token.symbol);
      enqueued++;
    }
    }

    for (const log of registrations) {
      const args = log.args as { name?: string; owner?: string; target?: string };
      if (!args.name) continue;
      this.enqueue('chain.name', {
        kind: 'chain.name',
        name: args.name,
        owner: args.owner,
        target: args.target,
        txHash: log.transactionHash,
      });
      enqueued++;
    }

    enqueued += await this.pollGenericEvents(from, latest);

    // The cursor advances only after the events are in the outbox, so a crash
    // mid-poll re-reads the range rather than skipping it. That can duplicate
    // an event; losing one is worse, because the outcome feed is the record
    // nobody can lie to.
    this.store.setCursor(CURSOR, latest);
    return enqueued;
  }

  /// One anomaly payload, emitted by BOTH feeders.
  ///
  /// Extracted when the generic pass became the second one: the detector's
  /// findings are read by an operator, and two call sites writing the payload
  /// would drift in exactly the field somebody is looking for. `label` is the
  /// token's symbol for a transfer and the contract's key for a call - what the
  /// reader would name the emitter.
  private enqueueAnomaly(
    intentId: string,
    anomaly: {
      reason: string;
      agentId: string;
      idSource: string | null;
      emissions: number;
      transfers: Array<{ txHash: string; from: string | null }>;
    },
    label: string,
  ): void {
      const senders = anomaly.transfers.map((t) => t.from ?? 'unknown').join(', ');
      this.enqueue('chain.anomaly', {
        kind: 'chain.anomaly',
        intentId,
        agentId: anomaly.agentId,
        reason: anomaly.reason,
        // Whether the intent id was the CALLER'S or ours. The spec's question
        // for a foreign sender is intent-id PREDICTABILITY, and a facilitator
        // should not need a second lookup to answer it: a model-chosen id being
        // quoted by a stranger is a guessable id being guessed, and a
        // chain-svc:<uuid> being quoted is a different story entirely.
        idSource: anomaly.idSource,
        transfers: anomaly.transfers,
        token: label,
        detail:
          anomaly.reason === 'foreign_sender'
            ? `An IntentTransfer for this wallet's intent id was sent by ${senders}, which is ` +
              `not the wallet that reserved it. transferWithIntent is permissionless, so this is ` +
              `somebody spending THEIR OWN funds while quoting our intent id - it says nothing ` +
              `about this wallet's key, and the reservation is NOT resolved by it. Inspect that ` +
              `sender. The id was ${anomaly.idSource ?? 'of unrecorded origin'}` +
              (anomaly.idSource === 'caller'
                ? ', so it was chosen by the caller and may be guessable - that is the question to ask.'
                : ', so it was generated here and is not guessable, which makes how they learned it the question.')
            : `${anomaly.emissions} IntentTransfer events for one intent id. chain-svc broadcasts ` +
              `at most once per reservation, so this means the reservation was bypassed - most ` +
              `likely a second chain-svc with a separate store writing to this chain, or an ` +
              `out-of-band transfer reusing the id. The money moved; FREEZE THE NAMED WALLET ON ` +
              `CHAIN with admin-call setFrozen - the service-side lock is retirement now, and ` +
              `a frozen account cannot send even to someone holding its key, which is the case ` +
              `this advice is for. Then inspect the other sender. Senders: ${senders}.`,
      });
  }

  /// §5. Is this log's emitter the contract the intent was issued for?
  ///
  /// For a CALL intent it is the contract the allowlist entry named; for a
  /// transfer or fund intent it is the default token - which is exactly what
  /// `isDefaultToken` computed, so every existing case answers the same. An
  /// intent this store never reserved answers `true`, because `recordEmission`
  /// returns null for it before the flag is ever read, and answering `false`
  /// here would state something untrue about a topic we know nothing about.
  private isExpectedEmitter(topic: string, emitter: string): boolean {
    const routing = this.store.intentRouting(topic);
    // An intent this store never reserved. `recordEmission` returns null for
    // it BEFORE this flag is read, so the branch is unreachable by
    // construction - a mutation flipping it to `false` SURVIVES the suite, and
    // that is correct rather than a coverage gap: no sequence of polls can
    // reach a state where the answer matters. It is written as `true` anyway
    // because the alternative states something untrue about a topic we know
    // nothing about, and the day the early return in `recordEmission` moves,
    // this is the line that decides whether every stranger's event becomes an
    // anomaly.
    if (routing === null) return true;

    // A CALL expects the contract it named. A TRANSFER expects THE TOKEN IT
    // MOVED - not the default token, which is what this computed before there
    // could be more than one. That distinction is the whole of §4: a second
    // token's IntentTransfer is an ORDINARY emission, and a cross-token one
    // under the same id is the anomaly.
    const expected =
      routing.callContract !== null
        ? this.chain.modules.byKey.get(routing.callContract)?.address
        : routing.token !== null
          ? this.chain.modules.tokens.find((t) => t.key === routing.token)?.address
          : this.chain.modules.tokens[0]?.address;
    if (expected === undefined) return true;
    return emitter.toLowerCase() === expected.toLowerCase();
  }

  /// §5. EVERY event of EVERY registered contract, decoded generically.
  ///
  /// One `getLogs` over all registered addresses, then `parseEventLogs` per
  /// contract with that contract's ABI. The named passes above stay: they carry
  /// the shapes the game already reads - amounts formatted at the token's
  /// decimals, the anomaly detector's joins - and re-deriving those from a
  /// generic decode would be a second implementation of the same thing.
  ///
  /// SO THE TWO OVERLAP, and the overlap is removed by (address, eventName):
  /// `Transfer` and `IntentTransfer` on a token, `Registered` on the registry.
  /// Removed by ADDRESS as well as name, not by name alone - a custom contract
  /// is perfectly entitled to declare its own `Transfer`, and filtering by name
  /// would silently swallow it.
  ///
  /// UNDECODABLE LOGS ARE FOUND BY DIFFERENCE, because `parseEventLogs` DROPS
  /// a log that matches no event in the ABI it was given - measured - rather
  /// than reporting it. Dropping is right for "this log belongs to another
  /// contract" and wrong for "this contract emitted something its ABI does not
  /// declare", and only a diff can tell those apart. So every decoded log is
  /// marked by (txHash, logIndex) and whatever is left over is reported with
  /// its raw topics: a contract emitting something nobody can read is a fact a
  /// operator should see, not a silence.
  private async pollGenericEvents(from: bigint, latest: bigint): Promise<number> {
    const registered = this.chain.modules.contracts;
    if (registered.length === 0) return 0;

    const logs = await this.chain.publicClient.getLogs({
      address: registered.map((c) => c.address),
      fromBlock: from,
      toBlock: latest,
    });
    if (logs.length === 0) return 0;

    /// What the named passes above already enqueued, by (address, event).
    const alreadyNamed = new Set<string>();
    for (const token of this.chain.modules.tokens) {
      alreadyNamed.add(`${token.address.toLowerCase()}:Transfer`);
      alreadyNamed.add(`${token.address.toLowerCase()}:IntentTransfer`);
    }
    if (this.chain.modules.names) {
      alreadyNamed.add(`${this.chain.modules.names.address.toLowerCase()}:Registered`);
    }

    const seen = new Set<string>();
    const id = (log: { transactionHash?: string | null; logIndex?: number | null }) =>
      `${log.transactionHash ?? ''}:${log.logIndex ?? -1}`;
    let enqueued = 0;

    for (const contract of registered) {
      const mine = logs.filter((l) => l.address.toLowerCase() === contract.address.toLowerCase());
      if (mine.length === 0) continue;
      const decoded = parseEventLogs({ abi: contract.abi as Abi, logs: mine });

      for (const log of decoded) {
        seen.add(id(log));
        if (alreadyNamed.has(`${contract.address.toLowerCase()}:${log.eventName}`)) continue;

        const args = (log.args ?? {}) as Record<string, unknown>;
        this.enqueue('chain.event', {
          kind: 'chain.event',
          contract: contract.key,
          event: log.eventName,
          // Stringified, because a bigint has no JSON form and the outbox is
          // JSON. Every other lossy type survives round-tripping as itself.
          args: Object.fromEntries(
            Object.entries(args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
          ),
          txHash: log.transactionHash,
          blockNumber: String(log.blockNumber ?? 0n),
        });
        enqueued++;

        // §5. THE ANOMALY DETECTOR GAINS A SECOND FEEDER. Any decoded event
        // carrying a bytes32 named `intentId` - the Converter's `Converted`,
        // and anything else that follows the convention - is recorded exactly
        // as an IntentTransfer is, so a call's on-chain proof resolves its
        // intent and a foreign emission under its id is still caught.
        const intentId = args.intentId;
        if (typeof intentId === 'string' && log.transactionHash) {
          const anomaly = this.store.recordEmission({
            topic: intentId,
            txHash: log.transactionHash,
            // The event convention carries no sender field, and inventing one
            // from the transaction would be a different fact: `from` here means
            // "the address the CONTRACT named", and this one named none.
            from: null,
            isExpectedEmitter: this.isExpectedEmitter(intentId, contract.address),
          });
          // RAISED, not merely recorded. Discarding this return was the defect
          // a test caught: the detector wrote its row, the operator heard
          // nothing, and the feed said the call was ordinary.
          if (anomaly) {
            this.enqueueAnomaly(intentId, anomaly, contract.key);
            enqueued++;
          }
        }
      }
    }

    for (const log of logs) {
      if (seen.has(id(log))) continue;
      const contract = registered.find(
        (c) => c.address.toLowerCase() === log.address.toLowerCase(),
      );
      this.enqueue('chain.event', {
        kind: 'chain.event',
        contract: contract?.key ?? null,
        // NULL, not omitted: "this contract emitted something its own ABI does
        // not declare" is the fact, and a missing field would read as a decode
        // nobody attempted.
        event: null,
        topics: log.topics,
        data: log.data,
        txHash: log.transactionHash,
        blockNumber: String(log.blockNumber ?? 0n),
      });
      enqueued++;
    }

    return enqueued;
  }

  private enqueue(kind: string, payload: unknown): void {
    const dropped = this.store.enqueueEvent(kind, payload);
    if (dropped > 0) {
      this.droppedTotal += dropped;
      console.warn(
        `chain-svc: event buffer full, dropped ${dropped} oldest event(s) ` +
          `(${this.droppedTotal} total). hub-core has not accepted events for some time.`,
      );
    }
  }

  /// Resolves reservations the chain has already answered (spec S4).
  ///
  /// RESOLVE AND DETECT, NEVER RELEASE (ruled). There is one branch and
  /// it only ever moves an intent from unresolved to CONFIRMED:
  ///
  ///   an IntentTransfer for this intent FROM THE RESERVING WALLET means it
  ///   landed, so the intent is completed with that hash and the hold is KEPT,
  ///   because the money moved. The sender constraint is not optional -
  ///   `transferWithIntent` is permissionless, so an emission under our id
  ///   proves an event EXISTS, not that chain-svc made it.
  ///
  /// THERE IS DELIBERATELY NO NEGATIVE BRANCH, and the reason is worth more
  /// than the code it replaces. A first version failed intents when the cursor
  /// had passed the block recorded at reservation. That block is a LOWER bound
  /// - a transfer cannot be BELOW it - and the branch needed an UPPER one.
  /// Knowing the cursor is past the same floor says nothing about whether it is
  /// past the transaction. Worse, `cursor == bound` is the ORDINARY post-poll
  /// state, because a poll sets the observed head and the cursor to the same
  /// number, so a reservation taken just after a poll was failed by the very
  /// next sweep - refunding a hold for money that had moved and, because the
  /// fail path deleted the row, FREEING THE IDEMPOTENCY KEY. The retry then
  /// broadcast a second transfer: the double-charge, through the component
  /// added to prevent it.
  ///
  /// "Provably did not land" is not something scanning can establish at all: a
  /// signed transaction can sit in the mempool arbitrarily long, so absence is
  /// never proof of never. `held` is the terminal pessimistic state for a
  /// post-broadcast unknown, and it is not permanent - stage spend is keyed by
  /// (agent, stage), so a stuck hold clears at stage rollover. Pre-broadcast
  /// failures already release at send time, where the failure IS provable.
  ///
  /// WHAT A REAL NEGATIVE BRANCH WOULD NEED, recorded so the next person does
  /// not re-derive the lower-bound reasoning: the TRANSACTION NONCE on the row,
  /// plus proof that a DIFFERENT transaction consumed it - a nonce consumed by
  /// something else makes ours unlandable, which is the only true proof
  /// available. A nonce alone is NOT enough: an advanced nonce cannot separate
  /// "another transaction took ours" from "OURS landed and the emission is not
  /// indexed yet". Distinguishing them needs the head observed at the moment
  /// the nonce was seen to have advanced, and then waiting for the cursor to
  /// pass THAT. Two phases, two columns, and a money-surface PR of its own.
  async sweepOnce(): Promise<{ confirmed: number; held: number }> {
    let confirmed = 0;
    let held = 0;

    for (const intent of this.store.unresolvedIntents()) {
      const wallet = this.store.spawnedAddress(intent.agentId);
      const landed =
        intent.emissions > 0 &&
        intent.firstTx !== null &&
        wallet !== null &&
        intent.firstFrom !== null &&
        intent.firstFrom.toLowerCase() === wallet.toLowerCase();

      if (landed) {
        // BOTH COORDINATES, and `unresolvedIntents` already selects the agent
        // id - it is passed to `recordEmission` two lines from here. Keyed on
        // the id alone this UPDATE would stamp one wallet's tx hash onto
        // another wallet's open reservation.
        this.store.completeIntent(intent.agentId, intent.intentId, intent.firstTx!);
        confirmed++;
        continue;
      }
      held++;
    }

    return { confirmed, held };
  }

  /// Drains the outbox. Returns what happened, so a test can assert delivery
  /// rather than infer it from the absence of an error.
  async deliverOnce(): Promise<{ delivered: number; failed: number; skipped: boolean }> {
    if (!this.config.hubCoreUrl) return { delivered: 0, failed: 0, skipped: true };
    // Skipped, not queued: a pass that is still running will drain the outbox,
    // and stacking passes is the exhaustion this guard exists to stop.
    if (this.delivering) return { delivered: 0, failed: 0, skipped: true };
    this.delivering = true;
    try {
      return await this.deliver();
    } finally {
      this.delivering = false;
    }
  }

  private async deliver(): Promise<{ delivered: number; failed: number; skipped: boolean }> {

    const due = this.store.dueEvents(DELIVER_BATCH);
    let delivered = 0;
    let failed = 0;

    for (const event of due) {
      try {
        const res = await fetch(new URL('/events', this.config.hubCoreUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.token}` },
          body: event.payload,
          // A hang is not a rejection, so the catch below cannot see one
          // without this: the timeout is what turns "stalled for ever" into a
          // failure the backoff can act on.
          signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`hub-core replied ${res.status}`);
        this.store.eventDelivered(event.id);
        delivered++;
      } catch {
        // Backoff, keep the event. A sink that is down must not cost us the
        // record of what happened while it was down.
        this.store.eventFailed(event.id);
        failed++;
      }
    }
    return { delivered, failed, skipped: false };
  }

  /// The sweep runs FAR less often than the poll, and the difference is not a
  /// performance guess: the poll must keep up with the chain, while the sweep
  /// only resolves reservations the poll has ALREADY recorded. Running it at
  /// the poll's cadence would re-walk the same unresolved rows every second to
  /// learn nothing new, because nothing can change between polls that the poll
  /// did not itself record.
  start(pollMs = 1000, deliverMs = 1000, sweepMs = 30_000): void {
    // Failures are swallowed on purpose: the tail is a background reporter and
    // must never be able to stop the service that holds the wallets. That now
    // covers the sweep too, and it matters more there - the sweep touches the
    // intents table, and an exception escaping a timer would take the process
    // down with every wallet key in it.
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => console.warn('chain-svc: event poll failed', (err as Error).message));
    }, pollMs);
    this.deliverTimer = setInterval(() => {
      void this.deliverOnce().catch((err) => console.warn('chain-svc: event delivery failed', (err as Error).message));
    }, deliverMs);
    this.sweepTimer = setInterval(() => {
      void this.sweepOnce().catch((err) => console.warn('chain-svc: intent sweep failed', (err as Error).message));
    }, sweepMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.deliverTimer) clearInterval(this.deliverTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = null;
    this.deliverTimer = null;
    this.sweepTimer = null;
  }
}
