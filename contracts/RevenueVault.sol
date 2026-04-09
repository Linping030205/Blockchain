// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./VacationToken.sol";
import "./AllocationManager.sol";

/**
 * @title RevenueVault
 * @notice Collects rental income and distributes it proportionally to yield-mode holders (§3.2, §4.5).
 *
 *  Revenue model:
 *    - Admin (SPV) deposits ETH rental income for a finalized cycle.
 *    - Each holder who selected YIELD mode claims their share:
 *        userShare = (cycleRevenue × userYieldShares) / totalYieldShares
 *    - Shares come from AllocationManager snapshots → prevents last-minute manipulation.
 *    - Checks-Effects-Interactions + ReentrancyGuard against re-entrancy (OWASP A01).
 *
 *  Incentive alignment (§3.4):
 *    When more holders choose USAGE mode, the yield pool is divided among fewer shares,
 *    increasing per-token yield for remaining YIELD holders.
 */
contract RevenueVault is Ownable, ReentrancyGuard {
    VacationToken     public immutable vacationToken;
    AllocationManager public immutable allocationManager;

    /// @notice Total ETH deposited by admin per cycle.
    mapping(uint256 => uint256) public cycleRevenue;

    /// @notice Tracks whether a user has already claimed for a given cycle.
    mapping(uint256 => mapping(address => bool)) public claimed;

    event RevenueDeposited(uint256 indexed cycleId, uint256 amount);
    event RevenueClaimed(uint256 indexed cycleId, address indexed user, uint256 amount);

    constructor(
        address initialOwner,
        address _vacationToken,
        address _allocationManager
    ) Ownable(initialOwner) {
        vacationToken     = VacationToken(_vacationToken);
        allocationManager = AllocationManager(_allocationManager);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit ETH rental income for a finalized cycle.
     *         Can be called multiple times (amounts accumulate) to cover partial/delayed income.
     * @param cycleId  A finalized settlement cycle.
     */
    function depositRevenue(uint256 cycleId) external payable onlyOwner {
        require(msg.value > 0, "RevenueVault: zero deposit");
        require(
            allocationManager.isCycleFinalized(cycleId),
            "RevenueVault: cycle not yet finalized"
        );

        cycleRevenue[cycleId] += msg.value;
        emit RevenueDeposited(cycleId, msg.value);
    }

    // ─── Holder ───────────────────────────────────────────────────────────────

    /**
     * @notice Claim proportional rental income for a finalized cycle.
     *         Follows Checks-Effects-Interactions pattern.
     * @param cycleId  Cycle for which to claim income.
     */
    function claim(uint256 cycleId) external nonReentrant {
        require(
            allocationManager.isCycleFinalized(cycleId),
            "RevenueVault: cycle not finalized"
        );
        require(!claimed[cycleId][msg.sender], "RevenueVault: already claimed");

        uint256 userShares  = allocationManager.getUserYieldShares(cycleId, msg.sender);
        require(userShares > 0, "RevenueVault: no yield shares registered for this cycle");

        uint256 totalShares = allocationManager.getCycleTotalYieldShares(cycleId);
        uint256 totalRev    = cycleRevenue[cycleId];
        require(totalRev > 0, "RevenueVault: no revenue deposited for this cycle");

        // Multiply before divide to minimise precision loss.
        uint256 userRevenue = (totalRev * userShares) / totalShares;
        require(userRevenue > 0, "RevenueVault: claimable amount rounds to zero");

        // Effects before Interaction (CEI pattern).
        claimed[cycleId][msg.sender] = true;

        (bool success, ) = payable(msg.sender).call{value: userRevenue}("");
        require(success, "RevenueVault: ETH transfer failed");

        emit RevenueClaimed(cycleId, msg.sender, userRevenue);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function claimableAmount(uint256 cycleId, address user) external view returns (uint256) {
        if (claimed[cycleId][user]) return 0;
        uint256 userShares  = allocationManager.getUserYieldShares(cycleId, user);
        uint256 totalShares = allocationManager.getCycleTotalYieldShares(cycleId);
        uint256 totalRev    = cycleRevenue[cycleId];
        if (userShares == 0 || totalShares == 0 || totalRev == 0) return 0;
        return (totalRev * userShares) / totalShares;
    }
}
