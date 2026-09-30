# BSC deployment-readiness TDD evidence

## Source and journeys

This patch was derived directly from the deployment-readiness request, without a separate plan
file.

- As an operator, I want missing or malformed contract configuration to fail closed while the free
  landing demo remains available.
- As a deployer, I want an explicit BSC Testnet RPC and a successful receipt before an artifact is
  written.
- As a verifier, I want the exact constructor arguments and chain ID checked before BscScan
  verification.
- As a contract owner, I want every paid package to have a non-zero price.

## RED and GREEN evidence

| Guarantee                                                                         | Test target                                   | RED evidence                                                        | GREEN evidence                                      |
| --------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Missing/malformed contract addresses fail closed                                  | `apps/web/test/rental-config.test.ts`         | 3 tests failed because `resolveRentalContractAddress` did not exist | 3 tests passed                                      |
| RPC is mandatory, reverted receipts are rejected, and constructor args are stored | `packages/contracts/test/deployment.test.ts`  | 5 tests failed because deployment helpers did not exist             | 7 tests passed, including verification-chain checks |
| Zero-priced packages are rejected                                                 | `packages/contracts/test/ArchavaRental.t.sol` | Solidity compilation failed because `ZeroPrice` did not exist       | Foundry suite passed 23/23                          |
| Existing application behavior remains intact                                      | repository Vitest suite                       | Not applicable to pre-existing behavior                             | 51 files and 718 tests passed                       |

## Commands and outcomes

- `pnpm --filter @archava/contracts test`: PASS, 23 tests.
- `pnpm test`: PASS, 51 files and 718 tests.
- `pnpm lint`: PASS, zero warnings/errors.
- `pnpm typecheck`: PASS for every workspace package and web app.
- `pnpm build`: PASS; `app.js` and `studio.js` built.
- `pnpm verify`: PASS; install, structure, lint, typecheck, test, and build all passed.

## Coverage and known gaps

The repository-wide requested test suite passed. No live deployment or BscScan request was made;
network broadcasting remains an operator-only step requiring an explicitly configured RPC, a
testnet-only deployer key, and sufficient tBNB. Verification command construction is unit-tested,
while BscScan availability is intentionally not tested as part of the offline suite.

No TDD checkpoint commits were created because the worktree already contained the user's
uncommitted onchain implementation. This avoids mixing ownership of pre-existing changes into
agent-created Git history.
