// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../IPolicy.sol";

abstract contract PolicyBase is IPolicy {
    address public owner;
    error NotOwner();
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    constructor() { owner = msg.sender; }

    function commit(address, address, uint256, bytes calldata) external virtual override {}
    function onRefused(address, address, uint256, bytes calldata) external virtual override {}

    function _selector(bytes calldata data) internal pure returns (bytes4) {
        if (data.length < 4) return bytes4(0);
        return bytes4(data[:4]);
    }
}
