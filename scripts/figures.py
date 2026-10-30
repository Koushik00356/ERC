"""Figures for the measured results in results/results.json.
Reuses the house style of the DA-8/DA-9 report figures."""
import json, os
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = json.load(open(os.path.join(HERE, "results", "results.json")))
OUT = os.path.join(HERE, "results", "figures")
E, G = R["experiments"], R["gas"]

INK, MUTED, GRID = "#1A1A1A", "#55606B", "#DDE2E8"
RED, GREEN, AMBER, BLUE = "#A8321E", "#15664F", "#9A6212", "#2C4A7A"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 9,
    "axes.edgecolor": "#9AA3AD", "axes.linewidth": 0.8,
    "axes.labelcolor": INK, "text.color": INK,
    "xtick.color": MUTED, "ytick.color": MUTED,
    "xtick.labelsize": 8.5, "ytick.labelsize": 8.5,
})

def frame(ax, axis="y"):
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    ax.set_axisbelow(True); ax.grid(axis=axis, color=GRID, linewidth=0.7)

NAME = {"none": "No policy", "cap": "PerTxCap", "cap_rolling": "Cap + RollingCap",
        "cap_breaker": "Cap + VelocityBreaker", "cap_allowlist": "Cap + Allowlist",
        "full": "All six policies"}

# ===== FIGURE 1 — static vs adaptive adversary. The headline result. ==========
arms = ["none", "cap", "cap_rolling", "cap_breaker", "cap_allowlist", "full"]
static = [E["E1"]["none_patient"]["loss"], E["E2"]["cap"]["patient"]["loss"]] + \
         [E["E3"][a]["patient"]["loss"] for a in arms[2:]]
adapt = [E["E4"][a]["loss"] for a in arms]
tries = [E["E4"][a]["proposals"] for a in arms]

fig, ax = plt.subplots(figsize=(7.4, 3.6), dpi=220)
frame(ax)
ax.axhline(100, color=MUTED, linewidth=0.9, linestyle=(0, (4, 3)))
ax.text(5.42, 102, "balance 100 ETH", fontsize=7.6, color=MUTED, ha="right", va="bottom")

x = list(range(len(arms))); w = 0.36
b1 = ax.bar([i - w / 2 for i in x], static, w, color=BLUE, edgecolor="white",
            linewidth=0.6, label="Static adversary (fixed 1.8 ETH drip)")
b2 = ax.bar([i + w / 2 for i in x], adapt, w, color=RED, edgecolor="white",
            linewidth=0.6, label="Adaptive adversary (probes, then adapts)")
for bars, vals in ((b1, static), (b2, adapt)):
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 2, f"{v:.1f}", ha="center",
                fontsize=7.9, color=INK)

ax.annotate("RollingCap holds the static drip\nbut the adaptive adversary\nwaits the window out",
            xy=(2.18, 96.5), xytext=(2.6, 62), fontsize=7.8, color=RED,
            arrowprops=dict(arrowstyle="-", color=RED, linewidth=0.8))

ax.set_xticks(x)
ax.set_xticklabels([NAME[a].replace(" + ", "\n+ ") for a in arms], fontsize=8.3)
ax.set_ylabel("Realised adversarial loss (ETH)")
ax.set_ylim(0, 118); ax.yaxis.set_major_locator(MultipleLocator(20))
ax.legend(frameon=False, fontsize=8.2, ncol=2, loc="upper center",
          bbox_to_anchor=(0.5, -0.17))
plt.tight_layout(); plt.savefig(f"{OUT}/fig1_static_vs_adaptive.png",
                                bbox_inches="tight", facecolor="white"); plt.close()

# ===== FIGURE 2 — security/utility frontier ==================================
fig, ax = plt.subplots(figsize=(6.8, 4.1), dpi=220)
frame(ax, axis="both")
# explicit label placement: several arms land on identical coordinates
OFF = {"none": (0, 16, "right"), "cap": (0, -13, "right"),
       "cap_rolling": (0, 14, "center"), "cap_breaker": (6, -13, "left"),
       "cap_allowlist": (0, -15, "center"), "full": (6, 13, "left")}
for a in arms:
    loss = E["E4"][a]["loss"]
    util = E["E5"][a]["burst"]["completion"] * 100
    c = GREEN if loss < 1 and util > 95 else (AMBER if loss < 10 else RED)
    ax.scatter(util, loss, s=76, color=c, zorder=5, edgecolor="white", linewidth=1.1)
    dx, dy, ha = OFF[a]
    ax.annotate(NAME[a], (util, loss), textcoords="offset points",
                xytext=(dx, dy), fontsize=8.3, color=c, ha=ha, zorder=6)

ax.scatter(100, 0, s=430, facecolor="none", edgecolor=GREEN, linewidth=1.0,
           linestyle=(0, (2, 2)), zorder=3)
ax.annotate("zero loss at no\nmeasured utility cost", (100, 0),
            textcoords="offset points", xytext=(-26, 14), fontsize=7.8,
            color=GREEN, ha="right")
ax.set_xlabel("Benign completion under a bursty workload (%)   →  better")
ax.set_ylabel("Adaptive-adversary loss (ETH)   →  worse upward")
ax.set_xlim(30, 108); ax.set_ylim(-16, 112)
ax.invert_yaxis()
plt.tight_layout(); plt.savefig(f"{OUT}/fig2_frontier.png",
                                bbox_inches="tight", facecolor="white"); plt.close()

