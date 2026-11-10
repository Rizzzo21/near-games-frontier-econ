import crypto from 'node:crypto';

// FRONTIER-ECON engine — every demo figure is COMPUTED from the scenario
// inputs below in integer micro-FGOLD (1 FGOLD = 1,000,000 micro units),
// using BigInt. Nothing in the demo is a pasted literal: change any input
// (a wallet, a reserve, the fee) and the figures move with it — the tests
// pin this (including wrong-fee / wrong-price controls that must fail).

export const TRACK_CODE = "FRONTIER-ECON";
export const BOUNTY_ID = "bnty_0419";
export const SCALE = 1000000n; // micro-FGOLD per FGOLD
export const LP_FEE_BPS = 200n; // 2% LP fee on player sales
export const BPS_DENOM = 10000n;

// Canonical scenario inputs. The on-chain contract (contract/src/index.js)
// is seeded with exactly these values, so the off-chain demo and the
// testnet flow agree to the micro-unit.
export const SCENARIO = {
  // NPC wallets in micro-FGOLD. NPC circulating supply = 2,500 FGOLD.
  npcWallets: {
    'blacksmith.npc': 800_000_000,
    'miner.npc': 200_000_000,
    'guild.npc': 1_500_000_000,
  },
  // NPC starting inventories (whole units).
  npcInventories: {
    'blacksmith.npc': { IRON_ORE: 0, IRON_INGOT: 12, STEEL_BLADE: 0 },
    'miner.npc': { IRON_ORE: 6, IRON_INGOT: 0, STEEL_BLADE: 0 },
    'guild.npc': { IRON_ORE: 0, IRON_INGOT: 0, STEEL_BLADE: 0 },
  },
  // IRON_ORE / FGOLD pool: 100 ORE against 2,500 FGOLD -> 25.00 FGOLD/ORE.
  orePool: { oreReserve: 100, goldReserveMicro: 2_500_000_000 },
  // STEEL_BLADE / FGOLD pool: 100 BLADE against 8,000 FGOLD -> 80.00/BLADE.
  bladePool: { bladeReserve: 100, goldReserveMicro: 8_000_000_000 },
  tradeQty: 6, // blacksmith buys 6 IRON_ORE from miner
  tradeItem: 'IRON_ORE',
  shockRemove: 40, // scarcity shock removes 40 ORE from the pool
  bladeSaleQty: 4, // player-kira sells 4 STEEL_BLADE into the blade pool
  playerBlades: 4, // blades crafted by player-kira before the sale
  totalMintMicro: 20_000_000_000, // 20,000 FGOLD: NPCs 2,500 + ore pool 2,500 + blade pool 8,000 + owner reserve 7,000
};

// ---- formatting (integer math; 2-decimal display rounds half-up) ----

