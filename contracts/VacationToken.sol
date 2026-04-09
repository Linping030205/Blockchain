// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VacationToken (VCT)
 * @notice ERC-20 fungible token representing fractional ownership of a vacation property.
 *         - Fixed supply: 1,000,000 VCT minted once at deployment (no further minting).
 *         - Locking mechanism: authorized contracts (UsageManager, RedemptionManager)
 *           can lock tokens to enforce the usage-right / yield trade-off described in §3.2–3.6.
 *         - Locked tokens cannot be transferred, preventing double-use.
 *         Corresponds to report sections: 3.1, 3.4, 3.5, 3.6
 */
contract VacationToken is ERC20, Ownable {
    /// @notice Total fixed supply — 1 million tokens with 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000 * 10 ** 18;

    /// @notice Amount of tokens currently locked per user (not transferable / not usable).
    mapping(address => uint256) public lockedBalance;

    /// @notice Contracts authorised to call lockTokens / unlockTokens / burn.
    mapping(address => bool) public authorizedLockers;

    event TokensLocked(address indexed user, uint256 amount);
    event TokensUnlocked(address indexed user, uint256 amount);
    event LockerAuthorized(address indexed locker, bool status);

    constructor(address initialOwner)
        ERC20("VacationToken", "VCT")
        Ownable(initialOwner)
    {
        // One-time mint — all tokens go to the issuer (SPV / owner).
        _mint(initialOwner, TOTAL_SUPPLY);
    }

    // ─── Access control ───────────────────────────────────────────────────────

    modifier onlyAuthorizedLocker() {
        require(authorizedLockers[msg.sender], "VCT: not authorized locker");
        _;
    }

    function setAuthorizedLocker(address locker, bool status) external onlyOwner {
        authorizedLockers[locker] = status;
        emit LockerAuthorized(locker, status);
    }

    // ─── Locking / unlocking ──────────────────────────────────────────────────

    /**
     * @notice Lock `amount` tokens for `user`.
     *         Called by UsageManager when a user exercises a usage right (§3.3, §3.6).
     */
    function lockTokens(address user, uint256 amount) external onlyAuthorizedLocker {
        require(availableBalance(user) >= amount, "VCT: insufficient available balance");
        lockedBalance[user] += amount;
        emit TokensLocked(user, amount);
    }

    /**
     * @notice Unlock `amount` tokens for `user` after the usage period expires.
     *         Called by UsageManager once check-out time has passed (§3.6 time-lock).
     */
    function unlockTokens(address user, uint256 amount) external onlyAuthorizedLocker {
        require(lockedBalance[user] >= amount, "VCT: insufficient locked balance");
        lockedBalance[user] -= amount;
        emit TokensUnlocked(user, amount);
    }

    /**
     * @notice Burn `amount` tokens from `user` upon redemption (§3.6).
     *         Called by RedemptionManager.
     */
    function burn(address user, uint256 amount) external onlyAuthorizedLocker {
        require(availableBalance(user) >= amount, "VCT: insufficient available balance to burn");
        _burn(user, amount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    /// @notice Tokens available for transfer / yield participation / usage booking.
    function availableBalance(address user) public view returns (uint256) {
        return balanceOf(user) - lockedBalance[user];
    }

    // ─── ERC-20 override — prevent transfer of locked tokens ─────────────────

    /**
     * @dev Overrides OpenZeppelin ERC-20 v5 `_update` (called by _transfer, _mint, _burn).
     *      For transfers (from != address(0)), the sender must have enough available tokens.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            require(
                availableBalance(from) >= value,
                "VCT: transfer amount exceeds available (unlocked) balance"
            );
        }
        super._update(from, to, value);
    }
}
