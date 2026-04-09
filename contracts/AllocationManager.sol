// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./VacationToken.sol";

/**
 * @title AllocationManager
 * @notice Implements the Dual-Layer Mechanism — Allocation Choice Layer (§3.3).
 *
 *  Each settlement cycle (e.g. one month), token holders choose ONE of:
 *    - YIELD  : participate in rental-income distribution for this cycle.
 *    - USAGE  : eligible to exchange tokens for usage rights via UsageManager.
 *
 *  Yield shares are recorded as a snapshot of the user's availableBalance at
 *  selection time, preventing last-minute manipulation (§3.3, §4.5).
 *
 *  Workflow:
 *    1. Owner calls startCycle(duration)
 *    2. Holders call selectMode(cycleId, YIELD | USAGE) — one-time per cycle
 *    3. Owner calls finalizeCycle(cycleId) after endTime
 *    4. RevenueVault uses stored yieldShares for distribution
 */
contract AllocationManager is Ownable {
    enum Mode { NONE, YIELD, USAGE }

    struct Cycle {
        uint256 cycleId;
        uint256 startTime;
        uint256 endTime;
        bool    finalized;
        uint256 totalYieldShares; // sum of yield-mode holders' snapshots
    }

    VacationToken public immutable vacationToken;

    uint256 public currentCycleId;

    /// @notice cycleId → Cycle metadata
    mapping(uint256 => Cycle) public cycles;

    /// @notice cycleId → user → selected mode
    mapping(uint256 => mapping(address => Mode)) public userMode;

    /// @notice cycleId → user → snapshotted availableBalance at selection time
    mapping(uint256 => mapping(address => uint256)) public yieldShares;

    event CycleStarted(uint256 indexed cycleId, uint256 startTime, uint256 endTime);
    event CycleFinalized(uint256 indexed cycleId, uint256 totalYieldShares);
    event ModeSelected(uint256 indexed cycleId, address indexed user, Mode mode, uint256 shares);

    constructor(address initialOwner, address _vacationToken) Ownable(initialOwner) {
        vacationToken = VacationToken(_vacationToken);
    }

    // ─── Admin functions ──────────────────────────────────────────────────────

    /**
     * @notice Start a new settlement cycle of `duration` seconds.
     *         Requires the previous cycle (if any) to be finalized.
     */
    function startCycle(uint256 duration) external onlyOwner returns (uint256) {
        require(duration > 0, "AllocationManager: zero duration");
        if (currentCycleId > 0) {
            require(
                cycles[currentCycleId].finalized,
                "AllocationManager: previous cycle not finalized"
            );
        }

        currentCycleId++;
        cycles[currentCycleId] = Cycle({
            cycleId:         currentCycleId,
            startTime:       block.timestamp,
            endTime:         block.timestamp + duration,
            finalized:       false,
            totalYieldShares: 0
        });

        emit CycleStarted(currentCycleId, block.timestamp, block.timestamp + duration);
        return currentCycleId;
    }

    /**
     * @notice Mark cycle as finalized after endTime.
     *         After this, RevenueVault accepts deposits for this cycleId.
     */
    function finalizeCycle(uint256 cycleId) external onlyOwner {
        Cycle storage cycle = cycles[cycleId];
        require(cycle.cycleId == cycleId && cycleId > 0, "AllocationManager: invalid cycle");
        require(!cycle.finalized, "AllocationManager: already finalized");
        require(block.timestamp > cycle.endTime, "AllocationManager: cycle not ended yet");

        cycle.finalized = true;
        emit CycleFinalized(cycleId, cycle.totalYieldShares);
    }

    // ─── Holder function ──────────────────────────────────────────────────────

    /**
     * @notice Choose yield or usage mode for an active cycle (one-time per cycle).
     *         Yield shares are snapshotted from availableBalance at call time.
     * @param cycleId  The active cycle to register for.
     * @param mode     Mode.YIELD or Mode.USAGE.
     */
    function selectMode(uint256 cycleId, Mode mode) external {
        Cycle storage cycle = cycles[cycleId];
        require(cycle.cycleId == cycleId && cycleId > 0, "AllocationManager: invalid cycle");
        require(!cycle.finalized, "AllocationManager: cycle already finalized");
        require(
            block.timestamp >= cycle.startTime && block.timestamp <= cycle.endTime,
            "AllocationManager: cycle not active"
        );
        require(
            mode == Mode.YIELD || mode == Mode.USAGE,
            "AllocationManager: invalid mode"
        );
        require(
            userMode[cycleId][msg.sender] == Mode.NONE,
            "AllocationManager: mode already selected for this cycle"
        );

        uint256 userShares = vacationToken.availableBalance(msg.sender);
        require(userShares > 0, "AllocationManager: no available tokens");

        userMode[cycleId][msg.sender] = mode;

        if (mode == Mode.YIELD) {
            // Incentive alignment: only yield-mode shares divide the revenue pool.
            // When more holders choose USAGE, remaining yield holders earn proportionally more (§3.4).
            yieldShares[cycleId][msg.sender]  = userShares;
            cycles[cycleId].totalYieldShares += userShares;
        }

        emit ModeSelected(cycleId, msg.sender, mode, userShares);
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function getUserMode(uint256 cycleId, address user) external view returns (Mode) {
        return userMode[cycleId][user];
    }

    function getUserYieldShares(uint256 cycleId, address user) external view returns (uint256) {
        return yieldShares[cycleId][user];
    }

    function getCycleTotalYieldShares(uint256 cycleId) external view returns (uint256) {
        return cycles[cycleId].totalYieldShares;
    }

    function isCycleFinalized(uint256 cycleId) external view returns (bool) {
        return cycles[cycleId].finalized;
    }

    function getCycle(uint256 cycleId)
        external
        view
        returns (uint256 startTime, uint256 endTime, bool finalized, uint256 totalYieldShares)
    {
        Cycle storage c = cycles[cycleId];
        return (c.startTime, c.endTime, c.finalized, c.totalYieldShares);
    }
}
