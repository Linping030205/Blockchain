// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./VacationToken.sol";
import "./AllocationManager.sol";

/**
 * @title UsageManager
 * @notice Implements the Dual-Layer Mechanism — Dynamic Pricing Layer (§3.3).
 *
 *  Holders who selected USAGE mode for a cycle may book time slots.
 *  Booking locks tokens (not burns) for the stay duration; they unlock automatically
 *  once check-out time passes (§3.6 time-lock replaces burning).
 *
 *  Dynamic pricing:
 *    - OFF_PEAK slot: BASE_COST = 100 VCT
 *    - PEAK    slot: PEAK_COST = 200 VCT  (2× scarce peak demand, §3.3)
 *
 *  Booking a slot implies forfeiting rental income for that period (§3.2).
 *
 *  Workflow:
 *    1. Owner creates slots via createSlot(checkIn, checkOut, season, cycleId)
 *    2. Holder (in USAGE mode) calls bookSlot(slotId, cycleId)  → tokens locked
 *    3. After checkOut, anyone calls unlockAfterStay(user, lockIndex) → tokens freed
 */
contract UsageManager is Ownable, ReentrancyGuard {
    enum SeasonType { OFF_PEAK, PEAK }

    struct TimeSlot {
        uint256    slotId;
        uint256    checkIn;
        uint256    checkOut;
        SeasonType season;
        uint256    tokenCost;
        address    bookedBy;
        bool       isBooked;
        uint256    cycleId;
    }

    struct LockRecord {
        uint256 amount;
        uint256 lockUntil; // checkOut timestamp
        uint256 slotId;
        bool    unlocked;
    }

    // ─── Constants (dynamic pricing) ─────────────────────────────────────────

    /// @notice Tokens required to book an off-peak slot (100 VCT).
    uint256 public constant BASE_COST = 100 * 10 ** 18;

    /// @notice Tokens required to book a peak-season slot (200 VCT — 2× off-peak).
    uint256 public constant PEAK_COST = 200 * 10 ** 18;

    // ─── State ────────────────────────────────────────────────────────────────

    VacationToken     public immutable vacationToken;
    AllocationManager public immutable allocationManager;

    uint256 public nextSlotId;

    mapping(uint256 => TimeSlot)    public slots;
    mapping(address => LockRecord[]) public lockRecords;

    // ─── Events ───────────────────────────────────────────────────────────────

    event SlotCreated(
        uint256 indexed slotId,
        uint256 checkIn,
        uint256 checkOut,
        SeasonType season,
        uint256 tokenCost,
        uint256 cycleId
    );
    event SlotBooked(
        uint256 indexed slotId,
        address indexed booker,
        uint256 cycleId,
        uint256 tokenCost
    );
    event TokensUnlockedAfterStay(address indexed user, uint256 amount, uint256 slotId);

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
     * @notice Create an available time slot for a given cycle.
     * @param checkIn   Unix timestamp for start of stay.
     * @param checkOut  Unix timestamp for end of stay (must be > checkIn).
     * @param season    SeasonType.PEAK or SeasonType.OFF_PEAK.
     * @param cycleId   Settlement cycle this slot belongs to.
     */
    function createSlot(
        uint256    checkIn,
        uint256    checkOut,
        SeasonType season,
        uint256    cycleId
    ) external onlyOwner returns (uint256) {
        require(checkOut > checkIn, "UsageManager: checkOut must be after checkIn");
        require(checkIn  > block.timestamp, "UsageManager: checkIn must be in the future");

        uint256 tokenCost = (season == SeasonType.PEAK) ? PEAK_COST : BASE_COST;
        uint256 slotId    = nextSlotId++;

        slots[slotId] = TimeSlot({
            slotId:    slotId,
            checkIn:   checkIn,
            checkOut:  checkOut,
            season:    season,
            tokenCost: tokenCost,
            bookedBy:  address(0),
            isBooked:  false,
            cycleId:   cycleId
        });

        emit SlotCreated(slotId, checkIn, checkOut, season, tokenCost, cycleId);
        return slotId;
    }

    // ─── Holder ───────────────────────────────────────────────────────────────

    /**
     * @notice Book a time slot.
     *         Caller must have selected USAGE mode for `cycleId` in AllocationManager.
     *         Tokens equal to `slot.tokenCost` are locked until `slot.checkOut`.
     * @param slotId   Slot to book.
     * @param cycleId  Must match the slot's registered cycle.
     */
    function bookSlot(uint256 slotId, uint256 cycleId) external nonReentrant {
        TimeSlot storage slot = slots[slotId];
        require(!slot.isBooked, "UsageManager: slot already booked");
        require(slot.slotId == slotId, "UsageManager: invalid slot");
        require(slot.cycleId == cycleId, "UsageManager: slot does not belong to this cycle");
        require(slot.checkIn > block.timestamp, "UsageManager: check-in has already passed");

        AllocationManager.Mode mode = allocationManager.getUserMode(cycleId, msg.sender);
        require(
            mode == AllocationManager.Mode.USAGE,
            "UsageManager: must select USAGE mode before booking"
        );

        uint256 cost = slot.tokenCost;
        require(
            vacationToken.availableBalance(msg.sender) >= cost,
            "UsageManager: insufficient available tokens"
        );

        // Lock tokens for the duration of the stay.
        vacationToken.lockTokens(msg.sender, cost);

        slot.isBooked  = true;
        slot.bookedBy  = msg.sender;

        lockRecords[msg.sender].push(LockRecord({
            amount:    cost,
            lockUntil: slot.checkOut,
            slotId:    slotId,
            unlocked:  false
        }));

        emit SlotBooked(slotId, msg.sender, cycleId, cost);
    }

    /**
     * @notice Unlock tokens after the stay has ended (time-lock expiry, §3.6).
     *         Can be called by anyone on behalf of the user.
     * @param user       The token holder whose lock should be released.
     * @param lockIndex  Index in lockRecords[user] array.
     */
    function unlockAfterStay(address user, uint256 lockIndex) external nonReentrant {
        LockRecord storage record = lockRecords[user][lockIndex];
        require(!record.unlocked, "UsageManager: already unlocked");
        require(record.amount > 0, "UsageManager: no lock record");
        require(block.timestamp >= record.lockUntil, "UsageManager: stay not yet ended");

        record.unlocked = true;
        vacationToken.unlockTokens(user, record.amount);

        emit TokensUnlockedAfterStay(user, record.amount, record.slotId);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getLockRecordCount(address user) external view returns (uint256) {
        return lockRecords[user].length;
    }

    function getSlotCost(SeasonType season) external pure returns (uint256) {
        return (season == SeasonType.PEAK) ? PEAK_COST : BASE_COST;
    }

    function isSlotAvailable(uint256 slotId) external view returns (bool) {
        return !slots[slotId].isBooked && slots[slotId].checkIn > block.timestamp;
    }
}
