// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Every containment rule implements this interface, so PolicyWallet can treat
 * them uniformly and a configuration is just a list of registered addresses.
 *
 * The three-call shape is deliberate and was forced by building the thing.
 * A single state-changing check() cannot work, because:
 *
 *   - if the wallet reverts on refusal, every state write made by policies that
 *     already ran is rolled back, including a rate-limiter latch — so the one
 *     control that must survive a refusal does not;
 *   - if the wallet does not revert, a policy that advanced its counter before a
 *     later policy refused has over-counted an operation that never executed.
 *
 * Splitting the decision (view) from the state advance (commit) and the refusal
 * notification (onRefused) removes both problems.
 */
interface IPolicy {
    /// Pure decision against current state. MUST NOT write.
    /// @return ok      true if this policy permits the operation
    /// @return ruleId  identifier of this policy, for attribution
    function evaluate(
        address from,
        address to,
        uint256 value,
        bytes calldata data
    ) external view returns (bool ok, uint8 ruleId);

    /// Advance counters. Called on every registered policy only when the
    /// operation has passed all of them and is about to execute.
    function commit(address from, address to, uint256 value, bytes calldata data) external;

    /// Called on the single policy that refused, so it may latch or record.
    function onRefused(address from, address to, uint256 value, bytes calldata data) external;

    function ruleId() external view returns (uint8);
}
