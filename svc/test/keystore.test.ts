import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { Keystore } from '../src/keystore.ts';
import { HttpError } from '../src/errors.ts';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'keystore-'));
}

describe('keystore', () => {
  it('round-trips a wallet key', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    const created = await ks.create('orch:vendor');
    const loaded = await ks.load('orch:vendor');

    expect(loaded.address).toBe(created.address);
    expect(loaded.privateKey).toBe(created.privateKey);
    expect(privateKeyToAccount(loaded.privateKey).address).toBe(created.address);
  }, 20_000);

  it('writes the file under the URL-encoded id, so no colon reaches a path', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:vendor');
    expect(() => readFileSync(join(dir, 'orch%3Avendor.json'), 'utf8')).not.toThrow();
  }, 20_000);

  it('never stores the private key in the clear', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    const { privateKey } = await ks.create('orch:vendor');
    const onDisk = readFileSync(join(dir, 'orch%3Avendor.json'), 'utf8');
    expect(onDisk).not.toContain(privateKey);
    expect(onDisk).not.toContain(privateKey.slice(2));
  }, 20_000);

  // A wallet whose key is replaced still owns its old balance and its registry
  // names, and nothing on chain would show the swap.
  it('refuses to overwrite an existing key file', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    await ks.create('orch:vendor');
    await expect(ks.create('orch:vendor')).rejects.toThrow(HttpError);
  }, 20_000);

  it('reports a missing wallet as wallet_not_found, not a crash', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    const err = await ks.load('orch:nobody').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('wallet_not_found');
  });

  it('refuses to decrypt with the wrong KEYSTORE_SECRET', async () => {
    const dir = freshDir();
    await new Keystore(dir, 'right-secret').create('orch:vendor');
    await expect(new Keystore(dir, 'wrong-secret').load('orch:vendor')).rejects.toThrow(HttpError);
  }, 20_000);

  // The address is stored in the clear for lookups, so it is editable by anyone
  // who can write the volume. Deriving it from the decrypted key and comparing
  // means a doctored file cannot redirect a transfer to an address the key does
  // not control - it fails loudly instead.
  // The stored address comes from the JSON, so its LENGTH is whatever the file
  // says. This used to be compared with timingSafeEqual, which throws
  // RangeError on a length mismatch - so a short doctored value escaped as an
  // unlabelled 500 instead of the refusal written for exactly this case. The
  // full-length case below always worked; only the short one did not.
  it('rejects a SHORT tampered address as a refusal, not a RangeError', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:vendor');

    const path = join(dir, 'orch%3Avendor.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as { address: string };
    file.address = '0xdeadbeef'; // deliberately not 42 characters
    writeFileSync(path, JSON.stringify(file));

    const err = await ks.load('orch:vendor').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('internal_error');
  }, 20_000);

  /// A truncated or doctored file is the same operator-visible problem as a
  /// wrong secret and gets the same labelled refusal, rather than a SyntaxError
  /// escaping to a bare 500 with no diagnostic.
  it('rejects a key file that is not JSON as a refusal', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:vendor');
    writeFileSync(join(dir, 'orch%3Avendor.json'), '{ truncated');

    const err = await ks.load('orch:vendor').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('internal_error');
  }, 20_000);

  /// Defence in depth - the contents are AES-256-GCM ciphertext - but this file
  /// is the agent's ability to spend, and there is no reason for it to be
  /// world-readable.
  it('writes the key file and its directory with restrictive modes', async () => {
    const dir = freshDir();
    await new Keystore(dir, 'secret').create('orch:vendor');

    expect(statSync(join(dir, 'orch%3Avendor.json')).mode & 0o777).toBe(0o600);
  }, 20_000);

  it('rejects a key file whose stored address was tampered with', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:vendor');

    const path = join(dir, 'orch%3Avendor.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as { address: string };
    file.address = '0x000000000000000000000000000000000000dEaD';
    writeFileSync(path, JSON.stringify(file));

    await expect(ks.load('orch:vendor')).rejects.toThrow(HttpError);
  }, 20_000);
});

// THE KDF PARAMETERS ARE THIS BUILD'S, NOT THE FILE'S.
//
// N, r and p set the COST of the derivation. Taking them from the key file lets
// the FILE choose how hard it is to brute-force itself - and a writer of the
// keystore volume is precisely the threat this encryption exists for, since a
// reader of the volume is exactly who must not get the keys. Rewrite N to 2,
// re-encrypt under that, and the service opens it without complaint: the work
// factor stops being a property of the service and becomes a property of the
// artefact under suspicion.
describe('the key file does not get to choose its own work factor', () => {
  async function tamper(dir: string, agentId: string, patch: (kdf: Record<string, unknown>) => void) {
    const path = join(dir, `${encodeURIComponent(agentId)}.json`);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { kdf: Record<string, unknown> };
    patch(file.kdf);
    writeFileSync(path, JSON.stringify(file));
  }

  // Each parameter on its own, so a check that guards only the famous one fails
  // here rather than passing on the row somebody thought of.
  for (const [param, weakened] of [['N', 2], ['r', 1], ['p', 2]] as Array<[string, number]>) {
    it(`refuses a file whose ${param} differs, naming it`, async () => {
      const dir = freshDir();
      const ks = new Keystore(dir, 'secret');
      await ks.create('orch:tamper');
      await tamper(dir, 'orch:tamper', (kdf) => { kdf[param] = weakened; });

      let err: unknown;
      try { await ks.load('orch:tamper'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(HttpError);
      // NAMED, because the alternative failure - deriving with our constants
      // against a file written under others - reports "could not be decrypted",
      // and an operator then goes looking for a corrupt file or a wrong
      // passphrase rather than for the parameter that changed.
      expect((err as HttpError).detail).toContain(`${param}=${weakened}`);
      expect((err as HttpError).detail).toMatch(/KDF parameters/);
    }, 20_000);
  }

  // THE CONTROL: an untouched file still loads. Without it the rows above pass
  // on a keystore that refuses everything, which is a different and much worse
  // service.
  it('control: an untampered file still round-trips', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    const created = await ks.create('orch:intact');
    expect((await ks.load('orch:intact')).privateKey).toBe(created.privateKey);
  }, 20_000);
});

// FINDING 22's keystore half: the watermark beside the keys.
describe('the ledger watermark', () => {
  it('is absent until something records one, and absent is not zero', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    // NULL, not 0. A keystore that has never spoken cannot accuse a store of
    // anything; one that has spoken and said zero is a different fact, and the
    // control reads them differently.
    expect(await ks.ledgerWatermark()).toBeNull();
  });

  it('records a mark and never lowers it', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    await ks.recordLedgerWatermark(40);
    expect(await ks.ledgerWatermark()).toBe(40);
    await ks.recordLedgerWatermark(12);
    // THE POINT OF THE WHOLE MECHANISM. If a restored store could write its own
    // lower count over the mark, the next boot would compare against the value
    // the restore itself installed and start cleanly.
    expect(await ks.ledgerWatermark()).toBe(40);
    await ks.recordLedgerWatermark(57);
    expect(await ks.ledgerWatermark()).toBe(57);
  });

  it('reads a corrupt mark as absent rather than throwing', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.recordLedgerWatermark(40);
    writeFileSync(join(dir, '.ledger-watermark'), 'not a number');
    // This file is the ACCUSER, not the evidence: a corrupt byte in it must not
    // be able to lock an operator out of a healthy game. The keys beside it are
    // what the control is really about.
    expect(await ks.ledgerWatermark()).toBeNull();
  });
});
