# Hackmons Cup Stat Inference — Handoff

**Status:** in progress (v1.3.0). Core inference + UI are working and verified end-to-end against
a scripted Playwright battle. Performance, crit/multi-hit, speed-as-bound, and confidence are done.
Remaining work is mostly accuracy depth and broader battle-shape coverage (see Next Steps).

## What it does

Infers an opponent's IV/EV/nature spread in `gen*hackmonscup` / `*balancedhackmons` battles from
damage already present in `battle.stepQueue`, and surfaces it as a non-binding Calcdex suggestion
("Estimated Spread") with **Apply** / **Reset**. It never writes IVs/EVs without the user pressing
Apply.

## Architecture / data flow

`syncBattle()` → (hackmons format + stepQueue grew) → `syncHackmonsInference(state, stepQueue)`:

1. `parseStepQueue.ts` — `parseHackmonsInferenceEvents()` walks turn chunks
   (`chunkStepQueueTurns`), tracking per-mon boosts/status/HP, and emits `damage` events
   (attacker/defender/move/boosts/crit/multi-hit/HP) plus inferred `speed`-order events.
2. `inferHackmonsSpread.ts` — for each opponent mon, runs a bounded coordinate-descent search over
   nature/IVs/EVs, scoring candidates by how close `@smogon/calc` median rolls land to observed
   damage; speed acts as a one-sided constraint. Publishes a best `estimate` (gated on at least one
   in-range damage match), a `confidence` tier, and `speedNotes`.
3. `syncHackmonsInference.ts` — thin orchestrator.
4. State: `CalcdexBattleState.hackmonsInference` (keyed by `calcdexId`), reducer
   `resetHackmonsInference` in `calcdexSlice.ts`, deep-clone in `cloneBattleState.ts`.
5. UI: `HackmonsSpreadEstimate.tsx` (under `PokeStats`, opponent only) — IVs/EVs/nature/confidence,
   deduped Speed bounds, modeled damage count, Apply / Reset. Detailed per-event matches are kept in
   component data attributes for the e2e harness, not rendered as user-facing rows.

### File map
- `src/features/hackmons-cup-inference/` — `parseStepQueue.ts`, `inferHackmonsSpread.ts`,
  `syncHackmonsInference.ts`, `types.ts`, `index.ts`
- `src/components/calc/HackmonsSpreadEstimate/` — UI component
- Wiring: `src/redux/actions/syncBattle.ts`, `src/redux/store/calcdexSlice.ts`,
  `src/interfaces/calc/CalcdexBattleState.ts`, `src/utils/battle/cloneBattleState.ts`,
  `src/components/calc/PokeCalc/PokeCalc.tsx`
- Test harness: `scripts/e2e-custom-hackmons-debug.mjs` (scripted accuracy),
  `scripts/e2e-hackmons-debug.mjs` (random), `scripts/e2e-local-showdown.mjs` (smoke)

## Done

### Performance (per-turn lag eliminated)
- Inference is gated in `syncBattle.ts` to run only when `stepQueue` actually grew (vs the carried
  `battleStepQueueLength`); otherwise the prior map is carried forward.
- Cache is **per-`calcdexId`**, keyed on that mon's own event signature (`InferenceCache`,
  `CacheVersion = 'bounded-search-v10'`): a new log step only re-searches mons whose events changed.
- `@smogon/calc` rolls are memoized within a single mon's search, keyed on only the candidate stats
  that feed each event's damage — collapses the thousands of redundant `calculate()` calls.
- Budget trimmed: `MaxCandidateCount = 4000`, EV refinement steps coarsened.
- Result: 0 UI-freeze timeouts across all scripted runs.

### Bugs fixed
- **Crit damage was never modeled.** `createSmogonMove()` rebuilds the move from its construction
  `options` inside the patched `calculate()`'s `move.clone()`, so a post-construction
  `move.isCrit = true` mutation was silently dropped (every observed crit was scored as a non-crit,
  ~10-14% low). Fix: pass crit via the attacker's `moveOverrides.alwaysCriticalHits` so it survives
  the clone (`inferHackmonsSpread.ts` ~L476). Found via the crit test scenario.
