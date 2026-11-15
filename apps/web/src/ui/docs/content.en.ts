import {
  BOOST_KEY_LABELS,
  BOOST_RULES,
  BPS,
  CUSTOM_CAPACITY_TIER,
  CUSTOM_DURATION_LIMITS,
  CUSTOM_LIMITS,
  CUSTOM_SETTINGS_DEFAULT,
  DEFAULT_HOLDER_FEE_RATES,
  GAS_SYMBOL,
  PRACTICE_ROOM,
  RULES,
  SIWE_STATEMENT,
  SITE_HOST_DEFAULT,
  TOKEN_SYMBOL_DEFAULT,
  X_CODE_PREFIX,
  X_CODE_TTL_MS,
  activeChain,
  formatUsdCents,
  totalFeeBps,
  type FeeRates,
} from '@elymum/shared';
import { FACTS as F, type DocBlock, type DocsContent } from './facts';

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const num = (n: number): string => nf.format(n);
/** `500` → `5%`, `450` → `4.5%`. */
const pct = (bps: number): string => `${nf.format(bps / 100)}%`;
/** `300000` → `5:00`, `30000` → `0:30`. */
const clock = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`;
/** `8000` → `8 s`. */
const secs = (ms: number): string => `${num(ms / 1000)} s`;

const S = F.server;
const R = F.rules;
const SH = F.shop;
const sym = TOKEN_SYMBOL_DEFAULT;
/** How many tickets one approval may cover: "1, 5, 10 or 20". */
const APPROVE = { choices: `${F.approve.choices.slice(0, -1).join(', ')} or ${F.approve.choices[F.approve.choices.length - 1]}`, preselected: F.approve.preselected } as const;

/** What the page knows about where it runs (the server's answer when known, else the build's defaults). */
export interface DocsEnv {
  /** The chain is a testnet: the one "Testnet" note is shown. */
  testnet?: boolean;
  /** The host the site is served at (`coinnibal.fun`). */
  site?: string;
}

/**
 * The player guide in English: how the game, the rooms, the fee, the Coinnibal NFT and the token work. Plain words,
 * and one place per rule: another section names that place instead of saying the rule again. Every number comes from
 * `FACTS` (see facts.ts) or the shared rules; the fee rates on profit are the server's (`ChainStatus.fees`, the game
 * contract's `config()`) when known, else the contract defaults. `chain` names the Robinhood Chain network (testnet
 * or mainnet; the active one by default). Gas is ETH.
 *
 * One word per thing: room (practice, paid, private), ticket, round, bell, value, fee (only the fee on profit), burn,
 * team wallet, NFT, power-up. Temporary things (the testnet's test rooms) are not described; what is true on the
 * testnet only stands in the one "Testnet" note.
 */
export const docsEn = (
  symbol: string = sym,
  rates: FeeRates = { burnBps: F.fee.burnBps, vaultBps: F.fee.vaultBps },
  chain: string = activeChain().name,
  env: DocsEnv = {},
): DocsContent => {
  const testnet = env.testnet ?? activeChain().testnet;
  const site = env.site || SITE_HOST_DEFAULT;
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
  const usd = (k: keyof typeof SH.usdCents): string => formatUsdCents(SH.usdCents[k]);
  const room = CUSTOM_SETTINGS_DEFAULT;
  const notAudited = 'The smart contracts have not been audited yet.';
  const testnetNote: DocBlock[] = testnet
    ? [
        {
          kind: 'note',
          tone: 'info',
          stamp: 'Testnet',
          title: `Testnet only: ${chain}`,
          text: `On the testnet, ${GAS_SYMBOL} and ${symbol} are test tokens: free and worth nothing. The Faucet page gives test ${symbol} once an hour, and twice as much to NFT holders. ${notAudited}`,
        },
      ]
    : [];
  return {
    pct,
    num,
    kicker: 'Player guide',
    title: 'How Coinnibal works',
    deck: `The game, the rooms, the fee, the Coinnibal NFT and ${symbol}. The numbers are the game's default settings; a ticket shows the ones that apply to it.`,
    rates,
    dateline: [
      `Round ${clock(RULES.roundMs)} + ${clock(RULES.roundBreakMs)} break`,
      `Joins close ${R.joinCloseS} s before the bell`,
      `${F.capacity.arena} players per paid room`,
      `Fee ${total} of profit`,
    ],
    tocLabel: 'Contents',
    receipt: {
      title: 'Round over',
      meta: `Example · fee ${total} of profit`,
      entry: 'Ticket price',
      cashout: 'Value at the bell',
      winnings: 'Profit',
      burn: (p) => `Burned (${p} of profit)`,
      vault: (p) => `Team wallet (${p} of profit)`,
      net: 'Paid to your wallet',
      footer: `Amounts in ${symbol}`,
      caption: `Example: a ${num(F.example.entry)} ${symbol} ticket, worth ${num(F.example.cashout)} ${symbol} at the bell`,
    },
    colophon: "The numbers on this page are read from the game's code.",
    backToTop: 'Back to top',
    sections: [
      {
        id: 'play',
        title: 'How to play',
        lede: 'Eat food to grow. Eat smaller coins. Stay away from bigger ones.',
        strip: { label: 'The basic rule', panels: ['Eat food. Grow.', `${num(R.eatRatio)} times bigger? You can eat it.`, 'Smaller? Run.'] },
        blocks: [
          {
            kind: 'p',
            text: `Your coin follows the mouse. Food makes it bigger. A coin can eat another coin when it has at least ${num(R.eatRatio)} times its mass and covers most of it. Bigger coins move slower, and a coin above ${num(RULES.decayStartMass)} mass slowly loses mass.`,
          },
          {
            kind: 'keys',
            caption: 'Controls',
            rows: [
              { key: 'Mouse', action: 'Move toward the pointer' },
              { key: 'WASD / arrows', action: 'Move with the keyboard' },
              { key: 'Space / left click', action: 'Split: shoot half of your coin forward' },
              { key: 'E', action: 'Push out a little mass (hold to repeat)' },
              { key: Object.values(BOOST_KEY_LABELS).join(' / '), action: 'Use a power-up (see Power-ups)' },
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
                text: `needs ${RULES.splitMinMass} mass. A coin can be in up to ${RULES.maxCells} pieces. The pieces stay close together and join again after ${RULES.mergeBaseMs / 1000} s or more (bigger pieces take longer). Small pieces are easy to eat.`,
              },
              { term: 'Rug cacti:', text: 'a big coin that touches a cactus breaks into pieces. Small coins can hide behind one.' },
              {
                term: 'Airdrops:',
                text: `free pickups that land on the map. Magnet pulls food for ${secs(RULES.magnetMs)}. Pump gives extra speed for ${secs(RULES.pumpMs)}. HODL Shield stops other coins from eating you for ${secs(RULES.shieldMs)}. Mega Bag adds mass at once.`,
              },
              { term: 'Spawn shield:', text: `a new coin cannot be eaten for ${R.spawnShieldS} s.` },
            ],
          },
        ],
      },
      {
        id: 'rooms',
        title: 'Rooms and tickets',
        lede: 'Practice rooms are free. Paid rooms need a ticket. Players can open private rooms.',
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
                text: `are the four rooms in the table. They are open all day and play in rounds (see Rounds, payout and fee). A room holds up to ${F.capacity.arena} players; when it is full, another copy of the room opens with the same vault.`,
              },
            ],
          },
          {
            kind: 'table',
            caption: `Paid rooms: ticket price in US dollars, paid in ${symbol}`,
            head: ['Room', 'Ticket', 'Who can join'],
            rows: F.arenas.map((a) => [a.name, formatUsdCents(a.usdCents), a.holdersOnly ? 'NFT holders' : 'Everyone']),
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Ticket:',
                text: `one ticket is one coin in one round. The price is set in US dollars and paid in ${symbol}; the lobby shows both amounts. The whole price goes into the room's vault. You can have one open ticket per room.`,
              },
              {
                term: 'Buying a ticket',
                text: `needs an EVM wallet (for example MetaMask or Rabby), ${symbol} for the ticket and a little ${GAS_SYMBOL} on ${chain} for network fees. It takes at most two signatures: an approval, then the ticket. The approval covers ${APPROVE.choices} tickets of that room (${APPROVE.preselected} is preselected, never unlimited), so the next tickets need one signature.`,
              },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Private rooms:',
                text: `a signed-in wallet can open a room with its own rules and an invite code: ${CUSTOM_DURATION_LIMITS.min} to ${CUSTOM_DURATION_LIMITS.max} minutes long, ${CUSTOM_LIMITS.playersMin} to ${CUSTOM_LIMITS.playersMax} players. Opening one costs ${room.priceGas} ${GAS_SYMBOL} for up to ${CUSTOM_CAPACITY_TIER} players, plus ${room.capacityStepPct}% of that for every ${CUSTOM_CAPACITY_TIER} more. There are two kinds.`,
              },
              { term: 'Free room:', text: 'no tickets and no payout. Anyone with the code can join, also without a wallet.' },
              {
                term: 'Ticket room:',
                text: `a private copy of a paid room. Every player buys the normal ticket of that room. The creator buys theirs while creating the room. The room has its own clock: one game from its creation to its end, with no ${R.roundMin}-minute bell. All tickets are paid at the room's end, with the normal fee. Joins close ${R.joinCloseS} s before the end; a ticket bought too late is refunded in full.`,
              },
              {
                term: 'Bots',
                text: `play only in free private rooms. When practice is quiet, the lobby offers "${PRACTICE_ROOM.name}": a free ${PRACTICE_ROOM.durationMin}-minute room with ${PRACTICE_ROOM.bots} bots for up to ${PRACTICE_ROOM.maxPlayers} players. Bots are labelled BOT and never play in paid rooms.`,
              },
            ],
          },
        ],
      },
      {
        id: 'value',
        title: 'Value: how tokens move',
        lede: `In a paid room your coin has a value in ${symbol}. Eat a coin and you take its value.`,
        strip: { label: 'Value moves by eating', panels: ['Eat a coin.', 'Its value moves to you.', 'Alive at the bell? Paid.'] },
        blocks: [
          {
            kind: 'flow',
            label: 'How value moves',
            diagram: { ticket: 'Your ticket', vault: 'Room vault', wallet: 'Your wallet', fee: 'Burn + team wallet' },
            steps: [
              { title: 'Ticket', text: 'Your coin starts with the whole ticket price as its value.' },
              { title: 'Eating', text: "When you eat a piece of a coin, you take that piece's share of the coin's value. The last piece gives all that is left." },
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
        lede: `A round is ${R.roundMin} minutes of play. At the bell every coin still alive is paid.`,
        strip: {
          label: 'One round',
          panels: [`${R.roundMin} minutes of play.`, 'The bell: coins still alive are paid.', `The fee is ${total} of the profit.`],
        },
        blocks: [
          {
            kind: 'p',
            text: `All paid rooms share one clock. A round is ${clock(RULES.roundMs)} of play, then a ${clock(RULES.roundBreakMs)} break, so a new round starts every ${clock(RULES.roundMs + RULES.roundBreakMs)}.`,
          },
          {
            kind: 'list',
            items: [
              { term: 'Joins', text: `close ${R.joinCloseS} s before the bell. A ticket bought in that last minute or in the break is held and joins the next round by itself.` },
              { term: 'No cash-out:', text: 'you cannot leave a round early with your value. Payout is at the bell only.' },
              {
                term: 'Payout:',
                text: 'the server sends the payouts on-chain during the break and pays their network fee. The "Round over" sheet shows the amount and the transaction.',
              },
            ],
          },
          {
            kind: 'p',
            text: `The only fee is ${total} of your profit. Profit is your value at the bell minus the ticket price. ${burn} of the profit is burned and ${team} goes to the team wallet. With no profit there is no fee, and buying a ticket has no fee.`,
          },
          { kind: 'fee-example' },
        ],
      },
      {
        id: 'powerups',
        title: 'Power-ups',
        lede: 'Four power-ups are sold in packs in the lobby shop. Each has its own key.',
        blocks: [
          {
            kind: 'list',
            items: [
              {
                term: `Magnet (${BOOST_KEY_LABELS.magnet}), ${usd('magnet')}:`,
                text: `pulls nearby food to your coin for ${secs(BOOST_RULES.magnet.durationMs)}. Cooldown ${secs(BOOST_RULES.magnet.cooldownMs)}.`,
              },
              {
                term: `Leap (${BOOST_KEY_LABELS.leap}), ${usd('leap')}:`,
                text: `jumps your coin toward the pointer at once. It cannot cross the wall. Cooldown ${secs(BOOST_RULES.leap.cooldownMs)}.`,
              },
              {
                term: `Speed burst (${BOOST_KEY_LABELS.speed}), ${usd('speed')}:`,
                text: `extra speed for ${secs(BOOST_RULES.speed.durationMs)}. Cooldown ${secs(BOOST_RULES.speed.cooldownMs)}.`,
              },
              {
                term: `Invisibility (${BOOST_KEY_LABELS.invis}), ${usd('invis')}:`,
                text: `other players cannot see your coin, its name or its minimap dot for ${secs(BOOST_RULES.invis.durationMs)}. It can still eat and be eaten. Cooldown ${secs(BOOST_RULES.invis.cooldownMs)}.`,
              },
            ],
          },
          {
            kind: 'list',
            items: [
              {
                term: 'Packs:',
                text: `each price above is for one pack of ${SH.packSize} uses. Prices are set in US dollars and paid in ${symbol}. Several packs can be paid in one transaction.`,
              },
              { term: 'Where the payment goes:', text: `${payBurn} is burned and ${payTeam} goes to the team wallet.` },
              {
                term: 'Limit:',
                text: `in a paid room you can use ${SH.arenaUses} power-ups per round, all four kinds together. Practice rooms and free private rooms have no limit, only the cooldown.`,
              },
              { term: 'Shop:', text: 'the shop is in the lobby and needs a signed-in wallet. Nothing is sold during a game.' },
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
            text: `The Coinnibal NFT is an ERC-721 collection. It is minted on the Mint page and paid in ${GAS_SYMBOL}: first the allowlist (WL), then everyone. The Mint page shows the price from the contract before the wallet signs. The NFT is not a ticket and has no value in a round.`,
          },
          {
            kind: 'table',
            caption: 'What the NFT changes',
            head: ['Perk', 'No NFT', 'NFT holder'],
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
            kind: 'list',
            items: [
              { term: 'Holders-only mode:', text: 'the game can be set to "NFT holders only". In that mode a wallet needs the NFT to play.' },
              {
                term: 'One NFT, one wallet:',
                text: 'an NFT serves one open ticket at a time. The power-up discount and the free room go to one wallet per NFT per day (UTC).',
              },
            ],
          },
        ],
      },
      {
        id: 'token',
        title: `The ${symbol} token`,
        lede: 'The token of the paid rooms.',
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Used for:', text: 'the tickets and payouts of the paid rooms, and power-up packs.' },
              { term: 'Not used for:', text: `the NFT mint, opening a private room and network fees. These are paid in ${GAS_SYMBOL}.` },
              {
                term: 'Burn:',
                text: `a part of every fee on profit and of every power-up payment is burned (see Rounds, payout and fee, and Power-ups). Burned tokens are gone for good. The game never creates new ${symbol}.`,
              },
              {
                term: 'Set once:',
                text: 'the token address is set in the game contract one time and cannot be changed. Until it is set, the paid rooms show "Opening soon".',
              },
            ],
          },
        ],
      },
      {
        id: 'fair',
        title: 'What is on-chain',
        lede: 'The money rules are in a smart contract. The game itself runs on a server.',
        strip: { label: 'Contract and server', panels: ['Money rules: in the contract.', 'The game: on the server.', 'Anyone can read the contract.'] },
        blocks: [
          {
            kind: 'compare',
            left: {
              title: 'On-chain: anyone can check',
              items: [
                "Ticket money sits in the room's vault. A payout can never be more than the vault holds.",
                `The fee rates are written on the ticket when it is bought. The contract allows at most ${pct(F.fee.maxBps)} of a profit.`,
                "Burned tokens go to the burn address, or to the token's own burn function.",
                'Every ticket has its own id, so a payout cannot be used twice.',
                'The server key can only pay or refund open tickets, or burn from a vault. Neither it nor the owner can take a vault that has open tickets.',
              ],
            },
            right: {
              title: 'On the server: players trust it',
              items: [
                'The game itself: movement, who ate whom, and the value of each coin at the bell.',
                `The dollar price of ${symbol}, set by the team. It decides how many ${symbol} a ticket or a pack costs.`,
                'Power-up uses: the payment is on-chain, the uses are kept on the server.',
                'Levels, XP, leagues and ranks.',
                'The chat filter.',
              ],
            },
          },
          ...testnetNote,
          {
            kind: 'note',
            tone: 'warn',
            stamp: 'Risk',
            title: 'Know the risk',
            text: `On the mainnet a ticket costs real money, and an eaten coin loses it. Check that playing is legal where you live. Burns are not a promise of profit.${testnet ? '' : ` ${notAudited}`}`,
          },
        ],
      },
      {
        id: 'wallet',
        title: 'Wallet safety',
        lede: 'Read every request before you sign.',
        strip: { label: 'Read before you sign', panels: ['Someone asks for your phrase.', 'Never give it. To no one.', 'Sign only what you have read.'] },
        blocks: [
          {
            kind: 'list',
            items: [
              { term: 'Sign-in', text: `is a free message, not a transaction. It reads: "${SIWE_STATEMENT}"` },
              {
                term: 'Approvals:',
                text: `a ticket approval names the game contract and a fixed amount of ${symbol}. An approval for another address or for an unlimited amount is not from Coinnibal.`,
              },
              { term: 'Recovery phrase:', text: 'Coinnibal never asks for a recovery phrase or a private key. Anyone who asks is a scammer.' },
              { term: 'Separate wallet:', text: 'use a wallet only for games and keep only the amount you play with in it.' },
              { term: 'Site:', text: `the game and the only mint are on ${site}.` },
            ],
          },
        ],
      },
      {
        id: 'profile',
        title: 'Profile, X and sharing',
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
                text: 'your coin stays in the paid room and can still be eaten. You can come back and go on. If it is alive at the bell, you are paid as usual.',
              },
              { term: 'Ticket not played:', text: `a ticket that never entered a room is refunded in full by the server after about ${S.staleTicketMinutes} minutes.` },
              {
                term: 'Payout not received:',
                text: 'if the transfer to the wallet fails, the payout waits in the vault and the lobby shows "Collect payout". One transaction collects the exact amount, at any time.',
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
