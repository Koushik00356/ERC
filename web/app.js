/* Policy console. Talks to the Express API in ../server, renders live events. */

const $ = (id) => document.getElementById(id);
const api = async (url, body) => {
  const res = await fetch(url, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};

const fmt = (n, d = 2) =>
  Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

let state = null;
let feed = [];
let busy = false;

/* ----------------------------------------------------------------- toast */

let toastT;
function toast(msg, bad = false) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 3200);
}

/* ------------------------------------------------------------------ views */

const TITLES = {
  overview: ["Overview", "What the agent proposed, and what the wallet allowed."],
  policies: ["Policies", "Six rules, split by whether they can run during validation."],
  activity: ["Activity", "The complete record for this session."],
  model: ["Threat model", "What is assumed, and what is not claimed."],
};

$("nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (!btn) return;
  const view = btn.dataset.view;
  for (const b of $("nav").querySelectorAll("button"))
    b.setAttribute("aria-current", String(b === btn));
  for (const s of document.querySelectorAll(".view"))
    s.hidden = s.id !== `view-${view}`;
  $("viewTitle").textContent = TITLES[view][0];
  $("viewSub").textContent = TITLES[view][1];
});

$("modeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  for (const b of $("modeSeg").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b === btn));
  for (const m of ["attack", "manual", "owner"])
    $(`pane-${m}`).hidden = m !== btn.dataset.mode;
});

/* --------------------------------------------------------------- rendering */

function renderStats() {
  const s = state;
  const lost = s.lostEth;
  const contain = s.fundedEth ? Math.max(0, 1 - lost / s.fundedEth) : 1;
  const active = s.policies.filter((p) => p.enabled);

  $("statBalance").textContent = fmt(s.balanceEth);
  $("statBalanceD").textContent = `of ${fmt(s.fundedEth, 0)} ETH funded`;
  $("statLost").textContent = fmt(lost);
  $("statLostD").textContent = lost > 0
    ? `${fmt((lost / s.fundedEth) * 100, 1)}% of the balance`
    : "nothing has left the wallet";
  $("statRefused").textContent = s.counts.refused;
  $("statRefusedD").textContent = `of ${s.counts.proposals} proposals`;
  $("statRules").innerHTML = `${active.length}<small>/ 6</small>`;

  const latched = s.policies.find((p) => p.status?.latched);
  $("statRulesD").textContent = latched ? "breaker latched" :
    active.length === 0 ? "the agent is unconstrained" : active.map((p) => p.label.split(" ")[0]).join(", ");

  // posture banner
  const waitableOnly = active.length > 0 &&
    active.every((p) => p.stage === "static" || p.waitable === true) &&
    active.some((p) => p.waitable === true);
  const hasLatch = active.some((p) => p.waitable === false);
  const hasAllow = active.some((p) => p.key === "allowlist");

  let title, note, cls;
  if (active.length === 0) {
    title = "No rules active";
    note = "The agent can move the entire balance in one transaction. This is the baseline every containment figure is measured against.";
    cls = "warn";
  } else if (hasAllow) {
    title = "Destination-constrained";
    note = "An allowlist is active, so an adversary with a novel destination has no path to value at all. Note that this holds only while the adversary cannot reach a listed payee.";
    cls = "ok";
  } else if (hasLatch) {
    title = "Latching containment";
    note = "A breaker is active. Once it trips it stays tripped until the owner key clears it, so an adversary cannot wait it out.";
    cls = "ok";
  } else if (waitableOnly) {
    title = "Waitable controls only";
    note = "Every active rule either caps a single transaction or resets on its own. An adversary with patience discovers the ceiling and drains below it.";
    cls = "warn";
  } else {
    title = "Partially constrained";
    note = "Some rules are active, but value can still leave the wallet.";
    cls = "";
  }
  $("postureTitle").textContent = title;
  $("postureNote").textContent = note;
  const meter = $("postureMeter");
  meter.className = "meter " + cls;
  meter.firstElementChild.style.width = `${Math.round(contain * 100)}%`;

  $("kvFunded").textContent = `${fmt(s.fundedEth, 0)} ETH`;
  $("kvBalance").textContent = `${fmt(s.balanceEth)} ETH`;
  $("kvLost").textContent = `${fmt(lost)} ETH`;
  $("kvContain").textContent = `${fmt(contain * 100, 1)}%`;
  $("railWallet").textContent = short(s.wallet);
  $("railAgent").textContent = short(s.agent);
}

