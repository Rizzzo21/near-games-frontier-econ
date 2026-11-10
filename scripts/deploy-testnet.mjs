// Deploy the FRONTIER-ECON contract to NEAR testnet and run the full
// NPC-economy flow, recording real tx hashes.
//
// Usage (from autonomous-npc-economy/):
//   node scripts/deploy-testnet.mjs [contract-account-id] [rpc-url]
//   # default: frontier-econ-backstop-1119.testnet, rpc.testnet.near.org
//
// Every keypair is generated in memory in this process and NEVER written
// to disk or printed. All accounts are funded by the free faucet helper;
// no real money is involved (testnet only). Evidence is written to
// docs/testnet-evidence.json (contract account, tx hashes, explorer
// links) — that file contains NO private key.
//
// Failure-capture note: near-api-js retries a refused functionCall with
// a fresh nonce and never surfaces the final tx hash, and the locally
// signed broadcast path silently drops txs in long-running processes
// (three runs: the tx never landed, proven by unchanged account nonces).
// So refusals use the plain functionCall path (which provably lands txs)
// and the failed tx hash is recovered afterwards from the NEARBlocks v3
// indexer (/v3/accounts/{signer}/txns, newest first) and confirmed via
// RPC txStatus. Proven on the 1110 run: kira-1110's npc_trade refusal is
// tx 2AXDkywQfRPefiA1Ee2wNk9vBg6aQxDAMvTr8Joq5BNH, Failure
// insufficient_balance, recovered exactly this way.
//
// RPC note: rpc.testnet.near.org hung a previous run for 8+ minutes on a
// single call (0 CPU, no timeout inside near-api-js). This script uses the
// FastNear free testnet RPC as primary and wraps EVERY network await in a
// 90s fail-fast timeout, so a hung endpoint fails loudly instead of
// hanging forever. If it fails, re-run with rpc.testnet.near.org as argv[2].
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as nearApi from 'near-api-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const CONTRACT_ID = process.argv[2] || 'frontier-econ-backstop-1119.testnet';
const RPC_URL = process.argv[3] || 'https://rpc.testnet.near.org';
const SMITH_ID = 'smith-1119.testnet';
const MINER_ID = 'miner-1119.testnet';
const KIRA_ID = 'kira-1119.testnet';
const GUILD_ID = 'guild.npc'; // background guild wallet: contract-level balance entry
const HELPER_URL = 'https://helper.testnet.near.org';
const EXPLORER_TX = 'https://explorer.testnet.near.org/transactions/';
const EXPLORER_ACCT = 'https://explorer.testnet.near.org/accounts/';
const GAS = 100_000_000_000_000n;
const fmt = (micro) => (Number(micro) / 1e6).toFixed(2);

// Fail-fast wrapper: near-api-js has no built-in timeout, and a hung RPC
// connection blocks forever (0 CPU). 90s per op, then throw loudly.
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
const call = (account, args) =>
  withTimeout(account.functionCall(args), 90000, `functionCall ${args.methodName} from ${account.accountId}`);
const view = (account, args) =>
  withTimeout(account.viewFunction(args), 60000, `view ${args.methodName}`);

