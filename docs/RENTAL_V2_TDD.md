# Archava Rental V2 TDD evidence

## Journeys

- A testnet user can claim 100 mUSDT once without confusing it with official USDT.
- A user can approve and purchase Starter (60 minutes) or Pro (300 minutes).
- A purchase records a 30-day entitlement while conversation usage remains offchain.
- An operator can pause sales and withdraw collected mUSDT.
- A deployer can deploy both contracts to chain 97 and retain reproducible artifacts.

## Evidence

| Guarantee                          | RED                                                        | GREEN                                                                              |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Token and rental behavior          | Foundry could not resolve the two missing contract sources | `ArchavaRentalV2Test`: 8/8 passed                                                  |
| Reproducible two-contract artifact | Vitest could not resolve `deploy-v2.js`                    | `deployment-v2.test.ts`: 2/2 passed                                                |
| Existing Solidity behavior         | Not applicable                                             | Full Foundry suite: 31/31 passed                                                   |
| Live BSC Testnet configuration     | Not applicable                                             | Chain ID 97; token metadata, payment-token link, and both prices read successfully |

## Deployment

- Mock token: `0xd63574ac426169cda5495e1e196bf64d124267d0`
- Mock token tx: `0xa8c398bb5a42b0c1ad53e26938e5d1553df30fcfc2d91f078f848242e7d7e411` (block `134051671`)
- Rental V2: `0xefaacd259136d40cd26a8672697b591c1f84200c`
- Rental V2 tx: `0x8a8392ab1ec0551b1e9e920932bf5e59443b7a8c6cf3ef1ea6cab520fa9353ff` (block `134052025`)
- Artifact: `packages/contracts/deployments/bscTestnetV2.json`

The final repository verification passed all six gates: install, structure, lint, typecheck, Vitest,
and build (53 test files, 723 tests). The live `GET /api/rental/packages` smoke test returned chain
97 and the deployed addresses/prices. `pnpm dev` successfully loaded `.env` without manual sourcing.

The mock token is testnet-only and is not official USDT. The existing web client still targets the
native-BNB V1 ABI; migrating its approve/rent flow is intentionally tracked as separate work so an
address-only configuration change cannot silently break purchases.

No checkpoint commits were created because the repository contained pre-existing uncommitted user
work before this task.
