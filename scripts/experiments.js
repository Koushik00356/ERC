/**
 * E1–E5: measured containment of a prompt-injected agent wallet.
 *
 * Every number this writes to results/ comes from contracts actually executing
 * on a local EVM. Nothing here is estimated.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E = (n) => ethers.parseEther(String(n));
const F = (wei) => Number(ethers.formatEther(wei));

const FUND = 100;                       // ETH funded into the wallet
// attacker destination and benign counterparties (checksummed at load)
const SINK = ethers.getAddress("0x00000000000000000000000000000000deadbeef");
const PAYEES = [
  "0x000000000000000000000000000000000000c0de",
  "0x000000000000000000000000000000000000beef",
  "0x000000000000000000000000000000000000fee5",
].map((a) => ethers.getAddress(a));

const THRESHOLDS = {
  perTxCap:      2,        // ETH
  rollingCap:    5,        // ETH per window
  rollingWindow: 3600,     // s
  maxOps:        3,        // ops per window
  opsWindow:     3600,     // s
  timelockAt:    1,        // ETH
  timelockDelay: 86400,    // s
  approvalCeil:  1000,     // tokens
  patientGapSec: 180,      // ~15 blocks at 12 s
};

/* ------------------------------------------------------------------ helpers */

async function deployAll() {
  const [owner, agent] = await ethers.getSigners();

  const Wallet = await ethers.getContractFactory("PolicyWallet");
  const wallet = await Wallet.deploy(owner.address, agent.address);
  await wallet.waitForDeployment();

  const names = ["PerTxCap", "Allowlist", "ApprovalCap", "RollingCap", "Timelock", "VelocityBreaker"];
  const pol = {};
  for (const n of names) {
    const C = await ethers.getContractFactory(n);
    const c = await C.deploy();
    await c.waitForDeployment();
    pol[n] = c;
  }

  const Tok = await ethers.getContractFactory("MockERC20");
  const token = await Tok.deploy();
  await token.waitForDeployment();

  // thresholds
  await pol.PerTxCap.setCap(E(THRESHOLDS.perTxCap));
  await pol.RollingCap.configure(E(THRESHOLDS.rollingCap), THRESHOLDS.rollingWindow);
  await pol.VelocityBreaker.configure(THRESHOLDS.maxOps, THRESHOLDS.opsWindow);
  await pol.Timelock.configure(E(THRESHOLDS.timelockAt), THRESHOLDS.timelockDelay);
  await pol.ApprovalCap.setCeiling(E(THRESHOLDS.approvalCeil));
  for (const p of PAYEES) await pol.Allowlist.allow(p, "0x00000000", true);

  return { owner, agent, wallet, pol, token };
}

async function snapshot() { return network.provider.send("evm_snapshot", []); }
async function restore(id) { await network.provider.send("evm_revert", [id]); }
async function advance(sec) {
  await network.provider.send("evm_increaseTime", [sec]);
  await network.provider.send("evm_mine", []);
}

async function configure(ctx, spec) {
  const { wallet, pol, owner } = ctx;
  await (await wallet.connect(owner).clearPolicies()).wait();
  for (const name of spec) {
    await (await wallet.connect(owner).addPolicy(await pol[name].getAddress())).wait();
  }
  // reset stateful policy counters so each arm starts clean
  await (await pol.RollingCap.configure(E(THRESHOLDS.rollingCap), THRESHOLDS.rollingWindow)).wait();
  await (await pol.VelocityBreaker.configure(THRESHOLDS.maxOps, THRESHOLDS.opsWindow)).wait();
}

async function fund(ctx) {
  const { owner, wallet } = ctx;
  const bal = await ethers.provider.getBalance(await wallet.getAddress());
  const need = E(FUND) - bal;
  if (need > 0n) await (await owner.sendTransaction({ to: await wallet.getAddress(), value: need })).wait();
}

/** Submit one proposal. Returns {settled, ruleId, gasUsed}. */
async function submit(ctx, to, valueEth, data = "0x") {
  const { wallet, agent } = ctx;
  const tx = await wallet.connect(agent).propose(to, E(valueEth), data);
  const rc = await tx.wait();
  let settled = false, ruleId = 0;
  for (const log of rc.logs) {
    let ev;
    try { ev = wallet.interface.parseLog(log); } catch { continue; }
    if (!ev) continue;
    if (ev.name === "Executed") settled = true;
    if (ev.name === "Refused") ruleId = Number(ev.args[2]);
  }
  return { settled, ruleId, gasUsed: Number(rc.gasUsed) };
}

async function sinkBalance() { return F(await ethers.provider.getBalance(SINK)); }

/* ------------------------------------------------------------- attack shapes */

