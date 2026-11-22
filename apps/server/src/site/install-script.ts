import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join('deploy', 'vps', 'install.sh');

/**
 * The VPS installer this server can hand to a new server (`GET /api/admin/install.sh`, the "Copy new-server command" of
 * /admin): `deploy/vps/install.sh` in the nearest folder above this module that holds one. That is the repository in
 * development and tests (`apps/server/src/site`, or `apps/server/dist` after a build) and `/app` in the image (the
 * Dockerfile copies it to `/app/deploy/vps/install.sh`, next to `/app/dist`). Null when there is none.
 */
export function findInstallScript(from = dirname(fileURLToPath(import.meta.url))): string | null {
  for (let dir = from; ; ) {
    const file = join(dir, SCRIPT);
    if (existsSync(file)) return file;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
