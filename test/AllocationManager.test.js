const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("AllocationManager", function () {

    const CYCLE_DURATION = 30 * 24 * 3600; // 30 days in seconds

    async function deployFixture() {
        const [owner, user1, user2, user3] = await ethers.getSigners();

        const VacationToken = await ethers.getContractFactory("VacationToken");
        const token = await VacationToken.deploy(owner.address);
        await token.waitForDeployment();

        const AllocationManager = await ethers.getContractFactory("AllocationManager");
        const manager = await AllocationManager.deploy(owner.address, await token.getAddress());
        await manager.waitForDeployment();

        // Distribute tokens
        await token.transfer(user1.address, ethers.parseEther("500000"));
        await token.transfer(user2.address, ethers.parseEther("300000"));
        await token.transfer(user3.address, ethers.parseEther("100000"));

        return { token, manager, owner, user1, user2, user3 };
    }

    const MODE_NONE  = 0n;
    const MODE_YIELD = 1n;
    const MODE_USAGE = 2n;

    // ─── startCycle ───────────────────────────────────────────────────────────
    describe("startCycle", function () {
        it("should create cycle with correct timestamps", async function () {
            const { manager, owner } = await loadFixture(deployFixture);
            const tx = await manager.startCycle(CYCLE_DURATION);
            const receipt = await tx.wait();

            const cycleId = await manager.currentCycleId();
            expect(cycleId).to.equal(1n);

            const { startTime, endTime, finalized, totalYieldShares } =
                await manager.getCycle(1n);
            expect(endTime - startTime).to.equal(BigInt(CYCLE_DURATION));
            expect(finalized).to.equal(false);
            expect(totalYieldShares).to.equal(0n);
        });

        it("should reject zero duration", async function () {
            const { manager } = await loadFixture(deployFixture);
            await expect(manager.startCycle(0)).to.be.revertedWith(
                "AllocationManager: zero duration"
            );
        });

        it("should reject non-owner", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);
            await expect(
                manager.connect(user1).startCycle(CYCLE_DURATION)
            ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
        });

        it("should reject second cycle if previous not finalized", async function () {
            const { manager } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            await expect(manager.startCycle(CYCLE_DURATION)).to.be.revertedWith(
                "AllocationManager: previous cycle not finalized"
            );
        });

        it("should allow second cycle after first is finalized", async function () {
            const { manager } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            await time.increase(CYCLE_DURATION + 1);
            await manager.finalizeCycle(1n);
            await manager.startCycle(CYCLE_DURATION);
            expect(await manager.currentCycleId()).to.equal(2n);
        });
    });

    // ─── selectMode ───────────────────────────────────────────────────────────
    describe("selectMode", function () {
        it("should allow YIELD mode selection during active cycle", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);

            await manager.connect(user1).selectMode(1n, MODE_YIELD);
            expect(await manager.getUserMode(1n, user1.address)).to.equal(MODE_YIELD);
        });

        it("should allow USAGE mode selection during active cycle", async function () {
            const { manager, user2 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);

            await manager.connect(user2).selectMode(1n, MODE_USAGE);
            expect(await manager.getUserMode(1n, user2.address)).to.equal(MODE_USAGE);
        });

        it("should record yield shares from availableBalance snapshot", async function () {
            const { manager, token, user1 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);

            const balance = await token.availableBalance(user1.address);
            await manager.connect(user1).selectMode(1n, MODE_YIELD);

            expect(await manager.getUserYieldShares(1n, user1.address)).to.equal(balance);
        });

        it("should accumulate totalYieldShares from multiple YIELD users", async function () {
            const { manager, token, user1, user2 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);

            const bal1 = await token.availableBalance(user1.address);
            const bal2 = await token.availableBalance(user2.address);
            await manager.connect(user1).selectMode(1n, MODE_YIELD);
            await manager.connect(user2).selectMode(1n, MODE_YIELD);

            expect(await manager.getCycleTotalYieldShares(1n)).to.equal(bal1 + bal2);
        });

        it("should NOT add yield shares for USAGE mode", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);

            await manager.connect(user1).selectMode(1n, MODE_USAGE);
            expect(await manager.getCycleTotalYieldShares(1n)).to.equal(0n);
            expect(await manager.getUserYieldShares(1n, user1.address)).to.equal(0n);
        });

        it("should reject duplicate mode selection in same cycle", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            await manager.connect(user1).selectMode(1n, MODE_YIELD);

            await expect(
                manager.connect(user1).selectMode(1n, MODE_YIELD)
            ).to.be.revertedWith("AllocationManager: mode already selected for this cycle");
        });

        it("should reject selection for non-existent cycle", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);
            await expect(
                manager.connect(user1).selectMode(99n, MODE_YIELD)
            ).to.be.revertedWith("AllocationManager: invalid cycle");
        });

        it("should reject selection after cycle end", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            await time.increase(CYCLE_DURATION + 1);

            await expect(
                manager.connect(user1).selectMode(1n, MODE_YIELD)
            ).to.be.revertedWith("AllocationManager: cycle not active");
        });

        it("should reject selection with zero available balance", async function () {
            const { manager, user1, token, owner } = await loadFixture(deployFixture);
            // Drain user1's tokens
            await token.connect(user1).transfer(
                owner.address,
                await token.balanceOf(user1.address)
            );
            await manager.startCycle(CYCLE_DURATION);

            await expect(
                manager.connect(user1).selectMode(1n, MODE_YIELD)
            ).to.be.revertedWith("AllocationManager: no available tokens");
        });
    });

    // ─── finalizeCycle ────────────────────────────────────────────────────────
    describe("finalizeCycle", function () {
        it("should finalize cycle after endTime", async function () {
            const { manager } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            await time.increase(CYCLE_DURATION + 1);

            await manager.finalizeCycle(1n);
            expect(await manager.isCycleFinalized(1n)).to.equal(true);
        });

        it("should reject finalization before endTime", async function () {
            const { manager } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);

            await expect(manager.finalizeCycle(1n)).to.be.revertedWith(
                "AllocationManager: cycle not ended yet"
            );
        });

        it("should reject double finalization", async function () {
            const { manager } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            await time.increase(CYCLE_DURATION + 1);
            await manager.finalizeCycle(1n);

            await expect(manager.finalizeCycle(1n)).to.be.revertedWith(
                "AllocationManager: already finalized"
            );
        });

        it("should reject non-owner", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            await time.increase(CYCLE_DURATION + 1);

            await expect(
                manager.connect(user1).finalizeCycle(1n)
            ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
        });

        it("should emit CycleFinalized event with correct totalYieldShares", async function () {
            const { manager, token, user1 } = await loadFixture(deployFixture);
            await manager.startCycle(CYCLE_DURATION);
            const bal = await token.availableBalance(user1.address);
            await manager.connect(user1).selectMode(1n, MODE_YIELD);

            await time.increase(CYCLE_DURATION + 1);
            await expect(manager.finalizeCycle(1n))
                .to.emit(manager, "CycleFinalized")
                .withArgs(1n, bal);
        });
    });
});
