const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const SINK = ethers.getAddress("0x00000000000000000000000000000000deadbeef");
const PAYEE = ethers.getAddress("0x000000000000000000000000000000000000c0de");

async function advance(s) {
  await network.provider.send("evm_increaseTime", [s]);
  await network.provider.send("evm_mine", []);
}

async function fixture() {
  const [owner, agent, stranger] = await ethers.getSigners();
  const wallet = await (await ethers.getContractFactory("PolicyWallet"))
    .deploy(owner.address, agent.address);
  const pol = {};
  for (const n of ["PerTxCap", "Allowlist", "ApprovalCap", "RollingCap", "Timelock", "VelocityBreaker"]) {
    pol[n] = await (await ethers.getContractFactory(n)).deploy();
  }
  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  await owner.sendTransaction({ to: await wallet.getAddress(), value: E(100) });
  return { owner, agent, stranger, wallet, pol, token };
}

async function use(f, names) {
  for (const n of names) await f.wallet.connect(f.owner).addPolicy(await f.pol[n].getAddress());
}

/** submit and return {settled, ruleId} read from the emitted event */
async function propose(f, to, value, data = "0x") {
  const rc = await (await f.wallet.connect(f.agent).propose(to, value, data)).wait();
  let settled = false, ruleId = 0;
  for (const log of rc.logs) {
    let ev; try { ev = f.wallet.interface.parseLog(log); } catch { continue; }
    if (!ev) continue;
    if (ev.name === "Executed") settled = true;
    if (ev.name === "Refused") ruleId = Number(ev.args[2]);
  }
  return { settled, ruleId, gasUsed: rc.gasUsed };
}

describe("PolicyWallet — access control", () => {
  it("T10: refuses propose() from a non-agent account", async () => {
    const f = await fixture();
    await expect(f.wallet.connect(f.stranger).propose(PAYEE, E(1), "0x"))
      .to.be.revertedWithCustomError(f.wallet, "NotAgent");
  });
  it("T11: refuses addPolicy() from the agent account", async () => {
    const f = await fixture();
    await expect(f.wallet.connect(f.agent).addPolicy(await f.pol.PerTxCap.getAddress()))
      .to.be.revertedWithCustomError(f.wallet, "NotOwner");
  });
  it("permits a transfer when no policy is registered", async () => {
    const f = await fixture();
    expect((await propose(f, PAYEE, E(1))).settled).to.equal(true);
  });
});

describe("PerTxCap (rule 2)", () => {
  it("T1: permits a transfer below the cap", async () => {
    const f = await fixture(); await use(f, ["PerTxCap"]);
    await f.pol.PerTxCap.setCap(E(2));
    expect((await propose(f, PAYEE, E(1))).settled).to.equal(true);
  });
  it("T2: refuses a transfer above the cap, attributing rule 2", async () => {
    const f = await fixture(); await use(f, ["PerTxCap"]);
    await f.pol.PerTxCap.setCap(E(2));
    const r = await propose(f, SINK, E(100));
    expect(r.settled).to.equal(false);
    expect(r.ruleId).to.equal(2);
  });
  it("does not stop a drain partitioned below the cap", async () => {
    const f = await fixture(); await use(f, ["PerTxCap"]);
    await f.pol.PerTxCap.setCap(E(2));
    for (let i = 0; i < 5; i++) expect((await propose(f, SINK, E(1.8))).settled).to.equal(true);
    expect(await ethers.provider.getBalance(SINK)).to.equal(E(9));
  });
});

describe("Allowlist (rule 3)", () => {
  it("T3: refuses a destination that is not on the list", async () => {
    const f = await fixture(); await use(f, ["Allowlist"]);
    await f.pol.Allowlist.allow(PAYEE, "0x00000000", true);
    const r = await propose(f, SINK, E(1));
    expect(r.settled).to.equal(false);
    expect(r.ruleId).to.equal(3);
  });
  it("T4: a self-call with an unapproved selector is refused even though the address is listed", async () => {
    const f = await fixture(); await use(f, ["Allowlist"]);
    const self = await f.wallet.getAddress();
    await f.pol.Allowlist.allow(self, "0x00000000", true);      // plain transfer to self allowed
    const r = await propose(f, self, E(1), "0xdeadbeef");        // different selector
    expect(r.settled).to.equal(false);
    expect(r.ruleId).to.equal(3);
  });
});

describe("ApprovalCap (rule 4)", () => {
  it("T5: refuses an unlimited token approval", async () => {
    const f = await fixture(); await use(f, ["ApprovalCap"]);
    await f.pol.ApprovalCap.setCeiling(E(1000));
    const data = f.token.interface.encodeFunctionData("approve", [SINK, ethers.MaxUint256]);
    const r = await propose(f, await f.token.getAddress(), 0, data);
    expect(r.settled).to.equal(false);
    expect(r.ruleId).to.equal(4);
  });
  it("permits an approval within the ceiling", async () => {
    const f = await fixture(); await use(f, ["ApprovalCap"]);
    await f.pol.ApprovalCap.setCeiling(E(1000));
    const data = f.token.interface.encodeFunctionData("approve", [SINK, E(10)]);
    expect((await propose(f, await f.token.getAddress(), 0, data)).settled).to.equal(true);
  });
});