function renderPolicies() {
  const grid = $("policyGrid");
  grid.innerHTML = "";
  for (const p of state.policies) {
    const latched = !!p.status?.latched;
    const el = document.createElement("div");
    el.className = "policy" + (p.enabled ? " on" : "") + (latched ? " latched" : "");

    const cfg = Object.entries(p.config)
      .map(([k, v]) => `${k} ${typeof v === "number" && k.endsWith("Seconds")
        ? (v >= 3600 ? `${v / 3600}h` : `${v / 60}m`) : v}`)
      .join("   ");

    const tags = [`<span class="tag rule">rule ${p.ruleId}</span>`,
      `<span class="tag">${p.stage}</span>`];
    if (p.waitable === true) tags.push('<span class="tag waitable">waitable</span>');
    if (p.waitable === false) tags.push('<span class="tag latching">latching</span>');
    if (latched) tags.push('<span class="tag danger">latched</span>');
    if (p.key === "rollingCap" && p.status?.spent > 0)
      tags.push(`<span class="tag">${fmt(p.status.spent)} spent</span>`);

    el.innerHTML = `
      <div class="policy-top">
        <div>
          <div class="policy-name">${p.label}</div>
          <div class="policy-meta">${tags.join("")}</div>
        </div>
        <label class="switch">
          <input type="checkbox" ${p.enabled ? "checked" : ""} data-policy="${p.key}"
                 aria-label="Enable ${p.label}" />
          <span></span>
        </label>
      </div>
      <div class="policy-blurb">${p.blurb}</div>
      <div class="policy-foot"><span class="policy-config">${cfg || "no parameters"}</span></div>`;
    grid.appendChild(el);
  }
}

