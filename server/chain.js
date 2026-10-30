/**
 * Everything that touches the chain. The HTTP layer in index.js never builds a
 * transaction itself — it calls in here, so there is exactly one place where the
 * owner key and the agent key are distinguished.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";

function artifact(name, sub = "") {
  const p = path.join(ROOT, "artifacts", "contracts", sub, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`artifact for ${name} not found — run "npx hardhat compile" first`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Ordered because registration order decides which rule is credited with a refusal. */
const POLICY_SPECS = [
  { key: "perTxCap", name: "PerTxCap", ruleId: 2, stage: "static",
    label: "Per-transaction cap", waitable: null,
    blurb: "Refuses any single transfer above a ceiling." },
  { key: "allowlist", name: "Allowlist", ruleId: 3, stage: "static",
    label: "Destination allowlist", waitable: null,
    blurb: "Refuses any (destination, selector) pair that was not pre-approved." },
  { key: "approvalCap", name: "ApprovalCap", ruleId: 4, stage: "static",
    label: "Token approval ceiling", waitable: null,
    blurb: "Decodes approve() and refuses an allowance above a ceiling." },
  { key: "velocityBreaker", name: "VelocityBreaker", ruleId: 5, stage: "stateful",
    label: "Velocity breaker", waitable: false,
    blurb: "Latches permanently once the operation rate is exceeded. Only the owner clears it." },
  { key: "rollingCap", name: "RollingCap", ruleId: 6, stage: "stateful",
    label: "Rolling-window cap", waitable: true,
    blurb: "Caps cumulative value per window. The window rolls on its own, so it can be waited out." },
  { key: "timelock", name: "Timelock", ruleId: 7, stage: "stateful",
    label: "Timelock", waitable: true,
    blurb: "Defers anything above a threshold until a delay has elapsed." },
];

const SINK = ethers.getAddress("0x00000000000000000000000000000000deadbeef");
const PAYEES = [
  { label: "Payroll", address: ethers.getAddress("0x000000000000000000000000000000000000c0de") },
  { label: "Supplier", address: ethers.getAddress("0x000000000000000000000000000000000000beef") },
  { label: "Gas reimbursement", address: ethers.getAddress("0x0000000000000000000000000000000000000fee") },
];

const DEFAULTS = {
  perTxCap: { cap: "2" },
  allowlist: {},
  approvalCap: { ceiling: "1000" },
  velocityBreaker: { maxOps: 3, windowSeconds: 3600 },
  rollingCap: { cap: "5", windowSeconds: 3600 },
  timelock: { threshold: "1", delaySeconds: 86400 },
};

const FUND_ETH = "100";

class Chain {
  constructor() {
    this.provider = null;
    this.owner = null;
    this.agent = null;
    this.wallet = null;
    this.token = null;
    this.policies = {};          // key -> { contract, address, enabled, config }
    this.activity = [];          // newest first
    this.listeners = new Set();  // SSE response objects
    this.sinkBaseline = 0n;
    this.seq = 0;
    this.ready = false;
  }

  // ------------------------------------------------------------------ bootstrap

  async connect() {
    // batchMaxCount:1 — Hardhat's node rejects ethers' batched JSON-RPC payloads,
    // which surfaces as an opaque "could not coalesce error" on the second
    // transaction of any rapid sequence.
    // cacheTimeout:-1 — JsonRpcApiProvider caches responses for 250 ms by default,
    // which is long enough to hand back a pre-transaction balance right after a
    // transaction has been mined.
    this.provider = new ethers.JsonRpcProvider(RPC, undefined,
      { batchMaxCount: 1, cacheTimeout: -1 });
    this.provider.pollingInterval = 120;
    await this.provider.getBlockNumber();          // fails fast if no node
    this.owner = await this.provider.getSigner(0);
    this.agent = await this.provider.getSigner(1);
  }