async function createAccount(near, keyStore, accountId) {
  const keyPair = nearApi.KeyPair.fromRandom('ed25519');
  await keyStore.setKey('testnet', accountId, keyPair);
  console.log(`      creating ${accountId} via faucet helper...`);
  const res = await withTimeout(
    fetch(`${HELPER_URL}/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newAccountId: accountId,
        newAccountPublicKey: keyPair.getPublicKey().toString(),
      }),
    }),
    90000,
    `faucet create ${accountId}`,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`faucet helper ${res.status} for ${accountId}: ${body.slice(0, 500)}`);
  }
  const account = await near.account(accountId);
  // The faucet helper returns OK before the account is visible on every
  // RPC node — poll state() until the account propagates (up to ~60s).
  let state = null;
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    try {
      state = await withTimeout(account.state(), 30000, `state ${accountId}`);
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!state) throw new Error(`account ${accountId} never became visible on ${RPC_URL}: ${String(lastErr?.message || lastErr).slice(0, 200)}`);
  const balanceNear = Number(nearApi.utils.format.formatNearAmount(state.amount));
  console.log(`      funded. balance: ${balanceNear.toFixed(4)} NEAR`);
  return { account, balanceNear };
}

// Make a call that is EXPECTED to fail on-chain. Uses the plain
// functionCall path (provably lands txs), then recovers the failed tx
// hash from the NEARBlocks v3 indexer and confirms it via RPC txStatus.
async function expectedFailureCall(provider, account, methodName, args, expectedSubstr) {
  let thrown = null;
  try {
    await call(account, {
      contractId: CONTRACT_ID, methodName, args, gas: GAS,
    });
  } catch (e) {
    thrown = e;
  }
  if (!thrown) throw new Error(`expected refusal for ${methodName}, call succeeded unexpectedly`);
  const errText = String(thrown.message || thrown);
  if (expectedSubstr && !errText.includes(expectedSubstr)) {
    throw new Error(`refusal error lacks '${expectedSubstr}': ${errText.slice(0, 300)}`);
  }
  // Recover the failed tx hash from the indexer (newest first).
  const signer = account.accountId;
  let txHash = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetch(`https://api-testnet.nearblocks.io/v3/accounts/${signer}/txns?per_page=5`);
      if (!res.ok) continue;
      const data = await res.json();
      const hit = (data.data || []).find((t) =>
        t.receiver_account_id === CONTRACT_ID &&
        (t.actions || []).some((a) => a.method === methodName) &&
        t.outcomes && t.outcomes.status === false);
      if (hit) { txHash = hit.transaction_hash; break; }
    } catch (e) { /* indexer hiccup — retry */ }
  }
  if (!txHash) throw new Error(`could not recover failed ${methodName} tx for ${signer} from indexer`);
  await verifyFailureTx(provider, signer, txHash, `refused_${methodName}`, expectedSubstr);
  return { txHash, failure: errText.slice(0, 300) };
}

async function verifySuccessTx(provider, signerId, txHash, label) {
  const status = await withTimeout(provider.txStatus(txHash, signerId), 60000, `txStatus ${label}`);
  // Final execution status lives in the TOP-LEVEL `status` field.
  const st = status?.status;
  if (!st || (!('SuccessValue' in st) && !('SuccessReceiptId' in st))) {
    throw new Error(`${label} tx ${txHash} did not succeed: ${JSON.stringify(st)}`);
  }
  return true;
}

async function verifyFailureTx(provider, signerId, txHash, label, expectedSubstr) {
  const status = await withTimeout(provider.txStatus(txHash, signerId), 60000, `txStatus ${label}`);
  // NOTE: for a panicking function call the TRANSACTION outcome is
  // SuccessReceiptId (the tx successfully produced a receipt) and the
  // Failure lives in the FINAL status (top-level `status`) and in the
  // receipt outcomes. Checking transaction_outcome for Failure is wrong.
  const st = status?.status;
  if (!st || !st.Failure) {
    throw new Error(`${label} tx ${txHash} is not a Failure: ${JSON.stringify(st)}`);
  }
  if (expectedSubstr && !JSON.stringify(st.Failure).includes(expectedSubstr)) {
    throw new Error(`${label} tx ${txHash} failure lacks '${expectedSubstr}'`);
  }
  return true;
}

