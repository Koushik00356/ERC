// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PolicyBase.sol";

/// Stage 1. Ceiling on the value of any single transfer.
contract PerTxCap is PolicyBase {
    uint8   public constant RULE_ID = 2;
    uint256 public cap;

    function ruleId() external pure override returns (uint8) { return RULE_ID; }
    function setCap(uint256 c) external onlyOwner { cap = c; }

    function evaluate(address, address, uint256 value, bytes calldata)
        external view override returns (bool, uint8)
    {
        if (cap != 0 && value > cap) return (false, RULE_ID);
        return (true, 0);
    }
}