- **Double `ignoredEventCount++` on indirect (`[from]`) damage** in `parseStepQueue.ts` — now
  counted once; HP tracking preserved.
- **Test harness didn't aggregate multi-hit damage** (compared the inference's per-move total
  against a single hit) — `e2e-custom-hackmons-debug.mjs` snapshot parser now sums consecutive
  same-move/same-target hits.
- **Temporary field/type state could be replayed against the current live state.** Damage and speed
  events now carry event-time snapshots for weather, terrain, room/gravity flags, Tera state, and
  volatile type changes (e.g. Protean). Inference applies those snapshots while evaluating each
  event, so later state changes do not overwrite earlier damage context.
- **Estimate panel was too noisy.** Removed visible per-turn damage diagnostics from
  `HackmonsSpreadEstimate`; users now see the spread, confidence, deduped Speed restrictions, a small
  modeled-event count, and Apply / Reset. The backend `estimate.matches` data is still exposed to the
  scripted test loop via structured `data-hackmons-*` attributes.
- **Preset item/ability contaminated default spread inference.** `inferHackmonsSpread.ts` now clears
  preset-suggested `dirtyAbility` / `dirtyItem` while evaluating damage, preserving only actually
  revealed battle ability/item. Unknown Hackmons item/ability remain neutral until specifically
  inferred.
- **Reloaded battles could keep missing inference state.** `CalcdexBootstrappable` now dispatches
  `syncBattle()` when `stepQueue.length` differs or a Hackmons battle has restored Calcdex state
  without `hackmonsInference`, allowing inference to be reconstructed from the existing log.
- **Lexical package skew broke static checks.** `@lexical/react` and root `lexical` are aligned with
  the rest of the Lexical packages at `0.44.0`; Composer's initial config now uses a lazy initializer
  instead of an empty-deps `useMemo`, satisfying the React Compiler lint rule.

### Speed inference (one-sided bound)
- Removed the mid-range "median centering" that fabricated an inflated Spe under a one-sided bound.
  Speed is now a pure one-sided constraint (penalize only candidates that contradict the observed
  turn order).