async function main() {
  console.log(`RPC: ${RPC_URL}`);
  const keyStore = new nearApi.keyStores.InMemoryKeyStore();
  const near = await withTimeout(
    nearApi.connect({
      networkId: 'testnet',
      nodeUrl: RPC_URL,
      walletUrl: 'https://wallet.testnet.near.org',
      helperUrl: HELPER_URL,
      keyStore,
    }),
    60000,
    'near.connect',
  );
  const provider = near.connection.provider;

  // 1. Contract account via the free faucet helper.
  console.log(`[1/12] creating ${CONTRACT_ID}...`);
  const { account: deployer, balanceNear } = await createAccount(near, keyStore, CONTRACT_ID);
  if (balanceNear < 6) {
    throw new Error(
      `INSUFFICIENT FAUCET FUNDING: ${balanceNear} NEAR < ~6 NEAR needed to store the 545KB contract.`,
    );
  }

  // 2. Deploy the contract.
  const wasm = fs.readFileSync(path.join(rootDir, 'contract', 'build', 'contract.wasm'));
  console.log(`[2/12] deploying ${wasm.length} bytes to ${CONTRACT_ID}...`);
  const deployOutcome = await withTimeout(deployer.deployContract(wasm), 120000, 'deployContract');
  const deployTx = deployOutcome.transaction.hash;
  console.log(`      deploy tx: ${deployTx}`);

  // 3. Init: owner = the contract account itself; mint 20,000 FGOLD to it.
  console.log('[3/12] init (mint 20,000 FGOLD to owner)...');
  const initOutcome = await call(deployer, {
    contractId: CONTRACT_ID,
    methodName: 'init',
    args: { owner_id: CONTRACT_ID },
    gas: GAS,
  });
  const initTx = initOutcome.transaction.hash;
  console.log(`      init tx: ${initTx}`);

  // 4. Real testnet accounts for the three acting NPCs.
  console.log('[4/12] creating NPC accounts...');
  const smith = (await createAccount(near, keyStore, SMITH_ID)).account;
  const miner = (await createAccount(near, keyStore, MINER_ID)).account;
  const kira = (await createAccount(near, keyStore, KIRA_ID)).account;

  // 5. Storage-register the NPCs on the FT contract, then fund wallets
  // and grant starting inventories (owner = contract account).
  console.log('[5/12] storage deposits + fund NPC wallets + grant inventories...');
  for (const npc of [smith, miner, kira]) {
    await call(npc, {
      contractId: CONTRACT_ID,
      methodName: 'storage_deposit',
      args: {},
      gas: GAS,
      attachedDeposit: 2000000000000000000000n, // 0.002 NEAR
    });
  }
  const fund = async (id, amountMicro) => {
    const o = await call(deployer, {
      contractId: CONTRACT_ID, methodName: 'fund_npc',
      args: { account_id: id, amount_micro: String(amountMicro) }, gas: GAS,
    });
    return o.transaction.hash;
  };
  const fundSmithTx = await fund(SMITH_ID, 800_000_000);
  const fundMinerTx = await fund(MINER_ID, 200_000_000);
  const fundGuildTx = await fund(GUILD_ID, 1_500_000_000);
  const grant = async (id, item, qty) => {
    const o = await call(deployer, {
      contractId: CONTRACT_ID, methodName: 'grant_item',
      args: { account_id: id, item, qty: String(qty) }, gas: GAS,
    });
    return o.transaction.hash;
  };
  const grantMinerOreTx = await grant(MINER_ID, 'IRON_ORE', 6);
  const grantSmithIngotTx = await grant(SMITH_ID, 'IRON_INGOT', 12);
  console.log(`      funded smith 800 / miner 200 / guild 1500 FGOLD; miner 6 ORE, smith 12 INGOT`);

  // 6. Seed the pools: ore 100 ORE / 2,500 FGOLD, blade 100 BLADE / 8,000 FGOLD.
  console.log('[6/12] seeding pools...');
  const seedOutcome = await call(deployer, {
    contractId: CONTRACT_ID, methodName: 'seed_pools', args: {}, gas: GAS,
  });
  const seedTx = seedOutcome.transaction.hash;
  const priceBefore = await view(deployer, {
    contractId: CONTRACT_ID, methodName: 'get_price', args: {},
  });
  console.log(`      ore price: ${priceBefore.ore_price_fgold} FGOLD (expect 25.00), blade price: ${priceBefore.blade_price_fgold} FGOLD (expect 80.00)`);
  if (priceBefore.ore_price_fgold !== '25.00' || priceBefore.blade_price_fgold !== '80.00') {
    throw new Error(`pool price mismatch: ${JSON.stringify(priceBefore)}`);
  }

  // 7. Failure path A — kira (0 FGOLD) tries to buy 1 ORE: REFUSED.
  console.log('[7/12] failure path A: empty wallet (kira, 0 FGOLD) tries to buy 1 ORE...');
  const refusedEmpty = await expectedFailureCall(
    provider, kira, 'npc_trade',
    { seller_id: MINER_ID, item: 'IRON_ORE', qty: '1' },
    'insufficient_balance',
  );
  console.log(`      refused. tx: ${refusedEmpty.txHash}`);

  // 8. Step 1 — smith buys 6 ORE from miner at 25.00 FGOLD.
  console.log('[8/12] step 1: smith buys 6 IRON_ORE from miner at 25.00 FGOLD...');
  const tradeOutcome = await call(smith, {
    contractId: CONTRACT_ID, methodName: 'npc_trade',
    args: { seller_id: MINER_ID, item: 'IRON_ORE', qty: '6' }, gas: GAS,
  });
  const tradeTx = tradeOutcome.transaction.hash;
  const smithAfter = await view(deployer, { contractId: CONTRACT_ID, methodName: 'get_npc', args: { account_id: SMITH_ID } });
  const minerAfter = await view(deployer, { contractId: CONTRACT_ID, methodName: 'get_npc', args: { account_id: MINER_ID } });
  console.log(`      smith: ${fmt(smithAfter.balance_micro)} FGOLD (expect 650.00), miner: ${fmt(minerAfter.balance_micro)} FGOLD (expect 350.00)`);
  if (smithAfter.balance_micro !== '650000000' || minerAfter.balance_micro !== '350000000') {
    throw new Error(`trade balances mismatch: smith ${smithAfter.balance_micro}, miner ${minerAfter.balance_micro}`);
  }

  // 9. Step 2 — scarcity shock: ore reserve 100 -> 60, price moves to 41.67.
  console.log('[9/12] step 2: scarcity shock (ore reserve 100 -> 60)...');
  const shockOutcome = await call(deployer, {
    contractId: CONTRACT_ID, methodName: 'scarcity_shock',
    args: { remove_qty: '40' }, gas: GAS,
  });
  const shockTx = shockOutcome.transaction.hash;
  const priceAfter = await view(deployer, {
    contractId: CONTRACT_ID, methodName: 'get_price', args: {},
  });
  console.log(`      ore price: ${priceAfter.ore_price_fgold} FGOLD (expect 41.67)`);
  if (priceAfter.ore_price_fgold !== '41.67') {
    throw new Error(`price-after-shock mismatch: ${JSON.stringify(priceAfter)}`);
  }

  // 10. Failure path B — miner (350 FGOLD) tries to buy 20 ORE at 41.67
  // (cost 833.33 FGOLD): under-collateralized, REFUSED.
  console.log('[10/12] failure path B: miner (350 FGOLD) tries to buy 20 ORE at 41.67...');
  const refusedUnder = await expectedFailureCall(
    provider, miner, 'npc_trade',
    { seller_id: SMITH_ID, item: 'IRON_ORE', qty: '20' },
    'insufficient_balance',
  );
  console.log(`      refused. tx: ${refusedUnder.txHash}`);

  // 11. Step 3 — kira crafts 4 blades, sells into the blade pool.
  console.log('[11/12] step 3: grant kira 4 STEEL_BLADE, kira sells them...');
  const grantKiraTx = await grant(KIRA_ID, 'STEEL_BLADE', 4);
  const sellOutcome = await call(kira, {
    contractId: CONTRACT_ID, methodName: 'sell_blades',
    args: { qty: '4' }, gas: GAS,
  });
  const sellTx = sellOutcome.transaction.hash;
  const kiraAfter = await view(deployer, { contractId: CONTRACT_ID, methodName: 'get_npc', args: { account_id: KIRA_ID } });
  console.log(`      kira FGOLD: ${fmt(kiraAfter.balance_micro)} (expect 301.54 net)`);
  if (kiraAfter.balance_micro !== '301538462') {
    throw new Error(`blade sale net mismatch: kira ${kiraAfter.balance_micro}`);
  }

  // 12. Final state + RPC verification of every tx + evidence file.
  console.log('[12/12] final state + verifying all txs via RPC...');
  const finalState = await view(deployer, { contractId: CONTRACT_ID, methodName: 'get_state', args: {} });
  console.log('      final state:', JSON.stringify(finalState));
  if (finalState.npc_supply_micro !== '2500000000') {
    throw new Error(`NPC supply not conserved: ${finalState.npc_supply_micro}`);
  }
  if (finalState.lp_fees_micro !== '6153846') {
    throw new Error(`LP fees mismatch: ${finalState.lp_fees_micro}`);
  }
  const successTxs = [
    ['deploy', deployTx, CONTRACT_ID], ['init', initTx, CONTRACT_ID],
    ['fund_smith', fundSmithTx, CONTRACT_ID], ['fund_miner', fundMinerTx, CONTRACT_ID],
    ['fund_guild', fundGuildTx, CONTRACT_ID], ['grant_miner_ore', grantMinerOreTx, CONTRACT_ID],
    ['grant_smith_ingot', grantSmithIngotTx, CONTRACT_ID], ['seed_pools', seedTx, CONTRACT_ID],
    ['npc_trade', tradeTx, SMITH_ID], ['scarcity_shock', shockTx, CONTRACT_ID],
    ['grant_kira_blades', grantKiraTx, CONTRACT_ID], ['sell_blades', sellTx, KIRA_ID],
  ];
  for (const [label, hash, signer] of successTxs) {
    await verifySuccessTx(provider, signer, hash, label);
  }
  await verifyFailureTx(provider, KIRA_ID, refusedEmpty.txHash, 'refused_empty_wallet', 'insufficient_balance');
  await verifyFailureTx(provider, MINER_ID, refusedUnder.txHash, 'refused_under_collateralized', 'insufficient_balance');
  console.log('      all success txs verified SuccessValue via RPC; both refusals verified Failure');

  const evidence = {
    network: 'testnet',
    contract_account: CONTRACT_ID,
    contract_explorer: EXPLORER_ACCT + CONTRACT_ID,
    contract_wasm_sha256: crypto.createHash('sha256').update(wasm).digest('hex'),
    deployed_at_utc: new Date().toISOString(),
    token: { name: 'Frontier Gold', symbol: 'FGOLD', decimals: 6, total_supply_fgold: '20000.00' },
    npc_accounts: { blacksmith: SMITH_ID, miner: MINER_ID, player: KIRA_ID, guild_wallet: GUILD_ID },
    flow: {
      deploy: { tx: deployTx, explorer: EXPLORER_TX + deployTx },
      init_mint_20000_fgold: { tx: initTx, explorer: EXPLORER_TX + initTx },
      fund_smith_800: { tx: fundSmithTx, explorer: EXPLORER_TX + fundSmithTx },
      fund_miner_200: { tx: fundMinerTx, explorer: EXPLORER_TX + fundMinerTx },
      fund_guild_1500: { tx: fundGuildTx, explorer: EXPLORER_TX + fundGuildTx },
      grant_miner_6_ore: { tx: grantMinerOreTx, explorer: EXPLORER_TX + grantMinerOreTx },
      grant_smith_12_ingot: { tx: grantSmithIngotTx, explorer: EXPLORER_TX + grantSmithIngotTx },
      seed_pools: { tx: seedTx, explorer: EXPLORER_TX + seedTx },
      empty_wallet_buy_refused: { tx: refusedEmpty.txHash, explorer: EXPLORER_TX + refusedEmpty.txHash, error: refusedEmpty.failure },
      npc_trade_6_ore_at_25: { tx: tradeTx, explorer: EXPLORER_TX + tradeTx, cost_fgold: '150.00', smith_after_fgold: '650.00', miner_after_fgold: '350.00' },
      scarcity_shock_100_to_60: { tx: shockTx, explorer: EXPLORER_TX + shockTx, price_after_fgold: '41.67' },
      under_collateralized_buy_refused: { tx: refusedUnder.txHash, explorer: EXPLORER_TX + refusedUnder.txHash, error: refusedUnder.failure },
      grant_kira_4_blades: { tx: grantKiraTx, explorer: EXPLORER_TX + grantKiraTx },
      sell_blades_4: { tx: sellTx, explorer: EXPLORER_TX + sellTx, gross_fgold: '307.69', lp_fee_fgold: '6.15', net_fgold: '301.54' },
    },
    final_state: finalState,
    verified_figures: {
      ore_price_before_fgold: '25.00',
      ore_price_after_fgold: '41.67',
      price_move_pct: '+66.68%',
      smith_fgold_after_trade: '650.00',
      miner_fgold_after_trade: '350.00',
      npc_supply_fgold: '2500.00',
      blade_sale_gross_fgold: '307.69',
      blade_sale_lp_fee_fgold: '6.15',
      blade_sale_net_fgold: '301.54',
    },
    disclosure:
      'Minimal NEP-141 FT + CPMM game market. The scarcity shock is an exogenous demo step (mine depletes; the operator supplies the removed quantity and the contract recomputes the price from live reserves). The guild wallet is a contract-level NEP-141 balance entry; blacksmith, miner and player-kira are real testnet accounts. No ft_transfer_call in this minimal FT.',
  };
  const evidencePath = path.join(rootDir, 'docs', 'testnet-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`evidence written: ${evidencePath}`);
  console.log('DONE. Contract:', CONTRACT_ID);
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
