# Policy Enforcement Against Prompt Injection in ERC-4337 Agent Wallets

An on-chain policy layer that bounds what an autonomous agent can do with a wallet,
together with the adversarial harness that measures how much each rule actually
contains.

The premise is that prompt injection cannot be filtered reliably at the language
layer, so the wallet should not depend on the agent having been honest. The agent
is treated as fully compromised by default. Every proposal it makes is evaluated
against rules the agent cannot read, write, or disable — only the owner key can.

## The result that matters

| Configuration | Loss to a *static* drip | Loss to an *adaptive* adversary | Benign completion under burst |
|---|---:|---:|---:|
| No policy | 99.00 ETH | 100.00 ETH | 100% |
| PerTxCap alone | 99.00 ETH | 99.56 ETH | 100% |
| Cap + RollingCap | 10.80 ETH | **96.50 ETH** | 62% |
| Cap + VelocityBreaker | 5.40 ETH | **4.62 ETH** | 38% |
| Cap + Allowlist | 0.00 ETH | 0.00 ETH | 100% |

A rolling-window cap looks like a strong control against a fixed-rate drain and
collapses against an adversary that simply waits. A latching breaker gives up a
third of the benign throughput and holds. That difference — waitable versus
non-waitable state — is the finding the harness exists to produce, and it is not
visible to a static evaluation.

Full tables, the gas measurements and the limitations are in
[RESULTS.md](RESULTS.md).

## The rules

| Rule | ID | Stage | Decides on | Waitable |
|---|:--:|---|---|---|
| `PerTxCap` | 2 | static | value of one transfer | n/a |
| `Allowlist` | 3 | static | (destination, selector) pair | n/a |
| `ApprovalCap` | 4 | static | decoded `approve()` amount | n/a |
| `VelocityBreaker` | 5 | stateful | operations per window, **latches** | no |
| `RollingCap` | 6 | stateful | cumulative value per window | yes |
| `Timelock` | 7 | stateful | defers value above a threshold | yes, by design |

The stage column is not cosmetic. ERC-7562 forbids a `validateUserOp`
implementation from reading `block.timestamp` or touching storage outside the
sender's own slots, which is exactly what rules 5–7 need. Rules 2–4 can be
enforced during validation, where a refusal costs the bundler nothing. Rules 5–7
have to be enforced during execution. Any design that claims to enforce all six in
validation has not read the validation rules.

`Allowlist` keys on `(address, selector)`, not address alone. An address-only
allowlist admits a self-call to the wallet's own upgrade or ownership entry point,
which is the shape of the Bybit drain.

## Why `IPolicy` has three functions

A single state-changing `check()` cannot be made correct, and discovering that is
why the interface looks like this:

- If the wallet **reverts** on refusal, every state write made by policies that
  already ran is rolled back — including the breaker's latch. The one control that
  most needs to survive a refusal is the one that does not.
- If the wallet **does not revert**, a policy that advanced its counter before a
  later policy refused has charged the budget for an operation that never executed.

So the decision is a `view` (`evaluate`), the state advance happens only once every
policy has passed (`commit`), and the policy that refused is told separately
(`onRefused`) so it can latch. `propose()` returns `(settled, refusedBy)` and emits
`Executed` or `Refused` rather than reverting, so the refusal is observable without
rolling back the latch.

## Running it

```bash
npm install
npx hardhat compile
npm test                                # 19 tests, rule matrix + composition
npx hardhat run scripts/experiments.js  # E1-E5, writes results/results.json
python3 scripts/figures.py              # figures into results/figures/
python3 scripts/report.py               # regenerates RESULTS.md from the JSON
```

### The live console

A web console drives the same contracts against a local chain, so the policy
decisions can be shown happening rather than described. Two terminals:

```bash
npm run chain      # terminal 1 — hardhat node on :8545
npm run server     # terminal 2 — API + UI on http://localhost:5173
```

The server deploys a fresh wallet, funds it with 100 ETH, registers the
per-transaction cap, and serves the console. From there:

- **Injected** runs a scenario as a compromised agent would — a blunt drain, a
  patient drip, an unlimited approval, or the adaptive adversary. Each one starts
  by showing the instruction that was injected, then streams every proposal and
  the rule that refused it.
- **Manual** signs a single proposal with the agent key, so a specific rule can be
  tripped on demand during a demo.
- **Owner** holds the actions the compromised agent cannot take: clearing a latched
  breaker, advancing the chain clock, redeploying.

Toggling a rule on the Policies tab rebuilds the wallet's registry on chain, so
the same adversary can be run against different configurations back to back. That
is the demo worth doing: run **Adaptive adversary** against *cap + rolling cap*,
then against *cap + velocity breaker*, and watch the loss figures diverge.

Measured live over a 70-proposal budget, with the same thresholds as the offline
harness:

| Configuration | Loss | Benign burst completion |
|---|---:|---:|
| Cap only | 82.72 ETH | 100% |
| Cap + rolling cap | 68.94 ETH | 62% |
| Cap + velocity breaker | 4.63 ETH | 38% |
| Cap + allowlist | 0.00 ETH | 100% |

The console is a demonstration surface, not a product: it holds the owner and
agent keys of a local test chain in one process, and it is not meant to be exposed
to a network.

Nothing in `RESULTS.md` is typed by hand; it is generated from `results.json`, so
re-running the harness with different thresholds regenerates a consistent report.

### A note on the solc download

`hardhat.config.js` overrides `TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD` to use the
`solc` package from npm instead of downloading a compiler from
`binaries.soliditylang.org`. On a normal machine you can delete that subtask and
Hardhat will fetch its own compiler. It is kept because it also pins the exact
compiler build, which makes the gas numbers reproducible.

## The experiments

| | What it measures |
|---|---|
| **E1** | Baseline loss with no policy registered — the denominator for every containment ratio |
| **E2** | Each rule in isolation against a blunt drain, a patient drip, and an unlimited approval |
| **E3** | Composition: does stacking rules compose, or does the weakest one set the loss |
| **E4** | An adaptive adversary that probes, bisects to find the cap, waits out windows, and stops when no path to value remains |
| **E5** | A benign workload, steady and bursty, to price the false blocks each rule causes |

The metric throughout is **realised adversarial loss** — value that actually left
the wallet — rather than a refusal count. A configuration that refuses 53 of 55
proposals and loses the balance anyway has not contained anything, and a
refusal-rate metric would score it well.

## Layout

```
contracts/
  IPolicy.sol            three-call interface, with the rationale in the header
  PolicyWallet.sol       holds funds; agent may propose, owner may configure
  policies/
    PolicyBase.sol       owner + no-op commit/onRefused + selector helper
    PerTxCap.sol  Allowlist.sol  ApprovalCap.sol
    RollingCap.sol  VelocityBreaker.sol  Timelock.sol
  mocks/MockERC20.sol
test/policies.test.js    19 tests: per-rule behaviour, latch persistence, composition
scripts/
  experiments.js         E1–E5 runner, adaptive adversary, gas measurement
  figures.py  report.py  derived artefacts, both regenerated from results.json
results/
  results.json           raw measurements
  figures/               fig1–fig5
RESULTS.md               generated
```

## What this is not

It is not an ERC-4337 deployment. The policy layer is exercised through a direct
`propose()` path rather than an EntryPoint and a bundler, so the gas figures are
relative policy costs, not bundler-accepted validation gas. Wiring the stage-1
rules into a real `validateUserOp` and re-measuring under ERC-7562 is the next
piece of work, and it is the piece that would turn the stage split from an argument
into a demonstration.
