// tokenHolders.js — RPC-only Whale Accumulation Tracker (AVICI/MetaDAO compatible)
// Manual decimals only (no auto-detect) for reliability across RPC providers.
// Still includes: Skip wallet automatically if 429s persist for more than X seconds.
// Uses uiAmountString from getTokenLargestAccounts() for stable current balances.

import dotenv from "dotenv";
import readline from "readline";
import { Connection, PublicKey } from "@solana/web3.js";

dotenv.config({ quiet: true });


const RPC_URL = process.env.RPC_URL;
const MINT = process.env.MINT_ADDRESS;
const TOP_N = parseInt(process.env.TOP_N || "25", 10);

if (!RPC_URL || !MINT) {
  console.error("❌ Missing RPC_URL or MINT_ADDRESS in .env");
  process.exit(1);
}

const connection = new Connection(RPC_URL, { commitment: "confirmed" });

console.log("🎯 Mint:", MINT);

let decimalsGlobal = 0;

// ---------------------- utils ----------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function askInput(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// retry wrapper for non-429 errors (used in non-scan areas)
async function rpcCall(fn, ...args) {
  let delay = 250;
  while (true) {
    try {
      return await fn(...args);
    } catch (e) {
      const msg = e?.message || "";
      if (msg.includes("429") || msg.includes("Too Many Requests")) {
        console.log(`⏳ RPC 429, retrying in ${delay}ms...`);
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      } else if (msg.includes("503")) {
        console.log(`⏳ RPC 503, retrying in ${delay}ms...`);
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      } else {
        console.error("❌ RPC error:", e);
        throw e;
      }
    }
  }
}

function parseManualDecimals(input) {
  // Only allow integer decimals 0..18
  // (Most SPL tokens are 0..9, but 18 is safe as an upper bound for validation)
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 18) return null;
  return n;
}

// ---------------------- top holders ----------------------
async function getTopHolders(mint) {
  console.log("📥 Fetching largest token accounts...");

  const mintPk = new PublicKey(mint);
  const largest = await rpcCall(
    connection.getTokenLargestAccounts.bind(connection),
    mintPk
  );

  // NOTE: use uiAmountString for stable "current balance"
  const tokenAccounts = largest.value.slice(0, TOP_N).map((acc) => ({
    tokenAccount: acc.address.toBase58(),
    uiAmountString: acc.uiAmountString ?? null,
    amount: acc.amount, // string fallback
  }));

  console.log("📌 Resolving token account owners...");

  const infos = await rpcCall(
    connection.getMultipleAccountsInfo.bind(connection),
    tokenAccounts.map((t) => new PublicKey(t.tokenAccount))
  );

  const holders = [];

  for (let i = 0; i < tokenAccounts.length; i++) {
    const info = infos[i];
    const ta = tokenAccounts[i].tokenAccount;

    let owner = ta;
    if (info && info.data && info.data.length >= 64) {
      try {
        // SPL Token Account owner is bytes 32..64
        owner = new PublicKey(info.data.slice(32, 64)).toBase58();
      } catch {
        owner = ta;
      }
    }

    // Prefer uiAmountString; fallback to decimalsGlobal if missing
    const uiBal =
      tokenAccounts[i].uiAmountString != null
        ? parseFloat(tokenAccounts[i].uiAmountString)
        : Number(tokenAccounts[i].amount) / 10 ** decimalsGlobal;

    holders.push({
      wallet: owner,
      tokenAccount: ta,
      balanceNow: uiBal,
    });
  }

  return holders;
}

// ---------------------- tx scanning per token account ----------------------
async function getTxsForTokenAccount(tokenAccount, hours, RATE_LIMIT_MAX_SECONDS) {
  const cutoffSec = Math.floor(Date.now() / 1000) - hours * 3600;
  const pubkey = new PublicKey(tokenAccount);

  const startTime = Date.now(); // real clock start

  // Wrapper NEVER resets the timer
  const callWithTimeout = async (fn, ...args) => {
    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;

      // If too long → skip wallet
      if (elapsed >= RATE_LIMIT_MAX_SECONDS) {
        console.log(`⏭️ SKIP ${tokenAccount} — 429s > ${RATE_LIMIT_MAX_SECONDS}s`);
        return null; // SKIP
      }

      try {
        return await fn(...args);
      } catch (e) {
        const msg = e?.message || "";

        if (msg.includes("429") || msg.includes("Too Many Requests")) {
          console.log(`⚠️ ${tokenAccount} 429 after ${elapsed.toFixed(1)}s`);
          await sleep(150);
          continue;
        }

        throw e; // Non-429 error → bubble up
      }
    }
  };

  // 1) Signatures
  const signatures = await callWithTimeout(
    connection.getSignaturesForAddress.bind(connection),
    pubkey,
    { limit: 80 }
  );

  if (!signatures) return []; // wallet skipped entirely

  const relevant = signatures.filter(
    (s) => s.blockTime && s.blockTime >= cutoffSec
  );

  const txs = [];

  // 2) Each transaction fetch
  for (const sig of relevant) {
    const tx = await callWithTimeout(
      connection.getParsedTransaction.bind(connection),
      sig.signature,
      { maxSupportedTransactionVersion: 0 }
    );

    if (!tx) break; // timed out mid-way

    txs.push(tx);
    await sleep(25);
  }

  return txs;
}

