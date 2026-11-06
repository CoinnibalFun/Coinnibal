import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One admin request that could change something (every `/api/admin/*` call but GET / HEAD). */
export interface AuditEntry {
  at: number;
  wallet: string;
  method: string;
  /** The path (no query string: it can hold nothing the audit needs). */
  path: string;
  /** The HTTP status the server answered. */
  status: number;
  /** The client address as the server saw it (behind the trusted proxy). */
  ip: string;
}

/** The file is cut to its newest half beyond this size. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Admin audit log (`DATA_DIR/admin-audit.jsonl`): who changed what and when, for every admin write
 * (settings, contracts, mint, maps, integrity decisions, bans, backups, ...). Request bodies are not kept (they
 * can hold allowlist data or notes; the store that applied a change keeps its own record). Read with
 * `GET /api/admin/audit`. Appending never fails a request.
 */
export class AdminAudit {
  private memory: AuditEntry[] = [];

  constructor(
    private readonly path: string | null,
    private readonly log: (m: string) => void = () => {},
  ) {}

  record(e: AuditEntry): void {
    this.memory.push(e);
    if (this.memory.length > 1000) this.memory.splice(0, this.memory.length - 1000);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(e) + '\n', { mode: 0o600 });
      if (statSync(this.path).size > MAX_BYTES) this.trim();
    } catch (err) {
      this.log(`!!! admin audit: could not append to ${this.path} (${(err as Error).message})`);
    }
  }

  private trim(): void {
    const lines = readFileSync(this.path!, 'utf8').split('\n').filter(Boolean);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, this.path!);
  }

  /** The newest entries first (at most `limit`). */
  recent(limit = 500): AuditEntry[] {
    if (!this.path || !existsSync(this.path)) return this.memory.slice(-limit).reverse();
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      const out: AuditEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          out.push(JSON.parse(lines[i]) as AuditEntry);
        } catch {
          /* a torn last line */
        }
      }
      return out;
    } catch {
      return this.memory.slice(-limit).reverse();
    }
  }
}
