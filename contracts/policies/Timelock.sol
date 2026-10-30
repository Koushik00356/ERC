// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PolicyBase.sol";

/// Stage 2. Mandatory delay above a value threshold.
/// This defers rather than refuses: it buys time for an external party to act,
/// and is worth nothing if nobody is watching the queue.
contract Timelock is PolicyBase {
    uint8 public constant RULE_ID = 7;

    uint256 public threshold;
    uint32  public delaySeconds;
    mapping(bytes32 => uint64) public readyAt;

    event Queued(bytes32 indexed opHash, uint64 readyAt);

    function ruleId() external pure override returns (uint8) { return RULE_ID; }
    function configure(uint256 t, uint32 d) external onlyOwner { threshold = t; delaySeconds = d; }

    function opHash(address to, uint256 value, bytes calldata data) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(to, value, data));
    }

    function evaluate(address, address to, uint256 value, bytes calldata data)
        external view override returns (bool, uint8)
    {
        if (threshold == 0 || value <= threshold) return (true, 0);
        uint64 r = readyAt[opHash(to, value, data)];
        if (r != 0 && block.timestamp >= r) return (true, 0);
        return (false, RULE_ID);
    }

    function onRefused(address, address to, uint256 value, bytes calldata data) external override {
        bytes32 h = opHash(to, value, data);
        if (readyAt[h] == 0) {
            readyAt[h] = uint64(block.timestamp) + delaySeconds;
            emit Queued(h, readyAt[h]);
        }
    }
}
