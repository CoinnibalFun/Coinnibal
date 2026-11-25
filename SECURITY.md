# Security policy

Coinnibal handles player funds through smart contracts and an authoritative game server, so we take security
reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

Please **do not** open a public issue, pull request or discussion for a security problem.

Report it privately instead, by either:

- **GitHub private vulnerability reporting:** the "Report a vulnerability" button under this repository's
  [Security tab](https://github.com/CoinnibalFun/Coinnibal/security/advisories/new), or
- **Email:** security@coinnibal.fun

Please include:

- a description of the issue and its impact;
- the affected component (contract, server, web client, deployment) and version or commit;
- steps to reproduce or a proof of concept;
- any suggested fix, if you have one.

We aim to acknowledge a report within a few days, keep you informed while we investigate, and credit you in the fix
notes if you wish. Please give us reasonable time to fix the problem before any public disclosure, and do not
access or modify other players' data or funds while testing.

## Scope

In scope:

- the Solidity contracts in [`packages/contracts`](packages/contracts) (`CoinnibalArena`, `CoinnibalNFT`);
- the game server in [`apps/server`](apps/server) (settlement, ledger and journal, join permits, authentication,
  site and admin API, integrity);
- the web client in [`apps/web`](apps/web) (wallet flows, sign-in, transaction previews);
- the deployment configuration in [`deploy`](deploy).

Out of scope:

- third-party services and infrastructure (Robinhood Chain itself, wallets, RPC providers, X);
- denial-of-service by sheer traffic volume, spam, and social engineering;
- findings that need a compromised owner wallet or server host;
- issues in dependencies that are already publicly known and have no exploitable path in Coinnibal.

## Status of the contracts

The contracts have **not been audited**. They are currently deployed on Robinhood Chain Testnet only.

## Rewards

There is no bug bounty program at this time, and no reward is promised for a report.
