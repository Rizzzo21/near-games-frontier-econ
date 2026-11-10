// FRONTIER-ECON on-chain contract (NEAR testnet).
// Minimal NEP-141 fungible token (FGOLD, "Frontier Gold") + a player-owned
// constant-product market for the autonomous NPC economy.
//
// All money math is integer micro-FGOLD (1 FGOLD = 1,000,000 micro units),
// computed with BigInt and stored as decimal strings — no floats, no
// literals. The off-chain engine (src/engine.mjs) runs the identical math,
// so the demo and the chain agree to the micro-unit.
//
// Honest scope: this is a MINIMAL game-economy contract, not a production
// AMM. The scarcity shock is an exogenous demo step (a mine depletes — the
// operator supplies the removed quantity and the contract only does the
// reserve accounting and the price recomputation). NPC wallets are NEP-141
// balance entries in this contract; the three acting NPCs (blacksmith,
// miner, player-kira) are real testnet accounts, the background guild
// wallet is a contract-level balance entry. There is no ft_transfer_call
// and no cross-contract call in this minimal FT.
import { NearBindgen, near, call, view } from 'near-sdk-js';

const SCALE = 1000000n; // micro-FGOLD per FGOLD
const LP_FEE_BPS = 200n; // 2% LP fee on player sales
const BPS_DENOM = 10000n;
const TOTAL_MINT_MICRO = '20000000000'; // 20,000 FGOLD
const MIN_STORAGE_DEPOSIT = 1000000000000000000000n; // 0.001 NEAR

@NearBindgen({})
class FrontierEcon {
  constructor() {
    this.owner = '';
    this.initialized = false;
    this.total_supply_micro = '0';
    this.balances = {}; // account_id -> FGOLD balance (micro, as string)
    this.npc_accounts = []; // account_ids funded via fund_npc (NPC supply set)
    this.storage_balances = {}; // account_id -> deposited yoctoNEAR (string)
    this.inventories = {}; // account_id -> { item: qty (string) }
    this.ore_reserve = '0'; // IRON_ORE units in the pool
    this.ore_gold_micro = '0'; // FGOLD (micro) held by the ore pool
    this.blade_reserve = '0'; // STEEL_BLADE units in the pool
    this.blade_gold_micro = '0'; // FGOLD (micro) held by the blade pool
    this.lp_fees_micro = '0'; // LP fees collected (micro)
    this.flow_events = []; // append-only log of flow steps, capped at 50
  }

  _log(step, detail) {
    this.flow_events.push({ step, ...detail });
    if (this.flow_events.length > 50) this.flow_events.shift();
  }

  _requireOwner() {
    if (near.predecessorAccountId() !== this.owner) {
      throw new Error('owner_only');
    }
  }

  _bal(accountId) {
    return BigInt(this.balances[accountId] || '0');
  }

  _setBal(accountId, amount) {
    this.balances[accountId] = amount.toString();
  }

  _inv(accountId, item) {
    return BigInt((this.inventories[accountId] || {})[item] || '0');
  }

  _setInv(accountId, item, qty) {
    if (!this.inventories[accountId]) this.inventories[accountId] = {};
    this.inventories[accountId][item] = qty.toString();
  }

  _orePriceMicro() {
    const ore = BigInt(this.ore_reserve);
    if (ore <= 0n) throw new Error('empty_ore_pool');
    return BigInt(this.ore_gold_micro) / ore;
  }

  // ---- views ----

  @view({})
  ft_total_supply({}) {
    return this.total_supply_micro;
  }

  @view({})
  ft_balance_of({ account_id }) {
    return { account_id, balance: this._bal(account_id).toString() };
  }

  @view({})
  ft_metadata({}) {
    return {
      spec: 'ft-1.0.0',
      name: 'Frontier Gold',
      symbol: 'FGOLD',
      icon: null,
      reference: null,
      reference_hash: null,
      decimals: 6,
    };
  }

  @view({})
  storage_balance_of({ account_id }) {
    return {
      total: this.storage_balances[account_id] || '0',
      available: this.storage_balances[account_id] || '0',
    };
  }

  // Current pool prices, computed on-chain from live reserves.
  @view({})
  get_price({}) {
    const orePrice = this._orePriceMicro();
    const blade = BigInt(this.blade_reserve);
    const bladePrice = blade > 0n ? BigInt(this.blade_gold_micro) / blade : 0n;
    return {
      ore_price_micro: orePrice.toString(),
      ore_price_fgold: (Number(orePrice) / 1e6).toFixed(2),
      blade_price_micro: bladePrice.toString(),
      blade_price_fgold: (Number(bladePrice) / 1e6).toFixed(2),
      ore_reserve: this.ore_reserve,
      blade_reserve: this.blade_reserve,
    };
  }