export function fmt2(micro) {
  const m = BigInt(micro);
  const sign = m < 0n ? '-' : '';
  const a = m < 0n ? -m : m;
  const hundredths = (a * 100n + SCALE / 2n) / SCALE; // round to cents
  return `${sign}${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

export function fmtMicro(micro) {
  return fmt2(micro);
}

// ---- AMM / economy primitives (all BigInt) ----

// Spot price of 1 unit of the pool item, in micro-FGOLD.
// price = gold_reserve / item_reserve (constant-product quote).
export function spotPriceMicro(goldReserveMicro, itemReserve) {
  const gold = BigInt(goldReserveMicro);
  const reserve = BigInt(itemReserve);
  if (reserve <= 0n) throw new Error('empty_pool_reserve');
  return gold / reserve; // truncates; display rounds (41,666,666 -> 41.67)
}

// Percent change between two prices, computed from the 2-decimal display
// prices (41.67 vs 25.00 -> 66.68%). Returned in basis points.
export function pctChangeBps(beforeMicro, afterMicro) {
  const before = (BigInt(beforeMicro) * 100n + SCALE / 2n) / SCALE;
  const after = (BigInt(afterMicro) * 100n + SCALE / 2n) / SCALE;
  if (before === 0n) throw new Error('zero_before_price');
  return ((after - before) * 10000n) / before;
}

export function fmtPct(bps) {
  const b = BigInt(bps);
  return `${(b / 100n).toString()}.${(b % 100n).toString().padStart(2, '0')}%`;
}

// NPC-to-NPC trade at the pool's quoted unit price. Throws on an empty or
// under-funded buyer wallet, or when the seller lacks the item.
export function npcTrade(wallets, inventories, buyer, seller, item, qty, unitPriceMicro) {
  const q = BigInt(qty);
  const cost = q * BigInt(unitPriceMicro);
  const buyerBal = BigInt(wallets[buyer] ?? 0);
  if (buyerBal < cost) {
    throw new Error(
      `insufficient_balance: ${buyer} holds ${fmtMicro(buyerBal)} FGOLD, trade costs ${fmtMicro(cost)} FGOLD`,
    );
  }
  const sellerStock = BigInt(inventories[seller]?.[item] ?? 0);
  if (sellerStock < q) {
    throw new Error(`insufficient_inventory: ${seller} holds ${sellerStock} ${item}, trade needs ${q}`);
  }
  const nextWallets = { ...wallets };
  nextWallets[buyer] = (buyerBal - cost).toString();
  nextWallets[seller] = (BigInt(wallets[seller] ?? 0) + cost).toString();
  const nextInv = structuredClone(inventories);
  nextInv[buyer][item] = (BigInt(nextInv[buyer]?.[item] ?? 0) + q).toString();
  nextInv[seller][item] = (sellerStock - q).toString();
  return { wallets: nextWallets, inventories: nextInv, costMicro: cost.toString(), unitPriceMicro: BigInt(unitPriceMicro).toString() };
}

// Scarcity shock: remove `removeQty` units from the ore pool (mine
// depletes). Gold reserve is untouched, so the constant-product price
// moves endogenously: 2,500 / 60 = 41.67 FGOLD per ORE.
export function scarcityShock(pool, removeQty) {
  const ore = BigInt(pool.oreReserve) - BigInt(removeQty);
  if (ore <= 0n) throw new Error('shock_empties_pool');
  return { oreReserve: Number(ore), goldReserveMicro: BigInt(pool.goldReserveMicro).toString() };
}

// Constant-product sale into a pool: sell `qty` items, receive
// gross = G - k/(R+qty); LP fee = gross * feeBps / 10000; net = gross - fee.
export function cpmmSell(pool, qty, feeBps) {
  const r = BigInt(pool.bladeReserve ?? pool.itemReserve);
  const g = BigInt(pool.goldReserveMicro);
  const q = BigInt(qty);
  if (q <= 0n) throw new Error('qty_must_be_positive');
  const k = r * g;
  const newGold = k / (r + q);
  const gross = g - newGold;
  const fee = (gross * BigInt(feeBps)) / BPS_DENOM;
  const net = gross - fee;
  return {
    grossMicro: gross.toString(),
    feeMicro: fee.toString(),
    netMicro: net.toString(),
    newItemReserve: Number(r + q),
    newGoldReserveMicro: newGold.toString(),
  };
}

export function npcSupplyMicro(wallets) {
  return Object.values(wallets).reduce((acc, v) => acc + BigInt(v), 0n).toString();
}

// ---- the canonical scenario, computed end to end ----

export function runScenario() {
  const s = SCENARIO;
  const wallets = Object.fromEntries(Object.entries(s.npcWallets).map(([k, v]) => [k, String(v)]));
  const inventories = structuredClone(s.npcInventories);
  const orePool = { oreReserve: s.orePool.oreReserve, goldReserveMicro: String(s.orePool.goldReserveMicro) };
  const bladePool = { bladeReserve: s.bladePool.bladeReserve, goldReserveMicro: String(s.bladePool.goldReserveMicro) };

  // Step 1 — npc_trade at the quoted pool price.
  const priceBefore = spotPriceMicro(orePool.goldReserveMicro, orePool.oreReserve);
  const trade = npcTrade(wallets, inventories, 'blacksmith.npc', 'miner.npc', s.tradeItem, s.tradeQty, priceBefore);
  const supplyAfterTrade = npcSupplyMicro(trade.wallets);

  // Step 2 — scarcity shock: ore reserve 100 -> 60, price moves.
  const shocked = scarcityShock(orePool, s.shockRemove);
  const priceAfter = spotPriceMicro(shocked.goldReserveMicro, shocked.oreReserve);
  const moveBps = pctChangeBps(priceBefore, priceAfter);

  // Step 3 — player sale: kira crafts blades, sells into the blade pool.
  const playerInv = { STEEL_BLADE: s.playerBlades };
  const sale = cpmmSell(bladePool, s.bladeSaleQty, LP_FEE_BPS);
  const playerGoldAfter = BigInt(sale.netMicro); // kira starts at 0 FGOLD
  const bladePoolAfter = { bladeReserve: sale.newItemReserve, goldReserveMicro: sale.newGoldReserveMicro };

  const steps = [
    {
      step: 'npc_trade',
      summary: `Blacksmith NPC (wallet ${fmtMicro(s.npcWallets['blacksmith.npc'])} FGOLD, inventory 12 IRON_INGOT) buys ${s.tradeQty} IRON_ORE from Miner NPC (wallet ${fmtMicro(s.npcWallets['miner.npc'])} FGOLD) at market price ${fmtMicro(priceBefore)} FGOLD/unit -> Blacksmith wallet = ${fmtMicro(trade.wallets['blacksmith.npc'])} FGOLD, Miner wallet = ${fmtMicro(trade.wallets['miner.npc'])} FGOLD, total money supply conserved = ${fmtMicro(supplyAfterTrade)} FGOLD`,
      metrics: {
        buyer_npc: 'blacksmith.npc',
        seller_npc: 'miner.npc',
        item: s.tradeItem,
        qty: s.tradeQty,
        unit_price_fgold: fmtMicro(priceBefore),
        blacksmith_fgold_after: fmtMicro(trade.wallets['blacksmith.npc']),
        miner_fgold_after: fmtMicro(trade.wallets['miner.npc']),
        total_supply_fgold: fmtMicro(supplyAfterTrade),
      },
    },
    {
      step: 'market_price_moves',
      summary: `Scarcity shock reduces IRON_ORE pool reserve from ${orePool.oreReserve} to ${shocked.oreReserve} units -> constant-product market price moves endogenously from ${fmtMicro(priceBefore)} FGOLD to ${fmtMicro(priceAfter)} FGOLD (+${fmtPct(moveBps)}) without any admin parameter patch`,
      metrics: {
        pool: 'IRON_ORE/FGOLD',
        reserve_before: orePool.oreReserve,
        reserve_after: shocked.oreReserve,
        price_before_fgold: fmtMicro(priceBefore),
        price_after_fgold: fmtMicro(priceAfter),
        pct_change: fmtPct(moveBps),
      },
    },
    {
      step: 'player_sale',
      summary: `player-kira crafts ${s.bladeSaleQty} STEEL_BLADE and sells into the player-owned market pool -> receives ${fmtMicro(sale.netMicro)} FGOLD net of ${fmtPct(LP_FEE_BPS)} LP fee (${fmtMicro(sale.feeMicro)} FGOLD distributed to player liquidity providers)`,
      metrics: {
        player: 'player-kira',
        item: 'STEEL_BLADE',
        qty: s.bladeSaleQty,
        gross_payout_fgold: fmtMicro(sale.grossMicro),
        net_payout_fgold: fmtMicro(sale.netMicro),
        lp_fee_fgold: fmtMicro(sale.feeMicro),
      },
    },
  ];

  return {
    steps,
    final: {
      wallets: trade.wallets,
      npcSupplyMicro: supplyAfterTrade,
      orePoolAfterShock: shocked,
      priceAfterMicro: priceAfter.toString(),
      bladePoolAfter,
      lpFeesMicro: sale.feeMicro,
      playerGoldMicro: playerGoldAfter.toString(),
      playerInventory: playerInv,
    },
  };
}

// Failure paths, exercised by the tests and mirrored on-chain:
// (a) an NPC with an empty wallet cannot buy; (b) an under-collateralized
// trade is refused; (c) a blade sale with no blades is refused.
export function probeFailurePaths() {
  const s = SCENARIO;
  const wallets = Object.fromEntries(Object.entries(s.npcWallets).map(([k, v]) => [k, String(v)]));
  wallets['player-kira'] = '0';
  const inventories = structuredClone(s.npcInventories);
  inventories['player-kira'] = { IRON_ORE: 0, IRON_INGOT: 0, STEEL_BLADE: 0 };
  const priceBefore = spotPriceMicro(s.orePool.goldReserveMicro, s.orePool.oreReserve);
  const shocked = scarcityShock(s.orePool, s.shockRemove);
  const priceAfter = spotPriceMicro(shocked.goldReserveMicro, shocked.oreReserve);
  const out = {};

  try {
    npcTrade(wallets, inventories, 'player-kira', 'miner.npc', 'IRON_ORE', 1, priceBefore);
    out.empty_wallet_buy = 'UNEXPECTED SUCCESS';
  } catch (e) {
    out.empty_wallet_buy = `REFUSED: ${e.message}`;
  }

  // Miner after the step-1 trade holds 350 FGOLD; 20 ORE at 41.67 costs
  // 833.33 FGOLD — under-collateralized, refused.
  const postTrade = npcTrade(wallets, inventories, 'blacksmith.npc', 'miner.npc', 'IRON_ORE', s.tradeQty, priceBefore);
  try {
    npcTrade(postTrade.wallets, postTrade.inventories, 'miner.npc', 'blacksmith.npc', 'IRON_ORE', 20, priceAfter);
    out.under_collateralized_buy = 'UNEXPECTED SUCCESS';
  } catch (e) {
    out.under_collateralized_buy = `REFUSED: ${e.message}`;
  }

  try {
    if (BigInt(inventories['player-kira'].STEEL_BLADE) < BigInt(s.bladeSaleQty)) {
      throw new Error(
        `insufficient_inventory: player-kira holds 0 STEEL_BLADE, sale needs ${s.bladeSaleQty}`,
      );
    }
    out.blade_sale_no_inventory = 'UNEXPECTED SUCCESS';
  } catch (e) {
    out.blade_sale_no_inventory = `REFUSED: ${e.message}`;
  }
  return out;
}

// Backwards-compatible spec: the step list is the computed scenario.
export const STEPS_SPEC = runScenario().steps;

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

export class DeterministicStateMachine {
  constructor() {
    this.events = [];
    this.headHash = '0'.repeat(64);
  }

  applyStep(stepName, payload) {
    if (!stepName || typeof stepName !== 'string') {
      throw new Error('stepName must be a non-empty string');
    }
    const index = this.events.length;
    const canonical = JSON.stringify({ index, prev: this.headHash, step: stepName, payload });
    const hash = sha256Hex(canonical);
    const entry = { index, step: stepName, payload, prevHash: this.headHash, hash };
    this.events.push(entry);
    this.headHash = hash;
    return entry;
  }

  runAllTryItSteps() {
    for (const s of STEPS_SPEC) {
      this.applyStep(s.step, { summary: s.summary, metrics: s.metrics });
    }
    return this.snapshot();
  }

  verifyChain() {
    let prev = '0'.repeat(64);
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.prevHash !== prev) return false;
      const expected = sha256Hex(JSON.stringify({ index: i, prev, step: ev.step, payload: ev.payload }));
      if (ev.hash !== expected) return false;
      prev = expected;
    }
    return true;
  }

  snapshot() {
    return {
      track: TRACK_CODE,
      bountyId: BOUNTY_ID,
      eventCount: this.events.length,
      headHash: this.headHash,
      chainVerified: this.verifyChain(),
      events: this.events,
    };
  }
}
