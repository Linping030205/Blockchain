# Vacation Property Tokenisation — Smart Contract System

UCL IFTE0007 Blockchain — Individual Coursework

## Overview

This project implements a blockchain-based fractional ownership system for vacation property. Six Solidity smart contracts map directly to the theoretical design in report sections §3 and §4:

| Contract | Report Section | Purpose |
|---|---|---|
| `VacationToken` | §3.1, §3.4, §3.5 | ERC-20 FT, fixed supply, locking |
| `AllocationManager` | §3.3 (allocation layer) | Periodic yield / usage mode selection |
| `UsageManager` | §3.2, §3.3 (dynamic pricing), §3.6 | Time-slot booking, token locking |
| `RevenueVault` | §3.2, §4.5 | Rental income distribution |
| `RedemptionManager` | §3.6, §4.1 | Project exit and token redemption |
| `SimpleLiquidityPool` | §4.2, §4.3, §4.4 | CPMM AMM secondary market |

---

## Tech Stack

- **Solidity** 0.8.24 (optimizer enabled, 200 runs)
- **Hardhat** ^2.22 + @nomicfoundation/hardhat-toolbox ^4.0
- **OpenZeppelin Contracts** ^5.0 (ERC-20, Ownable, ReentrancyGuard)
- **Target EVM**: Paris

## Prerequisites

- Node.js >= 18
- npm >= 9

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Compile contracts

```bash
npm run compile
```

### 3. Run all tests

```bash
npm test
```

### 4. Start local node and deploy

```bash
# Terminal 1 — start local Hardhat node
npm run node

# Terminal 2 — deploy
npm run deploy:local
```

---

## Contract Design

### VacationToken (VCT)

- **Fixed supply**: 1,000,000 VCT minted once at construction; no further minting possible.
- **Locking**: Authorised contracts (UsageManager, RedemptionManager) can lock/unlock tokens. Locked tokens cannot be transferred, preventing double-use between yield and usage (§3.6).
- **Available balance**: `availableBalance(user) = balanceOf(user) − lockedBalance(user)`

### AllocationManager

Each settlement cycle (e.g. 30 days):
1. Owner calls `startCycle(duration)`.
2. Holders call `selectMode(cycleId, YIELD | USAGE)` — one-time, irrevocable per cycle.
3. Yield shares are **snapshotted** from `availableBalance` at selection time (§3.3).
4. After cycle end, owner calls `finalizeCycle(cycleId)`.

**Incentive alignment** (§3.4): `totalYieldShares` only includes YIELD-mode holders. When more holders choose USAGE, the revenue pool is divided among fewer shares, increasing per-token yield.

### UsageManager — Dynamic Pricing (§3.3)

| Season | Token Cost |
|---|---|
| Off-peak | 100 VCT |
| Peak | 200 VCT (2×) |

Workflow:
1. Admin creates slots with `createSlot(checkIn, checkOut, season, cycleId)`.
2. USAGE-mode holders book with `bookSlot(slotId, cycleId)` — tokens locked until `checkOut`.
3. After `checkOut`, anyone calls `unlockAfterStay(user, lockIndex)` to free tokens.

### RevenueVault

- Admin deposits ETH rental income per cycle: `depositRevenue(cycleId)`.
- YIELD-mode holders claim proportionally: `claim(cycleId)`.
- Formula: `userRevenue = (cycleRevenue × userYieldShares) / totalYieldShares`
- CEI pattern + ReentrancyGuard prevent re-entrancy attacks.

### RedemptionManager

- Admin opens with `openRedemption()` and deposits total sale proceeds.
- Holders call `redeem(tokenAmount)` and receive: `ETH = (pool × tokens) / totalSupplySnapshot`
- Tokens are burned on redemption; double redemption is prevented by `hasRedeemed` mapping.

### SimpleLiquidityPool — CPMM AMM

Implements the **constant-product formula**: `x · y = k` (Uniswap V2 style).

- **0.3% fee** on all swaps (accumulates in reserves, rewarding LPs).
- `swapTokenForEth` / `swapEthForToken` demonstrate directional price impact.
- `minOut` slippage protection on both swap directions.
- LP shares: geometric mean for first deposit; proportional min for subsequent deposits.

---

## Test Coverage (91 tests — all passing)

| File | What is tested |
|---|---|
| `VacationToken.test.js` | Fixed supply, transfers, locking, unlocking, burns, access control |
| `AllocationManager.test.js` | Cycle creation, mode selection, yield share snapshots, finalization |
| `UsageManager.test.js` | Dynamic pricing, slot creation, booking, token locking, unlock |
| `RevenueVault.test.js` | Revenue deposit, proportional claim, double-claim guard, incentive alignment |
| `RedemptionManager.test.js` | Open redemption, proportional payout, token burn, conservation |
| `Integration.test.js` | Scenarios A–F: full yield flow, usage flow, mixed modes, token transfer, AMM |

### Integration Scenarios

| Scenario | Description |
|---|---|
| A | User selects YIELD → claims full rental income |
| B | User selects USAGE → books peak slot → no rental income |
| C | Mixed: YIELD user gets 100% when peer chooses USAGE |
| D | Token transfer → new holder participates in next cycle |
| E | Three users redeem → total payout conserved (ETH = pool × redeemed/supply) |
| F | AMM: CPMM price impact, slippage demo, LP add/remove |

---

## Security Notes

- **No reentrancy**: `RevenueVault` and `RedemptionManager` use `ReentrancyGuard` + CEI pattern.
- **Access control**: `Ownable` restricts admin functions (cycle management, revenue deposit).
- **Overflow protection**: Solidity 0.8+ built-in checked arithmetic.
- **Locked-token protection**: ERC-20 `_update` override prevents transferring locked tokens.
- **Double-action prevention**: `claimed` and `hasRedeemed` mappings block repeat actions.
- **Slippage protection**: `minOut` parameters on all AMM swaps.

---

## Project Structure

```
vacation-property-blockchain/
├── contracts/
│   ├── VacationToken.sol
│   ├── AllocationManager.sol
│   ├── UsageManager.sol
│   ├── RevenueVault.sol
│   ├── RedemptionManager.sol
│   └── SimpleLiquidityPool.sol
├── test/
│   ├── VacationToken.test.js
│   ├── AllocationManager.test.js
│   ├── UsageManager.test.js
│   ├── RevenueVault.test.js
│   ├── RedemptionManager.test.js
│   └── Integration.test.js
├── scripts/
│   └── deploy.js
├── hardhat.config.js
├── package.json
└── README.md
```
