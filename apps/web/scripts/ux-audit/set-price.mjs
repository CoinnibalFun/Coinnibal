// UX audit helper (localnet only): signs in as the localnet owner (Hardhat account #0, a public test key) and sets
// the manual token price, so the lobby shows the arenas' US dollar prices.
//   node apps/web/scripts/ux-audit/set-price.mjs [usdPerToken=0.001]
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
// Hardhat's well-known account #0 (never funded outside a local node)
const HARDHAT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const usd = process.argv[2] ?? '0.001';
const account = privateKeyToAccount(HARDHAT_0);
const nonce = await (await fetch(`${SERVER}/api/auth/nonce?address=${account.address}`)).json();
const signature = await account.signMessage({ message: nonce.message });
const login = await (
  await fetch(`${SERVER}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: account.address, message: nonce.message, signature }) })
).json();
const res = await fetch(`${SERVER}/api/admin/arena-prices`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
  body: JSON.stringify({ manualUsdPerToken: usd }),
});
console.log(res.status, (await res.text()).slice(0, 400));
