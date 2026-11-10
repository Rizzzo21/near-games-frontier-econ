# FRONTIER-ECON - autonomous NPC wallets, player-owned AMM/orderbook market, and self-balancing game economy

## 1. Problem Solved
Static game shops suffer from hyperinflation and require developer balance patches because NPCs have infinite money/items instead of bounded wallets and utility-driven supply/demand pricing.

## 2. Try It ('Do X -> See Y' Deterministic Steps)
```bash
npm test
node scripts/demo.mjs
bash docs/verify.sh
```
1. **`npc_trade`**: Blacksmith NPC (wallet 800 FGOLD, inventory 12 IRON_INGOT) buys 6 IRON_ORE from Miner NPC (wallet 200 FGOLD) at market price 25 FGOLD/unit -> Blacksmith wallet = 650 FGOLD, Miner wallet = 350 FGOLD, total money supply conserved = 2,500 FGOLD
2. **`market_price_moves`**: Scarcity shock reduces IRON_ORE pool reserve from 100 to 60 units -> constant-product market price moves endogenously from 25.00 FGOLD to 41.67 FGOLD (+66.68%) without any admin parameter patch
3. **`player_sale`**: player-kira crafts 4 STEEL_BLADE and sells into the player-owned market pool -> receives 301.54 FGOLD net of 2% LP fee (6.15 FGOLD distributed to player liquidity providers)
4. **`failure_path`**: an NPC with an empty wallet cannot buy (kira, 0 FGOLD, trade costs 25.00 FGOLD -> refused `insufficient_balance`); an under-collateralized trade is refused (miner, 350 FGOLD, 20 ORE at 41.67 costs 833.33 FGOLD -> refused `insufficient_balance`); a blade sale with no blades in inventory is refused (`insufficient_inventory`). All three are probed in `npm test` and the first two are executed on-chain (see §5).

Final Merkle State Head: `c1a9300455735f25f83bd0e0ec61f50963dd9edaf9961f2d521fc111e64c44ce`

## 3. Mechanical Mapping to NEAR Protocol Contracts
Maps 1:1 to a NEAR game-loop contract where NPC agents are registered sub-accounts with bounded NEP-141 balances and deterministic tick functions (`execute_npc_tick`), trading against a player-LP constant-product pool. The contract in `contract/` is that mapping, implemented in near-sdk-js: a minimal NEP-141 fungible token "Frontier Gold" (FGOLD, 6 decimals) with `ft_transfer`, `ft_balance_of`, `ft_total_supply`, `ft_metadata`, `npc_trade` (buyer pays seller at the computed spot price), `scarcity_shock` (owner-only reserve change), `sell_blades` (constant-product sale with a 2% LP fee), and `get_price` / `get_state` / `get_npc` / `get_events` views. NPC wallets are real testnet accounts (`smith-1119.testnet`, `miner-1119.testnet`, `kira-1119.testnet`) holding real FGOLD balances on-chain — the invented GOLD currency of the original sim is gone.

## 4. Prerequisites
- **Node.js 20+** (tested on Node v24.22.1, npm 10.9.4). The engine and demo use only the Node standard library; the contract build and testnet deploy need `near-api-js ^5.1.1` and `near-sdk-js ^2.0.0` (see `package.json`).
- **NEAR testnet** (free): deploying requires no wallet and no real funds — `scripts/deploy-testnet.mjs` creates the contract account and NPC accounts through the public testnet faucet helper (`https://helper.testnet.near.org/account`). Testnet NEAR only; nothing here spends mainnet funds.

## 5. Deploy to Testnet
```bash
npm install
npm run build-contract   # builds contract/build/contract.wasm (near-sdk-js)
node scripts/deploy-testnet.mjs   # creates accounts, deploys, runs the full flow, writes docs/testnet-evidence.json
```
The deploy script runs the same flow as the demo on-chain: deploy, mint 20,000 FGOLD, fund the NPC wallets (smith 800 / miner 200 / guild 1500), grant inventories, seed the pools, run both failure paths, execute the NPC trade, apply the scarcity shock, and sell the blades — then verifies every transaction via RPC and writes `docs/testnet-evidence.json`.

