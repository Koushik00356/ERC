const path = require("path");
const express = require("express");
const { Chain } = require("./chain");
const { SCENARIOS } = require("./scenarios");

const PORT = Number(process.env.PORT || 5173);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

const chain = new Chain();
let running = null;   // name of the scenario in flight, or null

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.shortMessage || e.message });
  });
};

app.get("/api/state", wrap(async (_req, res) => {
  const s = await chain.state();
  res.json({ ...s, running, scenarios: Object.entries(SCENARIOS).map(([k, v]) => ({
    key: k, label: v.label, payload: v.payload, note: v.note,
  })) });
}));

app.get("/api/activity", wrap(async (_req, res) => {
  res.json({ activity: chain.activity.slice(0, 120) });
}));

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  chain.subscribe(res);
});

app.post("/api/propose", wrap(async (req, res) => {
  const { to, valueEth, data, intent } = req.body || {};
  if (!to) return res.status(400).json({ error: "a destination is required" });
  res.json(await chain.propose({
    to, valueEth, data: data || "0x", intent: intent || "Manual proposal",
  }));
}));

app.post("/api/policy/:key", wrap(async (req, res) => {
  const { enabled, config } = req.body || {};
  if (config) await chain.configure(req.params.key, config);
  if (typeof enabled === "boolean") await chain.setEnabled(req.params.key, enabled);
  res.json(await chain.state());
}));

app.post("/api/unpause", wrap(async (_req, res) => {
  await chain.unpauseBreaker();
  res.json(await chain.state());
}));

app.post("/api/advance", wrap(async (req, res) => {
  await chain.advanceTime(Number(req.body?.seconds || 3600));
  res.json(await chain.state());
}));

app.post("/api/scenario/:key", wrap(async (req, res) => {
  const s = SCENARIOS[req.params.key];
  if (!s) return res.status(404).json({ error: "unknown scenario" });
  if (running) return res.status(409).json({ error: `${running} is still running` });

  running = s.label;
  res.json({ started: s.label });            // reply at once; the UI watches the stream

  const emit = (text, who = "injection") =>
    chain._push({ kind: who === "injection" ? "injection" : "note", who, text });
  try {
    await s.run(chain, emit);
  } catch (e) {
    chain._push({ kind: "system", text: `Scenario failed: ${e.shortMessage || e.message}` });
  } finally {
    running = null;
    chain._push({ kind: "system", text: `${s.label} finished.` });
  }
}));

app.post("/api/reset", wrap(async (_req, res) => {
  if (running) return res.status(409).json({ error: `${running} is still running` });
  await chain.deployAll();
  res.json(await chain.state());
}));

(async () => {
  try {
    await chain.connect();
  } catch {
    console.error(
      "\n  No JSON-RPC node at " + (process.env.RPC_URL || "http://127.0.0.1:8545") +
      "\n  Start one in another terminal:  npx hardhat node\n");
    process.exit(1);
  }
  await chain.deployAll();
  const s = await chain.state();
  app.listen(PORT, () => {
    console.log(`\n  Policy console   http://localhost:${PORT}`);
    console.log(`  wallet ${s.wallet}`);
    console.log(`  owner  ${s.owner}`);
    console.log(`  agent  ${s.agent}   (compromised in every scenario)\n`);
  });
})();
