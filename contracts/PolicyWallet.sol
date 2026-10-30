// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IPolicy.sol";

/**
 * Holds the funds. The agent may only propose; the owner may only reconfigure.
 * An adversary in full control of the agent inherits neither the balance nor
 * the ability to change a threshold.
 */
contract PolicyWallet {
    address public owner;
    address public agent;
    address[] public policies;
    mapping(address => bool) public isRegistered;

    event Executed(address indexed to, uint256 value, uint256 gasUsedPolicies);
    event Refused(address indexed to, uint256 value, uint8 ruleId);
    event PolicyAdded(address indexed policy, uint8 ruleId);
    event PolicyCleared();

    error NotOwner();
    error NotAgent();
    error TransferFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyAgent() { if (msg.sender != agent) revert NotAgent(); _; }

    constructor(address _owner, address _agent) {
        owner = _owner;
        agent = _agent;
    }

    receive() external payable {}

    // ------------------------------------------------------------- configuration

    function addPolicy(address policy) external onlyOwner {
        require(!isRegistered[policy], "already registered");
        isRegistered[policy] = true;
        policies.push(policy);
        emit PolicyAdded(policy, IPolicy(policy).ruleId());
    }

    /// Clear the whole registry. Used to rebuild a configuration between
    /// experiment arms without redeploying the wallet.
    function clearPolicies() external onlyOwner {
        for (uint256 i = 0; i < policies.length; i++) {
            isRegistered[policies[i]] = false;
        }
        delete policies;
        emit PolicyCleared();
    }

    function setAgent(address a) external onlyOwner { agent = a; }

    function policyCount() external view returns (uint256) { return policies.length; }

    // ----------------------------------------------------------------- proposal

    /**
     * The agent's only entry point.
     *
     * Note that a policy refusal does not revert. Reverting would roll back the
     * rate-limiter latch set in onRefused, which is the single piece of state
     * that most needs to survive a refusal. No value moves either way, and the
     * outcome is recorded in an event, so the caller can still distinguish the
     * two cases.
     */
    function propose(address to, uint256 value, bytes calldata data)
        external
        onlyAgent
        returns (bool settled, uint8 refusedBy)
    {
        uint256 g0 = gasleft();

        uint256 n = policies.length;
        for (uint256 i = 0; i < n; i++) {
            (bool ok, uint8 rid) = IPolicy(policies[i]).evaluate(msg.sender, to, value, data);
            if (!ok) {
                IPolicy(policies[i]).onRefused(msg.sender, to, value, data);
                emit Refused(to, value, rid);
                return (false, rid);
            }
        }

        for (uint256 i = 0; i < n; i++) {
            IPolicy(policies[i]).commit(msg.sender, to, value, data);
        }

        uint256 spent = g0 - gasleft();

        (bool sent, ) = to.call{value: value}(data);
        if (!sent) revert TransferFailed();

        emit Executed(to, value, spent);
        return (true, 0);
    }
}
