// A local Robinhood Chain stand-in: `hardhat node` (chain id 31337, gas in ETH) with the Coinnibal
// contracts deployed in the same order as /admin → Deploy the contracts, through the SDK:
//   TestToken (registered with the game server: the faucet hands it out) → CoinnibalArena (server authority = the
//   game server's key) → CoinnibalNFT → setToken → the four default arenas → the NFT perks (faucet 2x, the holder
//   fee, the $10 Room holders-only) (→ optionally the mint opened to the public).
// Shared by scripts/localnet.mjs, scripts/localnet-fund.mjs and scripts/demo.mjs.
//
// Accounts are Hardhat's well-known dev accounts (public keys, local only, 10,000 ETH each):
//   #0 owner / admin (contract owner, fee wallet, NFT treasury; in ADMIN_WALLETS)
//   #1 game server key (SERVER_PRIVATE_KEY, the arena's server authority)
//   #2 the Dev Wallet player of `--browser`
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALNET_CHAIN_ID, LOCALNET_RPC_PORT, ROOT, hardhatAccount, hardhatKey, importSdk, rpcUp, viem } from './common.mjs';

export const STATE_DIR = join(ROOT, '.localnet');
export const ADDRESSES_FILE = join(STATE_DIR, 'contracts.json');
export const SERVER_ENV_FILE = join(STATE_DIR, 'server.env');
/** The game server's DATA_DIR for the local chain (its contract registry holds the TestToken). */
export const SERVER_DATA_DIR = join(STATE_DIR, 'server-data');
export const ACCOUNT = { owner: 0, server: 1, player: 2 };

export const rpcUrlFor = (port = LOCALNET_RPC_PORT) => `http://127.0.0.1:${port}`;

/**
 * Starts `pnpm -F @coinnibal/contracts exec hardhat node` in its own process group and waits for the RPC.
 * Returns the child (kill it with `process.kill(-child.pid)`).
 */
