// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PolicyBase.sol";

/// Stage 1. Permitted destination keyed on (address, function selector).
/// Keying on the address alone admits a self-call that rewrites the wallet's
/// own logic, which is the operation shape behind the February 2025 exchange loss.
contract Allowlist is PolicyBase {
    uint8 public constant RULE_ID = 3;
    mapping(bytes32 => bool) public allowed;

    function ruleId() external pure override returns (uint8) { return RULE_ID; }

    function key(address to, bytes4 sel) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(to, sel));
    }

    function allow(address to, bytes4 sel, bool ok) external onlyOwner {
        allowed[key(to, sel)] = ok;
    }

    function evaluate(address, address to, uint256, bytes calldata data)
        external view override returns (bool, uint8)
    {
        if (!allowed[key(to, _selector(data))]) return (false, RULE_ID);
        return (true, 0);
    }
}