  async deployAll() {
    const deploy = async (name, sub, args = []) => {
      const a = artifact(name, sub);
      const f = new ethers.ContractFactory(a.abi, a.bytecode, this.owner);
      const c = await f.deploy(...args);
      await c.waitForDeployment();
      return c;
    };

    this.wallet = await deploy("PolicyWallet", "", [
      await this.owner.getAddress(),
      await this.agent.getAddress(),
    ]);
    this.token = await deploy("MockERC20", "mocks");

    this.policies = {};
    for (const spec of POLICY_SPECS) {
      const c = await deploy(spec.name, "policies");
      this.policies[spec.key] = {
        ...spec,
        contract: c,
        address: await c.getAddress(),
        enabled: false,
        config: { ...DEFAULTS[spec.key] },
      };
    }

    // The sink address keeps its balance across redeploys, so loss for this
    // session is measured against what it already held at deploy time.
    this.sinkBaseline = await this._balance(SINK);

    await this._applyConfig();
    await (await this.owner.sendTransaction({
      to: await this.wallet.getAddress(),
      value: ethers.parseEther(FUND_ETH),
    })).wait();

    // A sensible starting posture: the two static rules that cost nothing benign.
    await this.setEnabled("perTxCap", true);

    this.activity = [];
    this.seq = 0;
    this.ready = true;
    this._push({ kind: "system", text: `Wallet deployed and funded with ${FUND_ETH} ETH.` });
  }

  async _applyConfig() {
    const p = this.policies;
    await (await p.perTxCap.contract.setCap(ethers.parseEther(p.perTxCap.config.cap))).wait();
    await (await p.approvalCap.contract.setCeiling(
      ethers.parseEther(p.approvalCap.config.ceiling))).wait();
    await (await p.rollingCap.contract.configure(
      ethers.parseEther(p.rollingCap.config.cap), p.rollingCap.config.windowSeconds)).wait();
    await (await p.velocityBreaker.contract.configure(
      p.velocityBreaker.config.maxOps, p.velocityBreaker.config.windowSeconds)).wait();
    await (await p.timelock.contract.configure(
      ethers.parseEther(p.timelock.config.threshold), p.timelock.config.delaySeconds)).wait();
    for (const payee of PAYEES) {
      await (await p.allowlist.contract.allow(payee.address, "0x00000000", true)).wait();
    }
    const tokenAddr = await this.token.getAddress();
    await (await p.allowlist.contract.allow(tokenAddr, "0x095ea7b3", true)).wait();
  }

  // ------------------------------------------------------------- configuration

  /** Rebuild the wallet's registry so registration order always matches POLICY_SPECS. */
  async _rebuildRegistry() {
    // Explicit limits: the node's estimate for clearPolicies is taken against the
    // pre-clear array and comes back short, which surfaces as "ran out of gas".
    await (await this.wallet.clearPolicies({ gasLimit: 2_000_000 })).wait();
    for (const spec of POLICY_SPECS) {
      const p = this.policies[spec.key];
      if (p.enabled) {
        await (await this.wallet.addPolicy(p.address, { gasLimit: 400_000 })).wait();
      }
    }
  }

  async setEnabled(key, enabled) {
    if (!this.policies[key]) throw new Error(`unknown policy ${key}`);
    const was = this.policies[key].enabled;
    this.policies[key].enabled = !!enabled;
    try {
      await this._rebuildRegistry();
    } catch (e) {
      this.policies[key].enabled = was;   // keep the flag honest about the chain
      throw e;
    }
    this._push({
      kind: "config",
      text: `${this.policies[key].label} ${enabled ? "enabled" : "disabled"} by the owner.`,
    });
  }

  async configure(key, patch) {
    const p = this.policies[key];
    if (!p) throw new Error(`unknown policy ${key}`);
    p.config = { ...p.config, ...patch };
    await this._applyConfig();
    this._push({ kind: "config", text: `${p.label} reconfigured by the owner.` });
  }

  async unpauseBreaker() {
    await (await this.policies.velocityBreaker.contract.unpause()).wait();
    this._push({ kind: "config", text: "Velocity breaker cleared by the owner key." });
  }

  // -------------------------------------------------------------------- acting