export async function startHardhatNode({ port = LOCALNET_RPC_PORT, onLine = null, timeoutMs = 90_000 } = {}) {
  const url = rpcUrlFor(port);
  if (await rpcUp(url)) throw new Error(`something already answers JSON-RPC on ${url}; stop it first (lsof -i :${port})`);
  mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn('pnpm', ['-F', '@coinnibal/contracts', 'exec', 'hardhat', 'node', '--port', String(port)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (d) => onLine && d.split('\n').filter(Boolean).forEach(onLine));
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`hardhat node exited (code ${child.exitCode})`);
    if (await rpcUp(url)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  throw new Error(`hardhat node did not answer on ${url} within ${timeoutMs / 1000} s`);
}

function clients(sdk, rpcUrl, chainId, key) {
  const { privateKeyToAccount } = viem('/accounts');
  const chain = sdk.viemChain(chainId);
  const account = privateKeyToAccount(key);
  return {
    account,
    publicClient: sdk.createCoinnibalPublicClient(rpcUrl, chain, { pollingInterval: 200 }),
    wallet: sdk.createCoinnibalWalletClient(rpcUrl, { account, chain, pollingInterval: 200 }),
  };
}

/**
 * Registers the TestToken with the game server, as /admin → Deploy the contracts does on the testnet
 * (`POST /api/admin/contracts`): its contract registry, `<dataDir>/chains/<chainId>/contracts.json`, read when the
 * server starts. The faucet (`/faucet`, `GET /api/site/faucet`) hands out the registry's token, never the arena's. The
 * arena and the NFT stay env overrides (ARENA_ADDRESS / NFT_ADDRESS in server.env).
 */
function registerTokenWithServer(dataDir, { chainId, token, txHash, owner }) {
  const dir = join(dataDir, 'chains', String(chainId));
  mkdirSync(dir, { recursive: true });
  const record = { address: token, txHash, chainId, registeredAt: Date.now(), registeredBy: owner };
  writeFileSync(join(dir, 'contracts.json'), `${JSON.stringify({ arena: null, nft: null, token: record }, null, 2)}\n`);
}

/**
 * Deploys TestToken + CoinnibalArena + CoinnibalNFT from the owner account, registers the TestToken in the game
 * server's registry under `dataDir` (its DATA_DIR) and (unless `noToken`) sets the token, creates the default arenas and
 * sets the NFT perks. Writes `.localnet/contracts.json` and `.localnet/server.env`.
 * Returns `{ token, arena, nft, owner, server, chainId, rpcUrl, env }`.
 */
export async function deployLocalnet({ rpcUrl = rpcUrlFor(), publicUrl = 'http://localhost:5173', dataDir = SERVER_DATA_DIR, noToken = false, openMint = false, log = console.log } = {}) {
  const sdk = await importSdk();
  const probe = sdk.createCoinnibalPublicClient(rpcUrl);
  const chainId = await probe.getChainId();
  const ownerKey = hardhatKey(ACCOUNT.owner);
  const serverKey = hardhatKey(ACCOUNT.server);
  const { account: owner, publicClient, wallet } = clients(sdk, rpcUrl, chainId, ownerKey);
  const server = hardhatAccount(ACCOUNT.server).address;

  const send = async (call, what) => {
    const hash = await sdk.sendCall(wallet, call);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${what} reverted (${hash})`);
  };

  log(`deploying TestToken (owner ${owner.address})`);
  const tokenTx = await sdk.deployTestToken(wallet, { owner: owner.address });
  const token = await sdk.deployedAddress(publicClient, tokenTx);
  log(`deploying CoinnibalArena (server authority ${server}, fee wallet = owner)`);
  const arena = await sdk.deployedAddress(publicClient, await sdk.deployArena(wallet, { admin: owner.address, serverAuthority: server, feeWallet: owner.address }));
  log('deploying CoinnibalNFT (supply 3,333, 0.02 ETH, WL 2 / public 5 per wallet)');
  const nft = await sdk.deployedAddress(
    publicClient,
    await sdk.deployNft(wallet, {
      owner: owner.address,
      // the owner's fixed supply (NFT_SUPPLY in @coinnibal/shared)
      maxSupply: 3333,
      mintPrice: 2n * 10n ** 16n,
      wlLimit: 2,
      publicLimit: 5,
      baseURI: `${publicUrl.replace(/\/$/, '')}/api/nft/`,
      treasury: owner.address,
    }),
  );
  // the owner gets test tokens to hand out (localnet-fund.mjs)
  await send(sdk.testTokenMintCall(token, owner.address, 100_000_000n * 10n ** 18n), 'TestToken.mint');
  if (!noToken) {
    log('setToken + the four default arenas');
    await send(sdk.setTokenCall(arena, token), 'setToken');
    for (const call of sdk.createDefaultArenaCalls(arena, 18)) await send(call, `createArena(${call.args[0]})`);
    // the rest of Finish setup, as the deploy flow does: the faucet's 2x, the holder fee and the holders-only room(s)
    const holder = { burnBps: sdk.SUGGESTED_HOLDER_BURN_BPS, vaultBps: sdk.SUGGESTED_HOLDER_VAULT_BPS };
    log(`NFT perks: 2x from the faucet, holders pay ${(holder.burnBps + holder.vaultBps) / 100} % of profit, arena #${sdk.DEFAULT_HOLDERS_ONLY_ARENA_IDS.join(', #')} holders only`);
    await send(sdk.setHolderNftCall(token, nft), 'TestToken.setHolderNft');
    await send(sdk.setHolderPerksCall(arena, nft, holder), 'setHolderPerks');
    for (const id of sdk.DEFAULT_HOLDERS_ONLY_ARENA_IDS) await send(sdk.setArenaHoldersOnlyCall(arena, id, true), `setArenaHoldersOnly(${id})`);
  } else {
    log('--no-token: the token is NOT set on the arena (set it from /admin → Setup, like a fresh deploy)');
  }
  if (openMint) {
    log('opening the mint to the public');
    await send(sdk.setPhaseCall(nft, 'public'), 'setPhase');
  }

  const env = {
    EVM_RPC_URL: rpcUrl,
    PUBLIC_RPC_URL: rpcUrl,
    SERVER_PRIVATE_KEY: serverKey,
    ARENA_ADDRESS: arena,
    NFT_ADDRESS: nft,
    ADMIN_WALLETS: owner.address,
    PUBLIC_URL: publicUrl,
  };
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  log(`registering the TestToken with the game server (DATA_DIR ${dataDir}): the faucet hands it out`);
  registerTokenWithServer(dataDir, { chainId, token, txHash: tokenTx, owner: owner.address });
  writeFileSync(ADDRESSES_FILE, `${JSON.stringify({ chainId, rpcUrl, token, arena, nft, owner: owner.address, server }, null, 2)}\n`);
  writeFileSync(SERVER_ENV_FILE, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
  return { token, arena, nft, owner: owner.address, server, chainId, rpcUrl, env };
}

/** The addresses written by the last `deployLocalnet`. */
export function readAddresses() {
  try {
    return JSON.parse(readFileSync(ADDRESSES_FILE, 'utf8'));
  } catch {
    throw new Error(`${ADDRESSES_FILE} is missing: start the local chain first (node scripts/localnet.mjs or pnpm demo:localnet)`);
  }
}

/**
 * Sends `eth` ETH and `tokens` test tokens from the owner to `to`: a developer's own wallet on the local hardhat
 * chain only (31337, the well-known hardhat accounts). It refuses every other chain: nothing in this repo sends
 * ETH to players; on the testnet gas comes from the network's official faucet.
 */
export async function fundAddress(to, { eth = 10, tokens = 100_000, log = console.log } = {}) {
  const { token, rpcUrl } = readAddresses();
  const sdk = await importSdk();
  const { parseEther, getAddress } = viem();
  const probe = sdk.createCoinnibalPublicClient(rpcUrl);
  const chainId = await probe.getChainId();
  if (chainId !== LOCALNET_CHAIN_ID) throw new Error(`${rpcUrl} is chain ${chainId}, not the local chain (${LOCALNET_CHAIN_ID}): localnet-fund runs on the local chain only`);
  const { publicClient, wallet } = clients(sdk, rpcUrl, chainId, hardhatKey(ACCOUNT.owner));
  const addr = getAddress(to);
  if (eth > 0) {
    const hash = await wallet.sendTransaction({ to: addr, value: parseEther(String(eth)) });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`sent ${eth} ETH to ${addr}`);
  }
  if (tokens > 0) {
    const hash = await sdk.sendCall(wallet, sdk.testTokenMintCall(token, addr, BigInt(tokens) * 10n ** 18n));
    await publicClient.waitForTransactionReceipt({ hash });
    log(`minted ${tokens.toLocaleString('en-US')} test tokens (${token}) to ${addr}`);
  }
  const bal = await publicClient.getBalance({ address: addr });
  const tbal = await sdk.getTokenBalance(publicClient, token, addr);
  log(`balance of ${addr}: ${viem().formatEther(bal)} ETH, ${sdk.formatTokenAmount(tbal, 18)} test tokens`);
}
