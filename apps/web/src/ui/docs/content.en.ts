import { BOOST_RULES, BPS, CUSTOM_CAPACITY_TIER, DEFAULT_ARENAS, DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, activeChain, bpsToPercent, formatUsdCents, GAS_SYMBOL, TOKEN_SYMBOL_DEFAULT, totalFeeBps, type FeeRates } from '@elymum/shared';
import { FACTS as F, payoutExample, type DocsContent } from './facts';

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const num = (n: number): string => nf.format(n);
/** `500` → `5%`, `450` → `4.5%`. */
const pct = (bps: number): string => `${nf.format(bps / 100)}%`;

const S = F.server;
const R = F.rules;
const SH = F.shop;
const sym = TOKEN_SYMBOL_DEFAULT;
/** How many tickets one approval may cover: "1, 5, 10 or 20". */
const APPROVE = { choices: `${F.approve.choices.slice(0, -1).join(', ')} or ${F.approve.choices[F.approve.choices.length - 1]}`, preselected: F.approve.preselected } as const;

/**
 * The player guide in English: how to play, what the Coinnibal NFT and the token are for, and how the money
 * moves, kept short. Every number comes from `FACTS` (see facts.ts); the fee rates on profit are the server's
 * (`ChainStatus.fees`, the arena contract's `config()`) when known, else the contract defaults. `chain` names the
 * Robinhood Chain network (testnet or mainnet; the active one by default). Gas is ETH.
 */
