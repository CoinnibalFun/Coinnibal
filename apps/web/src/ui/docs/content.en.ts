import { BOOST_RULES } from '@elymum/shared';
import { FACTS as F, payoutExample, type DocBlock, type DocsContent } from './facts';

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const num = (n: number): string => nf.format(n);
/** `500` → `5%`, `450` → `4.5%`. */
const pct = (bps: number): string => `${nf.format(bps / 100)}%`;

const S = F.server;
const R = F.rules;
const C = F.cut;
const SH = F.shop;
const sym = '$ELYMUM';

/**
 * The player guide in English: how to play, what the Elymum NFT and the token are for, and how the money
 * moves, kept short. Every number comes from `FACTS` (see facts.ts); the entry fee rate is the server's
 * `feeBps` (the arena contract's `config().feeBps`) when known, else the contract default.
 */
export const docsEn = (symbol: string = sym, feeBps: number = F.fee.bps, feeModel: 'entry' | 'profit' = 'entry'): DocsContent => {
  const ex = payoutExample(feeBps);
  // a legacy v1 arena (`ChainStatus.feeModel` = 'profit') takes its own fee from the profit on top
  const legacy = feeModel === 'profit';
  const entryFee = feeBps > 0 && !legacy;
  const legacyNote: DocBlock = {
    kind: 'note',
    tone: 'info',
    stamp: 'Live now',
    title: 'The live arena takes its fee from the profit',
    text: `The arena contract live right now is the legacy one: on top of the cut on winnings below, it takes ${pct(feeBps)} of your profit at the payout. The ticket sheet in the lobby always shows what applies to your ticket.`,
  };
  return {
    pct,
    num,
    kicker: 'Guide · Player handbook',
    title: 'Ticket, coin, receipt.',
    deck: `How Elymum plays, what the Elymum NFT and ${symbol} are for, and where the money goes: short and plain. Numbers are the game's defaults; the amounts on your ticket are the ones that count.`,
    feeBps,
    dateline: [
      `Cut ${pct(C.bps)} of winnings only`,
      `Rounds ${R.roundMin} min · joins close ${R.joinCloseS} s before the bell`,
      `${F.capacity.arena} players per room`,
      `${pct(C.burnBps)} of winnings burned`,
    ],
    tocLabel: 'Contents',
    receipt: {
      title: 'Round over',
      meta: `Example · cut ${pct(C.bps)} of winnings`,
      entry: 'Entry fee',
      fee: (p) => `Entry fee rate (${p})`,
      starts: 'Your coin starts at',
      cashout: 'Till at the bell',
      winnings: 'Winnings',
      burn: (p) => `Burned (${p} of winnings)`,
      vault: (p) => `Arena vault (${p} of winnings)`,
      net: 'To your wallet',
      footer: `The burned part leaves the ${symbol} supply for good`,
      caption: `A ${num(F.example.entry)} ${symbol} ticket with ${num(F.example.cashout)} ${symbol} in the till at the bell`,
    },
    colophon: `This page uses the values in the game's code. The smart contracts have not been independently audited; only play with what you can afford to lose.`,
    backToTop: 'Back to top',
    sections: [
      {
        id: 'play',
        title: 'How to play',
        lede: 'Eat food, grow, swallow smaller coins, run from bigger ones.',
        strip: { label: 'The one rule', panels: ['Eat the food. Grow.', `${num(R.eatRatio)} times bigger? Lunch.`, 'Smaller? Run.'] },
        blocks: [
          {
            kind: 'p',
            text: `Pick the Practice ticket in the lobby and press Quick Play: no wallet needed. Your coin follows the mouse; WASD or the arrow keys steer it too (the joystick at the bottom left on phones). Eat food to grow. To eat a coin you need at least ${num(R.eatRatio)} times its mass and must mostly cover it. The bigger you are, the slower you move, so split to strike and stay away from anything bigger than you.`,
          },
          {
            kind: 'keys',
            caption: 'Controls',
            rows: [
              { key: 'Mouse', action: 'Move toward the pointer (joystick on phones)' },
              { key: 'WASD / arrows', action: 'Move with the keyboard (move the mouse to take it back)' },
              { key: 'Space / left click', action: 'Split: launch a half at runners' },
              { key: 'E', action: 'Tip out a little mass (hold to repeat)' },
              { key: 'Enter', action: 'Chat' },
              { key: '1–8', action: 'Stickers (emotes): Hype or Trash talk (the switch on the sticker bar)' },
              { key: 'R / F / G / V', action: 'Bought power-ups: Magnet, Leap, Speed burst, Invisibility (buttons by Split on phones)' },
              { key: 'Q', action: 'Next player while spectating' },
              { key: 'Esc', action: 'Close the chat or an open panel' },
            ],
          },
          {
            kind: 'list',
            items: [
              { term: 'Rug cacti', text: 'pop big coins into pieces; small coins can hide behind them.' },
              { term: 'Airdrops', text: 'drop free power-ups on the map: Magnet, Pump, HODL Shield and Mega Bag.' },
              { term: 'Spawn shield:', text: `a fresh coin cannot be eaten for ${R.spawnShieldS} s.` },
              {
                term: 'Tips:',
                text: 'split only when the half lands safely, keep away from walls and corners when something big is near, and remember that a coin split into pieces is at its weakest.',
              },
            ],
          },
        ],
      },
      {
        id: 'rooms',
        title: 'Rooms and tickets',
        lede: 'Practice is free; arenas take a ticket with a fixed entry fee.',
        strip: { label: 'Two doors', panels: ['Practice: free.', 'Arenas: show a ticket.', 'The entry fee goes into the vault.'] },
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Practice', text: `is free: no wallet, token or NFT, no prizes and nothing on-chain. Up to ${F.capacity.practice} players per room.` },
              {
                term: 'Leagues:',
                text: `Practice is split into Rookie and Pro. Profiles at level ${S.proLevel} or above play in Pro. A Rookie game above ${num(S.promoteMaxMass)} mass or with ${S.promoteKills} player kills sends you to Pro for ${S.promotionHours} hours.`,
              },
              {
                term: 'Arenas',
                text: `are paid rooms in one smart contract. Your entry fee goes into the arena's vault; nobody holds a key that can withdraw it. Arenas are open 24/7 and play in rounds. A room holds up to ${F.capacity.arena} players; when it is full, a new instance opens on the same vault.`,
              },
              { term: 'One ticket:', text: 'you can hold one open ticket per arena at a time.' },
              {
                term: 'Private rooms',
                text: 'are your own rooms with your own rules and an invite code, free or with tickets; Elymum NFT holders create them for less.',
              },
              {
                term: 'Opening soon:',
                text: `the arenas open once the ${symbol} token is set on-chain (once, after launch; it can never change). Until then the lobby shows "Opening soon" and practice is open.`,
              },
            ],
          },
          {
            kind: 'table',
            caption: 'Default arenas (they differ only by entry fee)',
            head: ['No', 'Room', 'Entry fee'],
            numeric: [0, 2],
            rows: F.arenas.map((a) => [String(a.id), a.name, `${num(a.entry)} ${symbol}`]),
          },
          {
            kind: 'p',
            text: `A ticket needs an EVM wallet (MetaMask, Rabby or any browser wallet), the entry fee in ${symbol} and a little of the network's gas token (HYPE on Elysium) for network fees. Buying takes at most two signatures: one allows the arena to take exactly the entry fee, the other buys the ticket.`,
          },
        ],
      },
      {
        id: 'value',
        title: 'Value flow',
        lede: 'In an arena your coin carries tokens. Eat a coin and its tokens move to you.',
        strip: { label: 'Who carries the tokens', panels: ['Eat a coin...', '...and its tokens hop to you.', 'Alive at the bell? Paid.'] },
        blocks: [
          {
            kind: 'flow',
            label: 'How value moves',
            diagram: { ticket: 'Your ticket', vault: 'Arena vault', wallet: 'Your wallet', fee: 'Burn + vault' },
            steps: [
              { title: 'Entry', text: entryFee ? `The entry fee rate (${pct(feeBps)}) comes off the entry fee; your coin starts at the rest.` : 'Your coin starts at the whole entry fee.' },
              { title: 'Eating', text: "An eaten cell moves its share of the victim's value to the eater: ⌊V · m / M⌋. The last cell moves everything left." },
              { title: 'The bell', text: `When the round ends, your value is paid to your wallet, less ${pct(C.bps)} of what you won.` },
            ],
          },
          {
            kind: 'list',
            items: [
              { term: 'Mass is not value.', text: 'Tipping mass (E), cactus pops and mass decay never change your value; value only changes hands by eating.' },
              { term: 'Every coin can carry value.', text: 'Some coins in an arena are played by the team; they win and lose value like anyone, what they hold is yours if you eat them, and what they still hold at the bell stays in the arena vault.' },
              { term: 'Loot', text: 'that spills on the floor can be picked up by any player until the bell; what is left then is burned.' },
              { term: 'If you disconnect,', text: 'your coin stays in the arena (it can still be eaten) and you carry on if you come back. Alive at the bell, you are paid as usual.' },
              { term: 'If you die,', text: 'your value goes to whoever ate you and the ticket closes. You may buy a new ticket and re-enter the same round.' },
            ],
          },
          {
            kind: 'note',
            tone: 'info',
            stamp: 'Vault',
            title: 'A payout never exceeds the vault',
            text: "Every value in play is backed by the tokens in the arena's vault, and the contract never pays out more than the vault holds. The server saves every change; if it crashes, open tickets are settled automatically at their last saved value.",
          },
        ],
      },
      {
        id: 'payout',
        title: 'Rounds, payout and the cut',
        lede: `Arenas play ${R.roundMin}-minute rounds. Stay alive until the bell and you are paid your value.`,
        strip: {
          label: 'Five minutes, then lunch',
          panels: [`${R.roundMin} minutes on the clock.`, 'The bell rings. Everyone alive is paid.', `${pct(C.bps)} of the winnings is the cut. Nothing if you did not win.`],
        },
        blocks: [
          ...(legacy ? [legacyNote] : []),
          {
            kind: 'p',
            text: `Rounds follow the clock: a new one starts every ${R.roundMin} minutes in every arena at once. There is no cash-out in an arena and no way to leave early with money. When the bell rings, everyone still alive is paid, the server sends the payout on-chain and the "Round over" receipt shows the transaction link. Joins close ${R.joinCloseS} s before the bell; a ticket bought in that window joins the next round automatically.`,
          },
          {
            kind: 'p',
            text: `The cut is ${pct(C.bps)} of your winnings, the part of your till above what your coin started with, and nothing else: break even or lose and you pay no cut, and your stake is never touched. Of your winnings, ${pct(C.burnBps)} is burned (it leaves the ${symbol} supply for good) and ${pct(C.vaultBps)} stays in the arena vault for the team. Example: entry ${num(F.example.entry)}, your coin starts at ${num(ex.start)}; the till at the bell is ${num(ex.gross)}, so you won ${num(ex.profit)}: ${num(ex.burn)} is burned, ${num(ex.vault)} stays in the vault and you get ${num(ex.net)}.`,
          },
          { kind: 'fee-example' },
          ...(entryFee
            ? [
                {
                  kind: 'p',
                  text: `The arena also takes an entry fee rate of ${pct(feeBps)} of each played entry fee (capped on-chain at ${pct(F.fee.maxBps)}); your coin starts at the rest. The rate is written into your ticket when you buy it.`,
                } satisfies DocBlock,
              ]
            : []),
          {
            kind: 'list',
            items: [
              { term: 'Network fees:', text: "You pay the network fee of your own transactions (buying, collecting). The server pays the network fee of every payout." },
              { term: 'Unplayed ticket:', text: `If you buy a ticket and never enter the room, the server refunds the full entry fee after about ${S.staleTicketMinutes} minutes.` },
            ],
          },
          {
            kind: 'note',
            tone: 'warn',
            stamp: 'Collect',
            title: 'Transfer refused? Your game still settles',
            text: `If the ${symbol} transfer to your wallet fails when your game ends, the server settles the game anyway and your payout waits in the arena vault. The lobby then shows "Collect payout": one transaction pays you the exact amount, at any time. A ticket the server never settled at all can be refunded by you ${F.refundHours} hours after it opened.`,
          },
        ],
      },
      {
        id: 'nft',
        title: 'The Elymum NFT',
        lede: 'Your emblem: the key to the game at launch, and perks every time you play.',
        blocks: [
          {
            kind: 'p',
            text: 'The Elymum NFT is the game\'s emblem, an ERC-721 minted for $1 in the network\'s gas token on the Mint page (allowlist first, then public). It is not a ticket and carries no value inside a round; it is your membership card.',
          },
          {
            kind: 'list',
            items: [
              { term: 'Access:', text: 'while the game opens up in phases, holders play first (the WL → Mint → Play order).' },
              { term: 'Emblem skin:', text: 'holders can wear the emblem coin, and their name carries the holder mark in the standings.' },
              { term: 'Cheaper power-ups:', text: `holders pay ${SH.holderDiscountPct}% less for every power-up pack in the shop.` },
              { term: 'More power-ups per round:', text: `${SH.holderExtraUses} extra power-up use per round in paid arenas (${SH.arenaUses + SH.holderExtraUses} instead of ${SH.arenaUses}).` },
              { term: 'Private rooms:', text: 'holders create their own rooms for less (or free, when the room settings say so).' },
              { term: 'Holders-only arenas:', text: 'arenas can be opened to holders only, on-chain.' },
            ],
          },
        ],
      },
      {
        id: 'token',
        title: `The ${symbol} token`,
        lede: 'The one token of the game: you play with it, you win it, and every win burns some of it.',
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Arena tickets:', text: `every arena entry fee is paid in ${symbol}, and every payout is paid in ${symbol}.` },
              {
                term: 'Power-ups:',
                text: `packs of ${SH.packSize} charges in the lobby shop: Magnet ${num(SH.prices.magnet)}, Leap ${num(SH.prices.leap)}, Speed burst ${num(SH.prices.speed)} and Invisibility ${num(SH.prices.invis)} ${symbol} by default. Shop payments are burned.`,
              },
              { term: 'Burn on every win:', text: `${pct(C.burnBps)} of every winning payout is burned, and so is floor loot left at the bell: the more the game is played, the smaller the supply.` },
              { term: 'Arena vault:', text: `${pct(C.vaultBps)} of the winnings stays in the arena vault, on-chain and visible to anyone.` },
              { term: 'Where to get it:', text: 'on a decentralized exchange. Check the token address only through the official channels.' },
            ],
          },
          {
            kind: 'list',
            items: [
              { term: 'Magnet', text: `pulls nearby food to you for ${BOOST_RULES.magnet.durationMs / 1000} s.` },
              { term: 'Leap', text: 'jumps you instantly toward your aim, never through the wall: the way out of a corner.' },
              { term: 'Speed burst', text: `gives ${BOOST_RULES.speed.durationMs / 1000} s of extra speed.` },
              { term: 'Invisibility', text: `hides your coin, name and minimap dot for ${BOOST_RULES.invis.durationMs / 1000} s; you still eat and can be eaten.` },
            ],
          },
          {
            kind: 'p',
            text: `Each power-up has a cooldown. Use them freely in practice and private rooms; in paid arenas at most ${SH.arenaUses} per round (${SH.arenaUses + SH.holderExtraUses} for NFT holders). Nothing is sold during a game.`,
          },
        ],
      },
      {
        id: 'fair',
        title: 'What is on-chain',
        lede: 'The money rules are on-chain, the game itself runs on a server. Know what you trust.',
        strip: { label: 'Two kinds of trust', panels: ['Money rules: on-chain.', 'The game: on the server.', 'Know which is which.'] },
        blocks: [
          {
            kind: 'compare',
            left: {
              title: 'On-chain: rules anyone can verify',
              items: [
                "Entry fees sit in the arena's vault; a payout can never exceed it.",
                'Burns go to the burn address and can be checked by anyone.',
                'Every ticket has a unique id, so an old payout cannot be applied to a new ticket.',
                `Collecting a settled payout at any time; a self-refund of an unsettled ticket after ${F.refundHours} hours.`,
                `The ${symbol} token, set once and never changed.`,
              ],
            },
            right: {
              title: 'On the server: you trust it',
              items: [
                'Physics and the outcome: who ate whom and what you hold at the bell.',
                'Score, XP, matchmaking and leagues.',
                'The Today / All-time standings (for bragging rights, no prizes) and the chat filter.',
              ],
            },
          },
          {
            kind: 'p',
            text: "The server key can only settle open tickets and burn from an arena's vault (never more than it holds); it cannot move tokens to a wallet of its choice. The admin cannot take an open arena's vault. Elymum currently runs on Elysium; the network may change in the future, and any move will be announced in the official channels.",
          },
          {
            kind: 'note',
            tone: 'warn',
            stamp: 'Unaudited',
            title: 'The smart contracts are not audited',
            text: 'The contracts have not been through an independent security audit. Only play with what you can afford to lose.',
          },
        ],
      },
      {
        id: 'wallet',
        title: 'Wallet safety',
        lede: 'Read before you sign. Elymum never asks for your secret recovery phrase.',
        strip: { label: 'Read before you sign', panels: ['Someone asks for your phrase.', 'Never. Not to anyone.', 'Sign only what you have read.'] },
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Sign-in', text: 'is only a message signature ("Sign in to Elymum. This is free and sends no transaction."): no transaction, no cost.' },
              { term: 'A ticket', text: `takes at most two transactions: an approval for exactly the entry fee in ${symbol}, then the ticket itself. If your wallet asks for an unlimited approval or for more, do not sign.` },
              { term: 'Anyone asking', text: 'for your recovery phrase or private key, site, person or "support", is a scammer.' },
              { term: 'Use a separate wallet', text: 'for games and keep only what you want to play with in it.' },
              { term: 'Links:', text: 'check the address bar. The only mint is the Mint page of this site.' },
            ],
          },
        ],
      },
      {
        id: 'faq',
        title: 'FAQ',
        lede: 'Short answers.',
        blocks: [
          {
            kind: 'faq',
            items: [
              { q: 'Do I need a wallet for practice?', a: 'No. Practice is free; no wallet, token or NFT needed.' },
              { q: 'What is the cut exactly?', a: `${pct(C.bps)} of your winnings only: ${pct(C.burnBps)} burned, ${pct(C.vaultBps)} kept in the arena vault. If your till at the bell is at or below what your coin started with, there is no cut.` },
              { q: 'What does the NFT give me?', a: `Early access while the game opens in phases, the emblem skin and holder mark, ${SH.holderDiscountPct}% off power-ups, an extra power-up use per arena round and cheaper private rooms.` },
              { q: `What is ${symbol} used for?`, a: 'Arena tickets and payouts, and power-ups in the shop. A share of every win and every shop payment is burned.' },
              { q: 'Why do the arenas say "Opening soon"?', a: `The ${symbol} token is not set on-chain yet. Practice is open; the arenas open by themselves as soon as it is set.` },
              { q: 'I lost my connection or closed the tab.', a: 'Your coin stays in the arena and can still be eaten. Come back and you carry on; alive at the bell, you are paid as usual.' },
              { q: 'Can I cash out early?', a: `No. Arenas have no cash-out: you are paid when the ${R.roundMin}-minute round ends.` },
              { q: 'I bought a ticket but never played.', a: `The server refunds the full entry fee after about ${S.staleTicketMinutes} minutes. If it does not, refund it yourself after ${F.refundHours} hours.` },
              { q: 'My payout has not arrived.', a: 'Check the payout banner in the lobby. "Collect payout" means your game is settled and the payout waits in the vault: collect it with one transaction. Otherwise the server is still sending it and retries by itself.' },
              { q: 'Are there prizes for the Standings?', a: 'No. The Today and All-time standings are for fun; they pay nothing.' },
              { q: 'Is this gambling?', a: 'It is a skill game played with a token of real value, and many countries may regulate it. Make sure playing is legal where you are. Burns are not a promise of returns.' },
            ],
          },
        ],
      },
    ],
  };
};