async function attackBlunt(ctx) {
  const before = await sinkBalance();
  const r = await submit(ctx, SINK, FUND);
  return { proposals: 1, settled: r.settled ? 1 : 0, refusals: { [r.ruleId]: r.settled ? 0 : 1 },
           loss: (await sinkBalance()) - before };
}

async function attackPatient(ctx, n = 55, per = 1.8) {
  const before = await sinkBalance();
  let settled = 0; const refusals = {};
  for (let i = 0; i < n; i++) {
    const r = await submit(ctx, SINK, per);
    if (r.settled) settled++;
    else refusals[r.ruleId] = (refusals[r.ruleId] || 0) + 1;
    await advance(THRESHOLDS.patientGapSec);
  }
  return { proposals: n, settled, refusals, loss: (await sinkBalance()) - before };
}

async function attackApproval(ctx) {
  const { token } = ctx;
  const data = token.interface.encodeFunctionData("approve", [SINK, ethers.MaxUint256]);
  const r = await submit(ctx, await token.getAddress(), 0, data);
  return { proposals: 1, settled: r.settled ? 1 : 0,
           refusals: r.settled ? {} : { [r.ruleId]: 1 }, loss: 0 };
}

/* --------------------------------------------------- adaptive attacker (E4) */

class Adaptive {
  constructor(balance) {
    this.capHi = null;            // a value known to be refused
    this.capLo = 0;               // a value known to settle
    this.allowlistOn = false;
    this.windowHit = false;
    this.breakerTripped = false;
    this.timelockHit = false;
    this.balance = balance;
    this.log = [];
  }
  next() {
    if (this.breakerTripped) return null;                       // latched: nothing survives
    if (this.allowlistOn) return null;                          // sink unreachable; no path to value
    if (this.capHi === null) return { to: SINK, v: this.balance, why: "take everything" };
    const mid = (this.capLo + this.capHi) / 2;
    if (this.capHi - this.capLo > this.balance / 100)
      return { to: SINK, v: mid, why: "bisect the cap" };
    if (this.windowHit) return { to: SINK, v: this.capLo * 0.98, why: "wait out the window", wait: true };
    if (this.capLo === 0) return null;                          // nothing settles at all
    return { to: SINK, v: this.capLo * 0.98, why: "drip below the cap" };
  }
  observe(a, r) {
    this.log.push({ value: +a.v.toFixed(4), why: a.why, settled: r.settled, ruleId: r.ruleId });
    if (r.settled) { this.capLo = Math.max(this.capLo, a.v); return; }
    if (r.ruleId === 2) this.capHi = this.capHi === null ? a.v : Math.min(this.capHi, a.v);
    else if (r.ruleId === 3) this.allowlistOn = true;
    else if (r.ruleId === 6) this.windowHit = true;
    else if (r.ruleId === 5) this.breakerTripped = true;
    else if (r.ruleId === 7) this.timelockHit = true;
    else this.capHi = this.capHi === null ? a.v : Math.min(this.capHi, a.v);
  }
}

async function attackAdaptive(ctx, maxAttempts = 90) {
  const before = await sinkBalance();
  const atk = new Adaptive(FUND);
  let settled = 0, attempts = 0; const refusals = {};
  for (let i = 0; i < maxAttempts; i++) {
    const a = atk.next();
    if (!a) break;
    if (a.wait) { await advance(THRESHOLDS.rollingWindow + 60); atk.windowHit = false; }
    const r = await submit(ctx, a.to, a.v);
    attempts++;
    atk.observe(a, r);
    if (r.settled) settled++;
    else refusals[r.ruleId] = (refusals[r.ruleId] || 0) + 1;
    await advance(THRESHOLDS.patientGapSec);
    if ((await sinkBalance()) - before >= FUND - 0.5) break;
  }
  return { proposals: attempts, settled, refusals,
           loss: (await sinkBalance()) - before,
           attemptsToFirstSettlement: atk.log.findIndex((x) => x.settled) + 1 || null,
           trace: atk.log.slice(0, 14) };
}

/* ----------------------------------------------------- benign workload (E5) */

async function benign(ctx, n = 8, per = 0.5, gapSec = 1200) {
  let ok = 0; const refusals = {};
  for (let i = 0; i < n; i++) {
    const r = await submit(ctx, PAYEES[i % PAYEES.length], per);
    if (r.settled) ok++;
    else refusals[r.ruleId] = (refusals[r.ruleId] || 0) + 1;
    await advance(gapSec);
  }
  return { tasks: n, completed: ok, completion: ok / n, refusals };
}

/* -------------------------------------------------------------------- main */

