// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PolicyBase.sol";

/// Stage 2. Rate limit that LATCHES once exceeded.
/// A rate limit that clears itself on a timer is defeated by patience: the
/// adversary waits out the window and resumes. Latching turns a rate breach
/// into a halt, and clearing it needs the owner key, which by construction
/// does not sit in the agent's environment.
contract VelocityBreaker is PolicyBase {
    uint8 public constant RULE_ID = 5;

    uint32 public maxOps;
    uint32 public windowSeconds;
    uint64 public windowStart;
    uint32 public opsInWindow;
    bool   public paused;

    event Tripped(uint64 at, uint32 opsInWindow);

    function ruleId() external pure override returns (uint8) { return RULE_ID; }

    function configure(uint32 m, uint32 w) external onlyOwner {
        maxOps = m; windowSeconds = w;
        windowStart = uint64(block.timestamp); opsInWindow = 0; paused = false;
    }

    function unpause() external onlyOwner { paused = false; opsInWindow = 0; windowStart = uint64(block.timestamp); }

    function _effectiveOps() internal view returns (uint32) {
        if (windowSeconds != 0 && block.timestamp >= windowStart + windowSeconds) return 0;
        return opsInWindow;
    }

    function evaluate(address, address, uint256, bytes calldata)
        external view override returns (bool, uint8)
    {
        if (maxOps == 0) return (true, 0);
        if (paused) return (false, RULE_ID);
        if (_effectiveOps() + 1 > maxOps) return (false, RULE_ID);
        return (true, 0);
    }

    function commit(address, address, uint256, bytes calldata) external override {
        if (maxOps == 0) return;
        if (windowSeconds != 0 && block.timestamp >= windowStart + windowSeconds) {
            windowStart = uint64(block.timestamp);
            opsInWindow = 0;
        }
        opsInWindow += 1;
    }

    /// The latch. Survives because the wallet does not revert on refusal.
    function onRefused(address, address, uint256, bytes calldata) external override {
        if (maxOps == 0) return;
        if (!paused) {
            paused = true;
            emit Tripped(uint64(block.timestamp), opsInWindow);
        }
    }
}
