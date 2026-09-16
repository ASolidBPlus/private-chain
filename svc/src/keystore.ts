// Encrypted-at-rest wallet keys, one file per agent (spec S4).
//
// scrypt (KEYSTORE_SECRET) -> AES-256-GCM. GCM rather than CBC so a tampered
// key file fails to decrypt instead of yielding a plausible wrong key: this
// file IS the agent's ability to spend, and a silently corrupted one would
// present as an unexplained chain error.

import {
  randomBytes,
  scrypt as scryptCb,
  createCipheriv,
  createDecipheriv,
  type ScryptOptions,
} from 'node:crypto';
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { HttpError } from './errors.ts';
import { keyFileName } from './validate.ts';

function scrypt(secret: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, keyLength, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

// N=2^15 costs ~33.5 MB (128*N*r), which is over node's 32 MB scrypt default -
// hence the explicit maxmem. Raising N later is a keystore format change: bump
// `version` and keep reading v1 files, or every existing wallet becomes
// unspendable.
const KDF = { N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 } as const;

export interface KeyFile {
  version: 1;
  agentId: string;
  address: Address;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  ciphertext: string;
}

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return scrypt(secret, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem });
}

export class Keystore {
  constructor(
    private readonly dir: string,
    private readonly secret: string,
  ) {}

  private path(agentId: string): string {
    return join(this.dir, keyFileName(agentId));
  }

  /// THE LEDGER WATERMARK: the highest reservation count this keystore has seen
  /// the store report (finding 22).
  ///
  /// It lives HERE, beside the keys, because the store cannot witness its own
  /// rollback: restore the store from a backup and any counter inside it is
  /// restored too, and the two agree about a past that is no longer true. The
  /// three volumes share one lifetime by design - the control above already
  /// leans on that - so a copy on a DIFFERENT volume is a fact the restored
  /// file cannot carry with it.
  ///
  /// A plain integer in a dotfile rather than a second database: it is one
  /// number, it is written once per boot, and anything more would be a second
  /// thing that can be half-written.
  private watermarkPath(): string {
    return join(this.dir, '.ledger-watermark');
  }

