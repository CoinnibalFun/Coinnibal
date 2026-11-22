import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupCurlCommand, installCommand } from '../src/site/api';

/**
 * The commands /admin → Network → Backup & move copies hand out the admin session token and a secret-export proof.
 * Any local user of the new server can read every process's command line (ps, /proc/<pid>/cmdline), so neither may
 * be an argument of any process: they go to the command's stdin. Each command runs here in a real bash with stub
 * `curl` and `sudo` that write down their arguments and their stdin.
 */
const TOKEN = 'tok.SECRET-token';
const PROOF = 'SECRET-proof';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Runs `command` in bash with the stubs first on PATH; returns every stub call's argv and stdin. */
function run(command: string): { argv: string[]; stdin: string } {
  dir = mkdtempSync(join(tmpdir(), 'secret-cmd-'));
  for (const name of ['curl', 'sudo']) {
    const stub = join(dir, name);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >>"${dir}/argv"\ncat >>"${dir}/stdin"\n`);
    chmodSync(stub, 0o755);
  }
  const r = spawnSync('bash', ['-c', command], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  return { argv: read('argv').split('\n').filter(Boolean), stdin: read('stdin') };
}

describe('the copied server commands keep the secrets off every command line', () => {
  it('the backup download: curl reads both headers from its stdin', () => {
    const { argv, stdin } = run(backupCurlCommand('https://game.coinnibal.fun/', TOKEN, PROOF));
    expect(argv).toEqual(["curl -fsS -H @- https://game.coinnibal.fun/api/admin/backup -o coinnibal-backup.tar.gz"]);
    expect(argv.join('\n')).not.toContain('SECRET');
    expect(stdin).toBe(`Authorization: Bearer ${TOKEN}\nX-Coinnibal-Proof: ${PROOF}\n`);
  });

  it('the new-server install: curl gets install.sh from the old server with the session on its stdin, then install.sh reads the token and the proof from its stdin', () => {
    const { argv, stdin } = run(installCommand('https://game.coinnibal.fun/', TOKEN, PROOF));
    expect(argv).toEqual(['curl -fsS -H @- https://game.coinnibal.fun/api/admin/install.sh -o install.sh', 'sudo bash install.sh --yes --from https://game.coinnibal.fun']);
    expect(argv.join('\n')).not.toContain('SECRET');
    // curl's here-document first (its header), then install.sh's (one value per line)
    expect(stdin).toBe(`Authorization: Bearer ${TOKEN}\n${TOKEN}\n${PROOF}\n`);
  });

  it('the new-server install names no repository (the site bundle ships it to every visitor)', () => {
    expect(installCommand('https://game.coinnibal.fun', TOKEN, PROOF)).not.toMatch(/github|furkan|solagel/i);
  });

  it('a quote or a dollar in a value reaches stdin unchanged (the here-document is quoted)', () => {
    const { stdin } = run(installCommand('https://game.coinnibal.fun', "a'b$HOME`id`", PROOF));
    expect(stdin).toBe(`Authorization: Bearer a'b$HOME\`id\`\na'b$HOME\`id\`\n${PROOF}\n`);
  });

  it('starts with a space, so the shell history skips it (HISTCONTROL=ignoreboth on Ubuntu)', () => {
    expect(installCommand('https://game.coinnibal.fun', TOKEN, PROOF).startsWith(' ')).toBe(true);
    expect(backupCurlCommand('https://game.coinnibal.fun', TOKEN, PROOF).startsWith(' ')).toBe(true);
  });

  it('refuses a value with a line break (it would end the here-document early)', () => {
    expect(() => installCommand('https://game.coinnibal.fun', 'tok\nrm -rf /', PROOF)).toThrow(/line break/);
    expect(() => backupCurlCommand('https://game.coinnibal.fun', TOKEN, 'p\r')).toThrow(/line break/);
    expect(() => installCommand('https://game.coinnibal.fun', 'COINNIBAL_SECRETS', PROOF)).toThrow();
    expect(() => installCommand('https://game.coinnibal.fun', TOKEN, 'COINNIBAL_AUTH')).toThrow();
  });
});
