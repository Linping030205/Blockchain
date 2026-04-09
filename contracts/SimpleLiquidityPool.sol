// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./VacationToken.sol";

/**
 * @title SimpleLiquidityPool
 * @notice Constant-Product Market Maker (CPMM, x·y = k) for VCT ↔ ETH (§4.2–4.4).
 *
 *  Demonstrates:
 *    ① Secondary market transferability — anyone can swap VCT for ETH and vice versa.
 *    ② Continuous price discovery via AMM algorithm (§4.3).
 *    ③ Price impact / slippage — large trades move the price along the curve (§4.4).
 *    ④ Liquidity provider incentive — LPs earn 0.3 % fee on every swap.
 *
 *  Invariant:  tokenReserve × ethReserve = k  (before fees)
 *
 *  Fee:  0.3 % deducted from input before the CPMM calculation.
 *        Effectively increases reserves, benefitting LP holders.
 *
 *  LP shares:
 *    - First depositor: shares = √(tokenAmount × ethAmount)  (geometric mean).
 *    - Subsequent:      shares = min(tokenShares, ethShares) to prevent inflation.
 */
contract SimpleLiquidityPool is Ownable, ReentrancyGuard {
    VacationToken public immutable vacationToken;

    uint256 public tokenReserve;
    uint256 public ethReserve;

    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;

    uint256 public constant FEE_NUMERATOR   = 997;   // 1000 - 3  → 0.3 % fee
    uint256 public constant FEE_DENOMINATOR = 1000;

    event LiquidityAdded(
        address indexed provider,
        uint256 tokenAmount,
        uint256 ethAmount,
        uint256 shares
    );
    event LiquidityRemoved(
        address indexed provider,
        uint256 tokenAmount,
        uint256 ethAmount,
        uint256 shares
    );
    event SwapTokenForEth(address indexed user, uint256 tokenIn, uint256 ethOut);
    event SwapEthForToken(address indexed user, uint256 ethIn,   uint256 tokenOut);

    constructor(address initialOwner, address _vacationToken) Ownable(initialOwner) {
        vacationToken = VacationToken(_vacationToken);
    }

    // ─── Liquidity provision ──────────────────────────────────────────────────

    /**
     * @notice Add liquidity to the pool.
     *         Caller must approve this contract to spend `tokenAmount` VCT beforehand.
     * @param tokenAmount VCT tokens to deposit alongside the ETH sent as msg.value.
     */
    function addLiquidity(uint256 tokenAmount) external payable nonReentrant {
        require(tokenAmount > 0 && msg.value > 0, "Pool: zero amounts");
        require(
            vacationToken.availableBalance(msg.sender) >= tokenAmount,
            "Pool: insufficient available token balance"
        );

        uint256 shares;
        if (totalLpShares == 0) {
            // First deposit: LP shares = geometric mean of deposits.
            shares = sqrt(tokenAmount * msg.value);
        } else {
            uint256 sharesByToken = (tokenAmount * totalLpShares) / tokenReserve;
            uint256 sharesByEth   = (msg.value   * totalLpShares) / ethReserve;
            // Take the minimum to keep deposits proportional.
            shares = sharesByToken < sharesByEth ? sharesByToken : sharesByEth;
        }
        require(shares > 0, "Pool: zero LP shares minted");

        // Pull tokens from caller (requires prior ERC-20 approval).
        vacationToken.transferFrom(msg.sender, address(this), tokenAmount);

        tokenReserve          += tokenAmount;
        ethReserve            += msg.value;
        totalLpShares         += shares;
        lpShares[msg.sender]  += shares;

        emit LiquidityAdded(msg.sender, tokenAmount, msg.value, shares);
    }

    /**
     * @notice Withdraw proportional share of reserves plus accumulated fees.
     * @param shares Number of LP shares to burn.
     */
    function removeLiquidity(uint256 shares) external nonReentrant {
        require(shares > 0, "Pool: zero shares");
        require(lpShares[msg.sender] >= shares, "Pool: insufficient LP shares");

        uint256 tokenAmount = (tokenReserve * shares) / totalLpShares;
        uint256 ethAmount   = (ethReserve   * shares) / totalLpShares;
        require(tokenAmount > 0 && ethAmount > 0, "Pool: zero withdrawal amounts");

        // Effects first.
        lpShares[msg.sender] -= shares;
        totalLpShares        -= shares;
        tokenReserve         -= tokenAmount;
        ethReserve           -= ethAmount;

        vacationToken.transfer(msg.sender, tokenAmount);

        (bool success, ) = payable(msg.sender).call{value: ethAmount}("");
        require(success, "Pool: ETH transfer failed");

        emit LiquidityRemoved(msg.sender, tokenAmount, ethAmount, shares);
    }

    // ─── Swaps ────────────────────────────────────────────────────────────────

    /**
     * @notice Sell `tokenIn` VCT for ETH.
     *         Caller must approve the pool to spend `tokenIn` VCT.
     * @param tokenIn    Exact amount of VCT to sell.
     * @param minEthOut  Minimum ETH to receive (slippage protection).
     */
    function swapTokenForEth(uint256 tokenIn, uint256 minEthOut) external nonReentrant {
        require(tokenIn > 0, "Pool: zero input");
        require(
            vacationToken.availableBalance(msg.sender) >= tokenIn,
            "Pool: insufficient available token balance"
        );

        uint256 ethOut = getTokenToEthOutput(tokenIn);
        require(ethOut >= minEthOut,     "Pool: slippage - insufficient ETH output");
        require(ethOut < ethReserve,     "Pool: insufficient ETH reserve");

        vacationToken.transferFrom(msg.sender, address(this), tokenIn);
        tokenReserve += tokenIn;
        ethReserve   -= ethOut;

        (bool success, ) = payable(msg.sender).call{value: ethOut}("");
        require(success, "Pool: ETH transfer failed");

        emit SwapTokenForEth(msg.sender, tokenIn, ethOut);
    }

    /**
     * @notice Buy VCT tokens with ETH (msg.value).
     * @param minTokenOut Minimum VCT to receive (slippage protection).
     */
    function swapEthForToken(uint256 minTokenOut) external payable nonReentrant {
        require(msg.value > 0, "Pool: zero ETH input");

        uint256 tokenOut = getEthToTokenOutput(msg.value);
        require(tokenOut >= minTokenOut, "Pool: slippage - insufficient token output");
        require(tokenOut < tokenReserve, "Pool: insufficient token reserve");

        ethReserve   += msg.value;
        tokenReserve -= tokenOut;

        vacationToken.transfer(msg.sender, tokenOut);

        emit SwapEthForToken(msg.sender, msg.value, tokenOut);
    }

    // ─── Pricing (CPMM with 0.3 % fee) ───────────────────────────────────────

    /**
     * @notice ETH output for selling `tokenIn` VCT (0.3 % fee applied to input).
     *         Formula: ethOut = (tokenIn × 997 × ethReserve) / (tokenReserve × 1000 + tokenIn × 997)
     */
    function getTokenToEthOutput(uint256 tokenIn) public view returns (uint256) {
        require(tokenReserve > 0 && ethReserve > 0, "Pool: no liquidity");
        uint256 tokenInWithFee = tokenIn * FEE_NUMERATOR;
        uint256 numerator      = tokenInWithFee * ethReserve;
        uint256 denominator    = tokenReserve * FEE_DENOMINATOR + tokenInWithFee;
        return numerator / denominator;
    }

    /**
     * @notice VCT output for buying with `ethIn` ETH (0.3 % fee applied to input).
     *         Formula: tokenOut = (ethIn × 997 × tokenReserve) / (ethReserve × 1000 + ethIn × 997)
     */
    function getEthToTokenOutput(uint256 ethIn) public view returns (uint256) {
        require(tokenReserve > 0 && ethReserve > 0, "Pool: no liquidity");
        uint256 ethInWithFee = ethIn * FEE_NUMERATOR;
        uint256 numerator    = ethInWithFee * tokenReserve;
        uint256 denominator  = ethReserve * FEE_DENOMINATOR + ethInWithFee;
        return numerator / denominator;
    }

    /// @notice Current ETH price per 1 VCT token (expressed in wei, scaled by 1e18).
    function getPrice() external view returns (uint256) {
        if (tokenReserve == 0) return 0;
        return (ethReserve * 1e18) / tokenReserve;
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Babylonian integer square root.
    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// @notice Accept ETH (e.g. from LP removal refunds).
    receive() external payable {}
}
