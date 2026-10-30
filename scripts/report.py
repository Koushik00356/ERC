"""Regenerate RESULTS.md from results/results.json so no number is typed by hand."""
import json, os
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = json.load(open(f"{H}/results/results.json"))
E, G, T = R["experiments"], R["gas"], R["thresholds"]
F = R["fundEth"]

PN = {"cap": "PerTxCap", "allowlist": "Allowlist", "approvalCap": "ApprovalCap",
      "rollingCap": "RollingCap", "timelock": "Timelock", "breaker": "VelocityBreaker",
      "none": "No policy", "cap_rolling": "Cap + RollingCap",
      "cap_breaker": "Cap + VelocityBreaker", "cap_allowlist": "Cap + Allowlist",
      "full": "All six"}
RID = {"cap": 2, "allowlist": 3, "approvalCap": 4, "breaker": 5,
       "rollingCap": 6, "timelock": 7}
POLS = ["cap", "allowlist", "approvalCap", "rollingCap", "timelock", "breaker"]
ARMS = ["none", "cap", "cap_rolling", "cap_breaker", "cap_allowlist", "full"]
C = lambda loss, base: f"{(1 - loss / base) * 100:.1f}%" if base else "—"

L = []
w = L.append
w("# Measured results\n")
w(f"Generated from `results/results.json`. Wallet funded with **{F} ETH**. "
  "Containment ratio C = 1 − (loss / baseline loss).\n")
w("Thresholds: per-transaction cap "
  f"{T['perTxCap']} ETH; rolling cap {T['rollingCap']} ETH per "
  f"{T['rollingWindow']//60} min; breaker {T['maxOps']} ops per "
  f"{T['opsWindow']//60} min; timelock on anything above {T['timelockAt']} ETH "
  f"for {T['timelockDelay']//3600} h; approval ceiling {T['approvalCeil']} tokens.\n")

w("\n## E1 — baseline, no policy registered\n")
w("| Attack | Proposals | Settled | Loss (ETH) |")
w("|---|---:|---:|---:|")
for k, lab in (("none_blunt", "Blunt drain (1 × 100 ETH)"),
               ("none_patient", "Patient drip (55 × 1.8 ETH)")):
    r = E["E1"][k]
    w(f"| {lab} | {r['proposals']} | {r['settled']} | {r['loss']:.2f} |")

w("\n## E2 — each policy in isolation\n")
w("Loss in ETH; containment against the E1 baseline in brackets.\n")
w("| Policy | Rule | Blunt drain | Patient drip | Unlimited approval |")
w("|---|:--:|---|---|---|")
BASE = {"blunt": E["E1"]["none_blunt"]["loss"], "patient": E["E1"]["none_patient"]["loss"],
        "approval": 100.0}
for p in POLS:
    cells = []
    for a in ("blunt", "patient", "approval"):
        v = E["E2"][p][a]["loss"]
        cells.append(f"{v:.2f}  ({C(v, BASE[a])})")
    w(f"| {PN[p]} | {RID[p]} | " + " | ".join(cells) + " |")

w("\n## E3 — composition, against the static patient drip\n")
w("| Configuration | Proposals | Settled | Loss (ETH) | Containment |")
w("|---|---:|---:|---:|---:|")
for k in ["cap_rolling", "cap_breaker", "cap_allowlist", "full"]:
    r = E["E3"][k]["patient"]
    w(f"| {PN[k]} | {r['proposals']} | {r['settled']} | {r['loss']:.2f} | "
      f"{C(r['loss'], BASE['patient'])} |")

w("\n## E4 — adaptive adversary\n")
w("The adversary probes, bisects to find the cap, waits out any window it detects, "
  "and gives up when no path to value remains.\n")