function rowHTML(e) {
  if (e.kind === "injection") {
    return `<div class="row injection">
      <div class="row-mark m-inj">!</div>
      <div class="row-main">
        <div class="row-title">Injected instruction reaches the agent</div>
        <div class="row-quote">“${escapeHtml(e.text)}”</div>
      </div>
      <div class="row-right"><div class="row-time">${clock(e.at)}</div></div></div>`;
  }
  if (e.kind !== "proposal") {
    return `<div class="row">
      <div class="row-mark m-sys">·</div>
      <div class="row-main"><div class="row-sub">${escapeHtml(e.text)}</div></div>
      <div class="row-right"><div class="row-time">${clock(e.at)}</div></div></div>`;
  }
  const ok = e.settled;
  const sub = ok
    ? `Settled to ${escapeHtml(e.toLabel)}`
    : `Refused by ${escapeHtml(e.refusedBy || "the wallet")} · rule ${e.ruleId}`;
  const dest = `<span class="mono">${short(e.to)}</span>`;
  return `<div class="row">
    <div class="row-mark ${ok ? "m-ok" : "m-no"}">${ok ? "✓" : "✕"}</div>
    <div class="row-main">
      <div class="row-title">${escapeHtml(e.intent)}</div>
      <div class="row-sub">${sub}${e.hasCalldata ? " · with calldata" : ""} · ${dest}</div>
    </div>
    <div class="row-right">
      <div class="row-amt ${ok && e.valueEth > 0 ? "out" : "held"}">
        ${ok && e.valueEth > 0 ? "−" : ""}${fmt(e.valueEth)} ETH</div>
      <div class="row-time">${clock(e.at)}</div>
    </div></div>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderFeed() {
  const empty = '<div class="feed-empty">Nothing proposed yet. Run a scenario from the panel.</div>';
  $("feedShort").innerHTML = feed.length ? feed.slice(0, 12).map(rowHTML).join("") : empty;
  $("feedFull").innerHTML = feed.length ? feed.map(rowHTML).join("") : empty;
}

function renderScenarios() {
  const list = $("scenarioList");
  list.innerHTML = "";
  for (const s of state.scenarios) {
    const benign = s.key.startsWith("benign");
    const b = document.createElement("button");
    b.className = "scenario";
    b.dataset.scenario = s.key;
    b.disabled = busy;
    b.innerHTML = `
      <div class="scenario-icon ${benign ? "benign" : "attack"}">
        ${benign
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'}
      </div>
      <div>
        <div class="scenario-name">${s.label}</div>
        <div class="scenario-note">${s.note}</div>
      </div>`;
    list.appendChild(b);
  }
}

function renderDestinations() {
  const sel = $("toSel");
  if (sel.options.length) return;
  const opts = [
    { v: state.sink, t: "Unknown address (the adversary)" },
    ...state.payees.map((p) => ({ v: p.address, t: `${p.label} — allowlisted` })),
    { v: state.token, t: "Mock token contract" },
  ];
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o.v; el.textContent = o.t;
    sel.appendChild(el);
  }
}

function setBusy(label) {
  busy = !!label;
  const chip = $("statusChip");
  chip.className = "chip " + (busy ? "busy" : "live");
  $("statusText").textContent = busy ? label : "live";
  for (const b of document.querySelectorAll("[data-scenario]")) b.disabled = busy;
  $("proposeBtn").disabled = busy;
}

/* ------------------------------------------------------------------ wiring */

document.addEventListener("change", async (e) => {
  const cb = e.target.closest("input[data-policy]");
  if (!cb) return;
  try {
    state = await api(`/api/policy/${cb.dataset.policy}`, { enabled: cb.checked });
    renderStats(); renderPolicies();
  } catch (err) { toast(err.message, true); cb.checked = !cb.checked; }
});

document.addEventListener("click", async (e) => {
  const sc = e.target.closest("[data-scenario]");
  if (!sc) return;
  try {
    const r = await api(`/api/scenario/${sc.dataset.scenario}`, {});
    setBusy(r.started);
  } catch (err) { toast(err.message, true); }
});

$("proposeBtn").addEventListener("click", async () => {
  try {
    await api("/api/propose", {
      to: $("toSel").value,
      valueEth: $("amt").value || "0",
      data: $("dataIn").value.trim() || "0x",
      intent: "Manual proposal",
    });
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$("unpauseBtn").addEventListener("click", async () => {
  try { state = await api("/api/unpause", {}); renderStats(); renderPolicies(); toast("Breaker cleared."); }
  catch (err) { toast(err.message, true); }
});
const advance = async (seconds) => {
  try { state = await api("/api/advance", { seconds }); renderStats(); renderPolicies(); }
  catch (err) { toast(err.message, true); }
};
$("advanceBtn").addEventListener("click", () => advance(3600));
$("advanceDayBtn").addEventListener("click", () => advance(86400));

$("resetBtn").addEventListener("click", async () => {
  try {
    state = await api("/api/reset", {});
    feed = []; renderFeed(); renderStats(); renderPolicies();
    toast("Wallet redeployed and refunded.");
  } catch (err) { toast(err.message, true); }
});

$("clearFeed").addEventListener("click", () => { feed = []; renderFeed(); });

/* -------------------------------------------------------------- live feed */

async function refresh() {
  state = await api("/api/state");
  renderStats(); renderPolicies(); renderScenarios(); renderDestinations();
}

function connect() {
  const es = new EventSource("/api/stream");
  es.onopen = () => setBusy(null);
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    feed.unshift(e);
    if (feed.length > 300) feed.length = 300;
    renderFeed();
    if (/finished\.$/.test(e.text || "")) setBusy(null);
    clearTimeout(connect._t);
    connect._t = setTimeout(() => refresh().catch(() => {}), 120);
  };
  es.onerror = () => {
    $("statusChip").className = "chip";
    $("statusText").textContent = "disconnected";
  };
}

(async () => {
  try {
    const { activity } = await api("/api/activity");
    feed = activity;
    await refresh();
    renderFeed();
    setBusy(null);
    connect();
  } catch (err) {
    $("statusText").textContent = "no server";
    toast("Cannot reach the API. Is the server running?", true);
  }
})();