  @view({})
  get_state({}) {
    let npcSupply = 0n;
    for (const id of this.npc_accounts) npcSupply += this._bal(id);
    return {
      owner: this.owner,
      total_supply_micro: this.total_supply_micro,
      npc_supply_micro: npcSupply.toString(),
      ore_reserve: this.ore_reserve,
      ore_gold_micro: this.ore_gold_micro,
      blade_reserve: this.blade_reserve,
      blade_gold_micro: this.blade_gold_micro,
      lp_fees_micro: this.lp_fees_micro,
      ore_price_micro: this.ore_reserve === '0' ? '0' : this._orePriceMicro().toString(),
    };
  }

  @view({})
  get_npc({ account_id }) {
    return {
      account_id,
      balance_micro: this._bal(account_id).toString(),
      inventory: this.inventories[account_id] || {},
    };
  }

  @view({})
  get_events({}) {
    return this.flow_events;
  }

  // ---- setup (owner only) ----

  // One-time init: names the owner and mints the whole 20,000 FGOLD supply
  // to the owner. NPC wallets and pools are seeded by the owner afterwards.
  @call({})
  init({ owner_id }) {
    if (this.initialized) throw new Error('already_initialized');
    if (!owner_id || typeof owner_id !== 'string') throw new Error('owner_id required');
    this.owner = owner_id;
    this.initialized = true;
    this.total_supply_micro = TOTAL_MINT_MICRO;
    this._setBal(owner_id, BigInt(TOTAL_MINT_MICRO));
    this.storage_balances[owner_id] = '0';
    this._log('init', { owner_id, total_supply_micro: TOTAL_MINT_MICRO });
    return { owner_id, total_supply_micro: TOTAL_MINT_MICRO };
  }

  @call({ payableFunction: true })
  storage_deposit({ account_id }) {
    const accountId = account_id || near.predecessorAccountId();
    if (near.attachedDeposit() < MIN_STORAGE_DEPOSIT) {
      throw new Error('insufficient_storage_deposit');
    }
    const prev = BigInt(this.storage_balances[accountId] || '0');
    this.storage_balances[accountId] = (prev + near.attachedDeposit()).toString();
    return {
      total: this.storage_balances[accountId],
      available: this.storage_balances[accountId],
    };
  }

  // Fund an NPC wallet from the owner's balance (registers the account).
  @call({})
  fund_npc({ account_id, amount_micro }) {
    this._requireOwner();
    const amount = BigInt(amount_micro);
    if (amount <= 0n) throw new Error('amount_micro must be positive');
    if (this._bal(this.owner) < amount) throw new Error('insufficient_owner_balance');
    this._setBal(this.owner, this._bal(this.owner) - amount);
    this._setBal(account_id, this._bal(account_id) + amount);
    if (!this.npc_accounts.includes(account_id)) this.npc_accounts.push(account_id);
    if (!this.storage_balances[account_id]) this.storage_balances[account_id] = '0';
    this._log('fund_npc', { account_id, amount_micro: amount.toString() });
    return { account_id, balance_micro: this._bal(account_id).toString() };
  }

  // Seed the two pools from the owner's balance: ore pool 100 ORE / 2,500
  // FGOLD (price 25.00), blade pool 100 BLADE / 8,000 FGOLD (price 80.00).
  @call({})
  seed_pools({}) {
    this._requireOwner();
    const oreGold = 2500000000n;
    const bladeGold = 8000000000n;
    if (this._bal(this.owner) < oreGold + bladeGold) {
      throw new Error('insufficient_owner_balance');
    }
    this._setBal(this.owner, this._bal(this.owner) - oreGold - bladeGold);
    this.ore_reserve = '100';
    this.ore_gold_micro = oreGold.toString();
    this.blade_reserve = '100';
    this.blade_gold_micro = bladeGold.toString();
    this._log('seed_pools', { ore_reserve: '100', ore_gold_micro: oreGold.toString(), blade_reserve: '100', blade_gold_micro: bladeGold.toString() });
    return { ore_reserve: this.ore_reserve, blade_reserve: this.blade_reserve };
  }

  // Grant crafted items to a wallet (owner only — the game operator credits
  // a player's crafting output).
  @call({})
  grant_item({ account_id, item, qty }) {
    this._requireOwner();
    const q = BigInt(qty);
    if (q <= 0n) throw new Error('qty must be positive');
    this._setInv(account_id, item, this._inv(account_id, item) + q);
    this._log('grant_item', { account_id, item, qty: q.toString() });
    return { account_id, item, qty: this._inv(account_id, item).toString() };
  }

  // ---- NEP-141 transfer ----

