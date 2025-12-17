# Solana Token Holder Distribution Tracker

An RPC-only Node.js tool for analyzing **top SPL token holders** on Solana and measuring their **token distribution, accumulation, or selling activity** over a configurable lookback window.

This project identifies the largest token accounts for a given mint, resolves their owner wallets, scans recent on-chain transactions, and computes **received, sent, and net token flow** per holder. It is designed to work with **any SPL token** on Solana using standard RPC methods only.

---

## What this tool does

For a given SPL token mint, the tracker:

1. Fetches the **top N largest token accounts** using Solana RPC
2. Resolves each token account’s **owner wallet**
3. Scans recent transactions for each token account
4. Compares pre- and post-transaction balances
5. Computes:
   - Tokens received
   - Tokens sent
   - Net flow (accumulation vs distribution)
6. Aggregates total whale activity across all tracked holders

The tool includes **rate-limit protection** and will automatically skip wallets that hit persistent RPC 429 errors, allowing the scan to continue without failing.

---

## Key features

- Works with **any SPL token** on Solana
- **RPC-only** (no indexers or proprietary APIs required)
- Tracks **top holder distribution over time**
- Calculates **received, sent, and net flow**
- Manual token decimals for consistent accuracy across RPC providers
- Automatic skip logic for wallets that exceed RPC rate limits
- Clear terminal output suitable for analysis or screenshots
  
---

Positive net flow indicates **accumulation**, while negative net flow indicates **distribution**.

---

## 🔧 Running Locally

This project is a command-line tool and is intended to be run locally using Node.js.

### Prerequisites
- Node.js 18+
- A Solana RPC endpoint (Helius, QuickNode, Alchemy, etc.)

## 1. Clone the repository
git clone https://github.com/<your-username>/solana-token-holder-distribution-tracker.git
cd solana-token-holder-distribution-tracker

## 2. Install dependencies
npm install

## 3. Configure environment variables
Create a .env from the example:
cp .env.example .env

## Edit the .env and provide:
- RPC_URL: your Solana RPC endpoint
- MINT_ADDRESS: the SPL token mint to analyze
- TOP_N:  the number of top holders to scan

## 4. Run the tracker
npm start

You will be prompted to enter:
- Token decimals
- Lookback window (in hours)
- Maximum time to tolerate RPC rate limits before skipping a wallet (in seconds)

## Technical Notes:
- Uses getTokenLargestAccounts to identify top holders at runtime
- Resolves token account owners directly from account data
- Analyzes token flow via parsed transaction pre/post balances
- Uses uiAmountString when available for stable balance reporting
- Designed to remain functional even under RPC rate limiting

## Limitations
- Only analyzes transactions available via the connected RPC provider
- Very old or pruned transactions may not be returned
- Results reflect token account activity, not aggregated wallet history
- Intended for analytical and educational use only








