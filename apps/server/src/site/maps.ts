import type { IncomingMessage, ServerResponse } from 'node:http';
import { MapSettingsError, defaultMapSettings, type MapRoomKind, type MapSettings, type MapSettingsStore } from '../rooms/map-settings';
import { SiteFail } from './validate';

/** One room's live numbers (people, the practice bots of a free custom room, its map now). */
export interface RoomCount {
  id: string;
  kind: MapRoomKind;
  name: string;
  arenaId?: number;
  humans: number;
  bots: number;
  mapSide: number;
  mapAuto: boolean;
}

/** What `/api/admin/maps` needs. */
export interface MapAdmin {
  store: MapSettingsStore;
  live: () => RoomCount[];
  log?: (m: string) => void;
}

/** The body of `GET` and `PUT /api/admin/maps`. */
export interface MapAdminView {
  settings: MapSettings;
  defaults: MapSettings;
  rooms: RoomCount[];
}

export function mapAdminView(a: MapAdmin): MapAdminView {
  return { settings: a.store.settings, defaults: defaultMapSettings(), rooms: a.live() };
}

/**
 * `GET /api/admin/maps` (the dynamic map settings per room kind and every room's live numbers) and
 * `PUT /api/admin/maps` (a partial update, stored in `DATA_DIR/site/maps.json` and applied to every room at
 * once). The caller checked that the session is an admin.
 */
export async function mapRoutes(
  a: MapAdmin,
  h: {
    send: (res: ServerResponse, status: number, body: unknown) => void;
    method: (req: IncomingMessage, ...allowed: string[]) => string;
    readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  },
  req: IncomingMessage,
  res: ServerResponse,
  wallet: string,
): Promise<void> {
  if (h.method(req, 'GET', 'PUT') === 'PUT') {
    const body = await h.readJson(req);
    try {
      a.store.update(body);
    } catch (err) {
      if (err instanceof MapSettingsError) throw new SiteFail(400, 'bad_request', err.message, err.field);
      throw err;
    }
    a.log?.(`maps: settings updated by ${wallet}`);
  }
  h.send(res, 200, mapAdminView(a));
}
