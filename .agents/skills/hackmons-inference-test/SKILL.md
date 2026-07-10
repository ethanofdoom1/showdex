---
name: hackmons-inference-test
description: >-
  Runs the end-to-end verification loop for the Hackmons Cup spread-inference feature
  (src/features/hackmons-cup-inference). Use this whenever you touch inference, parsing, the
  Estimated Spread UI, syncBattle's hackmons branch, or the e2e debug scripts — and any time the
  user asks to test / verify / debug / check the accuracy of Hackmons spread estimates, damage
  inference, or the "Estimated Spread" suggestion. It drives a real Showdown battle via Playwright,
  compares the inferred spread against a known one, and tells you how to read the result. Reach for
  this even if the user just says "run the hackmons test", "did my inference change regress
  anything", or "check the estimate" — it's the canonical way to validate this feature.
---

# Hackmons Cup inference — testing loop

This feature has **no unit tests**; it's verified by driving an actual Showdown battle and checking
the inferred opponent spread against the real one. The harness (`scripts/e2e-custom-hackmons-debug.mjs`)
plays a scripted battle between a known Vaporeon (the viewer) and a known Mew (the opponent the
inference must guess), then prints how close the estimate landed.

Background on the feature itself lives in `src/features/hackmons-cup-inference/sprint.md` — read it
if you need architecture/context.

## Prerequisites (check before running)

1. **A local Showdown server must be reachable at `http://localhost.psim.us`.** The scripts connect
   there. If it isn't running, the run will hang at name/battle handshake — start it (the
   pokemon-showdown server) first. This is the #1 cause of failures.
2. The script auto-builds the extension to `build/chrome` if missing, but after **any source change
   you must rebuild** so the browser loads new code: `pnpm build:chrome`.
3. Runs launch **headed Chrome** (two profiles) and take ~2-3 minutes. Run them in the background
   and poll, never inline-blocking.

## The loop

Make one focused change, then:

```bash
pnpm build:chrome                                   # rebuild so the browser runs new code
SCENARIO=physical node ./scripts/e2e-custom-hackmons-debug.mjs   # run one scenario
```

