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
} from '@elymum/shared';
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

/** What the page knows about where it runs (the server’s answer when known, else the build’s defaults). */
export interface DocsEnv {
  /** The chain is a testnet (kept for callers; the guide reads the same on every network). */
  testnet?: boolean;
  /** The host the site is served at (`coinnibal.fun`). */
  site?: string;
  /** The project’s X account, without `@` (`coinnibalfun`). */
  x?: string;
}

/**
 * The guide in English: how the game, the rooms, the fee, the Coinnibal NFT and the token work. Plain, natural words
 * (contractions, short prose where one thing causes another), numbers in tables, and one place per rule: another
 * section links to that place (`see`) instead of saying the rule again. Every number comes from `FACTS` (see facts.ts)
 * or the shared rules; the fee rates on profit are the server’s (`ChainStatus.fees`, the game contract’s `config()`)
 * when known, else the contract defaults. `chain` names the Robinhood Chain network (testnet or mainnet; the active
 * one by default). Gas is ETH.
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
  // visitors read the network’s plain name ("Robinhood Chain"); the wallet shows the exact network itself
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
  return {
    pct,
    num,
    title: 'How Coinnibal works',
    deck: 'Rounds, rooms and tickets, the fee, power-ups, the NFT and wallet safety, with the real numbers. Worth a read before you buy a ticket.',
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
      // the token’s name comes from the server: worded so any name reads right ("a ticket of 1,000 tokens")
      caption: `A ticket of ${num(F.example.entry)} ${symbol}, worth ${num(F.example.cashout)} ${symbol} at the bell`,
    },
    backToTop: 'Back to top',
    // the guide’s last word: the links to trust and the one rule that keeps a wallet safe (beside "Back to top")
    closing: {
      lines: [
        `The only official links are ${site} and @${x} on X. The NFT mint will be on OpenSea, through the one link @${x} posts.`,
        'Nobody from Coinnibal will ever ask for your seed phrase.',
      ],
      follow: `@${x}`,
      href: `https://x.com/${x}`,
    },
    sections: [
      {
        id: 'play',
        title: 'How to play',
        lede: "Eat food, eat smaller coins, and don’t let a bigger one catch you.",
        strip: { label: 'The basic rule', panels: ['Eat food. Grow.', `${num(RULES.eatRatio)} times its mass? Eat it.`, 'Bigger than you? Run.'] },
        blocks: [
          {
            kind: 'p',
            text: `Your coin follows the mouse, and food makes it bigger. To eat another coin you need at least ${num(RULES.eatRatio)} times its mass, and you have to cover most of it. Size has a price, though. Bigger coins move slower, and a coin above ${num(RULES.decayStartMass)} mass slowly loses mass.`,
          },
          {
            kind: 'keys',
            caption: 'Controls',
            rows: [
              { key: 'Mouse', action: 'Move toward the pointer' },
              { key: 'WASD / arrow keys', action: 'Move with the keyboard' },
              { key: 'Space / left click', action: 'Split, sending half of your coin forward' },
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
            kind: 'p',
            text: "On a phone, a joystick at the bottom left moves your coin, and split, push-out and the power-ups are buttons on the right. Tap the standings card to open the full standings.",
          },
          {
            kind: 'table',
            caption: 'Splitting and shields',
            head: ['', 'Number', 'What it means'],
            numeric: [1],
            stack: true,
            rows: [
              ['Split', `${RULES.splitMinMass} mass`, 'The least a coin needs before it can split. Small pieces are easy to eat.'],
              ['Pieces', `up to ${RULES.maxCells}`, 'How many pieces one coin can be in. They stay close together.'],
              ['Merge', `from ${secs(RULES.mergeBaseMs)}`, 'How long pieces take to join again. Bigger pieces take longer.'],
              ['Spawn shield', secs(RULES.spawnShieldMs), "A new coin can’t eat or be eaten by other coins."],
            ],
          },
          {
            kind: 'table',
            caption: 'Airdrops, the free pickups that land on the map',
            head: ['Airdrop', 'Lasts', 'What it does'],
            numeric: [1],
            stack: true,
            rows: [
              ['Magnet', secs(RULES.magnetMs), 'Pulls food to your coin.'],
              ['Pump', secs(RULES.pumpMs), 'Extra speed.'],
              ['HODL Shield', secs(RULES.shieldMs), "Other coins can’t eat you, but you can’t eat them either."],
              ['Mega Bag', 'Instant', 'Adds mass at once.'],
            ],
          },
          {
            kind: 'p',
            text: "Mind the rug cacti. A big coin that touches one breaks into pieces, which is why small coins like to hide behind them.",
          },
        ],
      },
      {
        id: 'rooms',
        title: 'Rooms and tickets',
        lede: 'Three kinds of room: practice, paid and private.',
        blocks: [
          {
            kind: 'p',
            text: `Practice rooms are free, with no wallet, no tokens and no payout. They have no rounds and no bell, and up to ${F.capacity.practice} players share a room. Practice has two leagues, Rookie and Pro. A profile at level ${S.proLevel} or higher plays in Pro, and a Rookie game above ${num(S.promoteMaxMass)} mass or with ${S.promoteKills} coins eaten moves you up to Pro for ${S.promotionHours} hours.`,
          },
          {
            kind: 'p',
            text: `The paid rooms are the four below. They play in rounds, one after another (see ${see('Rounds, payout and fee', 'payout')}). A room holds up to ${F.capacity.arena} players; when it’s full, another copy of the room opens with the same vault.`,
          },
          {
            kind: 'table',
            caption: 'Ticket prices, paid in our game token',
            head: ['Room', 'Ticket', 'Who can join'],
            numeric: [1],
            rows: F.arenas.map((a) => [a.name, formatUsdCents(a.usdCents), a.holdersOnly ? 'NFT holders' : 'Everyone']),
          },
          {
            kind: 'p',
            text: `A ticket buys your coin a place in one round. You pay for it in our game token, the lobby shows the amount, and you can hold one open ticket per room.`,
          },
          {
            kind: 'p',
            text: `To buy one you need an EVM wallet (MetaMask or Rabby, for example), ${symbol} for the ticket and a little ${GAS_SYMBOL} on ${chain} for network fees. It takes at most two signatures: an approval, then the ticket. The approval covers ${APPROVE.choices} tickets of that room (${APPROVE.preselected} is preselected), so the next tickets need only one signature.`,
          },
          { kind: 'h', text: 'Private rooms' },
          {
            kind: 'p',
            text: `A signed-in wallet can open a room with its own rules and an invite code, ${CUSTOM_DURATION_LIMITS.min} to ${CUSTOM_DURATION_LIMITS.max} minutes long and for ${CUSTOM_LIMITS.playersMin} to ${CUSTOM_LIMITS.playersMax} players. Opening one costs a little ${GAS_SYMBOL}. Bigger rooms cost more, and the price shows before you pay. There are two kinds.`,
          },
          {
            kind: 'list',
            items: [
              { term: 'A free room', text: "has no tickets and no payout. Anyone with the code can join, even without a wallet." },
              {
                term: 'A ticket room',
                text: `is a private copy of a paid room, and every player buys that room’s normal ticket (the creator buys theirs while creating it). It runs on its own clock, one game from its creation to its end, with no ${clockAdj(RULES.roundMs)} bell. Coins still alive at the room’s end are paid, with the normal fee on profit. Joins close ${secs(RULES.roundJoinCloseMs)} before the end, and a ticket bought too late is refunded in full.`,
              },
            ],
          },
          {
            kind: 'p',
            text: `Bots play only in free private rooms. When practice is quiet, the lobby offers “${PRACTICE_ROOM.name}”, a free ${PRACTICE_ROOM.durationMin}-minute room with ${PRACTICE_ROOM.bots} bots for up to ${PRACTICE_ROOM.maxPlayers} players. Bots are labelled BOT.`,
          },
        ],
      },
      {
        id: 'value',
        title: 'How value moves',
        lede: `In a paid room your coin is worth ${symbol}, and eating is the only thing that changes how many.`,
        blocks: [
          {
            kind: 'flow',
            label: 'How value moves: from your ticket to the room vault, between coins as they eat, then to your wallet at the bell, minus the fee',
            diagram: { ticket: 'Your ticket', vault: 'Room vault', wallet: 'Your wallet', fee: 'Burn + team wallet' },
          },
          {
            kind: 'p',
            text: "Your ticket price goes into the room’s vault, and your coin starts with all of it as its value. Eat a coin and its value moves to you. If it has split into pieces, each piece you eat gives you the share of its value that matches the piece’s size, and the last piece gives you the rest.",
          },
          {
            kind: 'p',
            text: "If your coin is still alive at the bell, the vault pays you its value, minus the fee on profit. An eaten coin has no value left and its ticket is closed, but you can buy a new ticket while joins are open.",
          },
          {
            kind: 'p',
            text: "Mass isn’t value. Pushing out mass, breaking on a cactus and losing mass over time don’t change what your coin is worth. Only eating does.",
          },
        ],
      },
      {
        id: 'payout',
        title: 'Rounds, payout and fee',
        lede: 'The four paid rooms share one clock.',
        blocks: [
          {
            kind: 'p',
            text: `A round is ${clock(RULES.roundMs)} of play, then a ${clockAdj(RULES.roundBreakMs)} break, so a new round starts every ${clock(RULES.roundMs + RULES.roundBreakMs)}. Joins close ${secs(RULES.roundJoinCloseMs)} before the bell; a ticket bought after that, or in the break, is held and joins the next round by itself.`,
          },
          {
            kind: 'p',
            text: 'There’s no cash-out, so you can’t leave a round early with your value. The server sends the payouts on-chain during the break and pays their network fee, and the “Round over” sheet shows the amount and the transaction.',
          },
          {
            kind: 'p',
            text: `The game takes one fee, ${total} of your profit. Profit is your value at the bell minus the ticket price. ${burn} of the profit is burned and ${team} goes to the team wallet. No profit, no fee. The network fees in ${GAS_SYMBOL} go to the network, not to Coinnibal.`,
          },
          { kind: 'fee-example' },
          {
            kind: 'note',
            tone: 'warn',
            title: 'Before you buy a ticket',
            text: `A ticket in a paid room costs real money, and you lose it if your coin gets eaten. Check that playing is legal where you live. Burns aren’t a promise of profit, and the smart contracts haven’t been audited yet.`,
          },
        ],
      },
      {
        id: 'powerups',
        title: 'Power-ups',
        lede: `You buy them in packs in the lobby shop, and each has its own key. They aren’t the free airdrops on the map (see ${see('How to play', 'play')}), and their times are different.`,
        blocks: [
          {
            kind: 'table',
            caption: 'The four power-ups',
            quiet: true,
            head: ['Key', 'Power-up', 'What it does', 'Lasts', 'Cooldown'],
            keys: 0,
            numeric: [3, 4],
            stack: true,
            rows: [
              [BOOST_KEY_LABELS.magnet, 'Magnet', 'Pulls nearby food to your coin.', secs(BOOST_RULES.magnet.durationMs), secs(BOOST_RULES.magnet.cooldownMs)],
              [BOOST_KEY_LABELS.leap, 'Leap', "Jumps your coin toward the pointer. It can’t cross the wall.", 'Instant', secs(BOOST_RULES.leap.cooldownMs)],
              [BOOST_KEY_LABELS.speed, 'Speed burst', 'Extra speed.', secs(BOOST_RULES.speed.durationMs), secs(BOOST_RULES.speed.cooldownMs)],
              [
                BOOST_KEY_LABELS.invis,
                'Invisibility',
                "Other players can’t see your coin, its name or its minimap dot. It can still eat and be eaten.",
                secs(BOOST_RULES.invis.durationMs),
                secs(BOOST_RULES.invis.cooldownMs),
              ],
            ],
          },
          {
            kind: 'p',
            text: `Each pack holds ${SH.packSize} uses of one power-up. The shop shows each price in ${symbol}, and several packs can be paid in one transaction. Of each payment, ${payBurn} is burned and ${payTeam} goes to the team wallet. The shop needs a signed-in wallet, and nothing is sold during a game.`,
          },
          {
            kind: 'p',
            text: `In a paid room you can use ${SH.arenaUses} power-ups per round (per game in a ticket room), all four kinds together. Practice rooms and free private rooms have no limit, only the cooldown.`,
          },
        ],
      },
      {
        id: 'nft',
        title: 'The Coinnibal NFT',
        lede: `A coin character on ${chain}. Hold one and your wallet gets perks in the game.`,
        blocks: [
          {
            kind: 'p',
            text: `The collection has ${num(NFT_SUPPLY)} NFTs. An NFT is never spent or risked in a round. You play with your ticket, and the NFT adds the perks below.`,
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
              ['Private room', `Paid in ${GAS_SYMBOL}`, `1 free a day, up to ${CUSTOM_CAPACITY_TIER} players`],
              ['Coin look', 'Standard skins', 'Also the NFT skin and a holder badge'],
            ],
          },
          {
            kind: 'p',
            text: 'Each NFT lends its perks to one open ticket at a time, and its free room and power-up discount to one wallet a day.',
          },
        ],
      },
      {
        id: 'token',
        title: 'The game token',
        lede: 'The paid rooms and the shop run on it, and part of what they take is burned.',
        blocks: [
          {
            kind: 'table',
            caption: `What is paid in ${symbol} and what in ${GAS_SYMBOL}`,
            quiet: true,
            head: ['What', 'Paid in'],
            numeric: [1],
            rows: [
              ['Tickets and payouts in the paid rooms', symbol],
              ['Power-up packs', symbol],
              ['The NFT mint', GAS_SYMBOL],
              ['Opening a private room', GAS_SYMBOL],
              ['Network fees', GAS_SYMBOL],
            ],
          },
          {
            kind: 'p',
            text: `The burns come from the fee on profit and from every power-up payment (see ${see('Rounds, payout and fee', 'payout')} and ${see('Power-ups', 'powerups')}). Burned tokens are gone for good, and the game never creates new ${symbol}.`,
          },
          {
            kind: 'p',
            text: 'The game token is set in the contract once and can never be changed.',
          },
        ],
      },
      {
        id: 'fair',
        title: 'Contract and server',
        lede: 'Tickets, vaults and fees are held to the contract. The game itself runs on our server.',
        blocks: [
          {
            kind: 'compare',
            left: {
              title: 'On-chain, so anyone can check',
              items: [
                "Ticket money sits in the room’s vault, and a payout can never be more than the vault holds.",
                `The fee rates are written on the ticket when it’s bought, and the contract allows at most ${pct(F.fee.maxBps)} of a profit.`,
                'The contract does the burns, so anyone can check them.',
                "Every ticket has its own id, so a payout can’t be used twice.",
                "The game server can only use a vault to pay players, refund tickets and burn tokens. The team can’t take tokens out of a vault that has open tickets.",
              ],
            },
            right: {
              title: 'On the server, so you trust it',
              items: [
                'The game itself: movement, who ate whom, and the value of each coin at the bell.',
                `The dollar price of the game token, set by the team. It decides how many ${symbol} a ticket or a pack costs.`,
                'Power-up uses. You pay for them on-chain, but the uses are counted on the server.',
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
        strip: { label: 'Stay safe', panels: ['Someone asks for your seed phrase.', 'Never give it to anyone.', "Sign only what you’ve read."] },
        blocks: [
          {
            kind: 'list',
            items: [
              `Signing in is a free message, not a transaction. It reads: “${SIWE_STATEMENT}”`,
              `A ticket approval names the game contract and a fixed amount of ${symbol}. An approval for another address or for an unlimited amount isn’t from Coinnibal.`,
              'Coinnibal never asks for your seed phrase or a private key. Anyone who asks is a scammer.',
              'Keep a separate wallet for games, with only the amount you play with in it.',
            ],
          },
        ],
      },
      {
        id: 'profile',
        title: 'Profile, X and ranks',
        lede: 'A signed-in wallet gets a profile, and your X account can show on your coin.',
        blocks: [
          { kind: 'p', text: 'Your profile has a name, a coin skin or picture, a country flag, a level and XP.' },
          { kind: 'h', text: 'Linking X' },
          {
            kind: 'steps',
            label: 'How to link X',
            items: [
              `Open Profile → Link X. It shows a code such as ${X_CODE_PREFIX}-7K2M9Q, valid for ${X_CODE_TTL_MS / 60_000} minutes.`,
              'Post the code from your X account.',
              "Paste the link of the post. There’s no X login.",
            ],
          },
          {
            kind: 'p',
            text: 'After linking, your @handle shows on your coin and your X picture can be your coin picture. Players who eat you can tag you when they share.',
          },
          {
            kind: 'p',
            text: 'Share on X is on the top bar during a game, on the sheet at the end of a game and right after eating a player. It opens X with a ready text and a link to a card of the game, and you can download the card picture too. Nothing is posted until you post it.',
          },
          {
            kind: 'p',
            text: 'The Ranks page lists the best games of today and of all time, the last rounds and the countries. Ranks pay nothing.',
          },
        ],
      },
      {
        id: 'help',
        title: 'When something goes wrong',
        lede: "What happens to your ticket when the connection drops, a payout goes missing or the server crashes.",
        blocks: [
          {
            kind: 'table',
            caption: 'What happens to your ticket in each case',
            quiet: true,
            head: ['What went wrong', 'What happens'],
            stack: true,
            rows: [
              ['You lose your connection', "Your coin stays in the paid room and can still be eaten. Come back and keep playing. If it’s alive at the bell, you’re paid as usual."],
              ['Your ticket never enters a room', `The server refunds it in full after about ${S.staleTicketMinutes} minutes.`],
              ["Your payout doesn’t arrive", 'If the transfer to your wallet fails, the payout waits in the vault and the lobby shows “Collect payout”. One transaction collects the exact amount, at any time.'],
              [
                'The anti-cheat checks flag a winning game',
                `Its payout waits for a team check instead of going out in the break. With no decision within ${INTEGRITY_SETTINGS_DEFAULT.autoReleaseHours} hours, it’s paid as usual. If the check finds cheating, nothing is paid.`,
              ],
              ['The server never settles a ticket', `You can refund the ticket price ${F.refundHours} hours after buying it (“Refund ticket” in the lobby).`],
              ['The server crashes', 'It saves every change of value. After a restart, open tickets are settled at their last saved value.'],
            ],
          },
        ],
      },
    ],
  };
};