  @call({ payableFunction: true })
  ft_transfer({ receiver_id, amount, memo }) {
    if (near.attachedDeposit() < 1n) throw new Error('ft_transfer requires 1 yoctoNEAR attached');
    const sender = near.predecessorAccountId();
    const amt = BigInt(amount);
    if (amt <= 0n) throw new Error('amount must be positive');
    if (!this.storage_balances[receiver_id]) throw new Error('receiver_not_registered');
    if (this._bal(sender) < amt) throw new Error('insufficient_balance');
    this._setBal(sender, this._bal(sender) - amt);
    this._setBal(receiver_id, this._bal(receiver_id) + amt);
    this._log('ft_transfer', { sender, receiver_id, amount: amt.toString(), memo: memo || null });
    return { sender, receiver_id, amount: amt.toString() };
  }

  // ---- economy ----

  // NPC-to-NPC trade at the pool's quoted ore price. The buyer is the
  // caller, unless buyer_id is given — then the caller must be the owner
  // (the game operator executing an NPC tick for a registered NPC wallet).
  // Refuses an empty wallet (insufficient_balance) and a seller without
  // the item (insufficient_inventory).
  @call({})
  npc_trade({ seller_id, item, qty, buyer_id }) {
    const caller = near.predecessorAccountId();
    let buyer = caller;
    if (buyer_id) {
      this._requireOwner();
      buyer = buyer_id;
    }
    if (item !== 'IRON_ORE') throw new Error('only_IRON_ORE_trades_in_this_demo');
    const q = BigInt(qty);
    if (q <= 0n) throw new Error('qty must be positive');
    const unitPrice = this._orePriceMicro();
    const cost = q * unitPrice;
    if (this._bal(buyer) < cost) {
      throw new Error(
        `insufficient_balance: ${buyer} holds ${this._bal(buyer)} micro-FGOLD, trade costs ${cost} micro-FGOLD`,
      );
    }
    if (this._inv(seller_id, item) < q) {
      throw new Error(`insufficient_inventory: ${seller_id} holds ${this._inv(seller_id, item)} ${item}, trade needs ${q}`);
    }
    this._setBal(buyer, this._bal(buyer) - cost);
    this._setBal(seller_id, this._bal(seller_id) + cost);
    this._setInv(buyer, item, this._inv(buyer, item) + q);
    this._setInv(seller_id, item, this._inv(seller_id, item) - q);
    this._log('npc_trade', { buyer, seller_id, item, qty: q.toString(), unit_price_micro: unitPrice.toString(), cost_micro: cost.toString() });
    return {
      buyer,
      seller_id,
      unit_price_micro: unitPrice.toString(),
      cost_micro: cost.toString(),
      buyer_balance_micro: this._bal(buyer).toString(),
      seller_balance_micro: this._bal(seller_id).toString(),
    };
  }

  // Scarcity shock (owner only): a mine depletes, removing `remove_qty`
  // ORE units from the pool. The gold reserve is untouched, so the
  // constant-product price moves endogenously (2,500 / 60 = 41.67 FGOLD).
  @call({})
  scarcity_shock({ remove_qty }) {
    this._requireOwner();
    const ore = BigInt(this.ore_reserve) - BigInt(remove_qty);
    if (ore <= 0n) throw new Error('shock_empties_pool');
    this.ore_reserve = ore.toString();
    const newPrice = this._orePriceMicro();
    this._log('scarcity_shock', { removed: String(remove_qty), ore_reserve: this.ore_reserve, new_price_micro: newPrice.toString() });
    return { ore_reserve: this.ore_reserve, new_price_micro: newPrice.toString() };
  }

  // Player sells `qty` STEEL_BLADE into the blade pool. Constant-product
  // payout minus the 2% LP fee, all computed on-chain. Refuses a player
  // with no blades in inventory.
  @call({})
  sell_blades({ qty }) {
    const caller = near.predecessorAccountId();
    const q = BigInt(qty);
    if (q <= 0n) throw new Error('qty must be positive');
    if (this._inv(caller, 'STEEL_BLADE') < q) {
      throw new Error(`insufficient_inventory: ${caller} holds ${this._inv(caller, 'STEEL_BLADE')} STEEL_BLADE, sale needs ${q}`);
    }
    const r = BigInt(this.blade_reserve);
    const g = BigInt(this.blade_gold_micro);
    const k = r * g;
    const newGold = k / (r + q);
    const gross = g - newGold;
    const fee = (gross * LP_FEE_BPS) / BPS_DENOM;
    const net = gross - fee;
    this.blade_reserve = (r + q).toString();
    this.blade_gold_micro = newGold.toString();
    this.lp_fees_micro = (BigInt(this.lp_fees_micro) + fee).toString();
    this._setInv(caller, 'STEEL_BLADE', this._inv(caller, 'STEEL_BLADE') - q);
    this._setBal(caller, this._bal(caller) + net);
    this._log('sell_blades', { seller: caller, qty: q.toString(), gross_micro: gross.toString(), fee_micro: fee.toString(), net_micro: net.toString() });
    return {
      seller: caller,
      gross_micro: gross.toString(),
      fee_micro: fee.toString(),
      net_micro: net.toString(),
      blade_reserve: this.blade_reserve,
    };
  }
}