### On-chain evidence (NEAR testnet, 2026-11-10)
Contract: [`frontier-econ-backstop-1119.testnet`](https://explorer.testnet.near.org/accounts/frontier-econ-backstop-1119.testnet)

| Step | Tx | Result |
|---|---|---|
| Deploy contract (544,794-byte WASM) | [`FZtZEbgqMjYbWRh5L87Qcd9MZQdrAN8pFhLb4E8DSbyu`](https://explorer.testnet.near.org/transactions/FZtZEbgqMjYbWRh5L87Qcd9MZQdrAN8pFhLb4E8DSbyu) | Success |
| Init: mint 20,000 FGOLD to owner | [`CyW8MHpmFrttf7QspCMxuW772GuzhmFgHecKXgbBwNem`](https://explorer.testnet.near.org/transactions/CyW8MHpmFrttf7QspCMxuW772GuzhmFgHecKXgbBwNem) | Success |
| Fund smith 800 / miner 200 / guild 1500 FGOLD | `3uTcna2pTqAFjB7d5u88Yk4nDfpt8XMMePYMzXeP3vKr`, `HvEVPX9M91HqJcnqinKVwJ9vtDCXxx2ng5bwtKa5zEyq`, `4jkgfqMNejEMuCJCJdK3m39Pj9G9sK7krrJwFNKXT4aw` | Success |
| Seed pools (ore 100 / 2,500 FGOLD; blade 100 / 8,000 FGOLD) | [`DvQV9TvHZBGePThwacHWq2DENcdJnKAtucaq1o4NRgps`](https://explorer.testnet.near.org/transactions/DvQV9TvHZBGePThwacHWq2DENcdJnKAtucaq1o4NRgps) | ore price 25.00 FGOLD on-chain |
| Failure path A: kira (0 FGOLD) buys 1 ORE | [`GMu5cyvkexQeCp7QWSphtYjdydzNrU6F2vJMwY4bkzqQ`](https://explorer.testnet.near.org/transactions/GMu5cyvkexQeCp7QWSphtYjdydzNrU6F2vJMwY4bkzqQ) | **Failure** — `insufficient_balance` |
| NPC trade: smith buys 6 ORE @ 25.00 | [`ECSJa5J9AdjUzUSWX1kfU2GMhgctnxKCd26fPRxdaER9`](https://explorer.testnet.near.org/transactions/ECSJa5J9AdjUzUSWX1kfU2GMhgctnxKCd26fPRxdaER9) | smith 650.00, miner 350.00 |
| Scarcity shock: ore reserve 100 -> 60 | [`CXngDrE7SMJJXUj9uTJ5kYG4vjRqS8T6dSdCf8yAYnGS`](https://explorer.testnet.near.org/transactions/CXngDrE7SMJJXUj9uTJ5kYG4vjRqS8T6dSdCf8yAYnGS) | ore price 41.67 FGOLD on-chain |
| Failure path B: miner (350 FGOLD) buys 20 ORE @ 41.67 | [`DTwU3z35wKzZcPcioBS6HyN96mbCWiZU4izy5Ko93zK4`](https://explorer.testnet.near.org/transactions/DTwU3z35wKzZcPcioBS6HyN96mbCWiZU4izy5Ko93zK4) | **Failure** — `insufficient_balance` (cost 833.33 FGOLD) |
| Blade sale: kira sells 4 STEEL_BLADE | [`5ooNwW3iY5napKikdQVexcXzPniho5iee9CTMMnNmzC5`](https://explorer.testnet.near.org/transactions/5ooNwW3iY5napKikdQVexcXzPniho5iee9CTMMnNmzC5) | gross 307.69, LP fee 6.15, net 301.54 FGOLD |

All figures above are computed by code (constant-product pricing, 2% LP fee) and reproduced on-chain; the on-chain final state confirms smith 650.00 / miner 350.00 / kira 301.54 FGOLD, ore price 41.67, ore reserve 60, blade reserve 104, LP fees 6.15 FGOLD, NPC supply conserved at 2,500 FGOLD. `node scripts/demo.mjs` prints the same table from `docs/testnet-evidence.json`. `docs/demo-screenshot.png` is a render of that real demo output (see `scripts/render-screenshot.py`).

## 6. Plain Disclosure
- **Zero External Dependencies (engine/demo)**: Uses Node.js standard library (`node:crypto`, `node:test`, `node:assert`, `node:fs`) only.
- **No Secrets or Network Calls (engine/demo)**: Deterministic offline verification (`bash docs/verify.sh` -> `ALL CHECKS PASSED`).
- **Corrected figures**: the original sim printed player-sale literals of 312.50 net / 6.38 fee. The computed constant-product sale is 307.69 gross, 6.15 fee, 301.54 net — the README, demo, and tests now carry the computed figures. The tamper tests in `test/engine.test.mjs` fail if any of these numbers are changed without changing the code.
- **Scarcity shock is an exogenous demo step**: the owner calls `scarcity_shock` to move the ore reserve 100 -> 60; the *price move* (25.00 -> 41.67) is computed by the constant-product formula, but the reserve change itself is a scripted demo event, not an autonomous market event.
- **Guild wallet is a contract-level balance entry** (`guild.npc`), not a separate testnet account; smith/miner/kira are real testnet accounts.
- **Minimal FT**: the contract implements the core NEP-141 interface (`ft_transfer`, `ft_balance_of`, `ft_total_supply`, `ft_metadata`, `storage_deposit`) but not `ft_transfer_call` / `ft_on_transfer` — cross-contract transfers are out of scope for this demo.
- **Shared Utility Harness Disclosure**: The SHA-256 hash-chain verification harness (`DeterministicStateMachine`) and `docs/verify.sh` layout are shared across our 7 NEAR Contest Build track entries (`bnty_0422`, `bnty_0420`, `bnty_0419`, `bnty_0417`, `bnty_0416`, `bnty_0412`, `bnty_0411`), while each track's step specifications, domain invariants, and state transitions are tailored to that track.

## Links
- [NEP-141 Fungible Token standard](https://nomicon.io/standards/tokens/fungible-token/core)
- [NEAR testnet explorer — contract account](https://explorer.testnet.near.org/accounts/frontier-econ-backstop-1119.testnet)
- [near-sdk-js](https://github.com/near/near-sdk-js)
- [near-api-js](https://github.com/near/near-api-js)
