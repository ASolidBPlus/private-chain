// wallet-mcp MUST NOT DEPEND ON chain-svc AT RUNTIME.
//
// It has exactly one reference to the other package - `import type { ErrorCode }`
// in wallet.ts - and `import type` is ERASED, so the built module never reaches
// for svc/. That property is load-bearing rather than tidy: org-core imports
// `Wallet` AS A LIBRARY, in a process where chain-svc is not installed and its
// files are not on disk. A single value import turns that into a crash at
// startup, in somebody else's process, for a type nobody needed at runtime.
//
// TWO HALVES, AND NEITHER IS REDUNDANT. Measured, by mutating both ways:
//
//   `import { type ErrorCode, HttpError as _Unused }` - a value import whose
//   binding is never referenced. The STRUCTURAL half catches it; the
//   behavioural one does not, because bun's transpiler ELIDES an unused import
//   and the module graph never reaches for the file.
//
//   `import { type ErrorCode, HttpError }` with HttpError actually used. The
//   BEHAVIOURAL half catches it - `Cannot find module '../../svc/src/errors.ts'`
//   - which is the real dependency, the one that would crash org-core.
//
// So the grep catches the statement that has not bitten yet, and the import
// catches the one that has. A grep proves a string is present or absent, never
// that the module LOADS without the other package; an import proves the load
// and says nothing about a line that is currently harmless and one edit from
// not being.
//
// It lives in svc/test because only this suite may import across the boundary;
// a test under wallet-mcp that imported chain-svc would itself be a second
// place the dependency exists.
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP_SRC = join(ROOT, 'wallet-mcp', 'src');

describe('wallet-mcp stands alone', () => {
  // THE STRUCTURAL HALF, which says WHICH LINE to look at when the other half
  // fails. Every reference to the other package, by file and line, with the
  // rule that each must be `import type`.
  it('references chain-svc only through `import type`', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(MCP_SRC)) {
      if (!f.endsWith('.ts')) continue;
      const lines = readFileSync(join(MCP_SRC, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        // The IMPORT STATEMENTS only: the two files that MENTION svc/src in
        // prose are describing the mirror rule, and a check that flagged those
        // would be a check nobody could keep green.
        if (!/^\s*import\b/.test(line)) return;
        if (!/svc\/src/.test(line)) return;
        if (!/^\s*import\s+type\b/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  // THE BEHAVIOURAL HALF. A copy of wallet-mcp with NO svc/ beside it at all -
  // if any module reaches across at runtime, resolution fails and this throws.
  //
  // Copied rather than mocked, because the thing under test is what the module
  // graph does when the file is not there, and a mock is a file that is.
  it('imports with chain-svc absent from the tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'standalone-'));
    // The same layout, minus svc/: wallet-mcp/src/* and its node_modules, at the
    // same depth, so `../../svc/src/...` resolves to nothing rather than to
    // something else.
    mkdirSync(join(dir, 'wallet-mcp'), { recursive: true });
    cpSync(join(ROOT, 'wallet-mcp', 'src'), join(dir, 'wallet-mcp', 'src'), { recursive: true });
    cpSync(join(ROOT, 'wallet-mcp', 'package.json'), join(dir, 'wallet-mcp', 'package.json'));
    cpSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), { recursive: true, dereference: false });
    writeFileSync(join(dir, 'package.json'), '{"name":"standalone-probe","private":true}');

    const probe = join(dir, 'probe.ts');
    writeFileSync(
      probe,
      `import { Wallet } from './wallet-mcp/src/wallet.ts';\n` +
        `if (typeof Wallet !== 'function') throw new Error('Wallet is not a class');\n` +
        `process.stdout.write('ok');\n`,
    );

    const proc = Bun.spawn(['bun', 'run', probe], { stdout: 'pipe', stderr: 'pipe', cwd: dir });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // THE STDERR IN THE FAILURE, not just the code: "exited 1" about a module
    // graph is a puzzle, and the resolution error names the file and the
    // importer.
    if (code !== 0) throw new Error(`the standalone import failed (exit ${code}):\n${err}`);
    expect(out).toBe('ok');
  }, 60_000);
});
