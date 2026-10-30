// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Approval(address indexed o, address indexed s, uint256 v);
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true;
    }
}
