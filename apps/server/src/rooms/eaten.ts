import { EATEN_SHOWN, shareName, type EatenName } from '@elymum/shared';

/** Distinct coins remembered per eater (a game with more only counts them in `eatenMore`). */
const KEYS_KEPT = 64;

interface Eaten {
  name: string;
  bot: boolean;
  n: number;
  /** Order of the first bite (ties of `n` keep it). */
  first: number;
}

interface Book {
  coins: Map<string, Eaten>;
  /** Distinct coins past `KEYS_KEPT`. */
  overflow: number;
}

/**
 * The coins each person ate this game, for the result card and the round-over sheet (`DeathStats.eaten`). A coin is
 * known by its wallet (the same person eaten again after a rejoin counts once, ×2), else by its name. People only,
 * except in a testnet test arena (`withBots`), where its practice bots count too, tagged BOT. A split coin is one
 * coin: the world reports one kill when its last cell goes. Names are stored cleaned (`shareName`).
 */
export class EatenTracker {
  private readonly books = new Map<number, Book>();
  private seq = 0;

  constructor(private readonly withBots: boolean) {}

  /** `eater` (a person's pid) ate `victim`. Ignored for a bot victim outside a test arena, and for eating oneself. */
  note(eater: number, victim: { pid: number; name: string; bot: boolean; wallet: string | null }): void {
    if (victim.pid === eater || (victim.bot && !this.withBots)) return;
    let book = this.books.get(eater);
    if (!book) this.books.set(eater, (book = { coins: new Map(), overflow: 0 }));
    const key = victim.bot ? `bot:${victim.name}` : victim.wallet ? `w:${victim.wallet.toLowerCase()}` : `n:${victim.name}`;
    const had = book.coins.get(key);
    if (had) {
      had.n++;
      return;
    }
    if (book.coins.size >= KEYS_KEPT) {
      book.overflow++;
      return;
    }
    book.coins.set(key, { name: shareName(victim.name), bot: victim.bot, n: 1, first: this.seq++ });
  }

  /** The eater's list (most eaten first, then first eaten) and the count past it; forgets the eater. Null: ate nobody. */
  take(eater: number): { eaten: EatenName[]; eatenMore: number } | null {
    const book = this.books.get(eater);
    this.books.delete(eater);
    if (!book || book.coins.size === 0) return null;
    const all = [...book.coins.values()].sort((a, b) => b.n - a.n || a.first - b.first);
    const eaten = all.slice(0, EATEN_SHOWN).map((e): EatenName => ({ name: e.name, ...(e.bot ? { bot: true } : {}), ...(e.n > 1 ? { n: e.n } : {}) }));
    return { eaten, eatenMore: all.length - eaten.length + book.overflow };
  }
}