# ===== FIGURE 3 — per-policy coverage matrix ================================
pols = ["cap", "allowlist", "approvalCap", "rollingCap", "timelock", "breaker"]
PN = {"cap": "PerTxCap", "allowlist": "Allowlist", "approvalCap": "ApprovalCap",
      "rollingCap": "RollingCap", "timelock": "Timelock", "breaker": "VelocityBreaker"}
atk = ["blunt", "patient", "approval"]
AN = {"blunt": "Blunt drain\n(1 × 100 ETH)", "patient": "Patient drip\n(55 × 1.8 ETH)",
      "approval": "Unlimited\napproval"}
base = {"blunt": 100.0, "patient": 99.0, "approval": 100.0}

fig, ax = plt.subplots(figsize=(6.4, 3.9), dpi=220)
for i, p in enumerate(pols):
    for j, a in enumerate(atk):
        loss = E["E2"][p][a]["loss"]
        frac = 0.0 if base[a] == 0 else loss / base[a]
        c = GREEN if frac < 0.02 else (AMBER if frac < 0.5 else RED)
        ax.add_patch(plt.Rectangle((j, i), 1, 1, facecolor=c, alpha=0.16,
                                   edgecolor="white", linewidth=2))
        lab = "contained" if frac < 0.02 else f"{loss:.1f} ETH lost"
        ax.text(j + 0.5, i + 0.56, lab, ha="center", va="center", fontsize=8.1, color=c)
ax.set_xlim(0, 3); ax.set_ylim(0, len(pols)); ax.invert_yaxis()
ax.set_xticks([j + 0.5 for j in range(3)])
ax.set_xticklabels([AN[a] for a in atk], fontsize=8.3)
ax.set_yticks([i + 0.5 for i in range(len(pols))])
RID = {"cap": 2, "allowlist": 3, "approvalCap": 4, "breaker": 5,
       "rollingCap": 6, "timelock": 7}
ax.set_yticklabels([f"{PN[p]}   rule {RID[p]}" for p in pols], fontsize=8.4)
ax.xaxis.set_ticks_position("top")
for s in ax.spines.values(): s.set_visible(False)
ax.tick_params(length=0)
plt.tight_layout(); plt.savefig(f"{OUT}/fig3_coverage.png",
                                bbox_inches="tight", facecolor="white"); plt.close()

# ===== FIGURE 4 — gas overhead ==============================================
fig, ax = plt.subplots(figsize=(6.6, 3.1), dpi=220)
frame(ax)
garms = [a for a in ["none", "cap", "cap_rolling", "full"] if a in G]
perm = [G[a]["permitted"] for a in garms]
ref = [G[a]["refused"] for a in garms]
x = list(range(len(garms))); w = 0.36
for off, vals, c, lab in ((-w / 2, perm, BLUE, "Permitted operation"),
                          (w / 2, ref, AMBER, "Refused operation")):
    bars = ax.bar([i + off for i in x], vals, w, color=c, edgecolor="white",
                  linewidth=0.6, label=lab)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 2200, f"{v:,}", ha="center",
                fontsize=7.8, color=INK)
ax.set_xticks(x)
ax.set_xticklabels([NAME[a].replace(" + ", "\n+ ") for a in garms], fontsize=8.3)
ax.set_ylabel("Gas used by the proposal")
ax.set_ylim(0, max(perm + ref) * 1.22)
ax.legend(frameon=False, fontsize=8.2, ncol=2, loc="upper center",
          bbox_to_anchor=(0.5, 1.14))
plt.tight_layout(); plt.savefig(f"{OUT}/fig4_gas.png",
                                bbox_inches="tight", facecolor="white"); plt.close()
print("4 figures ->", OUT)

# ===== FIGURE 5 — adaptive attacker trace, breaker vs rolling cap ===========
pair = [("cap_breaker", "Cap + VelocityBreaker", GREEN),
        ("cap_rolling", "Cap + RollingCap", RED)]
fig, axes = plt.subplots(2, 1, figsize=(7.4, 4.6), dpi=220, sharex=False)
for ax, (key, title, col) in zip(axes, pair):
    tr = E["E4"][key]["trace"]
    frame(ax)
    n = E["E4"][key]["proposals"]
    show = tr
    xs = list(range(1, len(show) + 1))
    for i, step in zip(xs, show):
        c = col if step["settled"] else "#B9C2CB"
        ax.bar(i, step["value"], 0.72, color=c, edgecolor="white", linewidth=0.4)
    ax.axhline(R["thresholds"]["perTxCap"], color=MUTED, linewidth=0.9,
               linestyle=(0, (4, 3)))
    ax.text(len(show) + 0.4, R["thresholds"]["perTxCap"],
            f"per-tx cap {R['thresholds']['perTxCap']} ETH", fontsize=7.4,
            color=MUTED, va="center")
    ax.set_yscale("log")
    ax.set_ylabel("Amount requested\n(ETH, log scale)", fontsize=8.2)
    tail = "" if len(show) >= n else f"   first {len(show)} shown"
    ax.set_title(f"{title} — {E['E4'][key]['loss']:.2f} ETH lost over "
                 f"{n} proposals{tail}", fontsize=9, color=INK, loc="left", pad=6)
    ax.set_xlim(0.3, len(show) + 0.9)
axes[-1].set_xlabel("Adversary proposal number  (coloured = settled, grey = refused)")
plt.tight_layout(); plt.savefig(f"{OUT}/fig5_adaptive_trace.png",
                                bbox_inches="tight", facecolor="white"); plt.close()
print("5 figures ->", OUT)