Run it in the background (it's long + headed) and wait for `Final custom Hackmons debug snapshot:`
to appear in the captured output, then summarize with the bundled scanner:

```bash
scripts/scan-e2e-output.sh <captured-output-file>
```

`scan-e2e-output.sh` (in this skill's `scripts/`) prints the signals that matter — scenario,
completion, hard failures, `damageMismatches`, confidence + nature histograms, the UI-freeze count,
the final `spreadVerification` deltas, and per-event observed-vs-modeled lines — so you don't
re-derive greps each time. Prefer it over ad-hoc grepping.

`pnpm typecheck` and `pnpm lint` are the static checks (the repo has no `test` script). Run them
before the e2e on code changes.

## Scenarios

`SCENARIO=<name>` selects the matchup (default `mixed`). Each probes different stats so you can
target what your change affects:

| Scenario   | Probes                         | Real opponent (Mew) |
|------------|--------------------------------|---------------------|
| `mixed`    | SpA + speed bound              | Quiet, special attacker |
| `physical` | Atk + Def                      | Adamant, physical attacker |
| `multihit` | multi-hit damage aggregation   | Adamant, Bullet Seed/Rock Blast |
| `crit`     | crit detection + modeling      | Adamant + Merciless/Toxic Orb |
| `speedtie` | boundary-inclusive speed bound + bound collapsing | Quiet, engineered to Spe 184 == Vaporeon's Spe |
| `ragefist` | Rage Fist variable BP (hit-counter threading) | Adamant, Rage Fist after 3/4 historical hits |
| `rollout`  | Rollout variable BP (repeat-count + Defense Curl doubling) | Adamant, Defense Curl + Rollout |
| `furycutter` | Fury Cutter variable BP (repeat-count doubling, no combo) | Adamant, Fury Cutter x4 |
| `upperhand`| confirms Upper Hand isn't actually bugged      | Adamant, Upper Hand vs Vaporeon's Quick Attack |
| `hugepower`| unconfirmed-ability neutralization             | Adamant + Huge Power (never reveals via log)   |

Run the scenario(s) relevant to your change; run all ten before declaring a broad change safe.

All scenarios run in **Pure Hackmons** (`gen9purehackmons`), not Balanced Hackmons: BH's banlist
silently rejects otherwise-legal sets (e.g. Storm Throw, Rage Fist), and a rejected team surfaces only
as a generic "battle room never appeared" timeout with no explicit error -- easy to misdiagnose as a
connection flake. If you hit that timeout after teams seed successfully, suspect a banned move/ability
before assuming it's transient.

## Reading the result (what "good" looks like)

- **`damageMismatches` empty** — the inference's observed damage% matches the harness's independent
  parse. Non-empty = the estimate is reading damage differently than reality → investigate.
- **`spreadVerification.deltas`** — estimate stats vs the known real spread, in %. The *probed*
  stats should be small (≈0-7%). A stat the scenario doesn't probe sitting at ~6.6% is just the
  unconstrained mid-range default — **expected, not a regression.**
- **nature** — should match the real spread for the probed scenario (e.g. `physical` → Adamant,
  `mixed` → Quiet).
- **estimate must still be visible even with outliers** — a damage event that can't be explained by
  any candidate (an unmodeled move mechanic, or a boosted/reduced hit from an uninferred item/ability)
  gets tagged `outlier` and shown in the UI's meta line (e.g. "3 modeled damage events,
  2 outliers"), but must never blank the whole "Estimated Spread" section. If `estimateVisible` goes
  false while `backendEventCount` is nonzero, that's this regression.
- **UI-freeze count 0** — `Progress wait timed out` means the inference blocked the main thread; a
  nonzero count is a performance regression.
- **per-event `delta`** — each observed hit should land within the modeled `range` (delta ≈ 0-2%).
- **blank-prior estimate at battle start** — every run logs an `Initial snapshot (before any planned
  turn):` block, captured right as turn 1 begins. It should show `estimateVisible: true` with a
  default spread (IV 15 / EV 128 / Serious nature, LOW confidence, "0 modeled damage events") — the
  estimate must appear immediately, not wait for the first event. Team preview itself is too early to
  expect this (Calcdex's per-Pokemon UI isn't mounted yet), which is why the snapshot waits for turn 1.
- **temporary debug block** — `HackmonsSpreadEstimate.tsx` currently has a `TEMPORARY`-marked block
  rendering per-event matches directly in the UI (added for manual review outside the e2e harness).
  It's unconditional (not gated behind `__DEV__`, since `pnpm build:chrome` sets `NODE_ENV=production`
  and would hide it). Remove it (and the matching `.debug*` SCSS classes) once manual review is done —
  see `sprint.md`'s "Temporary: debug per-event log block" section.

Discipline: **one hypothesis → one fix → rerun the affected scenario → confirm the targeted
delta/mismatch clears without regressing the others** (matches the repo's AGENTS.md workflow).

## Gotchas (learned the hard way)

- **Transient startup `TimeoutError`** at `waitForBattleRoom` / name handshake is usually a flake
  (challenge/accept race) if it happens once — retry the same scenario. If it fails **again** after
  teams seed successfully (no explicit error, just a timeout), suspect an illegal set before assuming
  it's transient — Balanced Hackmons' banlist used to reject sets this way with no visible message,
  which is why every scenario now runs in Pure Hackmons instead (see above).
- The `crit` scenario forces crits with **Merciless + Toxic Orb/Magic Guard** rather than a
  guaranteed-crit move like Storm Throw (opening with Earthquake so the poison locks in before any
  paralysis) — a holdover from when this scenario targeted Balanced Hackmons, which banned those
  moves. Still works fine under Pure Hackmons; no need to change it.
- **Use disjoint damaging move names across the two sides** in any new scenario. The harness pairs
  `damageMismatches` by `(turn, moveName)`; the same move on both sides pairs the wrong events and
  produces false mismatches.
- **The harness aggregates multi-hit** damage (sums consecutive same-move/same-target hits) to match
  the inference — keep that intact if you edit the snapshot parser.
- After editing inference/parse/UI code, **rebuild before rerunning** or you'll test stale code.

## Adding a scenario

Edit the `scenarios` map in `scripts/e2e-custom-hackmons-debug.mjs` (each entry: `teams` via the
`teamA`/`teamB` helpers, `plannedTurns`, and the real spread is parsed from team B). Keep damaging
moves disjoint per side, and pick a planned-turn sequence that produces several clean samples of
the stat you want to probe (interleave `Recover` to prolong the battle).
