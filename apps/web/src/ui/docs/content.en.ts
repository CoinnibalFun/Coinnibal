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
    deck: 'This guide explains how a round works, the rooms and tickets, the fee, the power-ups and what the NFT gives you.',
    rates,
    tocLabel: 'Contents',
    tocCount: (n) => `${n} chapters`,
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
      caption: `Example: a ticket of ${num(F.example.entry)} ${symbol} that is worth ${num(F.example.cashout)} ${symbol} at the bell`,
    },
    colophon: `For news, follow @${x} on X.`,
    backToTop: 'Back to top',
    sections: [
      {
        id: 'play',
        title: 'How to play',
        lede: 'Eat food to grow. Eat coins smaller than you and run from the ones that are bigger.',
        strip: { label: 'The basic rule', panels: ['Eat food to grow.', 'Eat coins smaller than you.', 'Run from coins bigger than you.'] },
        blocks: [
          {
            kind: 'p',
            text: `Your coin follows your mouse, or the joystick on a phone. Food makes it bigger. A coin's size is called its mass. A coin can eat another coin when its mass is at least ${num(RULES.eatRatio)} times the other coin's mass and it covers most of the other coin. Bigger coins move more slowly, and a coin with more than ${num(RULES.decayStartMass)} mass slowly loses mass.`,
          },
          {
            kind: 'keys',
            caption: 'On a computer',
            rows: [
              { key: 'Mouse', action: 'Move toward the pointer' },
              { key: 'WASD / arrows', action: 'Move with the keyboard' },
              { key: 'Space / left click', action: 'Split: shoot half of your coin forward' },
              { key: 'E', action: 'Push out a little mass (hold to keep going)' },
              {
                key: Object.values(BOOST_KEY_LABELS).join(' / '),
                action: `Use a power-up: ${BOOST_KEY_LABELS.magnet} Magnet, ${BOOST_KEY_LABELS.leap} Leap, ${BOOST_KEY_LABELS.speed} Speed burst, ${BOOST_KEY_LABELS.invis} Invisibility (see ${see('Power-ups', 'powerups')})`,
              },
              { key: '1–8', action: 'Show a sticker over your coin' },
              { key: 'Enter', action: 'Open the chat' },
              { key: 'Tab (hold)', action: 'Show the standings of the room' },
              { key: 'Q', action: 'Watch the next player (while you watch a game)' },
              { key: 'Esc', action: 'Close the chat or an open panel' },
            ],
          },
          {
            // the game's own words on a phone (MobileControls, GameHud): Split, Tip, the sticker and chat buttons
            kind: 'keys',
            touch: true,
            caption: 'On a phone',
            rows: [
              { key: 'Joystick (bottom left)', action: 'Move your coin' },
              { key: 'Split', action: 'Split: shoot half of your coin forward' },
              { key: 'Tip', action: 'Push out a little mass (hold to keep going)' },
              { key: 'Power-up buttons', action: 'Use a power-up. Each button shows its picture and how many you own.' },
              { key: 'Sticker button', action: 'Show a sticker over your coin' },
              { key: 'Chat button', action: 'Open the chat' },
              { key: 'Standings card (top left)', action: 'Tap it to see everyone in the room' },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Split:',
                text: `your coin needs at least ${RULES.splitMinMass} mass to split, and it can be in up to ${RULES.maxCells} pieces. The pieces stay close together and join again after ${secs(RULES.mergeBaseMs)} or more (bigger pieces take longer). Small pieces are easy for other coins to eat.`,
              },
              {
                // world.ts: a coin pops on a cactus only with at least `virusPopRatio` times its mass and covering it
                term: 'Rug cacti:',
                text: `a coin with at least ${num(RULES.virusPopRatio)} times a cactus's mass breaks into pieces when it moves over the cactus. Coins below that size are not hurt by it and can hide behind it.`,
              },
              {
                term: 'Airdrops:',
                text: `free pickups land on the map, and you use one at once by running over it. A Magnet airdrop pulls food for ${secs(RULES.magnetMs)}. A Pump airdrop gives extra speed for ${secs(RULES.pumpMs)}. A HODL Shield stops other coins from eating you for ${secs(RULES.shieldMs)}, but you cannot eat them either. A Mega Bag adds mass at once.`,
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
        strip: { label: 'Free or paid', panels: ['Practice rooms are free.', 'In a paid room, one ticket is one coin.', "The ticket price goes into the room's vault."] },
        blocks: [
          {
            kind: 'list',
            items: [
              {
                term: 'Practice rooms',
                text: `are free. You play without tokens, and nothing is paid out. They have no rounds and no bell, and a room holds up to ${F.capacity.practice} players.`,
              },
              {
                term: 'Practice leagues:',
                text: `practice has two leagues, Rookie and Pro. A profile at level ${S.proLevel} or higher plays in Pro. A Rookie game above ${num(S.promoteMaxMass)} mass or with ${S.promoteKills} coins eaten moves you to Pro for ${S.promotionHours} hours.`,
              },
              {
                term: 'Paid rooms',
                text: `are the four rooms in the table below. They play in rounds, one after another (see ${see('Rounds, payout and fee', 'payout')}). A room holds up to ${F.capacity.arena} players. When it is full, another copy of the room opens, and it uses the same vault.`,
              },
            ],
          },
          {
            kind: 'table',
            caption: 'The four paid rooms',
            head: ['Room', 'Ticket price', 'Who can join'],
            rows: F.arenas.map((a) => [a.name, formatUsdCents(a.usdCents), a.holdersOnly ? 'NFT holders' : 'Everyone']),
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Ticket:',
                text: 'one ticket gives you one coin for one round. Its price is set in dollars and paid in the game token; the lobby shows how many tokens that is. You can have one open ticket per room.',
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
                // "fee" is only the fee on profit: opening a room has a price. The holders' free room is the first
                // capacity tier only (custom-rooms.ts `customUsesFreeRoom`).
                text: `a signed-in wallet can open a room with its own rules and an invite code. A private room lasts ${CUSTOM_DURATION_LIMITS.min} to ${CUSTOM_DURATION_LIMITS.max} minutes and holds ${CUSTOM_LIMITS.playersMin} to ${CUSTOM_LIMITS.playersMax} players. Opening one costs tokens. Bigger rooms cost more, and you see the price before you pay. As with a power-up pack, ${payBurn} of the payment is burned and ${payTeam} goes to the team wallet. NFT holders open one room a day for free, for up to ${CUSTOM_CAPACITY_TIER} players. There are two kinds.`,
              },
              { term: 'Free room:', text: 'there are no tickets and no payouts. Anyone with the code can join, even without a wallet.', sub: true },
              {
                term: 'Ticket room:',
                text: `a private copy of one of the paid rooms. Every player buys that room's normal ticket, and the creator buys theirs while creating the room. The room has its own clock: it plays one game from its start to its end, without the ${clockAdj(RULES.roundMs)} rounds. Coins still alive at the room's end are paid, with the normal fee on profit. Joins close ${secs(RULES.roundJoinCloseMs)} before the end, and a ticket bought too late is refunded in full.`,
                sub: true,
              },
              {
                // where bots play, without describing the bot system: paid rooms and ticket rooms are people only
                // (custom-rooms.ts: "a room with stakes is people only")
                term: 'Bots',
                text: 'never play in the paid rooms or in ticket rooms. You meet them only in rooms where nothing of value can be won or lost, and every bot is labelled BOT.',
              },
            ],
          },
        ],
      },
      {
        id: 'value',
        title: 'Winning and losing tokens',
        lede: `In a paid room your coin holds ${symbol}, and the number of ${symbol} it holds is its value. Your coin wins ${symbol} when it eats a coin and loses them when it is eaten.`,
        strip: { label: 'Tokens move by eating', panels: ['You eat a coin.', 'Its tokens move to your coin.', 'If you are alive at the bell, you are paid.'] },
        blocks: [
          {
            // the value rules of apps/server/src/stake/ledger.ts (`transfer`: floor(V x m / M), the last piece gives
            // everything) and rooms/room.ts `onCellEaten`: only eating moves value between coins
            kind: 'flow',
            label: 'How tokens move',
            diagram: { ticket: 'Your ticket', vault: 'Room vault', wallet: 'Your wallet', fee: 'Burn + team wallet' },
            steps: [
              { title: 'Your ticket', text: "The tokens you pay for your ticket go into the room's vault. Your coin starts with exactly that many tokens as its value." },
              {
                title: 'Eating',
                text: 'Eat a whole coin and all of its value moves to your coin. Eat one piece of a split coin and you get part of its value: the bigger the piece, the bigger the part. Its last piece gives you everything it has left.',
              },
              {
                title: 'The bell',
                text: 'If your coin is still alive at the bell, the vault pays its value to your wallet. If that is more than your ticket price, the fee is taken from the profit only.',
              },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Size and value:',
                text: "mass is your coin's size. It decides who can eat whom and how fast you move, and food makes it grow. Value is the number of tokens your coin holds. Two coins of the same size can hold very different values.",
              },
              {
                // what each of these does to mass is not claimed (splitting keeps the total, Leap moves no mass, a
                // cactus adds its mass before the coin breaks): only that none of them moves value
                term: 'What changes value:',
                text: 'only eating. Your coin gains value when it eats another coin or a piece of one, and loses value when another coin eats it or one of its pieces. Nothing else changes your value: not food, airdrops, power-ups, splitting, pushing out mass, a cactus, or the slow mass loss of big coins.',
              },
              {
                // GameHud `WorthSticker`: `g.till` in a room of mode 'arena' (paid rooms and ticket rooms), `g.mass` in
                // practice and free private rooms
                term: 'Where you see it:',
                text: `in a paid room or a ticket room, the yellow sticker at the top of the game shows your value next to "You're worth". In practice rooms and free private rooms, the same sticker shows your mass next to "You weigh".`,
              },
              { term: 'An eaten coin', text: 'has no value left, and its ticket is closed. You can buy a new ticket and play again.' },
            ],
          },
        ],
      },
      {
        id: 'payout',
        title: 'Rounds, payout and fee',
        lede: 'All four paid rooms play their rounds at the same time.',
        strip: {
          label: 'One round',
          panels: [`A round has ${clock(RULES.roundMs)} of play.`, 'At the bell, every coin still alive is paid.', `The fee is ${total} of the profit.`],
        },
        blocks: [
          {
            kind: 'p',
            text: `A round is ${clock(RULES.roundMs)} of play, then a ${clockAdj(RULES.roundBreakMs)} break, so a new round starts every ${clock(RULES.roundMs + RULES.roundBreakMs)}.`,
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Joining:',
                text: `you can join a round until ${secs(RULES.roundJoinCloseMs)} before the bell. A ticket bought after that or in the break is held and joins the next round by itself.`,
              },
              { term: 'No cash-out:', text: 'you cannot leave a round early with your value.' },
              {
                term: 'Payout:',
                text: 'the server sends the payouts on-chain during the break and pays their network fee. The "Round over" sheet shows the amount and the transaction.',
              },
            ],
          },
          {
            // the fee paragraph sits beside the worked receipt it explains
            kind: 'fee-example',
            text: `The game takes one fee: ${total} of your profit. Profit is your value at the bell minus the ticket price. ${burn} of the profit is burned and ${team} goes to the team wallet. If you don't make a profit, you pay no fee. NFT holders pay ${pct(totalFeeBps(holder))} instead (see ${see('The Coinnibal NFT', 'nft')}). The network fees in ${GAS_SYMBOL} go to the network, not to Coinnibal.`,
          },
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
        // the shop's Magnet (BOOST_RULES, 8 s) and the airdrop Magnet (RULES.magnetMs, 10 s) differ: said with both numbers
        lede: `There are four power-ups. You buy them in packs in the lobby shop and use them during a game. They are not the free airdrops on the map (see ${see('How to play', 'play')}). Their times are not the same either. For example, the Magnet power-up pulls food for ${secs(BOOST_RULES.magnet.durationMs)}, and a Magnet airdrop pulls food for ${secs(RULES.magnetMs)}.`,
        blocks: [
          {
            kind: 'cards',
            label: 'The four power-ups',
            // how to use one: the key on a keyboard, the in-game button (BoostBar, the thumb cluster) on a phone
            use: { keyboard: 'Keyboard', press: 'Press', phone: 'Phone', tap: 'Tap', where: 'at the bottom right', button: (name) => `the ${name} button` },
            items: [
              {
                kind: 'magnet',
                key: BOOST_KEY_LABELS.magnet,
                title: 'Magnet',
                text: `Pulls nearby food to your coin for ${secs(BOOST_RULES.magnet.durationMs)}.`,
                meta: `Ready again after ${secs(BOOST_RULES.magnet.cooldownMs)}`,
              },
              {
                // world.ts `fireLeap`: toward the aim (the pointer or the joystick), `leapDistance` grows with the radius
                kind: 'leap',
                key: BOOST_KEY_LABELS.leap,
                title: 'Leap',
                text: 'Your coin jumps a short way at once, in the direction you are steering. Big coins jump farther. It cannot jump through the wall.',
                meta: `Ready again after ${secs(BOOST_RULES.leap.cooldownMs)}`,
              },
              {
                kind: 'speed',
                key: BOOST_KEY_LABELS.speed,
                title: 'Speed burst',
                text: `Your coin moves faster for ${secs(BOOST_RULES.speed.durationMs)}.`,
                meta: `Ready again after ${secs(BOOST_RULES.speed.cooldownMs)}`,
              },
              {
                kind: 'invis',
                key: BOOST_KEY_LABELS.invis,
                title: 'Invisibility',
                text: `Other players cannot see your coin, its name or its minimap dot for ${secs(BOOST_RULES.invis.durationMs)}. It can still eat and be eaten.`,
                meta: `Ready again after ${secs(BOOST_RULES.invis.cooldownMs)}`,
              },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                // BoostBar `shownKinds`: a button per power-up with a charge (`charges > 0`); it greys out, still on
                // screen, once the round's limit is spent
                term: 'Using one:',
                text: 'press its key on a keyboard, or tap its button at the bottom right of the screen on a phone. Its button shows while you own at least one of it.',
              },
              {
                term: 'Packs:',
                text: `a pack holds ${SH.packSize} uses of one power-up. The shop shows each price, paid in ${symbol}. Several packs can be paid in one transaction.`,
              },
              { term: 'Where the payment goes:', text: `${payBurn} is burned and ${payTeam} goes to the team wallet.` },
              {
                term: 'Limit:',
                text: `in a paid room you can use ${SH.arenaUses} power-ups per round (per game in a ticket room), all four kinds together. Practice rooms and free private rooms have no limit, but each power-up still needs its time to be ready again.`,
              },
              { term: 'Shop:', text: 'you need a signed-in wallet to buy. Nothing is sold during a game.' },
            ],
          },
        ],
      },
      {
        id: 'nft',
        title: 'The Coinnibal NFT',
        lede: `Each Coinnibal NFT is a coin character on ${chain}. A wallet that holds one gets perks in the game.`,
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
              // "Closed / Open" read as the room's status: this row says who can join it
              [holdersRoom, 'Cannot join', 'Can join'],
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
                term: 'One NFT at a time:',
                text: 'each NFT gives its perks to one open ticket at a time. Its free private room and its power-up discount can be used by one wallet a day.',
              },
            ],
          },
        ],
      },
      {
        id: 'token',
        title: 'The game token',
        lede: 'This is what the token pays for, and what it does not.',
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
        lede: 'Some rules are on-chain, where anyone can check them. The rest runs on the game server, which you have to trust.',
        strip: { label: 'Who does what', panels: ['The money rules are in the contract.', 'The game runs on the server.', 'Anyone can read the contract.'] },
        blocks: [
          {
            kind: 'compare',
            left: {
              title: 'On-chain: anyone can check',
              items: [
                "Ticket money sits in the room's vault. A payout can never be more than the vault holds.",
                `The fee rates are written on the ticket when it is bought. The contract allows at most ${pct(F.fee.maxBps)} of a profit.`,
                'The contract does the burns, so anyone can check them.',
                'Every ticket has its own id, so no ticket can be paid out twice.',
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
              { term: 'Profile:', text: 'it holds a name, a coin skin or picture, a country flag, a level and XP.' },
              {
                term: 'Link X:',
                text: `Profile → Link X shows a code such as ${X_CODE_PREFIX}-7K2M9Q. You post it from your X account and paste the link of the post. There is no X login. A code is valid for ${X_CODE_TTL_MS / 60_000} minutes.`,
              },
              {
                term: 'After linking:',
                text: 'your @handle shows on your coin and your X picture can be your coin picture. Players who eat you can tag you when they share.',
              },
              {
                term: 'Share on X:',
                text: 'the button is on the top bar during a game, on the sheet at the end of a game and right after eating a player. It opens X with a ready text and a link to a card of the game. You can also download the card picture. Nothing is posted until you post it.',
              },
              { term: 'Ranks:', text: 'the Ranks page lists the best games of today and of all time, the last rounds and the countries. Ranks pay nothing.' },
            ],
          },
        ],
      },
      {
        id: 'help',
        title: 'If something goes wrong',
        lede: 'Here is what happens to your ticket when something goes wrong.',
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
