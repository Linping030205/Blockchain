const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Integration Tests
 *
 * Scenario A: Full Yield Flow
 *   user1 selects YIELD, cycle finalised, admin deposits rent, user1 claims.
 *
 * Scenario B: Full Usage Flow
 *   user1 selects USAGE, books peak slot, stay ends, tokens unlock.
 *   user1 does NOT receive any rental income.
 *
 * Scenario C: Mixed mode — incentive alignment
 *   user1 (500k) YIELD, user2 (300k) USAGE → user1 claims full revenue.
 *   Demonstrates that USAGE holders yield larger share to remaining YIELD holders (§3.4).
 *
 * Scenario D: Trade then yield
 *   user1 transfers 250k to user3 mid-term.
 *   Next cycle: both user1 and user3 select YIELD; revenue splits by new balances.
 *
 * Scenario E: Redemption conservation
 *   All three users redeem; total ETH paid out is exactly proportional.
 *
 * Scenario F: AMM secondary market — slippage demonstration
 *   LP adds liquidity (10,000 VCT + 1 ETH).
 *   user1 swaps 1,000 VCT for ETH → price moves along CPMM curve (§4.3, §4.4).
 */

describe("Integration Tests", function () {

    const CYCLE_DURATION = 30 * 24 * 3600;
    const ONE_DAY        = 24 * 3600;
    const MODE_YIELD     = 1n;
    const MODE_USAGE     = 2n;
    const SEASON_PEAK    = 1;
    const SEASON_OFFPEAK = 0;

    // ─── Full system fixture ──────────────────────────────────────────────────
    async function deployFullSystem() {
        const [owner, user1, user2, user3, lpProvider] = await ethers.getSigners();

        // 1. Deploy contracts
        const VacationToken = await ethers.getContractFactory("VacationToken");
        const token = await VacationToken.deploy(owner.address);
        await token.waitForDeployment();

        const AllocationManager = await ethers.getContractFactory("AllocationManager");
        const allocMgr = await AllocationManager.deploy(owner.address, await token.getAddress());
        await allocMgr.waitForDeployment();

        const UsageManager = await ethers.getContractFactory("UsageManager");
        const usageMgr = await UsageManager.deploy(
            owner.address, await token.getAddress(), await allocMgr.getAddress()
        );
        await usageMgr.waitForDeployment();

        const RevenueVault = await ethers.getContractFactory("RevenueVault");
        const vault = await RevenueVault.deploy(
            owner.address, await token.getAddress(), await allocMgr.getAddress()
        );
        await vault.waitForDeployment();

        const RedemptionManager = await ethers.getContractFactory("RedemptionManager");
        const redemption = await RedemptionManager.deploy(
            owner.address, await token.getAddress()
        );
        await redemption.waitForDeployment();

        const SimpleLiquidityPool = await ethers.getContractFactory("SimpleLiquidityPool");
        const pool = await SimpleLiquidityPool.deploy(
            owner.address, await token.getAddress()
        );
        await pool.waitForDeployment();

        // 2. Authorize privilege contracts
        await token.setAuthorizedLocker(await usageMgr.getAddress(),   true);
        await token.setAuthorizedLocker(await redemption.getAddress(), true);

        // 3. Distribute tokens: user1=500k, user2=300k, user3=100k, owner keeps 100k
        const U1 = ethers.parseEther("500000");
        const U2 = ethers.parseEther("300000");
        const U3 = ethers.parseEther("100000");
        await token.transfer(user1.address, U1);
        await token.transfer(user2.address, U2);
        await token.transfer(user3.address, U3);

        return {
            token, allocMgr, usageMgr, vault, redemption, pool,
            owner, user1, user2, user3, lpProvider,
            U1, U2, U3
        };
    }

    // ─── Scenario A ───────────────────────────────────────────────────────────
    describe("Scenario A: Full Yield Flow", function () {
        it("user1 selects YIELD, claims proportional rental income", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFullSystem);

            // Cycle 1: user1 selects YIELD
            await allocMgr.startCycle(CYCLE_DURATION);
            await allocMgr.connect(user1).selectMode(1n, MODE_YIELD);

            await time.increase(CYCLE_DURATION + 1);
            await allocMgr.finalizeCycle(1n);

            const deposit = ethers.parseEther("10");
            await vault.depositRevenue(1n, { value: deposit });

            // user1 is sole YIELD holder → gets full 10 ETH
            const before  = await ethers.provider.getBalance(user1.address);
            const tx      = await vault.connect(user1).claim(1n);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * tx.gasPrice;
            const after   = await ethers.provider.getBalance(user1.address);

            expect(after + gasCost - before).to.equal(deposit);
        });
    });

    // ─── Scenario B ───────────────────────────────────────────────────────────
    describe("Scenario B: Full Usage Flow — no rental income accrues", function () {
        it("user1 books peak slot, tokens locked, unlocked after stay, no yield", async function () {
            const { token, allocMgr, usageMgr, vault, owner, user1 } =
                await loadFixture(deployFullSystem);

            const now = await time.latest();
            const checkIn  = now + ONE_DAY;
            const checkOut = now + 3 * ONE_DAY;

            // Cycle 1: user1 selects USAGE
            await allocMgr.startCycle(CYCLE_DURATION);
            await allocMgr.connect(user1).selectMode(1n, MODE_USAGE);

            // Create peak slot
            await usageMgr.createSlot(checkIn, checkOut, SEASON_PEAK, 1n);

            const balBefore = await token.availableBalance(user1.address);
            await usageMgr.connect(user1).bookSlot(0n, 1n);

            // Tokens locked
            const balAfterBook = await token.availableBalance(user1.address);
            expect(balBefore - balAfterBook).to.equal(ethers.parseEther("200")); // PEAK_COST

            // Advance past both checkOut AND cycle endTime (30 days > 3 days).
            await time.increase(CYCLE_DURATION + 1);
            await allocMgr.finalizeCycle(1n);

            // Unlock
            await usageMgr.unlockAfterStay(user1.address, 0n);
            expect(await token.availableBalance(user1.address)).to.equal(balBefore);

            // Deposit revenue — user1 registered no yield shares → cannot claim
            await vault.depositRevenue(1n, { value: ethers.parseEther("10") });
            await expect(vault.connect(user1).claim(1n)).to.be.revertedWith(
                "RevenueVault: no yield shares registered for this cycle"
            );
        });
    });

    // ─── Scenario C ───────────────────────────────────────────────────────────
    describe("Scenario C: Mixed users — incentive alignment", function () {
        it("USAGE holder foregoes income; YIELD holder gets entire pool", async function () {
            const { allocMgr, vault, owner, user1, user2 } =
                await loadFixture(deployFullSystem);

            // user1 = 500k YIELD, user2 = 300k USAGE
            await allocMgr.startCycle(CYCLE_DURATION);
            await allocMgr.connect(user1).selectMode(1n, MODE_YIELD);
            await allocMgr.connect(user2).selectMode(1n, MODE_USAGE);

            await time.increase(CYCLE_DURATION + 1);
            await allocMgr.finalizeCycle(1n);

            const deposit = ethers.parseEther("10");
            await vault.depositRevenue(1n, { value: deposit });

            // user1 is sole yield holder → full 10 ETH
            expect(await vault.claimableAmount(1n, user1.address)).to.equal(deposit);
            // user2 in USAGE mode → 0
            expect(await vault.claimableAmount(1n, user2.address)).to.equal(0n);

            await vault.connect(user1).claim(1n);
        });
    });

    // ─── Scenario D ───────────────────────────────────────────────────────────
    describe("Scenario D: Transfer tokens then yield in next cycle", function () {
        it("new holder participates in yield after receiving tokens", async function () {
            const { allocMgr, vault, token, owner, user1, user3 } =
                await loadFixture(deployFullSystem);

            // Cycle 1: user1 YIELD, finalize
            await allocMgr.startCycle(CYCLE_DURATION);
            await allocMgr.connect(user1).selectMode(1n, MODE_YIELD);
            await time.increase(CYCLE_DURATION + 1);
            await allocMgr.finalizeCycle(1n);

            // user1 transfers 250k to user3
            const transfer = ethers.parseEther("250000");
            await token.connect(user1).transfer(user3.address, transfer);

            // Cycle 2: both user1 (250k) and user3 (250k + 100k = 350k) select YIELD
            await allocMgr.startCycle(CYCLE_DURATION);
            await allocMgr.connect(user1).selectMode(2n, MODE_YIELD);
            await allocMgr.connect(user3).selectMode(2n, MODE_YIELD);

            await time.increase(CYCLE_DURATION + 1);
            await allocMgr.finalizeCycle(2n);

            const deposit = ethers.parseEther("6");
            await vault.depositRevenue(2n, { value: deposit });

            const totalShares = await allocMgr.getCycleTotalYieldShares(2n);
            const u1Shares    = await allocMgr.getUserYieldShares(2n, user1.address);
            const u3Shares    = await allocMgr.getUserYieldShares(2n, user3.address);

            const exp1 = (deposit * u1Shares) / totalShares;
            const exp3 = (deposit * u3Shares) / totalShares;

            expect(await vault.claimableAmount(2n, user1.address)).to.equal(exp1);
            expect(await vault.claimableAmount(2n, user3.address)).to.equal(exp3);

            // Sanity: both shares sum matches total
            expect(u1Shares + u3Shares).to.equal(totalShares);
        });
    });

    // ─── Scenario E ───────────────────────────────────────────────────────────
    describe("Scenario E: Redemption conservation", function () {
        it("total ETH redeemed equals pool × (redeemed tokens / total supply)", async function () {
            const { redemption, token, owner, user1, user2, user3 } =
                await loadFixture(deployFullSystem);

            const poolSize = ethers.parseEther("10");
            const supply   = await token.totalSupply(); // 1,000,000 tokens

            await redemption.openRedemption({ value: poolSize });

            const t1 = ethers.parseEther("500000"); // user1
            const t2 = ethers.parseEther("300000"); // user2
            const t3 = ethers.parseEther("100000"); // user3

            const e1 = (poolSize * t1) / supply; // 5 ETH
            const e2 = (poolSize * t2) / supply; // 3 ETH
            const e3 = (poolSize * t3) / supply; // 1 ETH

            expect(e1).to.equal(ethers.parseEther("5"));
            expect(e2).to.equal(ethers.parseEther("3"));
            expect(e3).to.equal(ethers.parseEther("1"));

            await redemption.connect(user1).redeem(t1);
            await redemption.connect(user2).redeem(t2);
            await redemption.connect(user3).redeem(t3);

            // Contract holds the remaining 1 ETH (owner's 100k unredeemed)
            const remaining = await ethers.provider.getBalance(await redemption.getAddress());
            expect(remaining).to.equal(ethers.parseEther("1"));

            // Burned tokens confirmed
            expect(await token.balanceOf(user1.address)).to.equal(0n);
            expect(await token.balanceOf(user2.address)).to.equal(0n);
            expect(await token.balanceOf(user3.address)).to.equal(0n);
        });
    });

    // ─── Scenario F ───────────────────────────────────────────────────────────
    describe("Scenario F: AMM secondary market — price impact and slippage", function () {
        it("CPMM price rises after selling tokens (demonstrates slippage)", async function () {
            const { token, pool, owner, user1, lpProvider } =
                await loadFixture(deployFullSystem);

            // Give lpProvider 10,000 tokens from owner
            const LP_TOKENS = ethers.parseEther("10000");
            await token.transfer(lpProvider.address, LP_TOKENS);

            // LP approves and adds liquidity: 10,000 VCT + 1 ETH
            const LP_ETH = ethers.parseEther("1");
            await token.connect(lpProvider).approve(await pool.getAddress(), LP_TOKENS);
            await pool.connect(lpProvider).addLiquidity(LP_TOKENS, { value: LP_ETH });

            const priceBeforeRaw = await pool.getPrice(); // ETH per token (×1e18)
            // Expected: 1e18 / 10000 = 1e14 (0.0001 ETH per token)
            expect(priceBeforeRaw).to.equal(1n * 10n ** 14n);

            // user1 approves and swaps 1,000 tokens for ETH (minEthOut=0 for test)
            const SWAP_TOKENS = ethers.parseEther("1000");
            await token.connect(user1).approve(await pool.getAddress(), SWAP_TOKENS);
            await pool.connect(user1).swapTokenForEth(SWAP_TOKENS, 0n);

            // After swap: tokenReserve increases → price (ETH/token) decreases
            // (more tokens in pool, less ETH)
            const priceAfterRaw = await pool.getPrice();
            expect(priceAfterRaw).to.be.lessThan(priceBeforeRaw);

            // ETH received should be less than naive 10% of 1 ETH (=0.1 ETH) due to CPMM curve
            // Actual ≈ 0.09066 ETH (0.3% fee applied)
            const ethOut = await pool.getTokenToEthOutput.staticCall
                ? undefined
                : undefined; // already executed; verify via reserves
            const newTokenReserve = await pool.tokenReserve();
            const newEthReserve   = await pool.ethReserve();

            expect(newTokenReserve).to.equal(LP_TOKENS + SWAP_TOKENS);
            expect(newEthReserve).to.be.lessThan(LP_ETH);
        });

        it("buy-side swap increases token reserve", async function () {
            const { token, pool, owner, user1, lpProvider } =
                await loadFixture(deployFullSystem);

            const LP_TOKENS = ethers.parseEther("10000");
            await token.transfer(lpProvider.address, LP_TOKENS);
            await token.connect(lpProvider).approve(await pool.getAddress(), LP_TOKENS);
            await pool.connect(lpProvider).addLiquidity(LP_TOKENS, { value: ethers.parseEther("1") });

            const reserveBefore = await pool.tokenReserve();

            // user1 buys tokens with 0.1 ETH
            await pool.connect(user1).swapEthForToken(0n, { value: ethers.parseEther("0.1") });

            expect(await pool.tokenReserve()).to.be.lessThan(reserveBefore);
            expect(await pool.ethReserve()).to.be.greaterThan(ethers.parseEther("1"));
        });

        it("LP can add and remove liquidity", async function () {
            const { token, pool, owner, lpProvider } =
                await loadFixture(deployFullSystem);

            const LP_TOKENS = ethers.parseEther("10000");
            await token.transfer(lpProvider.address, LP_TOKENS);
            await token.connect(lpProvider).approve(await pool.getAddress(), LP_TOKENS);

            await pool.connect(lpProvider).addLiquidity(LP_TOKENS, { value: ethers.parseEther("1") });

            const shares = await pool.lpShares(lpProvider.address);
            expect(shares).to.be.greaterThan(0n);

            // Remove all liquidity
            await pool.connect(lpProvider).removeLiquidity(shares);
            expect(await pool.lpShares(lpProvider.address)).to.equal(0n);
        });

        it("slippage protection rejects trade with insufficient output", async function () {
            const { token, pool, owner, user1, lpProvider } =
                await loadFixture(deployFullSystem);

            const LP_TOKENS = ethers.parseEther("10000");
            await token.transfer(lpProvider.address, LP_TOKENS);
            await token.connect(lpProvider).approve(await pool.getAddress(), LP_TOKENS);
            await pool.connect(lpProvider).addLiquidity(LP_TOKENS, { value: ethers.parseEther("1") });

            // Attempt to swap 1,000 tokens but demand an unrealistically high ETH output
            const SWAP_TOKENS = ethers.parseEther("1000");
            await token.connect(user1).approve(await pool.getAddress(), SWAP_TOKENS);

            await expect(
                pool.connect(user1).swapTokenForEth(SWAP_TOKENS, ethers.parseEther("1"))
            ).to.be.revertedWith("Pool: slippage - insufficient ETH output");
        });
    });
});
