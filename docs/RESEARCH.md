# Research: Robinhood Chain and Pons

Coinnibal runs on **Robinhood Chain only**: Robinhood Chain Testnet now, Robinhood Chain (mainnet) later, switched by
`CHAIN_ID` and nothing else. This page records what the code relies on, where each value comes from, and what is
still unconfirmed. Researched 2026-11-05. The values used in code are in `packages/shared/src/chains.ts`.

Status labels: **confirmed** (in the chain's or the project's own documentation), **third party** (a reputable
provider or partner documents it, the project's docs do not), **inferred** (follows from documented facts, not stated
anywhere), **unconfirmed** (seen once, could not be checked).

## Robinhood Chain

An Ethereum L2 built on **Arbitrum Orbit** ("Arbitrum Dedicated Blockchains"), **gas paid in ETH**, ERC-4337
account abstraction supported. Mainnet launched around 2026-07-01 (third party: launch coverage; the docs do not
date it).

| | Testnet | Mainnet | Status |
|---|---|---|---|
| Chain id | `46630` | `4663` | confirmed ([docs.robinhood.com](https://docs.robinhood.com/chain/)) |
| Public RPC | `https://rpc.testnet.chain.robinhood.com` | `https://rpc.mainnet.chain.robinhood.com` | confirmed (rate-limited; use a provider in production) |
| Provider RPC | Alchemy | `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}` | confirmed (Alchemy chain page) |
| Explorer (Blockscout) | `https://explorer.testnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` (verify API at `/api`) | confirmed |
| Sequencer feed | | `wss://feed.mainnet.chain.robinhood.com` (+ a delayed feed) | confirmed |
| Gas token | ETH (18 decimals) | ETH (18 decimals) | confirmed |
| Faucet | `https://faucet.testnet.chain.robinhood.com`; Alchemy's faucet gives 0.1 ETH / 24 h | none | confirmed ([docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting), checked 2026-11-18); Alchemy's faucet: third party |
| Bridge | | Arbitrum's canonical bridge `https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum` (deposit ~10 min, withdrawal 7 days); also Stargate, Chainlink Transporter, Relay, Across, LiFi / 0x | confirmed (bridge list), timings per Arbitrum's docs |
| Block time | ~100 ms | ~100 ms | **third party** (GetBlock, Chainstack); not stated by Robinhood |
| EVM version | | | **inferred**: Arbitrum Nitro runs current EVM opcodes; our contracts compile for `shanghai` (`hardhat.config.ts`), which it supports |

Sources:
- Robinhood Chain docs: [overview](https://docs.robinhood.com/chain), [connecting](https://docs.robinhood.com/chain/connecting),
  [add the network to a wallet](https://docs.robinhood.com/chain/add-network-to-wallet),
  [bridging](https://docs.robinhood.com/chain/bridging), [gas and fees](https://docs.robinhood.com/chain/gas-and-fees),
  [transaction finality](https://docs.robinhood.com/chain/transaction-finality),
  [differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum),
  [deploy smart contracts](https://docs.robinhood.com/chain/deploy-smart-contracts).
- [Arbitrum blog: Robinhood Chain testnet](https://blog.arbitrum.io/robinhood-chain-testnet/) (testnet launch, faucet).
- [BitGo developer docs](https://developers.bitgo.com/) (network parameters, faucet).
- Explorers: [testnet](https://explorer.testnet.chain.robinhood.com), [mainnet](https://robinhoodchain.blockscout.com).
- Block time: GetBlock and Chainstack Robinhood Chain node pages (third party).

### Differences from Ethereum that matter to Coinnibal

From Robinhood's "differences from Ethereum" page (Arbitrum Nitro behaviour):

- **`block.number` is an L1 block estimate**, not the L2 block. The contracts never use block numbers (time comes
  from `block.timestamp`: the 24 h self-refund); the server indexes events by L2 block through the RPC, which is
  correct. Use `ArbSys(100).arbBlockNumber()` if a contract ever needs the L2 block.
- **`block.prevrandao` is a constant**: never a randomness source. Coinnibal's randomness is server-side.
- `block.coinbase` is a fee account; gas is the L2 execution fee plus an **L1 calldata fee** (batches of 40
  settlements keep it per ticket small: about 182k gas for one settlement transaction, ~1.07M for 40, measured on
  Hardhat; the L1 part depends on calldata, not measured on the real chain yet).
- Contract size limit **96 KB** (Ethereum's is 24 KB): no constraint for us.
- **Sanctioned-address screening** at the RPC / sequencer level: transactions from or to screened addresses may be
  refused. A player affected cannot join; payouts to such an address fail and are held as `owed` (the arena's
  two-phase payout), never lost.
- **First-come-first-served sequencer ordering**: no public mempool auction; front-running the server's settlement
  is not a practical concern.
- **Finality**: soft (sequencer) confirmation in well under a second; batches are posted to Ethereum within minutes;
  Ethereum finality about 13 minutes after posting. The server treats a receipt as final (the sequencer's ordering
  does not reorg in practice); a deep reorg would at worst re-send settlements, which the contract refuses by session
  id.
- **Incident to remember**: on 2026-09-04 the mainnet sequencer stalled for 4 to 14 minutes (third-party reports).
  Settlements wait in the journal and retry with backoff; nothing is lost.

## Pons (token launchpad)

The game token is meant to be launched on **Pons** ([docs.ponsfamily.com](https://docs.ponsfamily.com),
[V2 docs](https://docs.ponsfamily.com/docs/v2); [Bitquery's Pons API docs](https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/);
an explainer: [BingX, "What is Pons"](https://bingx.com/en/learn/article/what-is-pons-crypto-and-how-does-pons-robinhood-launchpad-work), third party). V2 went live on 2026-08-04, on **Robinhood Chain mainnet only** (no testnet deployment): on the testnet
the game uses the bundled `TestToken` (ERC20Burnable; its public `faucet()` gives by default 1,000,000 an hour, 2,000,000 to emblem holders (the owner can change the amounts and the cooldown), and only its owner mints otherwise).

| Fact | Value | Status |
|---|---|---|
| Launch | `launchToken` / `launchAndBuy` on the router `0xe33e9e479df8802cb0866d5d05258bec4cf62948` | confirmed (Pons V2 docs) |
| Factory | `PonsV2LaunchFactory` `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`; Uniswap v4 hook `0xe5e7…e044`, locker `0x2674…4952`, PoolManager `0x8366…0951` | confirmed (addresses abbreviated here) |
| Supply | fixed **1,000,000,000**, all minted to the token's bonding curve at launch; **no mint after launch** | confirmed |
| Token standard | "fixed-supply ERC-20", 18 decimals (implied by the supply figures) | confirmed / implied |
| **`burn()`** | **not documented**: no burn function is listed | **unconfirmed** (see below) |
| Transfer tax, freeze, blacklist | none | confirmed |
| Address | CREATE2, predictable before launch, exists from the launch transaction | confirmed |
| Curve | constant product with a phantom quote reserve; quote in ETH or an approved ERC-20; launch fee 0.0005 ETH; curve fee 1 % + an optional creator tax + a snipe tax in the first seconds | confirmed |
| Graduation | at 4.2 ETH (per-asset otherwise) the curve moves to a Uniswap v4 pool, zero pool fee + hook fee, full-range liquidity locked forever; sells stop at `readyToGraduate` until it graduates | confirmed |
| Who may launch | public launches currently closed (allowlist, `canLaunch`) | confirmed (at the time of writing) |
| Audit | V2 unaudited until the reports are published | confirmed (docs say so) |
| PONS's own "burns" | transfers to a dead address (`totalSupply` unchanged); buybacks vest over 5 years | confirmed |

V1 (legacy docs): no curve, a Uniswap V3 pool from launch. Not relevant for a new launch.

### What this means for the arena

- **Burn mode.** `CoinnibalArena` burns in one of two ways: mode 0 transfers to `0x…dEaD` (works with any ERC-20),
  mode 1 calls the token's own `burn(uint256)` and accepts it only if the arena's balance fell by exactly the amount
  (anything else falls back to `0x…dEaD`, or reverts on a partial burn). Because a Pons token's `burn()` is not
  documented, **deploy with mode 0** and switch to mode 1 only after `/admin` shows "the token has a working burn()"
  (the SDK probes it with an `eth_call` of `burn(0)` from the arena). Either way the burned tokens leave
  circulation; only mode 1 lowers `totalSupply`.
- **No fee-on-transfer**: the arena refuses such tokens at join (`FeeOnTransferToken`); a Pons token has none.
- **Supply is fixed**, so every Coinnibal sink is deflationary for good (docs/ECONOMY.md).
- **Open questions** (to check at launch): the exact token bytecode (burnability), whether the launch needs the
  allowlist, and the graduation venue's liquidity (the arena does not depend on it).

## Coinnibal on Robinhood Chain: decisions

1. **One chain.** `packages/shared/src/chains.ts` holds Robinhood Chain Testnet, Robinhood Chain and the local
   Hardhat node used in development; any other chain id is refused (server `CHAIN_ID`, the RPC's `eth_chainId`, the
   web's `VITE_CHAIN_ID`, the admin CLI).
2. **Gas is ETH** everywhere in the copy; the network name comes from the active network (testnet or mainnet).
3. **The mint is priced in ETH** at the USD target `MINT_USD_CENTS` (default 100 US cents) from Hyperliquid's public
   `allMids` (key `ETH`), with the keeper's bounds and
   two-reading confirmation (OPERATIONS.md).
4. **The faucet URL is confirmed** (docs.robinhood.com/chain/connecting, 2026-11-18); `GAS_FAUCET_URL` still
   overrides it.
5. **Block time ~100 ms** is not relied on: the server polls receipts and logs by time, and the log window adapts
   (`LOG_CHUNK_BLOCKS`).
