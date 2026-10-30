// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PolicyBase.sol";

/// Stage 2. Cumulative value permitted inside a moving time window.
/// This is the direct answer to a drain partitioned beneath a per-transfer cap.
contract RollingCap is PolicyBase {
    uint8 public constant RULE_ID = 6;

    uint256 public cap;
    uint32  public windowSeconds;
    uint64  public windowStart;
    uint256 public spent;

    function ruleId() external pure override returns (uint8) { return RULE_ID; }

    function configure(uint256 c, uint32 w) external onlyOwner {
        cap = c; windowSeconds = w; windowStart = uint64(block.timestamp); spent = 0;
    }

    function _effectiveSpent() internal view returns (uint256) {
        if (windowSeconds != 0 && block.timestamp >= windowStart + windowSeconds) return 0;
        return spent;
    }

    function evaluate(address, address, uint256 value, bytes calldata)
        external view override returns (bool, uint8)
    {
        if (cap == 0) return (true, 0);
        if (_effectiveSpent() + value > cap) return (false, RULE_ID);
        return (true, 0);
    }

    function commit(address, address, uint256 value, bytes calldata) external override {
        if (cap == 0) return;
        if (windowSeconds != 0 && block.timestamp >= windowStart + windowSeconds) {
            windowStart = uint64(block.timestamp);
            spent = 0;
        }
        spent += value;
    }
}
