const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("RedemptionManager", function () {

    async function deployFixture() {
        const [owner, user1, user2, user3] = await ethers.getSigners();

        const VacationToken = await ethers.getContractFactory("VacationToken");
        const token = await VacationToken.deploy(owner.address);
        await token.waitForDeployment();

        const RedemptionManager = await ethers.getContractFactory("RedemptionManager");
        const redemption = await RedemptionManager.deploy(
            owner.address,
            await token.getAddress()
        );
        await redemption.waitForDeployment();

        // Authorize RedemptionManager to burn tokens
        await token.setAuthorizedLocker(await redemption.getAddress(), true);

        // Distribute: user1=300k, user2=200k, user3=100k, owner keeps 400k
        await token.transfer(user1.address, ethers.parseEther("300000"));
        await token.transfer(user2.address, ethers.parseEther("200000"));
        await token.transfer(user3.address, ethers.parseEther("100000"));

        return { token, redemption, owner, user1, user2, user3 };
    }

    // ─── openRedemption ───────────────────────────────────────────────────────
    describe("openRedemption", function () {
        it("should set redemptionPool and totalSupplyAtSnapshot", async function () {
            const { token, redemption, owner } = await loadFixture(deployFixture);
            const pool = ethers.parseEther("10");
            const supply = await token.totalSupply();

            await redemption.openRedemption({ value: pool });

            expect(await redemption.redemptionOpen()).to.equal(true);
            expect(await redemption.redemptionPool()).to.equal(pool);
            expect(await redemption.totalSupplyAtSnapshot()).to.equal(supply);
        });

        it("should emit RedemptionOpened event", async function () {
            const { token, redemption } = await loadFixture(deployFixture);
            const pool   = ethers.parseEther("10");
            const supply = await token.totalSupply();

            await expect(redemption.openRedemption({ value: pool }))
                .to.emit(redemption, "RedemptionOpened")
                .withArgs(pool, supply);
        });

        it("should reject zero pool", async function () {
            const { redemption } = await loadFixture(deployFixture);
            await expect(
                redemption.openRedemption({ value: 0n })
            ).to.be.revertedWith("RedemptionManager: zero redemption pool");
        });

        it("should reject double opening", async function () {
            const { redemption } = await loadFixture(deployFixture);
            await redemption.openRedemption({ value: ethers.parseEther("10") });
            await expect(
                redemption.openRedemption({ value: ethers.parseEther("1") })
            ).to.be.revertedWith("RedemptionManager: redemption already open");
        });

        it("should reject non-owner", async function () {
            const { redemption, user1 } = await loadFixture(deployFixture);
            await expect(
                redemption.connect(user1).openRedemption({ value: ethers.parseEther("1") })
            ).to.be.revertedWithCustomError(redemption, "OwnableUnauthorizedAccount");
        });
    });

    // ─── redeem ───────────────────────────────────────────────────────────────
    describe("redeem", function () {
        async function openedFixture() {
            const base = await deployFixture();
            const pool = ethers.parseEther("10");
            await base.redemption.openRedemption({ value: pool });
            return { ...base, pool };
        }

        it("user1 redeems proportional ETH (300k / 1M = 30%)", async function () {
            const { redemption, user1, pool } = await loadFixture(openedFixture);
            const tokens = ethers.parseEther("300000");
            const total  = ethers.parseEther("1000000");
            const expected = (pool * tokens) / total;  // 3 ETH

            const before  = await ethers.provider.getBalance(user1.address);
            const tx      = await redemption.connect(user1).redeem(tokens);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * tx.gasPrice;
            const after   = await ethers.provider.getBalance(user1.address);

            expect(after + gasCost - before).to.equal(expected);
        });

        it("should burn tokens on redemption", async function () {
            const { token, redemption, user1 } = await loadFixture(openedFixture);
            const tokens   = ethers.parseEther("300000");
            const supplyBefore = await token.totalSupply();
            await redemption.connect(user1).redeem(tokens);
            expect(await token.totalSupply()).to.equal(supplyBefore - tokens);
            expect(await token.balanceOf(user1.address)).to.equal(0n);
        });

        it("should emit Redeemed event", async function () {
            const { redemption, user1, pool } = await loadFixture(openedFixture);
            const tokens   = ethers.parseEther("300000");
            const total    = ethers.parseEther("1000000");
            const ethOut   = (pool * tokens) / total;

            await expect(redemption.connect(user1).redeem(tokens))
                .to.emit(redemption, "Redeemed")
                .withArgs(user1.address, tokens, ethOut);
        });

        it("should reject double redemption", async function () {
            const { redemption, user1 } = await loadFixture(openedFixture);
            await redemption.connect(user1).redeem(ethers.parseEther("300000"));
            await expect(
                redemption.connect(user1).redeem(1n)
            ).to.be.revertedWith("RedemptionManager: already redeemed");
        });

        it("should reject redemption when not open", async function () {
            const { redemption, user1 } = await loadFixture(deployFixture);
            await expect(
                redemption.connect(user1).redeem(ethers.parseEther("100"))
            ).to.be.revertedWith("RedemptionManager: redemption not open");
        });

        it("should reject zero amount", async function () {
            const { redemption, user1 } = await loadFixture(openedFixture);
            await expect(
                redemption.connect(user1).redeem(0n)
            ).to.be.revertedWith("RedemptionManager: zero token amount");
        });

        it("should reject redeem of more tokens than balance", async function () {
            const { redemption, user1 } = await loadFixture(openedFixture);
            await expect(
                redemption.connect(user1).redeem(ethers.parseEther("999999"))
            ).to.be.revertedWith("RedemptionManager: insufficient available balance");
        });
    });

    // ─── getRedemptionValue ───────────────────────────────────────────────────
    async function openedForValueFixture() {
        const base = await deployFixture();
        const pool = ethers.parseEther("10");
        await base.redemption.openRedemption({ value: pool });
        return { ...base, pool };
    }

    describe("getRedemptionValue", function () {
        it("should return proportional value", async function () {
            const { redemption, pool } = await loadFixture(openedForValueFixture);
            const tokens = ethers.parseEther("100000");
            const total  = ethers.parseEther("1000000");
            expect(await redemption.getRedemptionValue(tokens))
                .to.equal((pool * tokens) / total); // 1 ETH
        });
    });

    // ─── Conservation (Scenario E) ────────────────────────────────────────────
    describe("Redemption conservation", function () {
        it("total ETH paid out should be proportional to total tokens redeemed", async function () {
            const { redemption, token, user1, user2, user3 } =
                await loadFixture(deployFixture);
            const pool  = ethers.parseEther("10");
            const total = await token.totalSupply();
            await redemption.openRedemption({ value: pool });

            // user1=300k, user2=200k, user3=100k  → 600k out of 1000k
            const t1 = ethers.parseEther("300000");
            const t2 = ethers.parseEther("200000");
            const t3 = ethers.parseEther("100000");

            const e1 = (pool * t1) / total; // 3 ETH
            const e2 = (pool * t2) / total; // 2 ETH
            const e3 = (pool * t3) / total; // 1 ETH

            expect(e1).to.equal(ethers.parseEther("3"));
            expect(e2).to.equal(ethers.parseEther("2"));
            expect(e3).to.equal(ethers.parseEther("1"));

            await redemption.connect(user1).redeem(t1);
            await redemption.connect(user2).redeem(t2);
            await redemption.connect(user3).redeem(t3);

            // Remaining pool = 4 ETH (owner's 400k not redeemed)
            expect(await ethers.provider.getBalance(await redemption.getAddress()))
                .to.equal(ethers.parseEther("4"));
        });
    });
});