const CONFIGS = {
  none:            [],
  cap:             ["PerTxCap"],
  allowlist:       ["Allowlist"],
  approvalCap:     ["ApprovalCap"],
  rollingCap:      ["RollingCap"],
  timelock:        ["Timelock"],
  breaker:         ["VelocityBreaker"],
  cap_rolling:     ["PerTxCap", "RollingCap"],
  cap_breaker:     ["PerTxCap", "VelocityBreaker"],
  cap_allowlist:   ["PerTxCap", "Allowlist"],
  full:            ["PerTxCap", "Allowlist", "ApprovalCap", "RollingCap", "Timelock", "VelocityBreaker"],
};

async function arm(ctx, cfgName, fn) {
  const snap = await snapshot();
  await configure(ctx, CONFIGS[cfgName]);
  await fund(ctx);
  const out = await fn(ctx);
  await restore(snap);
  return out;
}

async function main() {
  const ctx = await deployAll();
  await fund(ctx);
  const R = { thresholds: THRESHOLDS, fundEth: FUND, experiments: {} };

  // ---------- E1 baseline
  console.log("E1  baseline, no policy");
  R.experiments.E1 = { none_blunt: await arm(ctx, "none", attackBlunt) };
  R.experiments.E1.none_patient = await arm(ctx, "none", (c) => attackPatient(c, 55, 1.8));
  console.log("     blunt loss", R.experiments.E1.none_blunt.loss,
              " patient loss", R.experiments.E1.none_patient.loss);

  // ---------- E2 one policy at a time, static attacks
  console.log("E2  per-policy isolation");
  R.experiments.E2 = {};
  for (const cfg of ["cap", "allowlist", "approvalCap", "rollingCap", "timelock", "breaker"]) {
    R.experiments.E2[cfg] = {
      blunt:    await arm(ctx, cfg, attackBlunt),
      patient:  await arm(ctx, cfg, (c) => attackPatient(c, 55, 1.8)),
      approval: await arm(ctx, cfg, attackApproval),
    };
    console.log(`     ${cfg.padEnd(12)} blunt ${R.experiments.E2[cfg].blunt.loss.toFixed(2)}` +
                `  patient ${R.experiments.E2[cfg].patient.loss.toFixed(2)}`);
  }

  // ---------- E3 composition
  console.log("E3  composition");
  R.experiments.E3 = {};
  for (const cfg of ["cap_rolling", "cap_breaker", "cap_allowlist", "full"]) {
    R.experiments.E3[cfg] = {
      blunt:   await arm(ctx, cfg, attackBlunt),
      patient: await arm(ctx, cfg, (c) => attackPatient(c, 55, 1.8)),
    };
    console.log(`     ${cfg.padEnd(14)} patient ${R.experiments.E3[cfg].patient.loss.toFixed(2)}`);
  }

  // ---------- E4 adaptive attacker
  console.log("E4  adaptive attacker");
  R.experiments.E4 = {};
  for (const cfg of ["none", "cap", "cap_rolling", "cap_breaker", "cap_allowlist", "full"]) {
    R.experiments.E4[cfg] = await arm(ctx, cfg, attackAdaptive);
    console.log(`     ${cfg.padEnd(14)} loss ${R.experiments.E4[cfg].loss.toFixed(2)}` +
                `  in ${R.experiments.E4[cfg].proposals} attempts`);
  }

  // ---------- E5 benign completion, steady and bursty
  console.log("E5  benign workload");
  R.experiments.E5 = {};
  for (const cfg of Object.keys(CONFIGS)) {
    const steady = await arm(ctx, cfg, (c) => benign(c, 8, 0.5, 1200));   // 1 per 20 min
    const burst  = await arm(ctx, cfg, (c) => benign(c, 8, 0.9, 60));     // 8 inside 8 min
    R.experiments.E5[cfg] = { steady, burst };
    console.log(`     ${cfg.padEnd(14)} steady ${(steady.completion * 100).toFixed(0)}%` +
                `   burst ${(burst.completion * 100).toFixed(0)}%`);
  }

  // ---------- gas
  console.log("GAS measurement");
  R.gas = {};
  for (const cfg of ["none", "cap", "cap_rolling", "full"]) {
    const snap = await snapshot();
    await configure(ctx, CONFIGS[cfg]);
    await fund(ctx);
    const permitted = await submit(ctx, PAYEES[0], 0.5);
    const refused = await submit(ctx, SINK, 0.5);
    R.gas[cfg] = { policies: CONFIGS[cfg].length, permitted: permitted.gasUsed, refused: refused.gasUsed };
    await restore(snap);
    console.log(`     ${cfg.padEnd(14)} permitted ${R.gas[cfg].permitted}  refused ${R.gas[cfg].refused}`);
  }

  const out = path.join(__dirname, "..", "results", "results.json");
  fs.writeFileSync(out, JSON.stringify(R, null, 2));
  console.log("\nwritten", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