- Surfaced as a human-readable bound: `describeSpeedBound()` → `speedNotes` on the state, rendered
  as a "Speed" line in the UI (e.g. `Outsped Vaporeon (Spe ≥ 167)`; numeric bound only when the
  other mon is the auth player's known mon). Bounds now use event-time modified Speed when Speed
  stages or paralysis are present, so a lowered Beedrill no longer contributes its original raw Spe.
- Effect: nature is no longer forced (the observed damage now drives nature correctly, e.g. picks
  Quiet's −Spe), and Spe is no longer inflated to mid-range.

### Confidence
- Recalibrated from "best-vs-adjacent-candidate separation" (always ~0 → permanently LOW) to the
  count of in-range damage matches (`confidenceFromMatches`): ≥3 → high, ≥2 → medium, else low.

### Test harness + scenarios
- `e2e-custom-hackmons-debug.mjs` is parameterized via `SCENARIO=<name>`; each scenario defines
  teams/spreads/planned turns and reuses the `spreadVerification` (estimate stats vs known real
  spread) + `damageMismatches` machinery. Scenarios share a known Vaporeon (viewer) vs inferred Mew
  (opponent). Convention: A and B use **disjoint damaging move names** so the `(turn, move)` matcher
  stays unambiguous.
- Scenarios: `mixed` (SpA + speed), `physical` (Atk + Def), `multihit` (hit aggregation),
  `crit` (crit modeling; uses Merciless + Toxic Orb/Magic Guard since BH bans guaranteed-crit moves,
  opening with Earthquake so poison locks in before any paralysis), `temporary` (Pure Hackmons direct
  challenge; Protean type change + repeated Weather Ball/Terrain Pulse under different weather/terrain
  states). `temporary` includes a harmless final Rain Dance turn so the last damaging event gets a
  subsequent Calcdex sync tick and the final live weather differs from the prior no-rain damage event.

## Current accuracy (final scripted runs)

All scenarios: nature correct, `damageMismatches` empty, 0 UI freezes, confidence mostly HIGH/MEDIUM.

| Scenario | Key stat delta | Notes |
|---|---|---|
| mixed    | SpA 0%, Spe +6.6% (was +18.9%) | nature Quiet ✓; HP −11.6% (unprobed) |
| physical | Atk −1.8%, Def +6.3%           | nature Adamant ✓ |
| multihit | Atk −2.4%, HP −2.5%            | nature Adamant ✓ |
| crit     | Atk −4%, crit delta 0% (was ~11%) | nature Adamant ✓ |
| temporary | backend events 6/6, duplicate-move checks ✓ | UI compact; Weather Ball/Terrain Pulse repeated under changed state |

The recurring ~6.6% deltas on stats a scenario doesn't probe are the unconstrained mid-range
default spread, not errors.

## Known limitations / by-design

- **HP / weakly-constrained defensive stats** settle on the mid-range default (e.g. HP −11.6% when
  not probed). HP↔Def is an identifiability trade-off; we deliberately did **not** add a "common
  spread" prior (overfit risk). Open question: report ranges, or anchor to common spreads.
- **Speed is one-sided only.** We only ever observe "faster/slower than X". Two-sided pinning (a mon
  seen both outspeeding and being outsped) is not yet aggregated, so exact Spe / Quiet-vs-Mild often
  can't be resolved.
- **Singles-only assumptions:** damage attribution (`pendingMoves … .at(-1)`) and speed pairing
  assume singles; doubles/FFA untested. Inference runs only for `state.opponentKey`, so spectated /
  multi-opponent (p3/p4) battles aren't fully covered.
- **Items/abilities not inferred:** unknown Choice Band / Life Orb / Assault Vest / Scarf, and
  speed-affecting abilities/effects (Chlorophyll, Swift Swim, Tailwind, Trick Room) widen or skew
  estimates; not modeled.
- `findPokemonByLogName` uses loose substring matching — could mismatch similarly-named mons.

## Verification loop

- Requires a local Showdown server reachable at `http://localhost.psim.us`.
- Static: `pnpm typecheck` && `pnpm lint` (no `test` script in the repo). Current targeted checks:
  `pnpm typecheck` passes after Lexical alignment; targeted ESLint for touched inference/bootstrapper
  and Composer files passes.
- Build the extension: `pnpm build:chrome` (scripts auto-build to `build/chrome` if missing).
- Accuracy (primary): `SCENARIO=physical node ./scripts/e2e-custom-hackmons-debug.mjs`
  (also `mixed` | `multihit` | `crit` | `temporary`; defaults to `mixed`). Read
  `spreadVerification.deltas`, `damageMismatches`, and for `temporary`, `temporaryEventChecks` in
  the printed snapshots. The compact UI hides per-event rows, so the harness reads detailed
  `estimate.matches` from `data-hackmons-estimate-events`; use `backendEventCount`,
  `backendMatchCount`, and `backendSpeedNotes` to confirm backend access.
- Random challenge sanity: `pnpm e2e:hackmons-debug`.
- One fix at a time: change → re-run the relevant scenario → confirm the targeted delta/mismatch
  clears without regressing the others.

## Next steps (suggested priority)

1. **Two-sided speed aggregation** — combine all speed observations per mon into `[lo, hi]`; pin Spe
   and distinguish ±Spe natures when both bounds exist. Add a scenario where the opponent is both
   outsped and outspeeds.
2. **Defensive-stat / HP identifiability** — decide between reporting per-stat ranges vs a common-
   spread prior; surface per-stat confidence (e.g. high SpA, low HP) rather than one tier.
3. **Item/ability awareness** — at minimum widen damage tolerance under unknown items; consider
   inferring Choice/Orb/AV from damage outliers.
4. **Doubles / FFA / spectator coverage** — fix singles-only attribution + speed pairing; run
   inference for all opponents, not just `state.opponentKey`. Add a doubles scenario.
5. **Harden `findPokemonByLogName`** matching to avoid similar-name collisions.
6. **More scenarios** — boosted attacker/defender, status-modified (burn/para), item sets; consider
   a defender-disambiguating comparison so same-move-both-sides scenarios are allowed.