  /// The recorded high-water mark, or NULL when this keystore has never
  /// recorded one.
  ///
  /// ABSENT IS NOT ZERO, and the distinction carries a whole failure mode. A
  /// keystore that has never recorded a mark is a fresh one, and cannot accuse
  /// a store of anything - the first boot after this ships establishes it. A
  /// keystore whose mark has GONE while the store's counter is non-zero is a
  /// keystore volume lost from under a live ledger, which is the wipe control's
  /// own case seen from the other side. Collapsing the two to 0 would make the
  /// second indistinguishable from the first and silently permit it.
  ///
  /// Unreadable content reads as absent rather than throwing: this file is the
  /// ACCUSER, not the evidence, and a corrupt byte in it must not be able to
  /// lock an operator out of a healthy game. The keys beside it are what the
  /// control is really about, and `agentCount` is the read that must propagate.
  async ledgerWatermark(): Promise<number | null> {
    try {
      const raw = await readFile(this.watermarkPath(), 'utf8');
      const n = Number.parseInt(raw.trim(), 10);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /// Record a new high-water mark. NEVER LOWERS IT: the only way this number
  /// goes down is somebody deleting the file, which is the same act as deleting
  /// the keys beside it.
  async recordLedgerWatermark(reservations: number): Promise<void> {
    const current = await this.ledgerWatermark();
    if (current !== null && reservations <= current) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.watermarkPath(), String(reservations), 'utf8');
  }

  /// How many agents this keystore holds keys for. Read at startup by the
  /// ledger-lifetime control: keys here beside an EMPTY intents ledger means
  /// the store was deleted on its own, because a fresh install has neither.
  /// Counts key files rather than trusting the store, which is the artefact
  /// under suspicion.
  async agentCount(): Promise<number> {
    try {
      const names = await readdir(this.dir);
      return names.filter((n) => n.endsWith('.json')).length;
    } catch (err) {
      // ONLY a missing directory means "no agent has ever been spawned". Every
      // other failure - permissions, I/O, a volume that did not mount - MUST
      // PROPAGATE.
      //
      // 0 is not a neutral answer here: it is the exact value that switches the
      // ledger-wipe control off (see assertLedgerLifetimeIntact). A bare catch
      // made this fact FAIL OPEN while its two siblings fail closed, and the
      // asymmetry pointed the wrong way - the scenario that trips the control
      // is an operator doing VOLUME SURGERY, which is precisely when a
      // NEIGHBOURING VOLUME can also fail to attach. The control's precondition
      // broke in the same incident it exists to detect.
      //
      // The old comment named one CAUSE where the code caught an error CLASS;
      // an unreadable keystore is not an empty one.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
      throw err;
    }
  }

  async has(agentId: string): Promise<boolean> {
    try {
      await access(this.path(agentId));
      return true;
    } catch {
      return false;
    }
  }

  /// Creates a wallet and persists its encrypted key. Refuses to overwrite an
  /// existing file: a wallet whose key is replaced still owns its old balance
  /// and its registry names, and nothing on chain would show the swap.
  async create(agentId: string): Promise<{ address: Address; privateKey: Hex }> {
    if (await this.has(agentId)) {
      throw new HttpError('internal_error', 'refusing to overwrite an existing key file');
    }
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;

    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(this.secret, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);

    const file: KeyFile = {
      version: 1,
      agentId,
      address,
      kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      ciphertext: ciphertext.toString('base64'),
    };

    // 0700/0600: the ciphertext is AES-256-GCM so this is defence in depth,
    // but this file is the agent's ability to spend and there is no reason for
    // it to be world-readable.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // wx: two concurrent spawns of the same agent must not both "win" and leave
    // one holding a key for an address the registry no longer points at.
    await writeFile(this.path(agentId), JSON.stringify(file, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return { address, privateKey };
  }

  async load(agentId: string): Promise<{ address: Address; privateKey: Hex }> {
    let raw: string;
    try {
      raw = await readFile(this.path(agentId), 'utf8');
    } catch {
      throw new HttpError('wallet_not_found', `no key file for ${agentId}`);
    }

    // Inside the try: a key file that is not JSON is a doctored or truncated
    // file, which is the same operator-visible problem as a wrong secret and
    // deserves the same labelled refusal - not a bare SyntaxError escaping to
    // a 500 with no diagnostic.
    let file: KeyFile;
    try {
      file = JSON.parse(raw) as KeyFile;
    } catch {
      throw new HttpError('internal_error', 'key file is not valid JSON');
    }
    if (file.version !== 1) {
      throw new HttpError('internal_error', `unsupported key file version ${file.version}`);
    }

    // THE CONSTANTS, NOT THE FILE'S OWN PARAMETERS (the reviewer's KDF
    // observation).
    //
    // `N`, `r` and `p` set the COST of the derivation, and taking them from the
    // key file lets the file choose how hard it is to brute-force itself. An
    // attacker who can write into the keystore volume - which is the threat the
    // encryption exists for, since a reader of the volume is exactly who must
    // not get the keys - can rewrite `N` to 2, re-encrypt under that, and hand
    // back a file this service opens without complaint. The work factor stops
    // being a property of the service and becomes a property of the artefact
    // under suspicion.
    //
    // REFUSED RATHER THAN SILENTLY RE-DERIVED WITH THE CONSTANTS, and the
    // difference matters: a file written under different parameters will not
    // decrypt under these, so quietly using ours would report "could not be
    // decrypted" for what is really a parameter change - and the operator would
    // go looking for a corrupt file or a wrong passphrase. It names which
    // parameter differs instead.
    if (file.kdf.N !== KDF.N || file.kdf.r !== KDF.r || file.kdf.p !== KDF.p) {
      const differs = [
        file.kdf.N !== KDF.N ? `N=${file.kdf.N} (expected ${KDF.N})` : null,
        file.kdf.r !== KDF.r ? `r=${file.kdf.r} (expected ${KDF.r})` : null,
        file.kdf.p !== KDF.p ? `p=${file.kdf.p} (expected ${KDF.p})` : null,
      ].filter((x): x is string => x !== null);
      throw new HttpError(
        'internal_error',
        `key file records KDF parameters this build does not use: ${differs.join(', ')}`,
      );
    }

    const salt = Buffer.from(file.kdf.salt, 'base64');
    const key = await scrypt(this.secret, salt, KDF.keyLength, {
      N: KDF.N,
      r: KDF.r,
      p: KDF.p,
      maxmem: KDF.maxmem,
    });

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
    let privateKey: string;
    try {
      privateKey = decipher.update(Buffer.from(file.ciphertext, 'base64'), undefined, 'utf8') + decipher.final('utf8');
    } catch {
      // Wrong KEYSTORE_SECRET or a tampered file. Both are operator-visible
      // problems, and neither should look like "this agent has no wallet".
      throw new HttpError('internal_error', 'key file could not be decrypted');
    }

    const derived = privateKeyToAccount(privateKey as Hex).address;
    // The address is stored in the clear for lookups, so it is attacker-editable
    // if the volume is. Deriving it and comparing means a doctored file cannot
    // redirect a transfer to an address the key does not control.
    //
    // A PLAIN comparison, deliberately. This was timingSafeEqual, which throws
    // RangeError on a length mismatch - and `file.address` is whatever the JSON
    // says, so a short doctored value escaped as a RangeError instead of the
    // refusal written for exactly this case. The address is public and stored
    // beside the key, so constant-time buys nothing here; the secret in this
    // function is the private key, which is never compared.
    if (derived.toLowerCase() !== String(file.address).toLowerCase()) {
      throw new HttpError('internal_error', 'key file address does not match its private key');
    }
    return { address: derived, privateKey: privateKey as Hex };
  }
}