  /**
   * The agent's only capability. Returns what the chain decided, never what the
   * agent intended — a refusal is read back out of the emitted event.
   */
  async propose({ to, valueEth = "0", data = "0x", intent = "agent proposal" }) {
    const value = ethers.parseEther(String(valueEth || "0"));
    const dest = ethers.getAddress(to);

    let receipt, failure = null;
    try {
      const tx = await this.wallet.connect(this.agent).propose(dest, value, data);
      receipt = await tx.wait();
    } catch (e) {
      failure = e.shortMessage || e.message;
    }

    let settled = false, ruleId = 0, gasPolicies = null, movedWei = 0n;
    if (receipt) {
      for (const log of receipt.logs) {
        let ev;
        try { ev = this.wallet.interface.parseLog(log); } catch { continue; }
        if (!ev) continue;
        if (ev.name === "Executed") {
          settled = true; movedWei = ev.args[1]; gasPolicies = Number(ev.args[2]);
        }
        if (ev.name === "Refused") ruleId = Number(ev.args[2]);
      }
    }

    const refusedBy = ruleId
      ? POLICY_SPECS.find((s) => s.ruleId === ruleId) || null
      : null;

    const entry = {
      kind: "proposal",
      intent,
      to: dest,
      toLabel: this._label(dest),
      valueEth: Number(ethers.formatEther(value)),
      hasCalldata: data !== "0x",
      settled,
      ruleId,
      refusedBy: refusedBy ? refusedBy.label : null,
      movedEth: Number(ethers.formatEther(movedWei)),
      gasTotal: receipt ? Number(receipt.gasUsed) : null,
      gasPolicies,
      failure,
    };
    this._push(entry);
    return entry;
  }

  _label(addr) {
    const a = ethers.getAddress(addr);
    if (a === SINK) return "Unknown address";
    const p = PAYEES.find((x) => x.address === a);
    if (p) return p.label;
    return a.slice(0, 6) + "…" + a.slice(-4);
  }

  async advanceTime(seconds) {
    await this.provider.send("evm_increaseTime", [Number(seconds)]);
    await this.provider.send("evm_mine", []);
    const h = Math.round(seconds / 3600);
    this._push({
      kind: "system",
      text: `Clock advanced ${h >= 1 ? `${h} h` : `${Math.round(seconds / 60)} min`}.`,
    });
  }

  // ------------------------------------------------------------------- reading

  /** Raw eth_getBalance. ethers' own getBalance resolves against a cached block
   *  tag, which hands back a pre-transaction balance right after a transfer. */
  async _balance(addr) {
    return BigInt(await this.provider.send("eth_getBalance", [addr, "latest"]));
  }

  async state() {
    const walletAddr = await this.wallet.getAddress();
    const bal = await this._balance(walletAddr);
    const sinkBal = await this._balance(SINK);
    const lost = sinkBal - (this.sinkBaseline ?? 0n);

    const policies = [];
    for (const spec of POLICY_SPECS) {
      const p = this.policies[spec.key];
      const status = {};
      if (spec.key === "velocityBreaker") {
        status.latched = await p.contract.paused();
        status.opsInWindow = Number(await p.contract.opsInWindow());
      }
      if (spec.key === "rollingCap") {
        status.spent = Number(ethers.formatEther(await p.contract.spent()));
      }
      policies.push({
        key: spec.key, label: spec.label, ruleId: spec.ruleId, stage: spec.stage,
        waitable: spec.waitable, blurb: spec.blurb,
        address: p.address, enabled: p.enabled, config: p.config, status,
      });
    }

    const proposals = this.activity.filter((a) => a.kind === "proposal");
    const settled = proposals.filter((a) => a.settled);
    return {
      ready: this.ready,
      wallet: walletAddr,
      token: await this.token.getAddress(),
      owner: await this.owner.getAddress(),
      agent: await this.agent.getAddress(),
      balanceEth: Number(ethers.formatEther(bal)),
      fundedEth: Number(FUND_ETH),
      lostEth: Number(ethers.formatEther(lost)),
      counts: {
        proposals: proposals.length,
        settled: settled.length,
        refused: proposals.length - settled.length,
      },
      policies,
      payees: PAYEES,
      sink: SINK,
    };
  }

  // --------------------------------------------------------------- event feed

  _push(entry) {
    const e = { ...entry, id: ++this.seq, at: Date.now() };
    this.activity.unshift(e);
    if (this.activity.length > 400) this.activity.length = 400;
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of this.listeners) {
      try { res.write(frame); } catch { this.listeners.delete(res); }
    }
    return e;
  }

  subscribe(res) {
    this.listeners.add(res);
    res.on("close", () => this.listeners.delete(res));
  }
}

module.exports = { Chain, POLICY_SPECS, PAYEES, SINK, FUND_ETH, artifact };