export const docsEn = (
  symbol: string = sym,
  rates: FeeRates = { burnBps: F.fee.burnBps, vaultBps: F.fee.vaultBps },
  chain: string = activeChain().name,
): DocsContent => {
  const ex = payoutExample(rates);
  const total = pct(totalFeeBps(rates));
  const burn = pct(rates.burnBps);
  const vault = pct(rates.vaultBps);
  const payBurn = pct(F.fee.paymentBurnBps);
  const payVault = pct(BPS - F.fee.paymentBurnBps);
  return {
    pct,
    num,
    kicker: 'Player guide',
    title: 'How Coinnibal works',
    deck: `How to play, how rounds and fees work, what the Coinnibal NFT and ${symbol} are for. Short and simple. The numbers here are the game's defaults; the numbers on your ticket are the ones that count.`,
    rates,
    dateline: [
      `Fee ${total} of profit only`,
      `Rounds ${R.roundMin} min + ${R.breakS} s break · joins close ${R.joinCloseS} s before the bell`,
      `${F.capacity.arena} players per room`,
      `${burn} of profit burned`,
    ],
    tocLabel: 'Contents',
    receipt: {
      title: 'Round over',
      meta: `Example · fee ${total} of profit`,
      entry: 'Entry fee (your coin starts at it)',
      cashout: 'Till at the bell',
      winnings: 'Profit',
      burn: (p) => `Burned (${p} of profit)`,
      vault: (p) => `Fee wallet (${p} of profit)`,
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
        lede: 'Eat food, grow, eat smaller coins, run from bigger ones.',
        strip: { label: 'The one rule', panels: ['Eat food. Grow.', `${num(R.eatRatio)} times bigger? You can eat it.`, 'Smaller? Run.'] },
        blocks: [
          {
            kind: 'p',
            text: `Pick Practice in the lobby and press Quick Play. You don't need a wallet. Your coin follows the mouse. You can also use WASD or the arrow keys (on phones, the joystick at the bottom left). Eat food to grow. To eat a coin, you must be ${num(R.eatRatio)} times its size and cover most of it. Big coins are slow. Split to catch others, and stay away from anything bigger than you.`,
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
              { key: 'Tab (hold)', action: 'Everyone in the room: the full standings while held (tap the standings card on phones)' },
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
                text: 'split only when it is safe, stay away from walls and corners when a big coin is near, and remember: a split coin is weak.',
              },
            ],
          },
        ],
      },
      {
        id: 'rooms',
        title: 'Rooms and tickets',
        lede: 'Practice is free. Paid rooms need a ticket.',
        strip: { label: 'Two kinds of room', panels: ['Practice: free.', 'Paid rooms: buy a ticket.', 'The ticket money goes into the vault.'] },
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
                text: `are your own rooms with your own rules and an invite code, free or with tickets, opened for a small fee in ${GAS_SYMBOL}; Coinnibal NFT holders open one a day for free (up to ${CUSTOM_CAPACITY_TIER} players).`,
              },
              {
                term: 'Opening soon:',
                text: `the arenas open once the ${symbol} token is set on-chain (once, after launch; it can never change). Until then the lobby shows "Opening soon" and practice is open.`,
              },
            ],
          },
          {
            kind: 'table',
            caption: `The rooms: ticket prices in US dollars, paid in ${symbol}`,
            head: ['No', 'Room', 'Ticket', 'Who'],
            numeric: [0, 2],
            rows: F.arenas.map((a) => [String(a.id), a.name, formatUsdCents(a.usdCents), a.holdersOnly ? 'NFT holders' : 'Everyone']),
          },
          {
            kind: 'p',
            text: `A ticket needs an EVM wallet (MetaMask, Rabby or any browser wallet), the entry fee in ${symbol} and a little of the network's gas token (${GAS_SYMBOL} on ${chain}) for network fees. The lobby shows each ticket's dollar price with its ${symbol} amount next to it, set from the token's price. Buying takes at most two signatures: an approval for the arena contract, then the ticket itself. You choose how many tickets of that room the approval covers (${APPROVE.choices}; ${APPROVE.preselected} preselected, never unlimited), so the next tickets need only one signature. There is no entry fee rate: the whole entry fee goes into the vault and your coin starts at it.`,
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
            diagram: { ticket: 'Your ticket', vault: 'Arena vault', wallet: 'Your wallet', fee: 'Burn + fee wallet' },
            steps: [
              { title: 'Entry', text: 'Your coin starts at the whole entry fee: nothing is taken when you join.' },
              { title: 'Eating', text: "An eaten cell moves its share of the victim's value to the eater: ⌊V · m / M⌋. The last cell moves everything left." },
              { title: 'The bell', text: `When the round ends, your value is paid to your wallet, less ${total} of your profit (nothing if you did not win).` },
            ],
          },
          {
            kind: 'list',
            items: [
              { term: 'Mass is not value.', text: 'Tipping mass (E), cactus pops and mass decay never change your value; value only changes hands by eating.' },
              { term: 'Only people play the official arenas.', text: 'Every coin in an arena is a player who bought a ticket; the game fields no coins of its own there. Only on the testnet, the extra rooms marked TEST also field practice coins that carry no value.' },
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
        title: 'Rounds, payout and the fee',
        lede: `Arenas play ${R.roundMin}-minute rounds. Stay alive until the bell and you are paid your value.`,
        strip: {
          label: 'Five minutes, then the bell',
          panels: [`${R.roundMin} minutes on the clock.`, 'The bell rings. Everyone alive is paid.', `${total} of the profit is the fee. Nothing if you did not win.`],
        },
        blocks: [
          {
            kind: 'p',
            text: `Rounds follow the clock in every arena at once: ${R.roundMin} full minutes of play, then a ${R.breakS} s break, so a new round starts every ${R.roundMin} minutes ${R.breakS} seconds. There is no cash-out in an arena and no way to leave early with money. When the bell rings, everyone still alive is paid, the server sends the payout on-chain and the "Round over" receipt shows the transaction link. After the bell the floor rests for ${R.breakS} s while the payouts go out ("Next round opens in"), then the next round opens; the break never comes out of the play. Joins close ${R.joinCloseS} s before the bell; a ticket bought while joins are closed, in the break or the final minute, joins the next round automatically.`,
          },
          {
            kind: 'p',
            text: `The only fee is ${total} of your profit, the part of your till above your entry fee, taken by the arena contract when it pays you: break even or lose and you pay nothing, and there is no fee to enter. Of your profit, ${burn} is burned (it leaves the ${symbol} supply for good) and ${vault} goes to the game's fee wallet. The rates are written into your ticket when you buy it, and the contract caps them at ${pct(F.fee.maxBps)} together. Example: entry ${num(ex.entry)}; the till at the bell is ${num(ex.payout)}, so your profit is ${num(ex.profit)}: ${num(ex.burned)} is burned, ${num(ex.toVault)} goes to the fee wallet and you get ${num(ex.net)}.`,
          },
          { kind: 'fee-example' },
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
        title: 'The Coinnibal NFT',
        lede: 'Your key to the game, with perks every time you play.',
        blocks: [
          {
            kind: 'p',
            text: `The Coinnibal NFT is a collection of coin characters (ERC-721) on ${chain}. You mint it on the Mint page with ${GAS_SYMBOL}: the WL first, then everyone. The Mint page shows the price from the contract before you sign. The NFT is not a ticket and has no value inside a round. It is your membership card.`,
          },
          {
            kind: 'list',
            items: [
              { term: 'Access:', text: 'while the game opens step by step, holders play first (WL → Mint → Play).' },
              { term: 'NFT skin and badge:', text: 'holders can wear their NFT coin, and get a holder badge on their name (looks only).' },
              { term: 'Cheaper power-ups:', text: `holders pay ${SH.holderDiscountPct}% less for every power-up pack in the shop.` },
              { term: 'More power-ups per round:', text: `${SH.holderExtraUses} extra power-up use per round in paid arenas (${SH.arenaUses + SH.holderExtraUses} instead of ${SH.arenaUses}).` },
              {
                term: 'A lower fee:',
                text: `holders pay a smaller fee on profit: ${bpsToPercent(totalFeeBps(DEFAULT_HOLDER_FEE_RATES))} % instead of ${bpsToPercent(totalFeeBps(DEFAULT_FEE_RATES))} % (${bpsToPercent(DEFAULT_HOLDER_FEE_RATES.burnBps)} % burned, ${bpsToPercent(DEFAULT_HOLDER_FEE_RATES.vaultBps)} % to the team). These are the configured holder perks; your ticket always shows the live rate before you pay.`,
              },
              { term: 'Private rooms:', text: 'holders open one room a day for free (a UTC day, rooms of up to 10 players); the room settings may give a discount instead.' },
              {
                term: 'Holders-only room:',
                text: `the ${DEFAULT_ARENAS.filter((a) => a.holdersOnly).map((a) => formatUsdCents(a.usdCents)).join(', ')} room is for holders only, on-chain.`,
              },
              { term: 'Testnet faucet:', text: 'on testnet, holders get twice the free test tokens from the faucet.' },
            ],
          },
        ],
      },
      {
        id: 'token',
        title: `The ${symbol} token`,
        lede: 'The one token of the game: you play with it, you win it, and every win and every power-up burns some of it.',
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Arena tickets:', text: `every arena entry fee is paid in ${symbol}, and every payout is paid in ${symbol}.` },
              {
                term: 'Power-ups:',
                text: `packs of ${SH.packSize} charges in the shop, priced in US dollars and paid in ${symbol} at the token's price: Magnet ${formatUsdCents(SH.usdCents.magnet)}, Leap ${formatUsdCents(SH.usdCents.leap)}, Speed burst ${formatUsdCents(SH.usdCents.speed)} and Invisibility ${formatUsdCents(SH.usdCents.invis)} by default. Put several packs in the cart and pay once. Each payment goes to the arena contract, which burns ${payBurn} of it and sends ${payVault} to the fee wallet.`,
              },
              { term: 'Burn on every win:', text: `${burn} of every profit is burned, and so is floor loot left at the bell: the more the game is played, the smaller the supply. Nothing mints new ${symbol}.` },
              { term: 'Fee wallet:', text: `${vault} of every profit and ${payVault} of every power-up payment go to the game's fee wallet, on-chain and visible to anyone.` },
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
            text: `Each power-up has a cooldown. Use them freely in practice and private rooms; in paid arenas at most ${SH.arenaUses} per round (${SH.arenaUses + SH.holderExtraUses} for NFT holders). The shop is in the lobby (the lightning key at the top); nothing is sold during a game.`,
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
                "Burns use the token's own burn() when it has one, else go to the burn address; anyone can check them.",
                `The fee on profit and its rates: at most ${pct(F.fee.maxBps)} of a profit, never anything on a loss.`,
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
            text: `The server key can only settle open tickets and burn from an arena's vault (never more than it holds); it cannot move tokens to a wallet of its choice. The admin cannot take an open arena's vault. Coinnibal currently runs on ${chain}; the network may change in the future, and any move will be announced in the official channels.`,
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
        lede: 'Read before you sign. Coinnibal never asks for your secret recovery phrase.',
        strip: { label: 'Read before you sign', panels: ['Someone asks for your phrase.', 'Never. Not to anyone.', 'Sign only what you have read.'] },
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Sign-in', text: 'is only a message signature ("Sign in to Coinnibal. This is free and sends no transaction."): no transaction, no cost.' },
              { term: 'A ticket', text: `takes at most two transactions: an approval of the arena contract for ${symbol} (for the entry fee of ${APPROVE.choices} tickets of that room, your choice, never unlimited), then the ticket itself. If your wallet asks you to approve any other address, do not sign.` },
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
              { q: 'What is the fee exactly?', a: `${total} of your profit only: ${burn} burned, ${vault} to the fee wallet. If your till at the bell is at or below your entry fee, there is no fee. Joining is free of fees.` },
              { q: 'What does the NFT give me?', a: `Early access, a lower fee on profit (${bpsToPercent(totalFeeBps(DEFAULT_HOLDER_FEE_RATES))}% instead of ${bpsToPercent(totalFeeBps(DEFAULT_FEE_RATES))}%), the holders-only ${DEFAULT_ARENAS.filter((a) => a.holdersOnly).map((a) => formatUsdCents(a.usdCents)).join(', ')} room, ${SH.holderDiscountPct}% off power-ups and one extra power-up per paid round, a free private room every day, the NFT skin and holder badge, and twice the testnet faucet.` },
              { q: `What is ${symbol} used for?`, a: 'Arena tickets and payouts, and power-ups in the shop. A share of every profit and half of every shop payment are burned.' },
              { q: 'Why do the arenas say "Opening soon"?', a: `The ${symbol} token is not set on-chain yet. Practice is open; the arenas open by themselves as soon as it is set.` },
              { q: 'I lost my connection or closed the tab.', a: 'Your coin stays in the arena and can still be eaten. Come back and you carry on; alive at the bell, you are paid as usual.' },
              { q: 'Can I cash out early?', a: `No. Arenas have no cash-out: you are paid when the ${R.roundMin}-minute round ends.` },
              { q: 'I bought a ticket but never played.', a: `The server refunds the full entry fee after about ${S.staleTicketMinutes} minutes. If it does not, refund it yourself after ${F.refundHours} hours.` },
              { q: 'My payout has not arrived.', a: 'Check the payout banner in the lobby. "Collect payout" means your game is settled and the payout waits in the vault: collect it with one transaction. Otherwise the server is still sending it and retries by itself.' },
              { q: 'How do I share a game on X?', a: 'Press "Share on X" on the top bar during a game, on the "Round over" receipt or right after you eat someone. X opens with a short line and a card of your game; nothing is posted until you post it.' },
              { q: 'Can I show my X account on my coin?', a: 'Yes: Profile → Link X. Post the code shown there from your X account and paste the post\'s link (no X login). Your @handle then shows on your coin, you can wear your X picture, and players who eat you can tag you when they share.' },
              { q: 'Are there prizes for the Standings?', a: 'No. The Today and All-time standings are for fun; they pay nothing.' },
              { q: 'Is this gambling?', a: 'It is a skill game played with a token of real value, and many countries may regulate it. Make sure playing is legal where you are. Burns are not a promise of returns.' },
            ],
          },
        ],
      },
    ],
  };
};
