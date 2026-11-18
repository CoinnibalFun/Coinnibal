import {
  BOOST_KEY_LABELS,
  BOOST_RULES,
  BPS,
  CUSTOM_CAPACITY_TIER,
  CUSTOM_DURATION_LIMITS,
  CUSTOM_LIMITS,
  DEFAULT_HOLDER_FEE_RATES,
  GAS_SYMBOL,
  INTEGRITY_SETTINGS_DEFAULT,
  PRACTICE_ROOM,
  RULES,
  SIWE_STATEMENT,
  SITE_HOST_DEFAULT,
  SITE_X_HANDLE_DEFAULT,
  TOKEN_SYMBOL_DEFAULT,
  NFT_SUPPLY,
  X_CODE_PREFIX,
  X_CODE_TTL_MS,
  activeChain,
  formatUsdCents,
  totalFeeBps,
  type FeeRates,
} from '@coinnibal/shared';
import { FACTS as F, type DocsContent } from './facts';

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const num = (n: number): string => nf.format(n);
/** `500` → `5%`, `450` → `4.5%`. */
const pct = (bps: number): string => `${nf.format(bps / 100)}%`;
/** `300000` → `5 minutes`, `30000` → `30 seconds`, `330000` → `5.5 minutes`. */
const clock = (ms: number): string => {
  if (ms < 60_000) return `${num(ms / 1000)} seconds`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec ? `${num(min)} minutes ${num(sec)} seconds` : `${num(min)} minutes`;
};
/** The same before a noun: `300000` → `5-minute`, `30000` → `30-second` ("a 30-second break"). */
const clockAdj = (ms: number): string => (ms < 60_000 ? `${num(ms / 1000)}-second` : `${num(ms / 60_000)}-minute`);
/** `8000` → `8 seconds`. A no-break space keeps the number and its unit on one line. */
const secs = (ms: number): string => `${num(ms / 1000)}\u00a0${ms === 1000 ? 'second' : 'seconds'}`;
/** An in-page link to another section of the guide: `[label](#id)`, drawn as a link by DocsPage (`RichText`). */
const see = (label: string, id: string): string => `[${label}](#${id})`;

const S = F.server;
const SH = F.shop;
const sym = TOKEN_SYMBOL_DEFAULT;
/** How many tickets one approval may cover: "1, 5, 10 or 20". */
const APPROVE = { choices: `${F.approve.choices.slice(0, -1).join(', ')} or ${F.approve.choices[F.approve.choices.length - 1]}`, preselected: F.approve.preselected } as const;

/** What the page knows about where it runs (the server's answer when known, else the build's defaults). */
export interface DocsEnv {
  /** The chain is a testnet (kept for callers; the guide reads the same on every network). */
  testnet?: boolean;
  /** The host the site is served at (`coinnibal.fun`). */
  site?: string;
  /** The project's X account, without `@` (`coinnibalfun`). */
  x?: string;
}

/**
 * The player guide in English: how the game, the rooms, the fee, the Coinnibal NFT and the token work. Plain words,
 * and one place per rule: another section links to that place (`see`) instead of saying the rule again. Every number comes from
 * `FACTS` (see facts.ts) or the shared rules; the fee rates on profit are the server's (`ChainStatus.fees`, the game
 * contract's `config()`) when known, else the contract defaults. `chain` names the Robinhood Chain network (testnet
 * or mainnet; the active one by default). Gas is ETH.
 *
 * One word per thing: room (practice, paid, private), ticket, round, bell, value, fee (only the fee on profit), burn,
 * team wallet, NFT, power-up. Temporary things (test rooms, the test network) are not described.
 */