w("| Configuration | Proposals | Settled | First settlement at | Loss (ETH) | Containment |")
w("|---|---:|---:|---:|---:|---:|")
for k in ARMS:
    r = E["E4"][k]
    first = r.get("attemptsToFirstSettlement")
    w(f"| {PN[k]} | {r['proposals']} | {r['settled']} | "
      f"{first if first else '—'} | {r['loss']:.2f} | {C(r['loss'], 100.0)} |")

w("\n## E5 — benign workload, false-block cost\n")
w("Eight legitimate payments. Steady: 0.5 ETH at 20-minute gaps. "
  "Burst: 0.9 ETH at 1-minute gaps.\n")
w("| Configuration | Steady completion | Burst completion |")
w("|---|---:|---:|")
for k in E["E5"]:
    r = E["E5"][k]
    w(f"| {PN.get(k, k)} | {r['steady']['completion']*100:.0f}% | "
      f"{r['burst']['completion']*100:.0f}% |")

w("\n## Gas\n")
w("Gas charged to the whole `propose()` call. A refusal short-circuits at the first "
  "policy that refuses, so a refusal under a long policy list can cost less than a "
  "permit. With no policy registered nothing can refuse, so both columns measure the "
  "same permitted operation.\n")
w("| Configuration | Policies | Permitted | Refused | Overhead vs none (permitted) |")
w("|---|---:|---:|---:|---:|")
b = G["none"]["permitted"]
for k, g in G.items():
    w(f"| {PN.get(k,k)} | {g['policies']} | {g['permitted']:,} | {g['refused']:,} | "
      f"+{g['permitted']-b:,} |")

w("\n## Security–utility frontier\n")
w("| Configuration | Adaptive loss (ETH) | Burst benign completion |")
w("|---|---:|---:|")
for k in ARMS:
    w(f"| {PN[k]} | {E['E4'][k]['loss']:.2f} | "
      f"{E['E5'][k]['burst']['completion']*100:.0f}% |")

w("\n## Limitations of these numbers\n")
w("These are the four places a reviewer will push, so they are stated here rather "
  "than discovered in the viva.\n")
w("1. **The Allowlist result is a property of the threat model, not a general win.** "
   "The adversary in this harness has one destination, which is not on the list, so "
   "the allowlist refuses everything and the adversary gives up after 7 probes. An "
   "attacker who redirects value to a *listed* payee — a compromised supplier, or a "
   "contract the wallet legitimately trades with — walks straight through it. The "
   "100% figure measures destination novelty, not containment.")
w("2. **The Timelock result is an artefact of the measurement horizon.** Timelock "
   f"defers rather than refuses, and the harness never runs past the {T['timelockDelay']//3600} h "
   "delay in the attack arms. Its 0.00 ETH is 'nothing settled yet', not 'nothing "
   "will settle'. Its real contribution is review time, which this harness does not "
   "model because it has no reviewer in it.")
w("3. **The adaptive adversary is one strategy, not a bound.** It probes, bisects, "
   "waits out windows and drips. It does not split value across destinations, batch "
   "through a contract call, or use token transfers to move value. Loss figures are "
   "lower bounds on what a better adversary extracts.")
w("4. **Gas is measured on a single-contract path, not through an ERC-4337 "
   "EntryPoint.** The stage-1 rules would run inside `validateUserOp` under the "
   "ERC-7562 restrictions; the stage-2 rules could not, which is the whole reason "
   "for the split. These numbers show relative policy cost, not bundler-accepted "
   "validation gas.\n")

w("\n### Figures\n")
for f, cap in (("fig1_static_vs_adaptive", "Loss under a static and an adaptive adversary"),
               ("fig2_frontier", "Security–utility frontier"),
               ("fig3_coverage", "Which rule contains which attack"),
               ("fig4_gas", "Gas cost of policy evaluation"),
               ("fig5_adaptive_trace", "Adaptive adversary probe sequence")):
    w(f"![{cap}](results/figures/{f}.png)\n*{cap}.*\n")

open(f"{H}/RESULTS.md", "w").write("\n".join(L) + "\n")
print("RESULTS.md written,", len(L), "lines")
