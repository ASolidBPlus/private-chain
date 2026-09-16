// chain-svc entrypoint: validate the environment, prove the chain is the
// private one, then serve. Every failure here is fatal on purpose - a service
// that starts in a half-configured state holds every wallet key in the game.

import { loadConfig } from './config.ts';
import { Chain, assertPrivateChain, assertPrivateRpcUrl, loadDeployment } from './chain.ts';
import { TokenAbi } from './abi.ts';
import { buildModules, describeModules, requireNames } from './modules.ts';
import { Keystore } from './keystore.ts';
import { Resolver } from './resolver.ts';
import { loadPolicyDefaults } from './policy.ts';
import { Spawner } from './spawn.ts';
import { Store } from './store.ts';
import { assertLedgerLifetimeIntact, assertLedgerNotRestored, gatherLifetimeFacts } from './migrate.ts';
import { assertDeploymentUnchanged } from './deployment.ts';
import { Treasury } from './treasury.ts';
import { EventTail } from './events.ts';
import { createChainSvcServer } from './server.ts';
import { CallPolicy } from './calls.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  // Before anything dials out: this must never emit a request to a public node.
  assertPrivateRpcUrl(config.rpcUrl);

  const deployment = loadDeployment(config.deploymentsDir);
  const chain = new Chain(config, deployment);

  await assertPrivateChain(chain);

  // AFTER the private-chain assertion and BEFORE anything that reads a module.
  // It dials the chain once per token instance, so it must not run against a
  // node this service has refused; and every later step - the identity, the
  // lifetime probe, the resolver, the routes - asks `chain.modules` a question.
  chain.modules = await buildModules(deployment, async (address) => {
    const [symbol, decimals] = await Promise.all([
      chain.publicClient.readContract({ address, abi: TokenAbi, functionName: 'symbol' }),
      chain.publicClient.readContract({ address, abi: TokenAbi, functionName: 'decimals' }),
    ]);
    return { symbol: symbol as string, decimals: Number(decimals) };
  });

  const store = new Store(config.storePath);
  const keystore = new Keystore(config.keystoreDir, config.keystoreSecret);

  // BEFORE the service accepts a single request. A store-only wipe leaves this
  // process able to sign transfers for wallets whose consumed intent ids it has
  // forgotten and whose freezes it has released, so the check has to be a
  // precondition of starting rather than a warning printed beside it.
  //
  // `getCode` rather than the deployments file: the file says what was deployed
  // once, and the question here is what is on the chain NOW. A file describing
  // a chain that has been reset is exactly the stale artefact this control must
  // not be fooled by.
  // BEFORE the ledger check and before anything serves: a store pointed at a
  // chain it was not written against cannot resolve any name it recorded, so
  // every later check would be reasoning about a pairing that is already wrong.
  //
  // Recorded on a store that has never seen a deployment; compared on every
  // boot after. An acknowledgement permits the boot and does NOT update the
  // record - see deployment.ts.
  const liveDeployment = {
    chainId: String(deployment.chainId),
    modules: deployment.modules.map((m) => ({ kind: m.kind, key: m.key, address: m.address })),
  };
  const recordedDeployment = store.recordedDeployment();
  assertDeploymentUnchanged(recordedDeployment, liveDeployment, config.acknowledgeChainReset);
  if (recordedDeployment === null) store.recordDeployment(liveDeployment);

  const lifetime = await gatherLifetimeFacts({
      store,
      keystore,
      // The default token if there is one, else the registry. The control asks
      // "are the game's contracts on this chain?", and on a names-only
      // deployment the registry is the whole answer.
      getCode: () =>
        chain.publicClient.getCode({
          address: chain.modules.tokens[0]?.address ?? requireNames(chain.modules).address,
        }),
      acknowledged: config.acknowledgeLedgerReset,
    });
  // FINDING 22, AND THE ORDER IS PART OF IT. A restored store is a more
  // specific diagnosis than an empty one; an operator told the wrong one goes
  // looking in the wrong place.
  assertLedgerNotRestored(lifetime);
  assertLedgerLifetimeIntact(lifetime);
  // RECORDED AFTER BOTH CHECKS PASS, so a refused boot never moves the mark it
  // was refused against - otherwise the second attempt would start cleanly and
  // the operator would conclude the first was a glitch.
  await keystore.recordLedgerWatermark(lifetime.reservations);
  const resolver = new Resolver(chain, store);
  // KIND DEFAULTS ARE OPT-IN as of v0.8.0: unset means NONE, not the shipped
  // example, which nothing loads. Built ONCE and shared, so the spawner's rules
  // and the allowlist loader's warnings are about the same object rather than
  // two copies of it.
  const defaults = config.policyDefaultsPath
    ? loadPolicyDefaults(
        config.policyDefaultsPath,
        chain.modules.names?.tld,
        chain.modules.tokens.map((t) => t.key),
      )
    : null;
  const services = {
    config,
    chain,
    resolver,
    store,
    keystore,
    spawner: new Spawner(config, chain, keystore, store, resolver, defaults),
    treasury: new Treasury(
      config,
      chain,
      keystore,
      store,
      resolver,
      defaults,
      // The generic call op's allowlist, constructed here so the boot line is
      // written where an operator is looking. It reads the file per request; a
      // deployment with no calls.json boots with the op closed and says so.
      new CallPolicy(
        config.policyDir,
        chain.modules,
        (line) => console.warn(line),
        // The kind defaults, so the loader can warn about an entry whose amount
        // no kind in its `kinds` can pay through. Same object the spawner
        // writes wallets from, so the warning is about the rules that will
        // actually apply rather than about a second copy of them.
        defaults,
      ),
    ),
  };

  // Started before the server accepts requests, so a transfer cannot happen
  // before there is anything reading the log for it.
  const events = new EventTail(config, chain, store);
  await events.pollOnce().catch((err) => console.warn('chain-svc: initial event poll failed', err.message));
  events.start();

  const server = createChainSvcServer(services);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(
      `chain-svc listening on :${config.port} (chain ${deployment.chainId}, ` +
        `treasury ${deployment.treasury}, modules ${describeModules(chain.modules)}, ` +
        `events -> ${config.hubCoreUrl ?? 'buffered, no HUB_CORE_URL set'})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`chain-svc: ${signal}, shutting down`);
    events.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // A refusal carries a machine-readable code as well as its prose, so an
  // operator or a log search can find the CAUSE without parsing a paragraph.
  // "Refuse by name" is the requirement; the name has to reach the log.
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') console.error(`chain-svc: ${code}`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
