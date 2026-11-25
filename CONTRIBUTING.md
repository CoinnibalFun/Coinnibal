# Contributing to Coinnibal

Thanks for your interest in Coinnibal. Bug reports, ideas and pull requests are welcome.

## Setup

Requirements: Node.js 22+ and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm demo        # the whole game on a simulated chain, at http://localhost:5173
```

See the [README](README.md#getting-started) for the local chain setup and the other commands.

## Before you open a pull request

Run the checks CI runs:

```bash
pnpm check:fast  # English-only guard, dead exports, typecheck, tests, money simulation
pnpm check       # the full run, including the contracts build and Solidity tests and the web build
```

If you change a contract, run `pnpm contracts:build` and commit the regenerated
`packages/contracts/src/artifacts.ts`.

## Guidelines

- **English only** in code, comments, docs and commit messages (CI enforces it; the translations under
  `apps/web/src/i18n/locales/` are the only exception).
- **Keep changes focused.** One topic per pull request, with tests for behaviour changes.
- **No unused exports.** `pnpm check:exports` fails on an exported name nothing uses.
- **Money rules are invariants.** Changes to settlement, fees, the ledger or the journal must keep the
  conservation tests green and should explain why the books still balance.
- **Docs follow code.** Update the relevant page in [`docs/`](docs) when behaviour changes.

## Commit messages

Write a short summary line in the imperative or descriptive present (for example "Arena scaling: drain quiet
instances after the bell"), optionally followed by a blank line and a body that explains the why.

## Security issues

Please do not report vulnerabilities in public issues; see [SECURITY.md](SECURITY.md).

## Code of Conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
