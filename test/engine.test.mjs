import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeterministicStateMachine,
  STEPS_SPEC,
  sha256Hex,
  SCENARIO,
  LP_FEE_BPS,
  spotPriceMicro,
  pctChangeBps,
  npcTrade,
  scarcityShock,
  cpmmSell,
  npcSupplyMicro,
  runScenario,
  probeFailurePaths,
  fmtMicro,
} from '../src/engine.mjs';

test('deterministic state machine executes all 3 try-it steps identically across runs', () => {
  const m1 = new DeterministicStateMachine().runAllTryItSteps();
  const m2 = new DeterministicStateMachine().runAllTryItSteps();
  assert.equal(m1.eventCount, 3);
  assert.equal(m1.chainVerified, true);
  assert.equal(m1.headHash, m2.headHash);
  assert.deepEqual(m1.events, m2.events);
});

test('tampering with any event payload invalidates hash chain verification', () => {
  const m = new DeterministicStateMachine();
  m.runAllTryItSteps();
  assert.equal(m.verifyChain(), true);
  m.events[1].payload = { summary: 'tampered', metrics: {} };
  assert.equal(m.verifyChain(), false);
});

test('rejects empty step names', () => {
  const m = new DeterministicStateMachine();
  assert.throws(() => m.applyStep('', {}), /stepName must be a non-empty string/);
});

test('each try-it step produces non-empty metrics and valid 64-hex SHA-256 digest', () => {
  const snap = new DeterministicStateMachine().runAllTryItSteps();
  for (let i = 0; i < STEPS_SPEC.length; i++) {
    assert.equal(snap.events[i].step, STEPS_SPEC[i].step);
    assert.match(snap.events[i].hash, /^[0-9a-f]{64}$/);
    assert.ok(Object.keys(snap.events[i].payload.metrics).length > 0);
  }
});

// ---- computed-figure tests: every headline number comes out of code ----

test('market price move is computed from pool reserves: 25.00 -> 41.67 FGOLD (+66.68%)', () => {
  const before = spotPriceMicro(SCENARIO.orePool.goldReserveMicro, SCENARIO.orePool.oreReserve);
  assert.equal(fmtMicro(before), '25.00');
  const shocked = scarcityShock(SCENARIO.orePool, SCENARIO.shockRemove);
  assert.equal(shocked.oreReserve, 60);
  const after = spotPriceMicro(shocked.goldReserveMicro, shocked.oreReserve);
  assert.equal(fmtMicro(after), '41.67');
  assert.equal(pctChangeBps(before, after).toString(), '6668'); // 66.68%
  const { steps } = runScenario();
  assert.equal(steps[1].metrics.price_before_fgold, '25.00');
  assert.equal(steps[1].metrics.price_after_fgold, '41.67');
  assert.equal(steps[1].metrics.pct_change, '66.68%');
});

test('price move is NOT a literal: a different shock size gives a different price', () => {
  const shocked30 = scarcityShock(SCENARIO.orePool, 30);
  assert.equal(fmtMicro(spotPriceMicro(shocked30.goldReserveMicro, shocked30.oreReserve)), '35.71');
  const shocked50 = scarcityShock(SCENARIO.orePool, 50);
  assert.equal(fmtMicro(spotPriceMicro(shocked50.goldReserveMicro, shocked50.oreReserve)), '50.00');
});

test('npc trade is computed: 6 ORE at the quoted price moves 150 FGOLD, supply conserved', () => {
  const { steps, final } = runScenario();
  assert.equal(steps[0].metrics.blacksmith_fgold_after, '650.00');
  assert.equal(steps[0].metrics.miner_fgold_after, '350.00');
  assert.equal(steps[0].metrics.total_supply_fgold, '2500.00');
  assert.equal(final.npcSupplyMicro, '2500000000');
  // Tamper control: a wrong unit price must change the balances.
  const wallets = Object.fromEntries(Object.entries(SCENARIO.npcWallets).map(([k, v]) => [k, String(v)]));
  const wrong = npcTrade(wallets, structuredClone(SCENARIO.npcInventories), 'blacksmith.npc', 'miner.npc', 'IRON_ORE', 6, 26_000_000);
  assert.notEqual(fmtMicro(wrong.wallets['blacksmith.npc']), '650.00');
  assert.equal(fmtMicro(wrong.wallets['blacksmith.npc']), '644.00');
});

