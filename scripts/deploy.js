const { ethers } = require("hardhat");

/**
 * deploy.js
 * Deploys the full vacation-property tokenisation system to the target network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network localhost
 */
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log(
        "Account balance:",
        ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
        "ETH\n"
    );

    // ── 1. VacationToken ──────────────────────────────────────────────────────
    const VacationToken = await ethers.getContractFactory("VacationToken");
    const token = await VacationToken.deploy(deployer.address);
    await token.waitForDeployment();
    console.log("VacationToken  deployed:", await token.getAddress());
    console.log(
        "  Total supply:",
        ethers.formatEther(await token.totalSupply()),
        "VCT"
    );

    // ── 2. AllocationManager ─────────────────────────────────────────────────
    const AllocationManager = await ethers.getContractFactory("AllocationManager");
    const allocMgr = await AllocationManager.deploy(deployer.address, await token.getAddress());
    await allocMgr.waitForDeployment();
    console.log("AllocationManager deployed:", await allocMgr.getAddress());

    // ── 3. UsageManager ───────────────────────────────────────────────────────
    const UsageManager = await ethers.getContractFactory("UsageManager");
    const usageMgr = await UsageManager.deploy(
        deployer.address,
        await token.getAddress(),
        await allocMgr.getAddress()
    );
    await usageMgr.waitForDeployment();
    console.log("UsageManager   deployed:", await usageMgr.getAddress());

    // ── 4. RevenueVault ───────────────────────────────────────────────────────
    const RevenueVault = await ethers.getContractFactory("RevenueVault");
    const vault = await RevenueVault.deploy(
        deployer.address,
        await token.getAddress(),
        await allocMgr.getAddress()
    );
    await vault.waitForDeployment();
    console.log("RevenueVault   deployed:", await vault.getAddress());

    // ── 5. RedemptionManager ─────────────────────────────────────────────────
    const RedemptionManager = await ethers.getContractFactory("RedemptionManager");
    const redemption = await RedemptionManager.deploy(
        deployer.address,
        await token.getAddress()
    );
    await redemption.waitForDeployment();
    console.log("RedemptionManager deployed:", await redemption.getAddress());

    // ── 6. SimpleLiquidityPool ────────────────────────────────────────────────
    const SimpleLiquidityPool = await ethers.getContractFactory("SimpleLiquidityPool");
    const pool = await SimpleLiquidityPool.deploy(
        deployer.address,
        await token.getAddress()
    );
    await pool.waitForDeployment();
    console.log("SimpleLiquidityPool deployed:", await pool.getAddress());

    // ── 7. Wire up authorised lockers ─────────────────────────────────────────
    console.log("\nSetting authorized lockers...");
    await (await token.setAuthorizedLocker(await usageMgr.getAddress(),   true)).wait();
    console.log("  UsageManager   authorised ✓");
    await (await token.setAuthorizedLocker(await redemption.getAddress(), true)).wait();
    console.log("  RedemptionManager authorised ✓");

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("\n─── Deployment complete ───────────────────────────────────────────");
    console.log({
        VacationToken:      await token.getAddress(),
        AllocationManager:  await allocMgr.getAddress(),
        UsageManager:       await usageMgr.getAddress(),
        RevenueVault:       await vault.getAddress(),
        RedemptionManager:  await redemption.getAddress(),
        SimpleLiquidityPool: await pool.getAddress(),
    });

    console.log("\nNext steps:");
    console.log("  1. Distribute VCT tokens to investors via token.transfer()");
    console.log("  2. Call allocMgr.startCycle(duration) to begin cycle 1");
    console.log("  3. Investors call allocMgr.selectMode(cycleId, YIELD|USAGE)");
    console.log("  4. Create usage slots via usageMgr.createSlot(...)");
    console.log("  5. USAGE holders book slots; YIELD holders await revenue");
    console.log("  6. After cycle: finalizeCycle → depositRevenue → claim");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
