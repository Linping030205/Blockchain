const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("RevenueVault", function () {

    const CYCLE_DURATION = 30 * 24 * 3600;
    const MODE_YIELD     = 1n;
    const MODE_USAGE     = 2n;

    async function deployFixture() {
        const [owner, user1, user2, user3] = await ethers.getSigners();

        const VacationToken = await ethers.getContractFactory("VacationToken");
        const token = await VacationToken.deploy(owner.address);
        await token.waitForDeployment();

        const AllocationManager = await ethers.getContractFactory("AllocationManager");
        const allocMgr = await AllocationManager.deploy(owner.address, await token.getAddress());
        await allocMgr.waitForDeployment();

        const RevenueVault = await ethers.getContractFactory("RevenueVault");
        const vault = await RevenueVault.deploy(
            owner.address,
            await token.getAddress(),
            await allocMgr.getAddress()
        );
        await vault.waitForDeployment();

        // Distribute: user1=500k, user2=300k, user3=100k
        await token.transfer(user1.address, ethers.parseEther("500000"));
        await token.transfer(user2.address, ethers.parseEther("300000"));
        await token.transfer(user3.address, ethers.parseEther("100000"));

        return { token, allocMgr, vault, owner, user1, user2, user3 };
    }

    // Helper: run a full cycle with chosen modes
    async function runCycle(allocMgr, owner, ...modeEntries) {
        // modeEntries = [[user, mode], ...]
        await allocMgr.startCycle(CYCLE_DURATION);
        const cycleId = await allocMgr.currentCycleId();
        for (const [user, mode] of modeEntries) {
            await allocMgr.connect(user).selectMode(cycleId, mode);
        }
        await time.increase(CYCLE_DURATION + 1);
        await allocMgr.finalizeCycle(cycleId);
        return cycleId;
    }

    // ─── depositRevenue ───────────────────────────────────────────────────────
    describe("depositRevenue", function () {
        it("should accept deposit after cycle finalized", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user1, MODE_YIELD]);
            const deposit = ethers.parseEther("10");

            await expect(vault.depositRevenue(cycleId, { value: deposit }))
                .to.emit(vault, "RevenueDeposited")
                .withArgs(cycleId, deposit);

            expect(await vault.cycleRevenue(cycleId)).to.equal(deposit);
        });

        it("should accumulate multiple deposits", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user1, MODE_YIELD]);

            await vault.depositRevenue(cycleId, { value: ethers.parseEther("6") });
            await vault.depositRevenue(cycleId, { value: ethers.parseEther("4") });

            expect(await vault.cycleRevenue(cycleId)).to.equal(ethers.parseEther("10"));
        });

        it("should reject deposit for non-finalized cycle", async function () {
            const { allocMgr, vault, owner } = await loadFixture(deployFixture);
            await allocMgr.startCycle(CYCLE_DURATION);
            const cycleId = await allocMgr.currentCycleId();

            await expect(
                vault.depositRevenue(cycleId, { value: ethers.parseEther("1") })
            ).to.be.revertedWith("RevenueVault: cycle not yet finalized");
        });

        it("should reject zero value deposit", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user1, MODE_YIELD]);
            await expect(
                vault.depositRevenue(cycleId, { value: 0n })
            ).to.be.revertedWith("RevenueVault: zero deposit");
        });

        it("should reject non-owner deposit", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user1, MODE_YIELD]);
            await expect(
                vault.connect(user1).depositRevenue(cycleId, { value: ethers.parseEther("1") })
            ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
        });
    });

    // ─── claim — single user ─────────────────────────────────────────────────
    describe("claim (single YIELD user)", function () {
        it("user should receive full deposit when sole yield holder", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user1, MODE_YIELD]);
            const deposit = ethers.parseEther("10");
            await vault.depositRevenue(cycleId, { value: deposit });

            const before = await ethers.provider.getBalance(user1.address);
            const tx     = await vault.connect(user1).claim(cycleId);
            const receipt = await tx.wait();
            const gasCost  = receipt.gasUsed * tx.gasPrice;
            const after   = await ethers.provider.getBalance(user1.address);

            expect(after + gasCost - before).to.equal(deposit);
        });

        it("should emit RevenueClaimed event", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user1, MODE_YIELD]);
            await vault.depositRevenue(cycleId, { value: ethers.parseEther("5") });

            await expect(vault.connect(user1).claim(cycleId))
                .to.emit(vault, "RevenueClaimed")
                .withArgs(cycleId, user1.address, ethers.parseEther("5"));
        });
    });

    // ─── claim — proportional split ──────────────────────────────────────────
    describe("claim (proportional split between yield holders)", function () {
        it("two YIELD users split revenue by token weight", async function () {
            // user1 = 500k, user2 = 300k → ratio 5:3
            const { allocMgr, vault, token, owner, user1, user2 } =
                await loadFixture(deployFixture);
            const cycleId = await runCycle(
                allocMgr, owner,
                [user1, MODE_YIELD],
                [user2, MODE_YIELD]
            );
            const deposit = ethers.parseEther("8"); // 8 ETH → 5 ETH to user1, 3 ETH to user2
            await vault.depositRevenue(cycleId, { value: deposit });

            const totalShares = await allocMgr.getCycleTotalYieldShares(cycleId);
            const u1Shares    = await allocMgr.getUserYieldShares(cycleId, user1.address);
            const u2Shares    = await allocMgr.getUserYieldShares(cycleId, user2.address);

            const expected1 = (deposit * u1Shares) / totalShares;
            const expected2 = (deposit * u2Shares) / totalShares;

            expect(await vault.claimableAmount(cycleId, user1.address)).to.equal(expected1);
            expect(await vault.claimableAmount(cycleId, user2.address)).to.equal(expected2);

            // Both claim
            await vault.connect(user1).claim(cycleId);
            await vault.connect(user2).claim(cycleId);

            expect(await vault.claimableAmount(cycleId, user1.address)).to.equal(0n);
        });
    });

    // ─── Incentive alignment (§3.4) ───────────────────────────────────────────
    describe("Incentive alignment — USAGE reduces yield pool divisor", function () {
        it("YIELD-only user gets more when peer chooses USAGE", async function () {
            // Scenario: user1 (500k YIELD), user2 (300k USAGE) → user1 gets full 10 ETH
            const { allocMgr, vault, owner, user1, user2 } = await loadFixture(deployFixture);
            const cycleIdA = await runCycle(
                allocMgr, owner, [user1, MODE_YIELD], [user2, MODE_USAGE]
            );
            await vault.depositRevenue(cycleIdA, { value: ethers.parseEther("10") });

            // user1 is sole yield holder → claims full deposit
            expect(await vault.claimableAmount(cycleIdA, user1.address))
                .to.equal(ethers.parseEther("10"));
            // user2 in USAGE mode → 0 claimable
            expect(await vault.claimableAmount(cycleIdA, user2.address)).to.equal(0n);
        });
    });

    // ─── Guard rails ─────────────────────────────────────────────────────────
    describe("Guard rails", function () {
        it("should reject double claim", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user1, MODE_YIELD]);
            await vault.depositRevenue(cycleId, { value: ethers.parseEther("5") });

            await vault.connect(user1).claim(cycleId);
            await expect(vault.connect(user1).claim(cycleId)).to.be.revertedWith(
                "RevenueVault: already claimed"
            );
        });

        it("should reject claim by USAGE-mode user", async function () {
            const { allocMgr, vault, owner, user2 } = await loadFixture(deployFixture);
            const cycleId = await runCycle(allocMgr, owner, [user2, MODE_USAGE]);
            await vault.depositRevenue(cycleId, { value: ethers.parseEther("5") });

            await expect(vault.connect(user2).claim(cycleId)).to.be.revertedWith(
                "RevenueVault: no yield shares registered for this cycle"
            );
        });

        it("should reject claim before cycle finalized", async function () {
            const { allocMgr, vault, owner, user1 } = await loadFixture(deployFixture);
            await allocMgr.startCycle(CYCLE_DURATION);
            const cycleId = await allocMgr.currentCycleId();
            await allocMgr.connect(user1).selectMode(cycleId, MODE_YIELD);

            await expect(vault.connect(user1).claim(cycleId)).to.be.revertedWith(
                "RevenueVault: cycle not finalized"
            );
        });
    });
});
