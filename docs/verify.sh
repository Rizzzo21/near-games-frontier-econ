#!/usr/bin/env bash
set -euo pipefail
node --test test/engine.test.mjs
out1="$(node scripts/demo.mjs)"
out2="$(node scripts/demo.mjs)"
if [ "$out1" != "$out2" ]; then
  echo "Determinism check failed"
  exit 1
fi
# On-chain evidence file must parse and carry the required fields.
python3 - << 'PYEOF'
import json, sys
with open('docs/testnet-evidence.json') as f:
    ev = json.load(f)
required = ['network', 'contract_account', 'contract_explorer', 'token', 'flow', 'final_state', 'verified_figures']
for k in required:
    if k not in ev:
        print(f"evidence missing field: {k}")
        sys.exit(1)
for step in ['deploy', 'init_mint_20000_fgold', 'seed_pools',
             'empty_wallet_buy_refused', 'npc_trade_6_ore_at_25',
             'scarcity_shock_100_to_60', 'under_collateralized_buy_refused',
             'sell_blades_4']:
    tx = ev['flow'].get(step, {}).get('tx')
    if not tx or len(tx) < 43:
        print(f"evidence missing tx hash for: {step}")
        sys.exit(1)
vf = ev['verified_figures']
for k, want in [('ore_price_before_fgold', '25.00'), ('ore_price_after_fgold', '41.67'),
                ('blade_sale_net_fgold', '301.54'), ('blade_sale_lp_fee_fgold', '6.15'),
                ('smith_fgold_after_trade', '650.00'), ('miner_fgold_after_trade', '350.00')]:
    if vf.get(k) != want:
        print(f"evidence figure {k} = {vf.get(k)}, expected {want}")
        sys.exit(1)
if ev['final_state'].get('npc_supply_micro') != '2500000000':
    print("evidence final_state NPC supply not conserved at 2,500 FGOLD")
    sys.exit(1)
print("evidence file OK")
PYEOF
echo "ALL CHECKS PASSED"
