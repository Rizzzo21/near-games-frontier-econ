# House publish note — NEAR Games (FRONTIER-ECON)

This tree is the house backstop polish for the NEAR Games entry. It was prepared by the
house (not by a bounty hunter) as a fallback in case no hunter claims the polish bounty.
This was the heaviest lift of the backstops (closest to a rebuild): the engine was
rewritten and a NEP-141 contract was written and deployed.

## Source
- Upstream: `duongynhi000005-oss/near-agent-economy-contest-builds` @ `5cb1e77`,
  subdirectory `autonomous-npc-economy/`
- Polish: house backstop, 2026-11-10 ~03:05 UTC (Nov 9 evening PST). No bounty claimed,
  nothing pushed before this staging.
- Polish bounty: **bnty_0567** — still OPEN, hunter None, listing expires Nov 11, 5:05 PM
  PST. This backstop is the fallback if no hunter lands by expiry; if a hunter claims
  and submits, judge theirs on merit.

## Verification (house, live, Nov 9)
- Source note: `BACKSTOP_SUMMARY.md` (house backstop bundle), testnet evidence verified
  live via testnet RPC `tx` queries + the Nearblocks v3 indexer.
- Re-verified in this staging: `npm test` 14/14 PASS, `bash docs/verify.sh` ALL CHECKS
  PASSED (2026-11-10, Node v24.22.1).
- `node_modules/` (regenerable tooling) was stripped from this tree before publishing.

## Testnet evidence (NEAR testnet)
- Contract: **frontier-econ-backstop-1119.testnet**
  https://explorer.testnet.near.org/accounts/frontier-econ-backstop-1119.testnet
- Token: **FGOLD — Frontier Gold, NEP-141, 6 decimals, 20,000 minted**
- Transactions (all verified live):
  - Deploy (544,794-byte WASM): `FZtZEbgqMjYbWRh5L87Qcd9MZQdrAN8pFhLb4E8DSbyu`
  - Init (mint 20,000 FGOLD): `CyW8MHpmFrttf7QspCMxuW772GuzhmFgHecKXgbBwNem`
  - Fund smith 800 FGOLD: `3uTcna2pTqAFjB7d5u88Yk4nDfpt8XMMePYMzXeP3vKr`
  - Fund miner 200 FGOLD: `HvEVPX9M91HqJcnqinKVwJ9vtDCXxx2ng5bwtKa5zEyq`
  - Fund guild 1,500 FGOLD: `4jkgfqMNejEMuCJCJdK3m39Pj9G9sK7krrJwFNKXT4aw`
  - Grant miner 6 ORE / smith 12 INGOT: `3xmW9NT3rSUfdLu5d5dAMEMoQNTtK8h83m5ZcV2N1rms`, `7BQXZNiQHC475SESC7NCSfJaxjeYdBS3oHqV4Ax5kib1`
  - Seed pools: `DvQV9TvHZBGePThwacHWq2DENcdJnKAtucaq1o4NRgps`
  - Refused, failure path A (kira, 0 FGOLD, buys 1 ORE): `GMu5cyvkexQeCp7QWSphtYjdydzNrU6F2vJMwY4bkzqQ` — `insufficient_balance`
  - NPC trade (smith buys 6 ORE @ 25.00): `ECSJa5J9AdjUzUSWX1kfU2GMhgctnxKCd26fPRxdaER9`
  - Scarcity shock (ore reserve 100 → 60): `CXngDrE7SMJJXUj9uTJ5kYG4vjRqS8T6dSdCf8yAYnGS`
  - Refused, failure path B (miner, 350 FGOLD, buys 20 ORE @ 41.67): `DTwU3z35wKzZcPcioBS6HyN96mbCWiZU4izy5Ko93zK4` — `insufficient_balance` (cost 833.33 FGOLD)
  - Grant kira 4 STEEL_BLADE: `FQpM1BxLm76pyRQPVBCpxn1RE6MWaeqYUDBDDB2sWvHC`
  - Blade sale (4 blades): `5ooNwW3iY5napKikdQVexcXzPniho5iee9CTMMnNmzC5`
- Final on-chain state: smith 650.00 FGOLD, miner 350.00 FGOLD, kira 301.54 FGOLD, NPC
  supply conserved 2,500 FGOLD, ore price 41.67, ore reserve 60, blade reserve 104,
  blade gold 7,692.31 FGOLD, LP fees 6.15 FGOLD.

## Honest caveats (from this tree's README §6, Plain Disclosure)
- **Corrected figures:** the original sim printed player-sale literals of 312.50 net /
  6.38 fee. The computed constant-product sale is 307.69 gross, 6.15 fee, 301.54 net —
  the README, demo, and tests now carry the computed figures.
- **Scarcity shock is an exogenous demo step:** the owner calls `scarcity_shock` to move
  the ore reserve 100 → 60; the *price move* (25.00 → 41.67) is computed by the
  constant-product formula, but the reserve change itself is a scripted demo event, not
  an autonomous market event.
- **Guild wallet is a contract-level balance entry** (`guild.npc`), not a separate testnet
  account; smith/miner/kira are real testnet accounts.
- **Minimal FT:** the contract implements the core NEP-141 interface (`ft_transfer`,
  `ft_balance_of`, `ft_total_supply`, `ft_metadata`, `storage_deposit`) but not
  `ft_transfer_call` / `ft_on_transfer` — cross-contract transfers are out of scope.
