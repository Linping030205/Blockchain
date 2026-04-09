const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("UsageManager", function () {

    const CYCLE_DURATION  = 30 * 24 * 3600;
    const ONE_DAY         = 24 * 3600;
    const MODE_USAGE      = 2n;
    const MODE_YIELD      = 1n;
    const SEASON_OFFPEAK  = 0;
    const SEASON_PEAK     = 1;

    async function deployFixture() {
        const [owner, user1, user2] = await ethers.getSigners();

        const VacationToken = await ethers.getContractFactory("VacationToken");
        const token = await VacationToken.deploy(owner.address);
        await token.waitForDeployment();

        const AllocationManager = await ethers.getContractFactory("AllocationManager");
        const manager = await AllocationManager.deploy(owner.address, await token.getAddress());
        await manager.waitForDeployment();

        const UsageManager = await ethers.getContractFactory("UsageManager");
        const usageMgr = await UsageManager.deploy(
            owner.address,
            await token.getAddress(),
            await manager.getAddress()
        );
        await usageMgr.waitForDeployment();

        // Authorize UsageManager to lock tokens
        await token.setAuthorizedLocker(await usageMgr.getAddress(), true);

        // Distribute tokens
        await token.transfer(user1.address, ethers.parseEther("500000"));
        await token.transfer(user2.address, ethers.parseEther("300000"));

        // Start cycle 1 and have user1 choose USAGE mode
        await manager.startCycle(CYCLE_DURATION);
        await manager.connect(user1).selectMode(1n, MODE_USAGE);

        return { token, manager, usageMgr, owner, user1, user2 };
    }

    // ─── Dynamic pricing ──────────────────────────────────────────────────────
    describe("Dynamic pricing", function () {
        it("PEAK_COST should be 200 VCT", async function () {
            const { usageMgr } = await loadFixture(deployFixture);
            expect(await usageMgr.PEAK_COST()).to.equal(ethers.parseEther("200"));
        });

        it("BASE_COST should be 100 VCT", async function () {
            const { usageMgr } = await loadFixture(deployFixture);
            expect(await usageMgr.BASE_COST()).to.equal(ethers.parseEther("100"));
        });

        it("PEAK slot should cost 2× off-peak slot", async function () {
            const { usageMgr } = await loadFixture(deployFixture);
            const peak    = await usageMgr.getSlotCost(SEASON_PEAK);
            const offpeak = await usageMgr.getSlotCost(SEASON_OFFPEAK);
            expect(peak).to.equal(offpeak * 2n);
        });
    });

    // ─── createSlot ───────────────────────────────────────────────────────────
    describe("createSlot", function () {
        it("should create peak slot with PEAK_COST", async function () {
            const { usageMgr } = await loadFixture(deployFixture);
            const now = await time.latest();
            const slotId = await usageMgr.createSlot.staticCall(
                now + ONE_DAY,
                now + 3 * ONE_DAY,
                SEASON_PEAK,
                1n
            );
            await usageMgr.createSlot(now + ONE_DAY, now + 3 * ONE_DAY, SEASON_PEAK, 1n);
            const slot = await usageMgr.slots(slotId);
            expect(slot.tokenCost).to.equal(ethers.parseEther("200"));
        });

        it("should create off-peak slot with BASE_COST", async function () {
            const { usageMgr } = await loadFixture(deployFixture);
            const now = await time.latest();
            await usageMgr.createSlot(now + ONE_DAY, now + 3 * ONE_DAY, SEASON_OFFPEAK, 1n);
            const slot = await usageMgr.slots(0n);
            expect(slot.tokenCost).to.equal(ethers.parseEther("100"));
        });

        it("should reject checkOut <= checkIn", async function () {
            const { usageMgr } = await loadFixture(deployFixture);
            const now = await time.latest();
            await expect(
                usageMgr.createSlot(now + ONE_DAY, now + ONE_DAY, SEASON_PEAK, 1n)
            ).to.be.revertedWith("UsageManager: checkOut must be after checkIn");
        });

        it("should reject checkIn in the past", async function () {
            const { usageMgr } = await loadFixture(deployFixture);
            const now = await time.latest();
            await expect(
                usageMgr.createSlot(now - 1, now + ONE_DAY, SEASON_PEAK, 1n)
            ).to.be.revertedWith("UsageManager: checkIn must be in the future");
        });

        it("should reject non-owner", async function () {
            const { usageMgr, user1 } = await loadFixture(deployFixture);
            const now = await time.latest();
            await expect(
                usageMgr.connect(user1).createSlot(now + ONE_DAY, now + 3 * ONE_DAY, SEASON_PEAK, 1n)
            ).to.be.revertedWithCustomError(usageMgr, "OwnableUnauthorizedAccount");
        });
    });

    // ─── bookSlot ────────────────────────────────────────────────────────────
    describe("bookSlot", function () {
        async function bookingFixture() {
            const base = await deployFixture();
            const now = await time.latest();
            // Create one peak slot and one off-peak slot for cycle 1
            await base.usageMgr.createSlot(now + ONE_DAY, now + 3 * ONE_DAY, SEASON_PEAK,    1n);
            await base.usageMgr.createSlot(now + ONE_DAY, now + 3 * ONE_DAY, SEASON_OFFPEAK, 1n);
            return { ...base, peakSlotId: 0n, offpeakSlotId: 1n };
        }

        it("should lock tokens on booking", async function () {
            const { token, usageMgr, user1, peakSlotId } = await loadFixture(bookingFixture);
            const balBefore = await token.availableBalance(user1.address);
            await usageMgr.connect(user1).bookSlot(peakSlotId, 1n);
            const balAfter = await token.availableBalance(user1.address);
            expect(balBefore - balAfter).to.equal(ethers.parseEther("200"));
        });

        it("should mark slot as booked", async function () {
            const { usageMgr, user1, peakSlotId } = await loadFixture(bookingFixture);
            await usageMgr.connect(user1).bookSlot(peakSlotId, 1n);
            const slot = await usageMgr.slots(peakSlotId);
            expect(slot.isBooked).to.equal(true);
            expect(slot.bookedBy).to.equal(user1.address);
        });

        it("should reject booking by user in YIELD mode", async function () {
            const { usageMgr, manager, user2, peakSlotId } = await loadFixture(bookingFixture);
            // user2 selected no mode — also rejectable
            await manager.connect(user2).selectMode(1n, MODE_YIELD);
            await expect(
                usageMgr.connect(user2).bookSlot(peakSlotId, 1n)
            ).to.be.revertedWith("UsageManager: must select USAGE mode before booking");
        });

        it("should reject booking by user with NONE mode", async function () {
            const { usageMgr, user2, peakSlotId } = await loadFixture(bookingFixture);
            await expect(
                usageMgr.connect(user2).bookSlot(peakSlotId, 1n)
            ).to.be.revertedWith("UsageManager: must select USAGE mode before booking");
        });

        it("should reject double booking of same slot", async function () {
            const { usageMgr, user1, peakSlotId } = await loadFixture(bookingFixture);
            await usageMgr.connect(user1).bookSlot(peakSlotId, 1n);
            await expect(
                usageMgr.connect(user1).bookSlot(peakSlotId, 1n)
            ).to.be.revertedWith("UsageManager: slot already booked");
        });

        it("should reject booking when cycleId mismatches slot's cycle", async function () {
            const { usageMgr, user1, peakSlotId } = await loadFixture(bookingFixture);
            await expect(
                usageMgr.connect(user1).bookSlot(peakSlotId, 2n)
            ).to.be.revertedWith("UsageManager: slot does not belong to this cycle");
        });

        it("should create a lock record", async function () {
            const { usageMgr, user1, peakSlotId } = await loadFixture(bookingFixture);
            await usageMgr.connect(user1).bookSlot(peakSlotId, 1n);
            expect(await usageMgr.getLockRecordCount(user1.address)).to.equal(1n);
        });
    });

    // ─── unlockAfterStay ─────────────────────────────────────────────────────
    describe("unlockAfterStay", function () {
        async function afterBookFixture() {
            const base = await deployFixture();
            const now = await time.latest();
            const checkOut = now + 3 * ONE_DAY;
            await base.usageMgr.createSlot(now + ONE_DAY, checkOut, SEASON_OFFPEAK, 1n);
            await base.usageMgr.connect(base.user1).bookSlot(0n, 1n);
            return { ...base, slotId: 0n, checkOut };
        }

        it("should unlock tokens after stay ends", async function () {
            const { token, usageMgr, user1, checkOut } = await loadFixture(afterBookFixture);
            const balBefore = await token.availableBalance(user1.address);

            await time.increaseTo(checkOut + 1);
            await usageMgr.unlockAfterStay(user1.address, 0n);

            const balAfter = await token.availableBalance(user1.address);
            expect(balAfter - balBefore).to.equal(ethers.parseEther("100")); // BASE_COST
        });

        it("should reject unlock before stay ends", async function () {
            const { usageMgr, user1 } = await loadFixture(afterBookFixture);
            await expect(
                usageMgr.unlockAfterStay(user1.address, 0n)
            ).to.be.revertedWith("UsageManager: stay not yet ended");
        });

        it("should reject double unlock", async function () {
            const { usageMgr, user1, checkOut } = await loadFixture(afterBookFixture);
            await time.increaseTo(checkOut + 1);
            await usageMgr.unlockAfterStay(user1.address, 0n);
            await expect(
                usageMgr.unlockAfterStay(user1.address, 0n)
            ).to.be.revertedWith("UsageManager: already unlocked");
        });
    });
});