describe("RollingCap (rule 6)", () => {
  it("T8: refuses once cumulative spend passes the window cap", async () => {
    const f = await fixture(); await use(f, ["RollingCap"]);
    await f.pol.RollingCap.configure(E(5), 3600);
    expect((await propose(f, SINK, E(2))).settled).to.equal(true);
    expect((await propose(f, SINK, E(2))).settled).to.equal(true);
    const r = await propose(f, SINK, E(2));                     // would be 6 > 5
    expect(r.settled).to.equal(false);
    expect(r.ruleId).to.equal(6);
  });
  it("permits the same transfer once the window has rolled — it can be waited out", async () => {
    const f = await fixture(); await use(f, ["RollingCap"]);
    await f.pol.RollingCap.configure(E(5), 3600);
    await propose(f, SINK, E(4));
    expect((await propose(f, SINK, E(2))).settled).to.equal(false);
    await advance(3700);
    expect((await propose(f, SINK, E(2))).settled).to.equal(true);
  });
});

describe("VelocityBreaker (rule 5)", () => {
  it("T6: trips once the rate is exceeded", async () => {
    const f = await fixture(); await use(f, ["VelocityBreaker"]);
    await f.pol.VelocityBreaker.configure(3, 3600);
    for (let i = 0; i < 3; i++) expect((await propose(f, SINK, E(1))).settled).to.equal(true);
    const r = await propose(f, SINK, E(1));
    expect(r.settled).to.equal(false);
    expect(r.ruleId).to.equal(5);
    expect(await f.pol.VelocityBreaker.paused()).to.equal(true);
  });
  it("T7: stays latched after the window rolls — it cannot be waited out", async () => {
    const f = await fixture(); await use(f, ["VelocityBreaker"]);
    await f.pol.VelocityBreaker.configure(3, 3600);
    for (let i = 0; i < 4; i++) await propose(f, SINK, E(1));
    await advance(7200);
    expect((await propose(f, SINK, E(1))).settled).to.equal(false);
  });
  it("only the owner can clear the latch", async () => {
    const f = await fixture(); await use(f, ["VelocityBreaker"]);
    await f.pol.VelocityBreaker.configure(1, 3600);
    await propose(f, SINK, E(1)); await propose(f, SINK, E(1));
    await expect(f.pol.VelocityBreaker.connect(f.agent).unpause())
      .to.be.revertedWithCustomError(f.pol.VelocityBreaker, "NotOwner");
    await f.pol.VelocityBreaker.connect(f.owner).unpause();
    expect(await f.pol.VelocityBreaker.paused()).to.equal(false);
  });
});

describe("Timelock (rule 7)", () => {
  it("T9: defers a transfer above the threshold, then permits it after the delay", async () => {
    const f = await fixture(); await use(f, ["Timelock"]);
    await f.pol.Timelock.configure(E(1), 86400);
    const r1 = await propose(f, SINK, E(5));
    expect(r1.settled).to.equal(false);
    expect(r1.ruleId).to.equal(7);
    expect((await propose(f, SINK, E(5))).settled).to.equal(false);   // still inside the delay
    await advance(86500);
    expect((await propose(f, SINK, E(5))).settled).to.equal(true);
  });
  it("leaves transfers below the threshold alone", async () => {
    const f = await fixture(); await use(f, ["Timelock"]);
    await f.pol.Timelock.configure(E(1), 86400);
    expect((await propose(f, PAYEE, E(0.5))).settled).to.equal(true);
  });
});

describe("Composition", () => {
  it("attributes the refusal to the first policy that refuses", async () => {
    const f = await fixture(); await use(f, ["PerTxCap", "Allowlist"]);
    await f.pol.PerTxCap.setCap(E(2));
    await f.pol.Allowlist.allow(PAYEE, "0x00000000", true);
    expect((await propose(f, SINK, E(100))).ruleId).to.equal(2);   // cap is registered first
    expect((await propose(f, SINK, E(1))).ruleId).to.equal(3);     // within cap, wrong destination
  });
  it("does not advance a counter for an operation a later policy refuses", async () => {
    const f = await fixture(); await use(f, ["RollingCap", "Allowlist"]);
    await f.pol.RollingCap.configure(E(5), 3600);
    await f.pol.Allowlist.allow(PAYEE, "0x00000000", true);
    await propose(f, SINK, E(4));                 // refused by the allowlist
    expect(await f.pol.RollingCap.spent()).to.equal(0n);
    expect((await propose(f, PAYEE, E(4))).settled).to.equal(true);
    expect(await f.pol.RollingCap.spent()).to.equal(E(4));
  });
});
