const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("VacationToken", function () {

    // ─── Shared fixture ───────────────────────────────────────────────────────
    async function deployFixture() {
        const [owner, user1, user2, locker] = await ethers.getSigners();
        const VacationToken = await ethers.getContractFactory("VacationToken");
        const token = await VacationToken.deploy(owner.address);
        await token.waitForDeployment();
        return { token, owner, user1, user2, locker };
    }

    // ─── Deployment ───────────────────────────────────────────────────────────
    describe("Deployment", function () {
        it("should have correct name and symbol", async function () {
            const { token } = await loadFixture(deployFixture);
            expect(await token.name()).to.equal("VacationToken");
            expect(await token.symbol()).to.equal("VCT");
        });

        it("should have 18 decimals", async function () {
            const { token } = await loadFixture(deployFixture);
            expect(await token.decimals()).to.equal(18);
        });

        it("should mint entire fixed supply to owner", async function () {
            const { token, owner } = await loadFixture(deployFixture);
            const totalSupply = await token.TOTAL_SUPPLY();
            expect(await token.totalSupply()).to.equal(totalSupply);
            expect(await token.balanceOf(owner.address)).to.equal(totalSupply);
        });

        it("TOTAL_SUPPLY should be 1,000,000 tokens", async function () {
            const { token } = await loadFixture(deployFixture);
            expect(await token.TOTAL_SUPPLY()).to.equal(ethers.parseEther("1000000"));
        });
    });

    // ─── Transfers ────────────────────────────────────────────────────────────
    describe("Transfers", function () {
        it("should transfer tokens between accounts", async function () {
            const { token, owner, user1 } = await loadFixture(deployFixture);
            const amount = ethers.parseEther("1000");
            await token.transfer(user1.address, amount);
            expect(await token.balanceOf(user1.address)).to.equal(amount);
        });

        it("should fail to transfer more than available balance", async function () {
            const { token, owner, user1 } = await loadFixture(deployFixture);
            const supply = await token.totalSupply();
            await expect(
                token.transfer(user1.address, supply + 1n)
            ).to.be.revertedWith("VCT: transfer amount exceeds available (unlocked) balance");
        });

        it("should correctly update balances on transfer", async function () {
            const { token, owner, user1, user2 } = await loadFixture(deployFixture);
            const amount = ethers.parseEther("5000");
            const ownerInitial = await token.balanceOf(owner.address);
            await token.transfer(user1.address, amount);
            expect(await token.balanceOf(owner.address)).to.equal(ownerInitial - amount);
            await token.connect(user1).transfer(user2.address, amount);
            expect(await token.balanceOf(user2.address)).to.equal(amount);
        });
    });

    // ─── Authorized locker setup ──────────────────────────────────────────────
    describe("setAuthorizedLocker", function () {
        it("should set authorized locker", async function () {
            const { token, owner, locker } = await loadFixture(deployFixture);
            await token.setAuthorizedLocker(locker.address, true);
            expect(await token.authorizedLockers(locker.address)).to.equal(true);
        });

        it("should revoke authorized locker", async function () {
            const { token, owner, locker } = await loadFixture(deployFixture);
            await token.setAuthorizedLocker(locker.address, true);
            await token.setAuthorizedLocker(locker.address, false);
            expect(await token.authorizedLockers(locker.address)).to.equal(false);
        });

        it("should reject non-owner from setting locker", async function () {
            const { token, user1, locker } = await loadFixture(deployFixture);
            await expect(
                token.connect(user1).setAuthorizedLocker(locker.address, true)
            ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
        });
    });

    // ─── Locking ──────────────────────────────────────────────────────────────
    describe("lockTokens", function () {
        it("should lock tokens and reduce available balance", async function () {
            const { token, owner, user1, locker } = await loadFixture(deployFixture);
            const amount = ethers.parseEther("500");
            await token.transfer(user1.address, ethers.parseEther("1000"));
            await token.setAuthorizedLocker(locker.address, true);

            await token.connect(locker).lockTokens(user1.address, amount);

            expect(await token.lockedBalance(user1.address)).to.equal(amount);
            expect(await token.availableBalance(user1.address)).to.equal(ethers.parseEther("500"));
            expect(await token.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
        });

        it("should prevent transfer of locked tokens", async function () {
            const { token, owner, user1, user2, locker } = await loadFixture(deployFixture);
            const amount = ethers.parseEther("1000");
            await token.transfer(user1.address, amount);
            await token.setAuthorizedLocker(locker.address, true);

            // Lock all tokens
            await token.connect(locker).lockTokens(user1.address, amount);

            await expect(
                token.connect(user1).transfer(user2.address, 1n)
            ).to.be.revertedWith("VCT: transfer amount exceeds available (unlocked) balance");
        });

        it("should reject lock if insufficient available balance", async function () {
            const { token, owner, user1, locker } = await loadFixture(deployFixture);
            await token.transfer(user1.address, ethers.parseEther("100"));
            await token.setAuthorizedLocker(locker.address, true);

            await expect(
                token.connect(locker).lockTokens(user1.address, ethers.parseEther("200"))
            ).to.be.revertedWith("VCT: insufficient available balance");
        });

        it("should reject lock from unauthorized caller", async function () {
            const { token, user1, user2 } = await loadFixture(deployFixture);
            await expect(
                token.connect(user1).lockTokens(user2.address, 1n)
            ).to.be.revertedWith("VCT: not authorized locker");
        });
    });

    // ─── Unlocking ────────────────────────────────────────────────────────────
    describe("unlockTokens", function () {
        it("should unlock tokens and restore available balance", async function () {
            const { token, owner, user1, locker } = await loadFixture(deployFixture);
            const amount = ethers.parseEther("500");
            await token.transfer(user1.address, ethers.parseEther("1000"));
            await token.setAuthorizedLocker(locker.address, true);

            await token.connect(locker).lockTokens(user1.address, amount);
            await token.connect(locker).unlockTokens(user1.address, amount);

            expect(await token.lockedBalance(user1.address)).to.equal(0n);
            expect(await token.availableBalance(user1.address)).to.equal(ethers.parseEther("1000"));
        });

        it("should reject unlock if locked balance insufficient", async function () {
            const { token, owner, user1, locker } = await loadFixture(deployFixture);
            await token.transfer(user1.address, ethers.parseEther("100"));
            await token.setAuthorizedLocker(locker.address, true);
            await token.connect(locker).lockTokens(user1.address, ethers.parseEther("100"));

            await expect(
                token.connect(locker).unlockTokens(user1.address, ethers.parseEther("200"))
            ).to.be.revertedWith("VCT: insufficient locked balance");
        });
    });

    // ─── Burn ─────────────────────────────────────────────────────────────────
    describe("burn", function () {
        it("should burn tokens and reduce total supply", async function () {
            const { token, owner, user1, locker } = await loadFixture(deployFixture);
            const amount = ethers.parseEther("500");
            await token.transfer(user1.address, amount);
            await token.setAuthorizedLocker(locker.address, true);

            const supplyBefore = await token.totalSupply();
            await token.connect(locker).burn(user1.address, amount);

            expect(await token.totalSupply()).to.equal(supplyBefore - amount);
            expect(await token.balanceOf(user1.address)).to.equal(0n);
        });

        it("should reject burn if insufficient available balance", async function () {
            const { token, owner, user1, locker } = await loadFixture(deployFixture);
            const amount = ethers.parseEther("1000");
            await token.transfer(user1.address, amount);
            await token.setAuthorizedLocker(locker.address, true);

            // Lock all tokens, then try to burn
            await token.connect(locker).lockTokens(user1.address, amount);
            await expect(
                token.connect(locker).burn(user1.address, amount)
            ).to.be.revertedWith("VCT: insufficient available balance to burn");
        });

        it("should reject burn from unauthorized caller", async function () {
            const { token, user1, user2 } = await loadFixture(deployFixture);
            await expect(
                token.connect(user1).burn(user2.address, 1n)
            ).to.be.revertedWith("VCT: not authorized locker");
        });
    });
});
