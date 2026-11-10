import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeterministicStateMachine, TRACK_CODE, BOUNTY_ID, probeFailurePaths } from '../src/engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const machine = new DeterministicStateMachine();
const snap = machine.runAllTryItSteps();
const probes = probeFailurePaths();

const lines = [
  `=== ${TRACK_CODE} (${BOUNTY_ID}) DETERMINISTIC DEMO TRANSCRIPT ===`,
  `Chain Integrity Verified: ${snap.chainVerified}`,
  `Final State Merkle Head:  ${snap.headHash}`,
  ''
];

for (const ev of snap.events) {
  lines.push(`[STEP ${ev.index + 1}] ${ev.step}`);
  lines.push(`  Summary: ${ev.payload.summary}`);
  lines.push(`  Metrics: ${JSON.stringify(ev.payload.metrics)}`);
  lines.push(`  Hash:    ${ev.hash}`);
  lines.push('');
}

// Failure-path probes (computed off-chain; the first two are also
// executed on-chain — see the ON-CHAIN EVIDENCE section below).
lines.push('=== FAILURE-PATH PROBES (off-chain model) ===');
lines.push(`  empty wallet buy:        ${probes.empty_wallet_buy}`);
lines.push(`  under-collateralized buy: ${probes.under_collateralized_buy}`);
lines.push(`  blade sale, no inventory: ${probes.blade_sale_no_inventory}`);
lines.push('');

// On-chain evidence, when the testnet deploy has been run (see
// scripts/deploy-testnet.mjs). Figures above are computed off-chain by the
// model; the tx hashes below are the same flow executed on NEAR testnet.
const evidencePath = path.join(rootDir, 'docs', 'testnet-evidence.json');
if (fs.existsSync(evidencePath)) {
  const ev = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const f = ev.flow;
  const vf = ev.verified_figures;
  lines.push('=== ON-CHAIN EVIDENCE (NEAR testnet) ===');
  lines.push(`Contract: ${ev.contract_account} (${ev.token.symbol}, NEP-141, ${ev.token.total_supply_fgold} ${ev.token.symbol} minted)`);
  lines.push(`Deploy:   ${f.deploy.tx}`);
  lines.push(`Init:     ${f.init_mint_20000_fgold.tx}`);
  lines.push(`Fund smith 800 FGOLD:  ${f.fund_smith_800.tx}`);
  lines.push(`Fund miner 200 FGOLD:  ${f.fund_miner_200.tx}`);
  lines.push(`Fund guild 1500 FGOLD: ${f.fund_guild_1500.tx}`);
  lines.push(`Seed pools: ${f.seed_pools.tx}`);
  lines.push(`Refused (empty wallet): ${f.empty_wallet_buy_refused.tx} (insufficient_balance)`);
  lines.push(`NPC trade (6 ORE @ 25.00): ${f.npc_trade_6_ore_at_25.tx}`);
  lines.push(`Scarcity shock (100 -> 60): ${f.scarcity_shock_100_to_60.tx}`);
  lines.push(`Refused (under-collateralized): ${f.under_collateralized_buy_refused.tx} (insufficient_balance)`);
  lines.push(`Blade sale (4 blades): ${f.sell_blades_4.tx}`);
  lines.push(`On-chain ore price: ${vf.ore_price_before_fgold} -> ${vf.ore_price_after_fgold} FGOLD (${vf.price_move_pct})`);
  lines.push(`On-chain blade sale: gross ${vf.blade_sale_gross_fgold}, LP fee ${vf.blade_sale_lp_fee_fgold}, net ${vf.blade_sale_net_fgold} FGOLD`);
  lines.push(`Explorer: ${ev.contract_explorer}`);
  lines.push('');
}

const transcript = lines.join('\n');
fs.writeFileSync(path.join(rootDir, 'docs', 'demo-transcript.txt'), transcript, 'utf8');
fs.writeFileSync(path.join(rootDir, 'docs', 'demo-trace.json'), JSON.stringify(snap, null, 2) + '\n', 'utf8');
process.stdout.write(transcript);
