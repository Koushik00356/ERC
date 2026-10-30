// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PolicyBase.sol";

/// Stage 1. Ceiling on ERC-20 approval amounts. Catches a drain that moves no
/// value at the moment it is authorised, which no value cap can see.
contract ApprovalCap is PolicyBase {
    uint8   public constant RULE_ID = 4;
    bytes4  private constant APPROVE = bytes4(keccak256("approve(address,uint256)"));
    uint256 public ceiling;

    function ruleId() external pure override returns (uint8) { return RULE_ID; }
    function setCeiling(uint256 c) external onlyOwner { ceiling = c; }

    function evaluate(address, address, uint256, bytes calldata data)
        external view override returns (bool, uint8)
    {
        if (_selector(data) != APPROVE) return (true, 0);
        if (data.length < 68) return (false, RULE_ID);
        uint256 amount = abi.decode(data[36:68], (uint256));
        if (ceiling != 0 && amount > ceiling) return (false, RULE_ID);
        return (true, 0);
    }
}