// ---------------------- analyze token account flow ----------------------
function analyzeTokenAccountFlow(txs, tokenAccount, mint) {
  let received = 0;
  let sent = 0;

  for (const tx of txs) {
    const meta = tx?.meta;
    const message = tx?.transaction?.message;
    if (!meta || !message) continue;

    const accountKeys = message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey.toBase58()
    );

    const idx = accountKeys.indexOf(tokenAccount);
    if (idx === -1) continue;

    const preEntry = meta.preTokenBalances?.find(
      (b) => b.accountIndex === idx && b.mint === mint
    );
    const postEntry = meta.postTokenBalances?.find(
      (b) => b.accountIndex === idx && b.mint === mint
    );

    const pre = preEntry ? parseFloat(preEntry.uiTokenAmount.uiAmountString || "0") : 0;
    const post = postEntry ? parseFloat(postEntry.uiTokenAmount.uiAmountString || "0") : 0;

    if (post > pre) received += post - pre;
    if (post < pre) sent += pre - post;
  }

  return {
    received,
    sent,
    net: received - sent,
  };
}

// ---------------------- main ----------------------
async function main() {
  // ✅ Manual decimals only (required)
  while (true) {
    const decAns = await askInput("❗ Enter token decimals (required, e.g., 6 or 9): ");
    const parsed = parseManualDecimals(decAns);

    if (parsed == null) {
      console.log("❌ Invalid decimals. Enter an integer between 0 and 18 (example: 6 or 9).");
      continue;
    }

    decimalsGlobal = parsed;
    console.log("🧮 Using manual decimals:", decimalsGlobal);
    break;
  }

  // hours back
  const hoursAns = await askInput("⏱️ Enter number of hours to look back (1, 4, 24): ");
  const hours = parseInt(hoursAns || "1", 10);

  // 429 skip timer
  const max429Ans = await askInput("🚦 Enter max seconds to tolerate 429s before skipping a wallet (e.g., 5): ");
  const RATE_LIMIT_MAX_SECONDS = parseInt(max429Ans || "5", 10);
  console.log(`📛 Any wallet 429'ing for > ${RATE_LIMIT_MAX_SECONDS}s will be skipped.\n`);

  console.log(`📡 Scanning top ${TOP_N} holders of ${MINT} for last ${hours} hours...\n`);

  const holders = await getTopHolders(MINT);

  let totalNet = 0;
  const results = [];

  for (const h of holders) {
    console.log(
      `🐳 Whale wallet: ${h.wallet}\n   Token account: ${h.tokenAccount}\n   Current balance: ${h.balanceNow}`
    );

    const txs = await getTxsForTokenAccount(
      h.tokenAccount,
      hours,
      RATE_LIMIT_MAX_SECONDS
    );

    const analysis = analyzeTokenAccountFlow(txs, h.tokenAccount, MINT);

    totalNet += analysis.net;

    results.push({
      wallet: h.wallet,
      tokenAccount: h.tokenAccount,
      balanceNow: h.balanceNow,
      ...analysis,
    });
  }

  // output results
  console.log("\n==============================");
  console.log(`🐳 Whale Accumulation (Last ${hours} hours)`);
  console.log("==============================");

  results
    .sort((a, b) => b.net - a.net)
    .forEach((r) => {
      console.log(`
Wallet: ${r.wallet}
Token Account: ${r.tokenAccount}
Balance Now: ${r.balanceNow}
Received (${hours}h): ${r.received}
Sent (${hours}h): ${r.sent}
Net Flow (${hours}h): ${r.net}
--------------------------`);
    });

  console.log(`🔥 TOTAL NET FLOW (${hours}h) = ${totalNet}`);

  if (totalNet > 0) console.log("📈 Whales accumulating (bullish)");
  else if (totalNet < 0) console.log("📉 Whales net selling (bearish)");
  else console.log("😐 Whale flow neutral");

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