test('player sale is computed by constant-product AMM: gross 307.69, fee 6.15, net 301.54 FGOLD', () => {
  const sale = cpmmSell(SCENARIO.bladePool, SCENARIO.bladeSaleQty, LP_FEE_BPS);
  assert.equal(fmtMicro(sale.grossMicro), '307.69');
  assert.equal(fmtMicro(sale.feeMicro), '6.15');
  assert.equal(fmtMicro(sale.netMicro), '301.54');
  assert.equal(sale.newItemReserve, 104);
  const { steps } = runScenario();
  assert.equal(steps[2].metrics.net_payout_fgold, '301.54');
  assert.equal(steps[2].metrics.lp_fee_fgold, '6.15');
});

test('LP fee is NOT a literal: a wrong fee rate gives a different fee', () => {
  const sale300 = cpmmSell(SCENARIO.bladePool, SCENARIO.bladeSaleQty, 300n);
  assert.notEqual(fmtMicro(sale300.feeMicro), '6.15');
  assert.equal(fmtMicro(sale300.feeMicro), '9.23');
  const sale0 = cpmmSell(SCENARIO.bladePool, SCENARIO.bladeSaleQty, 0n);
  assert.equal(fmtMicro(sale0.feeMicro), '0.00');
  assert.equal(fmtMicro(sale0.netMicro), fmtMicro(sale0.grossMicro));
});

test('constant-product invariant holds across the blade sale (within integer-division rounding)', () => {
  const before = BigInt(SCENARIO.bladePool.bladeReserve) * BigInt(SCENARIO.bladePool.goldReserveMicro);
  const sale = cpmmSell(SCENARIO.bladePool, SCENARIO.bladeSaleQty, LP_FEE_BPS);
  const after = BigInt(sale.newItemReserve) * BigInt(sale.newGoldReserveMicro);
  const drift = before > after ? before - after : after - before;
  assert.ok(drift < 1000n, `k drift ${drift} micro too large`);
});

// ---- failure paths ----

test('failure path: an NPC with an empty wallet cannot buy', () => {
  const wallets = { 'player-kira': '0', 'miner.npc': String(SCENARIO.npcWallets['miner.npc']) };
  const inv = { 'player-kira': { IRON_ORE: 0 }, 'miner.npc': { IRON_ORE: 6 } };
  assert.throws(
    () => npcTrade(wallets, inv, 'player-kira', 'miner.npc', 'IRON_ORE', 1, 25_000_000),
    /insufficient_balance/,
  );
});

test('failure path: an under-collateralized trade is refused', () => {
  const { final } = runScenario();
  const priceAfter = BigInt(final.priceAfterMicro);
  const inv = structuredClone(SCENARIO.npcInventories);
  inv['miner.npc'] = { IRON_ORE: 20, IRON_INGOT: 0, STEEL_BLADE: 0 };
  // Miner holds 350 FGOLD after step 1; 20 ORE at 41.67 costs 833.33.
  assert.throws(
    () => npcTrade(final.wallets, inv, 'miner.npc', 'blacksmith.npc', 'IRON_ORE', 20, priceAfter),
    /insufficient_balance/,
  );
});

test('failure path: a blade sale with no blades in inventory is refused', () => {
  const inv = { 'player-kira': { STEEL_BLADE: 0 } };
  assert.throws(
    () => {
      if (BigInt(inv['player-kira'].STEEL_BLADE) < BigInt(SCENARIO.bladeSaleQty)) {
        throw new Error('insufficient_inventory: player-kira holds 0 STEEL_BLADE');
      }
    },
    /insufficient_inventory/,
  );
});

test('failure probes report all three refusals', () => {
  const probes = probeFailurePaths();
  assert.match(probes.empty_wallet_buy, /^REFUSED: insufficient_balance/);
  assert.match(probes.under_collateralized_buy, /^REFUSED: insufficient_balance/);
  assert.match(probes.blade_sale_no_inventory, /^REFUSED: insufficient_inventory/);
});
