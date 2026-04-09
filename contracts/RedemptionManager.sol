// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./VacationToken.sol";

/**
 * @title RedemptionManager
 * @notice Provides a clear exit path for token holders when the project terminates (§3.6, §4.1).
 *
 *  Exit mechanism:
 *    - Admin (SPV) opens redemption by depositing total sale/liquidation proceeds (ETH).
 *    - Each holder calls redeem(tokenAmount):
 *        ethPayout = (redemptionPool × tokenAmount) / totalSupplyAtSnapshot
 *    - Tokens are burned upon redemption, locking the payout permanently.
 *    - totalSupplyAtSnapshot is taken at openRedemption to ensure consistent proportions.
 *
 *  Security:
 *    - ReentrancyGuard + CEI pattern (OWASP A01).
 *    - hasRedeemed mapping prevents double redemption.
 */
contract RedemptionManager is Ownable, ReentrancyGuard {
    VacationToken public immutable vacationToken;

    bool    public redemptionOpen;
    uint256 public redemptionPool;
    uint256 public totalSupplyAtSnapshot;

    /// @notice Tracks whether a user has already redeemed (prevents double-redemption).
    mapping(address => bool) public hasRedeemed;

    event RedemptionOpened(uint256 totalPool, uint256 totalSupply);
    event Redeemed(address indexed user, uint256 tokenAmount, uint256 ethAmount);

    constructor(address initialOwner, address _vacationToken) Ownable(initialOwner) {
        vacationToken = VacationToken(_vacationToken);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /**
     * @notice Open the redemption window by depositing the total liquidation pool.
     *         Takes a snapshot of total token supply at this moment.
     */
    function openRedemption() external payable onlyOwner {
        require(!redemptionOpen, "RedemptionManager: redemption already open");
        require(msg.value > 0, "RedemptionManager: zero redemption pool");

        redemptionOpen          = true;
        redemptionPool          = msg.value;
        totalSupplyAtSnapshot   = vacationToken.totalSupply();

        emit RedemptionOpened(redemptionPool, totalSupplyAtSnapshot);
    }

    // ─── Holder ───────────────────────────────────────────────────────────────

    /**
     * @notice Redeem `tokenAmount` tokens for proportional ETH from the redemption pool.
     *         Tokens must be unlocked (not currently locked for usage).
     *         Tokens are burned; ETH is sent immediately.
     * @param tokenAmount Number of VCT tokens to redeem.
     */
    function redeem(uint256 tokenAmount) external nonReentrant {
        require(redemptionOpen, "RedemptionManager: redemption not open");
        require(!hasRedeemed[msg.sender], "RedemptionManager: already redeemed");
        require(tokenAmount > 0, "RedemptionManager: zero token amount");
        require(
            vacationToken.availableBalance(msg.sender) >= tokenAmount,
            "RedemptionManager: insufficient available balance"
        );
        require(totalSupplyAtSnapshot > 0, "RedemptionManager: invalid snapshot");

        uint256 ethAmount = (redemptionPool * tokenAmount) / totalSupplyAtSnapshot;
        require(ethAmount > 0, "RedemptionManager: redemption value rounds to zero");

        // Effects before Interactions (CEI pattern).
        hasRedeemed[msg.sender] = true;

        // Burn tokens — authorised by VacationToken.setAuthorizedLocker.
        vacationToken.burn(msg.sender, tokenAmount);

        (bool success, ) = payable(msg.sender).call{value: ethAmount}("");
        require(success, "RedemptionManager: ETH transfer failed");

        emit Redeemed(msg.sender, tokenAmount, ethAmount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getRedemptionValue(uint256 tokenAmount) external view returns (uint256) {
        if (!redemptionOpen || totalSupplyAtSnapshot == 0) return 0;
        return (redemptionPool * tokenAmount) / totalSupplyAtSnapshot;
    }
}