export const docsEn = (
  symbol: string = sym,
  rates: FeeRates = { burnBps: F.fee.burnBps, vaultBps: F.fee.vaultBps },
  chain: string = activeChain().name,
  env: DocsEnv = {},
): DocsContent => {
  // visitors read the network's plain name ("Robinhood Chain"); the wallet shows the exact network itself
  chain = chain.replace(/\s+Testnet$/i, '');
  const site = env.site || SITE_HOST_DEFAULT;
  const x = (env.x || SITE_X_HANDLE_DEFAULT).replace(/^@/, '');
  const total = pct(totalFeeBps(rates));
  const burn = pct(rates.burnBps);
  const team = pct(rates.vaultBps);
  const payBurn = pct(F.fee.paymentBurnBps);
  const payTeam = pct(BPS - F.fee.paymentBurnBps);
  const holder = DEFAULT_HOLDER_FEE_RATES;
  const holdersRoom = F.arenas
    .filter((a) => a.holdersOnly)
    .map((a) => a.name)
    .join(', ');
  const notAudited = 'The smart contracts have not been audited yet.';
  return {
    pct,
    num,
    // the plate above already says "Player guide" (and the art's stamp "Guide"): no third label
    kicker: '',
    title: 'How Coinnibal works',
    deck: 'Everything about Coinnibal in one place: how a round works, the rooms and tickets, the fee, power-ups and what the NFT gives you.',
    rates,
    tocLabel: 'Contents',
    receipt: {
      title: 'Round over',
      meta: 'Example',
      entry: 'Ticket price',
      cashout: 'Value at the bell',
      winnings: 'Profit',
      burn: (p) => `Burned (${p} of profit)`,
      vault: (p) => `Team wallet (${p} of profit)`,
      net: 'Paid to your wallet',
      footer: `Amounts in ${symbol}`,
      // the token's name comes from the server: worded so any name reads right ("a ticket of 1,000 tokens")
      caption: `A ticket of ${num(F.example.entry)} ${symbol}, worth ${num(F.example.cashout)} ${symbol} at the bell`,
    },
    colophon: '',
    backToTop: 'Back to top',
    sections: [
      {
        id: 'play',
        title: 'How to play',
        lede: 'Eat food to grow. Eat smaller coins. Stay away from bigger ones.',
        strip: { label: 'The basic rule', panels: ['Eat food. Grow.', `${num(RULES.eatRatio)} times its mass? Eat it.`, 'Bigger than you? Run.'] },
        blocks: [
          {
            kind: 'p',
            text: `Your coin follows the mouse. Food makes it bigger. A coin can eat another coin when it has at least ${num(RULES.eatRatio)} times its mass and covers most of it. Bigger coins move slower, and a coin above ${num(RULES.decayStartMass)} mass slowly loses mass.`,
          },
          {
            kind: 'keys',
            caption: 'Controls',
            rows: [
              { key: 'Mouse', action: 'Move toward the pointer' },
              { key: 'WASD / arrows', action: 'Move with the keyboard' },
              { key: 'Space / left click', action: 'Split: shoot half of your coin forward' },
              { key: 'E', action: 'Push out a little mass (hold to repeat)' },
              { key: Object.values(BOOST_KEY_LABELS).join(' / '), action: `Use a power-up (see ${see('Power-ups', 'powerups')})` },
              { key: '1–8', action: 'Show an emote over your coin' },
              { key: 'Enter', action: 'Chat' },
              { key: 'Tab (hold)', action: 'Show the standings of the room' },
              { key: 'Q', action: 'Watch the next player (when watching)' },
              { key: 'Esc', action: 'Close the chat or an open panel' },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'On phones:',
                text: 'a joystick at the bottom left moves your coin. The buttons for split, push-out and power-ups are on the right. A tap on the standings card opens the full standings.',
              },
              {
                term: 'Split:',
                text: `needs ${RULES.splitMinMass} mass. A coin can be in up to ${RULES.maxCells} pieces. The pieces stay close together and join again after ${secs(RULES.mergeBaseMs)} or more (bigger pieces take longer). Small pieces are easy to eat.`,
              },
              { term: 'Rug cacti:', text: 'a big coin that touches a cactus breaks into pieces. Small coins can hide behind one.' },
              {
                term: 'Airdrops:',
                text: `free pickups that land on the map. Magnet pulls food for ${secs(RULES.magnetMs)}. Pump gives extra speed for ${secs(RULES.pumpMs)}. HODL Shield stops other coins from eating you for ${secs(RULES.shieldMs)}, but you cannot eat them either. Mega Bag adds mass at once.`,
              },
              { term: 'Spawn shield:', text: `a new coin cannot eat or be eaten by other coins for ${secs(RULES.spawnShieldMs)}.` },
            ],
          },
        ],
      },
      {
        id: 'rooms',
        title: 'Rooms and tickets',
        lede: 'Three kinds of room: practice, paid and private.',
        strip: { label: 'Free or paid', panels: ['Practice: free.', 'Paid room: one ticket, one coin.', "The ticket price goes into the room's vault."] },
        blocks: [
          {
            kind: 'list',
            items: [
              {
                term: 'Practice rooms',
                text: `are free: no wallet, no token, no payout. They have no rounds and no bell. Up to ${F.capacity.practice} players per room.`,
              },
              {
                term: 'Practice leagues:',
                text: `Rookie and Pro. A profile at level ${S.proLevel} or higher plays in Pro. A Rookie game above ${num(S.promoteMaxMass)} mass or with ${S.promoteKills} coins eaten moves you to Pro for ${S.promotionHours} hours.`,
              },
              {
                term: 'Paid rooms',
                text: `are the four rooms in the table. They play in rounds, one after another (see ${see('Rounds, payout and fee', 'payout')}). A room holds up to ${F.capacity.arena} players; when it is full, another copy of the room opens with the same vault.`,
              },
            ],
          },
          {
            kind: 'table',
            caption: 'Paid rooms: ticket prices, paid in our game token',
            head: ['Room', 'Ticket', 'Who can join'],
            rows: F.arenas.map((a) => [a.name, formatUsdCents(a.usdCents), a.holdersOnly ? 'NFT holders' : 'Everyone']),
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Ticket:',
                text: `one ticket is one coin in one round. You pay for it in our game token; the lobby shows the amount. You can have one open ticket per room.`,
              },
              {
                term: 'Buying a ticket',
                text: `needs an EVM wallet (for example MetaMask or Rabby), ${symbol} for the ticket and a little ${GAS_SYMBOL} on ${chain} for network fees. It takes at most two signatures: an approval, then the ticket. The approval covers ${APPROVE.choices} tickets of that room (${APPROVE.preselected} is preselected), so the next tickets need one signature.`,
              },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Private rooms:',
                text: `a signed-in wallet can open a room with its own rules and an invite code: ${CUSTOM_DURATION_LIMITS.min} to ${CUSTOM_DURATION_LIMITS.max} minutes long, ${CUSTOM_LIMITS.playersMin} to ${CUSTOM_LIMITS.playersMax} players. Opening one costs a small fee in tokens: bigger rooms cost more, and the price shows before you pay. Like a power-up pack, ${payBurn} of the fee is burned and ${payTeam} goes to the team wallet. NFT holders open one room a day for free. There are two kinds.`,
              },
              { term: 'Free room:', text: 'no tickets and no payout. Anyone with the code can join, even without a wallet.' },
              {
                term: 'Ticket room:',
                text: `a private copy of a paid room. Every player buys the normal ticket of that room. The creator buys theirs while creating the room. The room has its own clock: one game from its creation to its end, with no ${clockAdj(RULES.roundMs)} bell. Coins still alive at the room's end are paid, with the normal fee on profit. Joins close ${secs(RULES.roundJoinCloseMs)} before the end; a ticket bought too late is refunded in full.`,
              },
              {
                term: 'Bots',
                text: `play only in free private rooms. When practice is quiet, the lobby offers "${PRACTICE_ROOM.name}": a free ${PRACTICE_ROOM.durationMin}-minute room with ${PRACTICE_ROOM.bots} bots for up to ${PRACTICE_ROOM.maxPlayers} players. Bots are labelled BOT.`,
              },
            ],
          },
        ],
      },
      {
        id: 'value',
        title: 'Value: how tokens move',
        lede: `In a paid room your coin has a value in ${symbol}.`,
        strip: { label: 'Value moves by eating', panels: ['Eat a coin.', 'Its value moves to you.', 'Alive at the bell? Paid.'] },
        blocks: [
          {
            kind: 'flow',
            label: 'How value moves',
            diagram: { ticket: 'Your ticket', vault: 'Room vault', wallet: 'Your wallet', fee: 'Burn + team wallet' },
            steps: [
              { title: 'Ticket', text: 'Your coin starts with the whole ticket price as its value.' },
              { title: 'Eating', text: "If a coin has split into pieces, eating one piece gives you a share of its value that matches the piece's size. The last piece gives the rest." },
              { title: 'Bell', text: 'If your coin is alive at the bell, you are paid its value from the vault, minus the fee on profit.' },
            ],
          },
          {
            kind: 'list',
            items: [
              { term: 'Mass is not value.', text: 'Pushing out mass, breaking on a cactus and losing mass over time do not change the value. Only eating does.' },
              { term: 'An eaten coin', text: 'has no value left, and its ticket is closed. You can buy a new ticket while joins are open.' },
            ],
          },
        ],
      },
      {
        id: 'payout',
        title: 'Rounds, payout and fee',
        lede: 'The four paid rooms share one clock.',
        strip: {
          label: 'One round',
          panels: [`${clock(RULES.roundMs)} of play.`, 'The bell: coins still alive are paid.', `The fee is ${total} of the profit.`],
        },
        blocks: [
          {
            kind: 'p',
            text: `A round is ${clock(RULES.roundMs)} of play, then a ${clockAdj(RULES.roundBreakMs)} break, so a new round starts every ${clock(RULES.roundMs + RULES.roundBreakMs)}.`,
          },
          {
            kind: 'list',
            items: [
              { term: 'Joins', text: `close ${secs(RULES.roundJoinCloseMs)} before the bell. A ticket bought after that or in the break is held and joins the next round by itself.` },
              { term: 'No cash-out:', text: 'you cannot leave a round early with your value.' },
              {
                term: 'Payout:',
                text: 'the server sends the payouts on-chain during the break and pays their network fee. The "Round over" sheet shows the amount and the transaction.',
              },
            ],
          },
          {
            kind: 'p',
            text: `The game takes one fee: ${total} of your profit. Profit is your value at the bell minus the ticket price. ${burn} of the profit is burned and ${team} goes to the team wallet. No profit, no fee. The network fees in ${GAS_SYMBOL} go to the network, not to Coinnibal.`,
          },
          { kind: 'fee-example' },
          {
            kind: 'note',
            tone: 'warn',
            stamp: 'Risk',
            title: 'Know the risk',
            text: `In a paid room a ticket costs real money, and an eaten coin loses it. Check that playing is legal where you live. Burns are not a promise of profit. ${notAudited}`,
          },
        ],
      },
      {
        id: 'powerups',
        title: 'Power-ups',
        lede: `Four power-ups, sold in packs in the lobby shop, each with its own key. They are not the free airdrops on the map (see ${see('How to play', 'play')}), and their times are different.`,
        blocks: [
          {
            kind: 'cards',
            label: 'The four power-ups',
            items: [
              {
                key: BOOST_KEY_LABELS.magnet,
                title: 'Magnet',
                text: `Pulls nearby food to your coin for ${secs(BOOST_RULES.magnet.durationMs)}.`,
                meta: `Cooldown ${secs(BOOST_RULES.magnet.cooldownMs)}`,
              },
              {
                key: BOOST_KEY_LABELS.leap,
                title: 'Leap',
                text: 'Jumps your coin toward the pointer at once. It cannot cross the wall.',
                meta: `Cooldown ${secs(BOOST_RULES.leap.cooldownMs)}`,
              },
              {
                key: BOOST_KEY_LABELS.speed,
                title: 'Speed burst',
                text: `Extra speed for ${secs(BOOST_RULES.speed.durationMs)}.`,
                meta: `Cooldown ${secs(BOOST_RULES.speed.cooldownMs)}`,
              },
              {
                key: BOOST_KEY_LABELS.invis,
                title: 'Invisibility',
                text: `Other players cannot see your coin, its name or its minimap dot for ${secs(BOOST_RULES.invis.durationMs)}. It can still eat and be eaten.`,
                meta: `Cooldown ${secs(BOOST_RULES.invis.cooldownMs)}`,
              },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Packs:',
                text: `a pack holds ${SH.packSize} uses of one power-up. The shop shows each price, paid in ${symbol}. Several packs can be paid in one transaction.`,
              },
              { term: 'Where the payment goes:', text: `${payBurn} is burned and ${payTeam} goes to the team wallet.` },
              {
                term: 'Limit:',
                text: `in a paid room you can use ${SH.arenaUses} power-ups per round (per game in a ticket room), all four kinds together. Practice rooms and free private rooms have no limit, only the cooldown.`,
              },
              { term: 'Shop:', text: 'it needs a signed-in wallet. Nothing is sold during a game.' },
            ],
          },
        ],
      },
      {
        id: 'nft',
        title: 'The Coinnibal NFT',
        lede: `A coin character on ${chain}. A wallet that holds one gets perks in the game.`,
        blocks: [
          {
            kind: 'p',
            text: `The Coinnibal NFT collection has ${num(NFT_SUPPLY)} NFTs. The NFT is not a ticket and has no value in a round.`,
          },
          {
            kind: 'table',
            caption: 'What the NFT changes',
            head: ['Perk', 'No NFT', 'NFT holder'],
            stack: true,
            rows: [
              ['Fee on profit', total, `${pct(totalFeeBps(holder))} (${pct(holder.burnBps)} burned, ${pct(holder.vaultBps)} team wallet)`],
              [holdersRoom, 'Closed', 'Open'],
              ['Power-up packs', 'Full price', `${SH.holderDiscountPct}% off`],
              ['Power-ups per round in a paid room', String(SH.arenaUses), String(SH.arenaUses + SH.holderExtraUses)],
              ['Private room', 'Paid in tokens', `1 free a day, up to ${CUSTOM_CAPACITY_TIER} players`],
              ['Coin look', 'Standard skins', 'Also the NFT skin and a holder badge'],
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'One NFT, one wallet:',
                text: 'each NFT gives its perks to one open ticket at a time, and its free room and power-up discount to one wallet a day.',
              },
            ],
          },
        ],
      },
      {
        id: 'token',
        title: 'The game token',
        lede: 'What the token pays for, and what it does not.',
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Used for:', text: 'the tickets and payouts of the paid rooms, power-up packs and opening a private room.' },
              { term: 'Not used for:', text: `the NFT mint and network fees. These are paid in ${GAS_SYMBOL}.` },
              {
                term: 'Burn:',
                text: `a part of every fee on profit is burned, and ${payBurn} of every power-up and private-room payment (see ${see('Rounds, payout and fee', 'payout')} and ${see('Power-ups', 'powerups')}). Burned tokens are gone for good. The game never creates new ${symbol}.`,
              },
              {
                term: 'Set once:',
                text: 'the game token is set in the contract once and can never be changed.',
              },
            ],
          },
        ],
      },
      {
        id: 'fair',
        title: 'Contract and server',
        lede: 'What anyone can check on-chain, and what you trust the game server for.',
        strip: { label: 'Who does what', panels: ['Money rules: in the contract.', 'The game: on the server.', 'Anyone can read the contract.'] },
        blocks: [
          {
            kind: 'compare',
            left: {
              title: 'On-chain: anyone can check',
              items: [
                "Ticket money sits in the room's vault. A payout can never be more than the vault holds.",
                `The fee rates are written on the ticket when it is bought. The contract allows at most ${pct(F.fee.maxBps)} of a profit.`,
                'The contract does the burns, so anyone can check them.',
                'Every ticket has its own id, so a payout cannot be used twice.',
                'The game server can only use a vault to pay players, refund tickets and burn tokens. The team cannot take tokens out of a vault that has open tickets.',
              ],
            },
            right: {
              title: 'On the server: players trust it',
              items: [
                'The game itself: movement, who ate whom, and the value of each coin at the bell.',
                `The dollar price of the game token, set by the team. It decides how many ${symbol} a ticket or a pack costs.`,
                'Power-up uses: the payment is on-chain, the uses are kept on the server.',
                'Levels, XP, leagues and ranks.',
                'The chat filter.',
              ],
            },
          },
        ],
      },
      {
        id: 'wallet',
        title: 'Wallet safety',
        lede: 'Read every request before you sign.',
        strip: { label: 'Stay safe', panels: ['Someone asks for your seed phrase.', 'Never give it to anyone.', 'Sign only what you have read.'] },
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Sign-in', text: `is a free message, not a transaction. It reads: "${SIWE_STATEMENT}"` },
              {
                term: 'Approvals:',
                text: `a ticket approval names the game contract and a fixed amount of ${symbol}. An approval for another address or for an unlimited amount is not from Coinnibal.`,
              },
              { term: 'Seed phrase:', text: 'Coinnibal never asks for your seed phrase or a private key. Anyone who asks is a scammer.' },
              { term: 'Separate wallet:', text: 'use a wallet only for games and keep only the amount you play with in it.' },
              {
                term: 'Official links:',
                text: `the site is ${site} and the X account is @${x}. The NFT mint will be on OpenSea: use only the OpenSea link that @${x} posts.`,
              },
            ],
          },
        ],
      },
      {
        id: 'profile',
        title: 'Profile, X and ranks',
        lede: 'A signed-in wallet has a profile. Your X account can show on your coin.',
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Profile:', text: 'a name, a coin skin or picture, a country flag, a level and XP.' },
              {
                term: 'Link X:',
                text: `Profile → Link X shows a code such as ${X_CODE_PREFIX}-7K2M9Q. You post it from your X account and paste the link of the post. There is no X login. A code is valid for ${X_CODE_TTL_MS / 60_000} minutes.`,
              },
              {
                term: 'After linking,',
                text: 'your @handle shows on your coin and your X picture can be your coin picture. Players who eat you can tag you when they share.',
              },
              {
                term: 'Share on X',
                text: 'is on the top bar during a game, on the sheet at the end of a game and right after eating a player. It opens X with a ready text and a link to a card of the game. The card picture can also be downloaded. Nothing is posted until you post it.',
              },
              { term: 'Ranks:', text: 'the Ranks page lists the best games of today and of all time, the last rounds and the countries. Ranks pay nothing.' },
            ],
          },
        ],
      },
      {
        id: 'help',
        title: 'When something goes wrong',
        lede: 'What happens to a ticket in each case.',
        blocks: [
          {
            kind: 'list',
            items: [
              {
                term: 'Lost connection:',
                text: 'your coin stays in the paid room and can still be eaten. You can come back and keep playing. If it is alive at the bell, you are paid as usual.',
              },
              { term: 'Ticket not played:', text: `a ticket that never entered a room is refunded in full by the server after about ${S.staleTicketMinutes} minutes.` },
              {
                term: 'Payout not received:',
                text: 'if the transfer to the wallet fails, the payout waits in the vault and the lobby shows "Collect payout". One transaction collects the exact amount, at any time.',
              },
              {
                term: 'Payout on hold:',
                text: `if the anti-cheat checks flag a winning game, its payout waits for a team check instead of going out in the break. With no decision within ${INTEGRITY_SETTINGS_DEFAULT.autoReleaseHours} hours, it is paid as usual. If the check finds cheating, nothing is paid.`,
              },
              {
                term: 'Ticket never settled:',
                text: `if the server never settles a ticket, you can refund the ticket price ${F.refundHours} hours after buying it ("Refund ticket" in the lobby).`,
              },
              { term: 'Server crash:', text: 'the server saves every change of value. After a restart, open tickets are settled at their last saved value.' },
            ],
          },
        ],
      },
    ],
  };
};
