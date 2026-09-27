/**
 * Deterministic offline fixtures for the Hackmons spread-inference fit.
 *
 * Bundles the REAL `inferHackmonsSpread()` (same webpack + shim trick as
 * `l2-search-equivalence.mjs`) and runs it against fixed synthetic damage/speed events -- no
 * Showdown server, no browser, no random rolls. Every case is reproducible byte-for-byte, which is
 * what the live `e2e-custom-hackmons-debug.mjs` harness can't offer (its battles are unseeded).
 *
 * `MODE=fixtures` (default) runs the frozen fixture set; `MODE=sweep` runs the observation-pair
 * sweep used to construct them.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import webpack from 'webpack';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'showdex-fit-fixtures-'));
const entryPath = path.join(tempDirectory, 'entry.mjs');
const battleShimPath = path.join(tempDirectory, 'battle-shim.mjs');
const calcShimPath = path.join(tempDirectory, 'calc-shim.mjs');
const outputPath = path.join(tempDirectory, 'bundle.cjs');
const mode = process.env.MODE || 'fixtures';

const entrySource = String.raw`
import { Generations, calculate } from '@smogon/calc';
import { calcPokemonSpreadStats, createSmogonField, createSmogonMove, createSmogonPokemon } from '@showdex/utils/calc';
import { inferHackmonsSpread } from '@showdex/features/hackmons-cup-inference/inferHackmonsSpread';

globalThis.Dex = {
  forGen: (gen) => {
    const generation = Generations.get(gen);

    return {
      ...generation,
      species: {
        ...generation.species,
        get: (id) => generation.species.get(String(id).toLowerCase().replace(/[^a-z0-9]+/g, '')),
      },
    };
  },
};

const MODE = ${JSON.stringify(mode)};
const stats = (hp, atk, def, spa, spd, spe) => ({ hp, atk, def, spa, spd, spe });
const zeroStats = stats(0, 0, 0, 0, 0, 0);
const fullIvs = stats(31, 31, 31, 31, 31, 31);

const SPECIES = {
  // bulky physical wall -- Body Slam off it is a SMALL absolute number
  Vaporeon: { base: stats(130, 65, 60, 110, 95, 65), types: ['Water'], evs: stats(252, 0, 252, 0, 4, 0), nature: 'Bold', maxhp: 471 },
  // paper-thin -- the SAME move off it is a LARGE absolute number
  'Deoxys-Attack': { base: stats(50, 180, 20, 180, 20, 150), types: ['Psychic'], evs: stats(0, 0, 0, 0, 0, 0), nature: 'Serious', maxhp: 251 },
  Mew: { base: stats(100, 100, 100, 100, 100, 100), types: ['Psychic'], evs: stats(0, 0, 0, 0, 0, 0), nature: 'Serious', maxhp: 341 },
};

const pokemon = ({ side, name, calcdexId, moves }) => {
  const spec = SPECIES[name];

  return {
    calcdexId,
    ident: side + ': ' + name,
    searchid: side + ': ' + name,
    name,
    speciesForme: name,
    playerKey: side,
    source: 'server',
    level: 100,
    baseStats: spec.base,
    types: spec.types,
    ability: 'Pressure',
    item: 'Leftovers',
    hp: spec.maxhp,
    maxhp: spec.maxhp,
    status: '',
    nature: spec.nature,
    ivs: fullIvs,
    evs: spec.evs,
    boosts: zeroStats,
    dirtyTypes: [],
    moves,
    volatiles: {},
  };
};

const createState = (suffix) => {
  const vaporeon = pokemon({ side: 'p1', name: 'Vaporeon', calcdexId: 'p1-vaporeon-' + suffix, moves: ['Waterfall', 'Recover'] });
  const deoxys = pokemon({ side: 'p1', name: 'Deoxys-Attack', calcdexId: 'p1-deoxys-' + suffix, moves: ['Psycho Boost', 'Recover'] });
  const mew = pokemon({ side: 'p2', name: 'Mew', calcdexId: 'p2-mew-' + suffix, moves: ['Body Slam', 'Crunch', 'Thunderbolt', 'Bullet Seed'] });

  return {
    operatingMode: 'battle', battleId: 'fit-fixture-' + suffix, gen: 9, format: 'gen9hackmonscup',
    legacy: false, gameType: 'Singles', playerCount: 2, playerKey: 'p1', authPlayerKey: 'p1', opponentKey: 'p2',
    field: { isGravity: false }, sheetsNonce: '',
    p1: { active: true, selectionIndex: 0, activeIndices: [0], pokemon: [vaporeon, deoxys], side: {} },
    p2: { active: true, selectionIndex: 0, activeIndices: [0], pokemon: [mew], side: {} },
  };
};

// Mew (p2) attacks a p1 target. the target field picks which p1 mon takes the hit.
const damageEvent = ({ id, turn, moveName, damage, target = 'Vaporeon', crit = false, hits, ko = false, effectiveness = 'neutral' }) => {
  const maxHp = SPECIES[target].maxhp;

  return {
    eventType: 'damage', id, turn,
    attackerKey: 'p2', defenderKey: 'p1',
    attackerId: 'p2a: Mew', defenderId: 'p1a: ' + target,
    attackerName: 'p2: Mew', defenderName: 'p1: ' + target,
    moveName, damage,
    attackerStartHp: SPECIES.Mew.maxhp, attackerMaxHp: SPECIES.Mew.maxhp,
    startHp: maxHp, endHp: ko ? 0 : Math.max(1, maxHp - damage), maxHp,
    crit, hits, effectiveness, rawLine: '|-damage|',
  };
};

// PERCENT-HP path: Showdown reports the OPPONENT's HP as ceil(100*hp/maxhp) (sim/pokemon.ts:2077),
// clamped to 99 below full, while our own side is exact. So events where WE attack the opponent -- the
// ones that constrain their HP/Def/SpD -- carry a quantized observation. Vaporeon attacks Mew here.
const percentState = (suffix) => {
  const state = createState(suffix);

  return { ...state, rules: { hpPercentage: true } };
};

const percentDamageEvent = ({ id, turn, moveName, startPercent, endPercent }) => ({
  eventType: 'damage', id, turn,
  attackerKey: 'p1', defenderKey: 'p2',
  attackerId: 'p1a: Vaporeon', defenderId: 'p2a: Mew',
  attackerName: 'p1: Vaporeon', defenderName: 'p2: Mew',
  moveName, damage: startPercent - endPercent,
  attackerStartHp: SPECIES.Vaporeon.maxhp, attackerMaxHp: SPECIES.Vaporeon.maxhp,
  startHp: startPercent, endHp: endPercent, maxHp: 100,
  crit: false, effectiveness: 'neutral', rawLine: '|-damage|',
});

const speedEvent = ({ id, turn, moveName = 'Body Slam', slowerMoveName = 'Waterfall' }) => ({
  eventType: 'speed', id, turn,
  attackerKey: 'p2', defenderKey: 'p1',
  attackerId: 'p2a: Mew', defenderId: 'p1a: Vaporeon',
  attackerName: 'p2: Mew', defenderName: 'p1: Vaporeon',
  moveName, slowerMoveName, rawLine: '|move|',
});

const report = (name, events, makeState = createState) => {
  const state = makeState(name);
  const output = inferHackmonsSpread(state, events, 0);
  const mon = Object.values(output)[0] || {};
  const estimate = mon.estimate || {};
  const matches = estimate.matches || [];

  const natureMod = { Adamant: 1.1, Lonely: 1.1, Brave: 1.1, Naughty: 1.1, Bold: 0.9, Modest: 0.9, Calm: 0.9, Timid: 0.9 };
  const atkStat = estimate.ivs && estimate.evs
    ? Math.floor((Math.floor(((2 * 100 + estimate.ivs.atk + Math.floor(estimate.evs.atk / 4)) * 100) / 100) + 5) * (natureMod[estimate.nature] || 1))
    : null;

  return {
    name,
    atkStat,
    nature: estimate.nature || null,
    ivs: estimate.ivs || null,
    evs: estimate.evs || null,
    confidence: estimate.confidence || null,
    score: typeof estimate.score === 'number' ? Number(estimate.score.toFixed(6)) : null,
    ignoredEventCount: mon.ignoredEventCount ?? null,
    outliers: matches.filter((m) => !!m.outlier).length,
    events: matches.map((m) => ({
      move: m.moveName,
      observed: m.observedDamage,
      range: m.rollRange || null,
      outlier: m.outlier || null,
      logLikelihood: typeof m.logLikelihood === 'number' ? Number(m.logLikelihood.toFixed(6)) : null,
      error: m.error || null,
    })),
  };
};

// FORWARD ORACLE -- independent of the search: given an explicit Mew spread, what damage rolls does
// Body Slam actually produce against each target? Used to prove a fixture's observation pair is
// jointly FEASIBLE (some single spread covers both) before freezing anything about it.
const forwardRolls = (spread, target) => {
  const state = createState('forward');
  const mew = { ...state.p2.pokemon[0], nature: spread.nature, ivs: spread.ivs, evs: spread.evs };
  const defender = state.p1.pokemon.find((p) => p.speciesForme === target);
  const field = createSmogonField(state.format, state.gameType, state.field, state.p2, state.p1, [state.p1, state.p2]);
  const attacker = createSmogonPokemon(state.format, state.gameType, mew, 'Body Slam', defender);
  const smogonDefender = createSmogonPokemon(state.format, state.gameType, defender, null, mew);
  const [move] = createSmogonMove(state.format, mew, 'Body Slam', defender, field) || [];
  const result = calculate(Dex.forGen(9), attacker, smogonDefender, move, field, { hitBasePowers: null, excludeHazardsDamage: true, excludeEotDamage: true });
  const damage = result?.damage;

  return Array.isArray(damage) ? damage.filter((v) => typeof v === 'number') : [damage];
};

// FORWARD ORACLE for any move at an explicit base power (independent of the search): the rolls the
// given Mew spread produces. The calc doubles Payback (moving last) and Bolt Beak/Fishious Rend
// (moving first) on its own from Speed, so the oracle pins the ORDER that doesn't double -- via raw
// Speed, which nothing else in those moves reads -- and the asked-for power is exactly what it uses.
const forwardMoveRolls = (spread, moveName, basePower, target, patches = {}) => {
  const state = createState('forward-move');
  const mew = { ...state.p2.pokemon[0], ...spread, ...patches.attacker };
  const defender = { ...state.p1.pokemon.find((p) => p.speciesForme === target), ...patches.defender };
  const field = createSmogonField(state.format, state.gameType, state.field, state.p2, state.p1, [state.p1, state.p2]);
  const attacker = createSmogonPokemon(state.format, state.gameType, mew, moveName, defender);
  const smogonDefender = createSmogonPokemon(state.format, state.gameType, defender, null, mew);
  const neutralOrder = { Payback: 'first', 'Bolt Beak': 'last', 'Fishious Rend': 'last' }[moveName];

  if (neutralOrder) {
    attacker.rawStats.spe = neutralOrder === 'first' ? 9999 : 1;
    smogonDefender.rawStats.spe = neutralOrder === 'first' ? 1 : 9999;
  }

  const withBp = { ...mew, moveOverrides: { [moveName]: { basePower } } };
  const [move] = createSmogonMove(state.format, withBp, moveName, defender, field) || [];
  const result = calculate(Dex.forGen(9), attacker, smogonDefender, move, field, { hitBasePowers: null, excludeHazardsDamage: true, excludeEotDamage: true });

  return result.damage.filter((v) => typeof v === 'number');
};

const results = [];
let FAILED = false;

if (MODE === 'forward') {
  const natures = ['Adamant', 'Serious', 'Modest'];
  const natureMod = { Adamant: 1.1, Serious: 1, Modest: 0.9 };
  const atkStat = (iv, ev, nature) => Math.floor((Math.floor(((2 * 100 + iv + Math.floor(ev / 4)) * 100) / 100) + 5) * natureMod[nature]);
  const ivList = Array.from({ length: 32 }, (_, i) => i);
  const evList = Array.from({ length: 64 }, (_, i) => i * 4);
  const seenStats = new Set();

  for (const nature of natures) {
    for (const iv of ivList) {
      for (const ev of evList) {
        const stat = atkStat(iv, ev, nature);

        if (seenStats.has(stat)) {
          continue;
        }

        seenStats.add(stat);
        const spread = { nature, ivs: { ...fullIvs, atk: iv }, evs: { ...stats(0, 0, 0, 0, 0, 0), atk: ev } };
        const vap = forwardRolls(spread, 'Vaporeon');
        const deo = forwardRolls(spread, 'Deoxys-Attack');
        results.push({
          nature, atkIv: iv, atkEv: ev, atkStat: stat,
          vaporeon: [Math.min(...vap), Math.max(...vap)],
          deoxys: [Math.min(...deo), Math.max(...deo)],
          vaporeonRolls: vap,
          deoxysRolls: deo,
        });
      }
    }
  }
} else if (MODE === 'window') {
  // TRUNCATION FIXTURE. All four hits are Body Slam, so all four land in the same 'def' scoring
  // category and selectScoringEvents()'s .slice(-MaxScoredEventsPerCategory) keeps only the last
  // three. Forward oracle (MODE=forward): the Deoxys hit at 268 is consistent with only 14 Atk
  // stats (>= 284), while the three Vaporeon hits 79/80/81 are jointly consistent with 46 stats
  // (266..312); ten stats satisfy all four. A fit that ignores the turn-1 hit is therefore free to
  // land in the loose band and strand it outside its own roll range.
  results.push(report('stale-window', [
    damageEvent({ id: 'w1', turn: 1, moveName: 'Body Slam', damage: 195, target: 'Deoxys-Attack' }),
    damageEvent({ id: 'w2', turn: 2, moveName: 'Body Slam', damage: 57, target: 'Vaporeon' }),
    damageEvent({ id: 'w3', turn: 3, moveName: 'Body Slam', damage: 57, target: 'Vaporeon' }),
    damageEvent({ id: 'w4', turn: 4, moveName: 'Body Slam', damage: 57, target: 'Vaporeon' }),
  ]));
  // REPEAT WEIGHTING. Three identical Vaporeon hits at 59 plus one Deoxys hit at 202. The exact
  // collapse weights the repeated group x3, whose likelihood argmax is Atk stat 213; counting the
  // group once instead (i.e. dropping the count multiplier) moves it to 225. Derived from the
  // MODE=forward oracle over all 143 reachable Atk stats, independent of the search.
  results.push(report('repeat-weighting', [
    damageEvent({ id: 'r1', turn: 1, moveName: 'Body Slam', damage: 59, target: 'Vaporeon' }),
    damageEvent({ id: 'r2', turn: 2, moveName: 'Body Slam', damage: 59, target: 'Vaporeon' }),
    damageEvent({ id: 'r3', turn: 3, moveName: 'Body Slam', damage: 59, target: 'Vaporeon' }),
    damageEvent({ id: 'r4', turn: 4, moveName: 'Body Slam', damage: 202, target: 'Deoxys-Attack' }),
  ]));
  // control: identical observations, the odd one out moved LAST so it sits inside the window
  results.push(report('stale-window-control', [
    damageEvent({ id: 'c1', turn: 1, moveName: 'Body Slam', damage: 57, target: 'Vaporeon' }),
    damageEvent({ id: 'c2', turn: 2, moveName: 'Body Slam', damage: 57, target: 'Vaporeon' }),
    damageEvent({ id: 'c3', turn: 3, moveName: 'Body Slam', damage: 57, target: 'Vaporeon' }),
    damageEvent({ id: 'c4', turn: 4, moveName: 'Body Slam', damage: 195, target: 'Deoxys-Attack' }),
  ]));
} else if (MODE === 'percent') {
  // Vaporeon Waterfall into Mew, three hits down the HP bar. Same move, same attacker, same target --
  // so a single Mew HP/SpD-consistent spread must explain all three. The observed percent for a given
  // raw damage depends on WHERE in the bar the hit landed, which the current single-Math.round model
  // cannot represent.
  results.push(report('percent-hp-defender', [
    percentDamageEvent({ id: 'p1', turn: 1, moveName: 'Waterfall', startPercent: 100, endPercent: 89 }),
    percentDamageEvent({ id: 'p2', turn: 2, moveName: 'Waterfall', startPercent: 89, endPercent: 79 }),
    percentDamageEvent({ id: 'p3', turn: 3, moveName: 'Waterfall', startPercent: 79, endPercent: 68 }),
  ], percentState));
} else if (MODE === 'latency') {
  // cost curve: repeated hits with IDENTICAL damage context (same move, same target, same snapshot)
  // differ only by event id, so every one of them currently pays its own calculate() per candidate
  const build = (n) => Array.from({ length: n }, (_, i) => damageEvent({
    id: 'l' + i, turn: i + 1, moveName: 'Body Slam', damage: 70, target: 'Vaporeon',
  }));

  // (a) identical context AND identical observed damage -- an exact likelihood collapse can merge them
  // MIN OF 5. Wall-clock timing is not deterministic even though the OUTPUT is: repeated runs of
  // identical code measured 62 ms and 84 ms for the same case. The minimum is the standard robust
  // estimator for a microbenchmark -- it filters scheduler noise, which can only ever add time.
  const timeIt = (label, events, makeState) => {
    let best = Infinity;
    let out = null;

    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      out = report(label + '-' + i, events, makeState);
      best = Math.min(best, Date.now() - started);
    }

    return { ms: best, out };
  };

  for (const n of [1, 3, 6, 12, 24, 48]) {
    const { ms, out } = timeIt('latency-' + n, build(n));
    results.push({ kind: 'identical', events: n, ms, outliers: out.outliers, nature: out.nature, evs: out.evs.atk, ivs: out.ivs.atk });
  }

  // (b) identical context, DISTINCT observed damage -- the likelihood terms cannot merge, but every
  // event shares one damage context, so a context-keyed roll cache still collapses the calculate()s.
  // This is the case the rollKey re-key targets; observations cycle within a real roll range.
  const spread = [66, 67, 68, 69, 70, 71, 72, 73];
  const buildDistinct = (n) => Array.from({ length: n }, (_, i) => damageEvent({
    id: 'd' + i, turn: i + 1, moveName: 'Body Slam', damage: spread[i % spread.length], target: 'Vaporeon',
  }));

  for (const n of [1, 3, 6, 12, 24, 48]) {
    const { ms, out } = timeIt('latency-distinct-' + n, buildDistinct(n));
    results.push({ kind: 'distinct', events: n, ms, outliers: out.outliers, nature: out.nature, evs: out.evs.atk, ivs: out.ivs.atk });
  }
} else if (MODE === 'modifiers') {
  // MULTI-HYPOTHESIS FIXTURE (architect-owned; slice 8). ONE Body Slam whose observed 115 is
  // unreachable by ANY of Mew's 143 reachable Atk stats at x1 (MODE=forward oracle, re-derived
  // 2026-08-23: 0 stats cover 115 at x1, 34 at x1.3, 47 at x1.5, 37 at x2). A single supporting
  // event can never be ADOPTED (adoption needs >= 2), so every surviving class lands in possible
  // -- the exact multi-chip situation the UI must let the user switch between, and the one live
  // unseeded battles cannot be made to produce on demand.
  const modifierEvents = [
    damageEvent({ id: 'mod1', turn: 1, moveName: 'Body Slam', damage: 115, target: 'Vaporeon' }),
  ];

  // the candidate's item must be UNKNOWN for item-slot classes to be proposed at all
  // (candidateItemPinned(): a known item pins the slot), which is the state a Hackmons opponent is
  // actually in before it reveals one
  const modifierBaseState = createState('modifiers');
  const modifierState = {
    ...modifierBaseState,
    p2: {
      ...modifierBaseState.p2,
      pokemon: modifierBaseState.p2.pokemon.map((mon) => ({ ...mon, item: '', dirtyItem: null })),
    },
  };
  const modifierOutput = inferHackmonsSpread(modifierState, modifierEvents, 0);
  const modifierMon = Object.values(modifierOutput)[0] || {};
  const modifierEstimate = modifierMon.estimate || {};
  const mods = modifierEstimate.inferredModifiers || [];

  const clauses = [];
  const clause = (id, ok, detail) => clauses.push({ id, ok: !!ok, detail });

  const fullSpread = (spread) => !!spread
    && typeof spread.nature === 'string'
    && ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].every((s) => (
      typeof spread.ivs?.[s] === 'number' && typeof spread.evs?.[s] === 'number'
    ));

  const inRange = (match) => Array.isArray(match?.rollRange)
    && match.rollRange.length === 2
    && match.observedDamage >= match.rollRange[0]
    && match.observedDamage <= match.rollRange[1];

  // M1 -- the fixture actually reaches the multi-hypothesis branch (guards every "for all" below)
  clause('M1-two-unadopted-hypotheses', mods.length >= 2 && mods.every((m) => m.adopted === false), {
    count: mods.length,
    ids: mods.map((m) => m.modifier?.id),
    adopted: mods.map((m) => m.adopted),
  });

  // M2 -- both slots are represented, so "clicking the ability one must clear the item one" is a
  // situation this fixture can actually distinguish
  const slots = [...new Set(mods.map((m) => m.modifier?.slot))].sort();
  clause('M2-both-slots-proposed', slots.includes('item') && slots.includes('ability'), { slots });

  // M3 -- every hypothesis publishes a COMPLETE spread (the UI overrides the whole set from it)
  clause('M3-complete-candidate-spreads', mods.length >= 2 && mods.every((m) => fullSpread(m.candidateSpread)), {
    spreads: mods.map((m) => ({ id: m.modifier?.id, nature: m.candidateSpread?.nature, atkEv: m.candidateSpread?.evs?.atk, atkIv: m.candidateSpread?.ivs?.atk })),
  });

  // M4 -- every hypothesis publishes its OWN per-event matches, one per input event
  clause('M4-candidate-matches-per-event', mods.length >= 2 && mods.every((m) => (
    Array.isArray(m.candidateMatches)
      && m.candidateMatches.length === modifierEvents.length
      && m.candidateMatches.every((match, i) => (
        match?.eventId === modifierEvents[i].id
          && Number.isFinite(match?.logLikelihood)
          && Array.isArray(match?.rollRange)
          && match.rollRange.length === 2
          && match.observedDamage === modifierEvents[i].damage
      ))
  )), {
    lengths: mods.map((m) => (Array.isArray(m.candidateMatches) ? m.candidateMatches.length : null)),
    eventCount: modifierEvents.length,
  });

  // M5 -- under its OWN hypothesis, each suggestion's supporting event is IN RANGE and carries no
  // outlier: the debug row a user sees after clicking that chip shows a consistent damage fit
  clause('M5-supporting-events-consistent', mods.length >= 2 && mods.every((m) => (
    (m.supportingEventIds || []).length > 0
      && (m.supportingEventIds || []).every((eventId) => {
        const match = (m.candidateMatches || []).find((candidate) => candidate?.eventId === eventId);

        return inRange(match) && !match?.outlier;
      })
  )), {
    rows: mods.map((m) => ({
      id: m.modifier?.id,
      supporting: m.supportingEventIds,
      matches: (m.candidateMatches || []).map((match) => ({ eventId: match?.eventId, observed: match?.observedDamage, range: match?.rollRange, outlier: match?.outlier || null })),
    })),
  });

  // M6 -- DISCRIMINATION (clause CORRECTED 2026-08-24, see below). Each hypothesis must have been
  // fitted independently: its spread must differ from another hypothesis's, and its modelled range
  // for the event must differ from the PUBLISHED (neutral) estimate's range for that same event.
  //
  // The clause originally frozen here also demanded that two hypotheses with different multipliers
  // report DIFFERENT roll ranges from EACH OTHER. That premise is arithmetically wrong and no
  // correct implementation can satisfy it: modelled damage depends on the EFFECTIVE attack stat
  // (raw x multiplier), so two hypotheses explaining one observation converge on the same effective
  // value from different raw spreads -- measured here, Huge Power fits Bold/1 IV/96 EV = raw 207,
  // x2 = 414, while Choice Band and Gorilla Tactics fit Bashful/8 IV/252 EV = raw 276, x1.5 = 414.
  // Identical effective Atk, therefore identical [106,125]. Differing SPREADS at an identical range
  // is exactly the user-visible property this slice is for, not a failure of it.
  // The corrected comparison is the copy-detection the clause was always meant to be, and it rests
  // on an oracle that predates the implementation: M7 froze the published neutral range at [75,89]
  // and M5 requires the observation (115) to be IN RANGE under each hypothesis, so a hypothesis
  // that merely echoed the published matches is caught with certainty.
  const rangeKey = (m) => JSON.stringify((m.candidateMatches || []).map((match) => match?.rollRange));
  const spreadKey = (m) => JSON.stringify([m.candidateSpread?.nature, m.candidateSpread?.ivs?.atk, m.candidateSpread?.evs?.atk]);
  const publishedRangeKey = JSON.stringify((modifierEstimate.matches || []).map((match) => match?.rollRange));
  const distinctMultipliers = [...new Set(mods.map((m) => m.modifier?.multiplier))];
  const distinctSpreads = [...new Set(mods.map(spreadKey))];
  const echoesPublished = mods.filter((m) => rangeKey(m) === publishedRangeKey);
  clause('M6-hypotheses-fitted-independently', distinctMultipliers.length >= 2
    && distinctSpreads.length >= 2
    && mods.length >= 2
    && !echoesPublished.length, {
    distinctMultipliers,
    distinctSpreads: distinctSpreads.length,
    publishedRange: publishedRangeKey,
    echoesPublished: echoesPublished.map((m) => m.modifier?.id),
    perHypothesis: mods.map((m) => ({ id: m.modifier?.id, multiplier: m.modifier?.multiplier, range: (m.candidateMatches || [])[0]?.rollRange || null, atkIv: m.candidateSpread?.ivs?.atk, atkEv: m.candidateSpread?.evs?.atk, nature: m.candidateSpread?.nature })),
  });

  // M8 -- every hypothesis publishes the COMPLETE slot state its spread was fitted under, not just
  // its own slot. Nothing is adopted in this fixture, so each hypothesis was fitted alone and its
  // selection must name its own slot and NULL the other -- which is what makes clicking one chip
  // able to undo another chip's slot. (The composite case -- a damage and a speed modifier adopted
  // together, whose shared spread was fitted under BOTH -- is why this is published by the search
  // rather than derived in the UI from modifier.slot.)
  clause('M8-selection-names-both-slots', mods.length >= 2 && mods.every((m) => {
    const keys = Object.keys(m.selection || {}).sort();
    const ownSlot = m.modifier?.slot === 'ability' ? 'dirtyAbility' : 'dirtyItem';
    const otherSlot = m.modifier?.slot === 'ability' ? 'dirtyItem' : 'dirtyAbility';

    return keys.length === 2
      && keys[0] === 'dirtyAbility'
      && keys[1] === 'dirtyItem'
      && m.selection[ownSlot] === m.modifier?.representative
      && m.selection[otherSlot] === null;
  }), {
    selections: mods.map((m) => ({ id: m.modifier?.id, slot: m.modifier?.slot, representative: m.modifier?.representative, selection: m.selection || null })),
  });

  // M9 -- the PUBLISHED estimate carries the same slot state, so pressing Apply can be exactly as
  // coherent as clicking a chip. Nothing is adopted here, so both slots must be null.
  clause('M9-estimate-selection', !!modifierEstimate.selection
    && Object.keys(modifierEstimate.selection).sort().join(',') === 'dirtyAbility,dirtyItem'
    && modifierEstimate.selection.dirtyAbility === null
    && modifierEstimate.selection.dirtyItem === null, {
    selection: modifierEstimate.selection || null,
    adoptedCount: mods.filter((m) => m.adopted).length,
  });

  // M7 -- REGRESSION ANCHOR. The published (neutral, no-modifier) estimate still tags the event as a
  // too-high outlier and still reports its own matches; the per-hypothesis field must be additive.
  const published = modifierEstimate.matches || [];
  clause('M7-published-estimate-unchanged', published.length === modifierEvents.length
    && published[0]?.outlier === 'too-high'
    && published[0]?.observedDamage === 115, {
    matches: published.map((match) => ({ eventId: match?.eventId, observed: match?.observedDamage, range: match?.rollRange, outlier: match?.outlier || null })),
  });

  results.push({
    mode: 'modifiers',
    passed: clauses.every((c) => c.ok),
    clauses,
  });

  if (!clauses.every((c) => c.ok)) {
    FAILED = true;
  }
} else if (MODE === 'typeevidence') {
  // the effectiveness line is evidence for a type-change ability (Pixilate/Normalize/...) ONLY once
  // every other reason the line can differ from the dex chart is accounted for: an event-time move
  // type (Tera Blast, Weather Ball), per-move rules (Freeze-Dry, Thousand Arrows), grounding
  // (Gravity, Roost) and the defender's tera type. Each event observes its OWN modelled median
  // (pass 1 runs with no effectiveness evidence), so only the mechanic under test can move anything.
  SPECIES.Tornadus = { base: stats(79, 115, 70, 125, 80, 111), types: ['Flying'], evs: stats(0, 0, 0, 0, 0, 0), nature: 'Serious', maxhp: 299 };
  SPECIES.Gengar = { base: stats(60, 65, 60, 130, 75, 110), types: ['Ghost', 'Poison'], evs: stats(0, 0, 0, 0, 0, 0), nature: 'Serious', maxhp: 261 };

  const evidenceState = (suffix) => {
    const state = createState(suffix);
    const tornadus = pokemon({ side: 'p1', name: 'Tornadus', calcdexId: 'p1-tornadus-' + suffix, moves: ['Recover'] });
    const gengar = pokemon({ side: 'p1', name: 'Gengar', calcdexId: 'p1-gengar-' + suffix, moves: ['Recover'] });

    return {
      ...state,
      p1: { ...state.p1, pokemon: [...state.p1.pokemon, tornadus, gengar] },
      p2: {
        ...state.p2,
        pokemon: state.p2.pokemon.map((mon) => ({ ...mon, ability: '', dirtyAbility: null, item: '', dirtyItem: null })),
      },
    };
  };

  const infer = (name, events) => {
    const output = inferHackmonsSpread(evidenceState(name), events, 0);
    const estimate = (Object.values(output)[0] || {}).estimate || {};

    return { estimate, matches: estimate.matches || [] };
  };

  const scenario = (name, specs, scale = 1) => {
    const draft = specs.map((spec, i) => ({ ...damageEvent({ id: name + i, turn: i + 1, damage: 1, ...spec.base }), ...spec.extra, effectiveness: undefined }));
    const pass1 = infer(name + '-pass1', draft);
    // a 0-damage model of the true scenario means the mechanic isn't modelled at all -- observing 0
    // would make every clause below pass vacuously
    const unmodelled = specs.some((spec, i) => !(pass1.matches.find((m) => m.eventId === name + i)?.rollRange?.[1] > 0));
    const events = specs.map((spec, i) => {
      const range = pass1.matches.find((m) => m.eventId === name + i)?.rollRange || [1, 1];
      const observed = Math.round(((range[0] + range[1]) / 2) * scale);
      const maxHp = SPECIES[spec.base.target || 'Vaporeon'].maxhp;

      return { ...damageEvent({ id: name + i, turn: i + 1, ...spec.base, damage: observed }), ...spec.extra, endHp: Math.max(1, maxHp - observed) };
    });
    const { estimate, matches } = infer(name, events);

    return {
      name,
      unmodelled,
      modifiers: (estimate.inferredModifiers || []).map((m) => m.modifier?.id + (m.adopted ? ' (adopted)' : '')),
      outliers: matches.filter((m) => !!m.outlier).map((m) => m.moveName + ' ' + m.observedDamage + ' ' + JSON.stringify(m.rollRange)),
    };
  };

  const tera = (teraType) => ({ teraType, terastallized: true });
  const twice = (spec) => [spec, spec];
  const negatives = [
    scenario('tera-blast', twice({ base: { moveName: 'Tera Blast', effectiveness: 'resisted' }, extra: { attackerSnapshot: tera('Water') } })),
    scenario('weather-ball-rain', twice({ base: { moveName: 'Weather Ball', effectiveness: 'resisted' }, extra: { field: { weather: 'Rain' } } })),
    scenario('freeze-dry-plus-normal', [
      ...twice({ base: { moveName: 'Freeze-Dry', effectiveness: 'super' } }),
      { base: { moveName: 'Body Slam' } },
    ]),
    scenario('thousand-arrows', twice({ base: { moveName: 'Thousand Arrows', target: 'Tornadus' } })),
    scenario('gravity-earthquake', twice({ base: { moveName: 'Earthquake', target: 'Tornadus' }, extra: { field: { isGravity: true } } })),
    scenario('roost-earthquake', twice({ base: { moveName: 'Earthquake', target: 'Tornadus' }, extra: { defenderSnapshot: { roosted: true } } })),
    // a Normal move that LANDED on a Ghost had its immunity lifted (Scrappy, Mind's Eye, Foresight)
    scenario('landed-on-ghost', twice({ base: { moveName: 'Body Slam', target: 'Gengar' } })),
    scenario('tera-defender', twice({ base: { moveName: 'Body Slam', effectiveness: 'resisted' }, extra: { defenderSnapshot: tera('Rock') } })),
    scenario('control-body-slam', twice({ base: { moveName: 'Body Slam' } })),
  ];

  // positive control: a real Galvanize Body Slam into Water Vaporeon is logged super-effective and
  // lands at ~x2.4 the neutral roll (x2 type, x1.2 -ate). Electric is the only -ate type that's
  // super-effective on Water, so the class is unique -- it must still be found and adopted
  const galvanize = scenario('galvanize', twice({ base: { moveName: 'Body Slam', effectiveness: 'super' } }), 2.4);

  negatives.forEach((result) => results.push({
    ...result,
    ok: !result.unmodelled && !result.modifiers.length && !result.outliers.length,
  }));
  results.push({ ...galvanize, ok: !galvanize.unmodelled && galvanize.modifiers.includes('ability-ate-electric (adopted)') });

  FAILED = results.some((result) => !result.ok);
} else if (MODE === 'speedevidence') {
  // turn order is Speed evidence only once priority is known and the known mon's own Speed is
  // modelled. Deoxys-Attack/Vaporeon are p1 = authPlayerKey (known side); Mew's ability is unknown.
  const orderEvent = ({ id, faster, fasterMove, slower, slowerMove, field }) => ({
    eventType: 'speed', id, turn: 1,
    attackerKey: faster === 'Mew' ? 'p2' : 'p1', defenderKey: slower === 'Mew' ? 'p2' : 'p1',
    attackerId: (faster === 'Mew' ? 'p2a: ' : 'p1a: ') + faster, defenderId: (slower === 'Mew' ? 'p2a: ' : 'p1a: ') + slower,
    attackerName: (faster === 'Mew' ? 'p2: ' : 'p1: ') + faster, defenderName: (slower === 'Mew' ? 'p2: ' : 'p1: ') + slower,
    moveName: fasterMove, slowerMoveName: slowerMove, field, rawLine: '|move|',
  });
  const speState = (suffix, vaporeonAbility) => {
    const state = createState(suffix);

    return {
      ...state,
      // the known side's Speed is read from its server stats, as for a real battle's own team
      p1: {
        ...state.p1,
        pokemon: state.p1.pokemon.map((mon) => ({
          ...mon,
          ability: mon.speciesForme === 'Vaporeon' && vaporeonAbility ? vaporeonAbility : mon.ability,
          serverStats: calcPokemonSpreadStats(state.format, mon),
        })),
      },
      p2: { ...state.p2, pokemon: state.p2.pokemon.map((mon) => ({ ...mon, ability: '', dirtyAbility: null, item: '', dirtyItem: null })) },
    };
  };
  const speNature = { Timid: 1.1, Hasty: 1.1, Jolly: 1.1, Naive: 1.1, Brave: 0.9, Relaxed: 0.9, Quiet: 0.9, Sassy: 0.9 };
  const summarize = (name, state, events) => {
    const estimate = (Object.values(inferHackmonsSpread(state, events, 0))[0] || {}).estimate || {};
    const speStat = estimate.ivs && estimate.evs
      ? Math.floor((Math.floor(((2 * 100 + estimate.ivs.spe + Math.floor(estimate.evs.spe / 4)) * 100) / 100) + 5) * (speNature[estimate.nature] || 1))
      : null;

    return { name, speStat, modifiers: (estimate.inferredModifiers || []).map((m) => m.modifier?.id + (m.adopted ? ' (adopted)' : '')) };
  };
  const bodySlam = damageEvent({ id: 'bs', turn: 1, moveName: 'Body Slam', damage: 70, target: 'Vaporeon' });

  // Thunder Wave is a Status move: an unrevealed Prankster makes Mew's first move pure priority,
  // so outspeeding 336-Spe Deoxys-Attack (unreachable for ANY Mew spread, max 328) proves nothing
  const prankster = summarize('prankster-status-first', speState('prankster'), [
    bodySlam,
    orderEvent({ id: 'p1', faster: 'Mew', fasterMove: 'Thunder Wave', slower: 'Deoxys-Attack', slowerMove: 'Psycho Boost' }),
  ]);
  results.push({ ...prankster, ok: !prankster.modifiers.length });

  // our Swift Swim Vaporeon (166 Spe) is 332 in rain: moving first caps Mew at <= 331, not <= 165
  const swiftSwim = summarize('our-swift-swim-in-rain', speState('swiftswim', 'Swift Swim'), [
    bodySlam,
    orderEvent({ id: 'w1', faster: 'Vaporeon', fasterMove: 'Waterfall', slower: 'Mew', slowerMove: 'Body Slam', field: { weather: 'Rain' } }),
  ]);
  results.push({ ...swiftSwim, ok: swiftSwim.speStat > 166 && !swiftSwim.modifiers.length });

  // control: with no rain the 166-Spe Vaporeon moving first is infeasible for EVERY Mew spread (its
  // minimum is 184: 0 IV/0 EV/-Spe), so a Speed-lowering class must be proposed -- proving the rain,
  // and not a dead speed event, is what clears the case above
  const noRain = summarize('control-no-rain', speState('norain', 'Swift Swim'), [
    bodySlam,
    orderEvent({ id: 'n1', faster: 'Vaporeon', fasterMove: 'Waterfall', slower: 'Mew', slowerMove: 'Body Slam' }),
  ]);
  results.push({ ...noRain, ok: noRain.modifiers.length > 0 });

  FAILED = results.some((result) => !result.ok);
} else if (MODE === 'powerhistory') {
  // moves whose power doubles on something earlier in the turn. Observations come from a FORWARD
  // oracle at one fixed Mew spread with an explicit base power (independent of the code under test),
  // anchored by a Body Slam at that same spread -- so a correctly modelled event is in range with no
  // modifier, and an unmodelled one is off by exactly x2.
  const mewSpread = { nature: 'Adamant', ivs: fullIvs, evs: stats(0, 252, 0, 0, 4, 252) };
  const forward = (moveName, basePower, target = 'Vaporeon') => {
    const rolls = forwardMoveRolls(mewSpread, moveName, basePower, target);

    return rolls[Math.floor(rolls.length / 2)];
  };

  const powerState = (suffix, item = '') => {
    const state = createState(suffix);

    return {
      ...state,
      p2: { ...state.p2, pokemon: state.p2.pokemon.map((mon) => ({ ...mon, ability: '', dirtyAbility: null, item, dirtyItem: null })) },
    };
  };
  const scenario = (name, moveName, basePower, powerDoubled, effectiveness, item = '') => {
    const itemRolls = (move, bp) => forwardMoveRolls(mewSpread, move, bp, 'Vaporeon', { attacker: { item } });
    const median = (rolls) => rolls[Math.floor(rolls.length / 2)];
    const events = [
      damageEvent({ id: name + '0', turn: 1, moveName: 'Body Slam', damage: median(itemRolls('Body Slam', 85)) }),
      ...[1, 2].map((turn) => ({
        ...damageEvent({ id: name + turn, turn: turn + 1, moveName, damage: median(itemRolls(moveName, basePower)), effectiveness }),
        powerDoubled,
      })),
    ];
    const estimate = (Object.values(inferHackmonsSpread(powerState(name, item), events, 0))[0] || {}).estimate || {};
    const matches = estimate.matches || [];
    const modifiers = (estimate.inferredModifiers || []).map((m) => m.modifier?.id + (m.adopted ? ' (adopted)' : ''));
    const outliers = matches.filter((m) => !!m.outlier).map((m) => m.moveName + ' ' + m.observedDamage + ' ' + JSON.stringify(m.rollRange));

    results.push({ name, modifiers, outliers, ok: !modifiers.length && !outliers.length });
  };

  scenario('avalanche-doubled', 'Avalanche', 120, true, 'resisted');
  scenario('payback-doubled', 'Payback', 100, true, 'neutral');
  scenario('bolt-beak-plain', 'Bolt Beak', 85, false, 'super');
  // Mew's known Black Glasses (x1.2 on Dark moves) must stay applied on top of the doubling
  scenario('payback-doubled-black-glasses', 'Payback', 100, true, 'neutral', 'Black Glasses');
  // control: an undoubled Avalanche is what the calc already modelled, before and after
  scenario('control-avalanche-plain', 'Avalanche', 60, false, 'resisted');

  FAILED = results.some((result) => !result.ok);
} else if (MODE === 'survivals') {
  // Focus Sash/Sturdy/Endure (and False Swipe) cap a hit at the defender's HP - 1: the real roll was
  // AT LEAST the observation, exactly like a KO. So a capped hit (251 -> 1 HP, observed 250) must score
  // exactly like a KO with the SAME observation (250 -> 0 HP) -- identical estimate, no outlier.
  const spread = { nature: 'Adamant', ivs: fullIvs, evs: stats(0, 252, 0, 0, 4, 252) };
  const edgeRolls = forwardMoveRolls(spread, 'Double-Edge', 120, 'Deoxys-Attack');
  const anchorRolls = forwardMoveRolls(spread, 'Body Slam', 85, 'Vaporeon');
  const anchor = damageEvent({ id: 'a0', turn: 1, moveName: 'Body Slam', damage: anchorRolls[Math.floor(anchorRolls.length / 2)] });
  const capState = (suffix) => {
    const state = createState(suffix);

    return { ...state, p2: { ...state.p2, pokemon: state.p2.pokemon.map((mon) => ({ ...mon, ability: '', dirtyAbility: null, item: '', dirtyItem: null })) } };
  };
  const estimateOf = (name, event) => {
    const estimate = (Object.values(inferHackmonsSpread(capState(name), [anchor, event], 0))[0] || {}).estimate || {};

    return {
      spread: JSON.stringify([estimate.nature, estimate.ivs, estimate.evs]),
      outliers: (estimate.matches || []).filter((m) => !!m.outlier).map((m) => m.moveName + ' ' + m.observedDamage + ' ' + JSON.stringify(m.rollRange)),
    };
  };
  const capped = estimateOf('capped', {
    ...damageEvent({ id: 'c1', turn: 2, moveName: 'Double-Edge', damage: 250, target: 'Deoxys-Attack' }),
    startHp: 251, endHp: 1, survivalCapped: true,
  });
  const ko = estimateOf('ko', {
    ...damageEvent({ id: 'k1', turn: 2, moveName: 'Double-Edge', damage: 250, target: 'Deoxys-Attack' }),
    startHp: 250, endHp: 0,
  });

  results.push({
    name: 'sash-capped-equals-ko',
    edgeMinRoll: Math.min(...edgeRolls),
    capped,
    ko,
    // the oracle must actually overkill (else the cap never engaged), and the two must agree
    ok: Math.min(...edgeRolls) > 250 && capped.spread === ko.spread && !capped.outliers.length,
  });

  FAILED = results.some((result) => !result.ok);
} else if (MODE === 'eventitems') {
  // the item a mon held AT THE TIME of each hit: one consumed by that very hit (a resist berry, a Gem)
  // or one it only lost later (Knock Off) still applied. Observations come from the forward oracle
  // with the real item at one fixed Mew spread, so a correctly modelled event is in range with no
  // modifier; an unmodelled one is off by the item's multiplier.
  const spread = { nature: 'Adamant', ivs: fullIvs, evs: stats(0, 252, 0, 0, 4, 252) };
  const median = (rolls) => rolls[Math.floor(rolls.length / 2)];
  const itemState = (suffix, mewPatch, vaporeonPatch) => {
    const state = createState(suffix);

    return {
      ...state,
      p1: { ...state.p1, pokemon: state.p1.pokemon.map((mon) => (mon.speciesForme === 'Vaporeon' ? { ...mon, ...vaporeonPatch } : mon)) },
      p2: { ...state.p2, pokemon: state.p2.pokemon.map((mon) => ({ ...mon, ability: '', dirtyAbility: null, item: '', dirtyItem: null, ...mewPatch })) },
    };
  };
  const scenario = (name, state, events) => {
    const estimate = (Object.values(inferHackmonsSpread(state, events, 0))[0] || {}).estimate || {};
    const modifiers = (estimate.inferredModifiers || []).map((m) => m.modifier?.id + (m.adopted ? ' (adopted)' : ''));
    const outliers = (estimate.matches || []).filter((m) => !!m.outlier).map((m) => m.moveName + ' ' + m.observedDamage + ' ' + JSON.stringify(m.rollRange));

    results.push({ name, modifiers, outliers, ok: !modifiers.length && !outliers.length });
  };
  const crunch = (id, turn) => damageEvent({ id, turn, moveName: 'Crunch', damage: median(forwardMoveRolls(spread, 'Crunch', 80, 'Vaporeon')) });

  // our Vaporeon ate a Chilan Berry (halves one Normal hit) right before Mew's Body Slam; the Crunch
  // before it is unaffected either way. Vaporeon's live item is gone; Showdown keeps it as prevItem.
  const berryRoll = median(forwardMoveRolls(spread, 'Body Slam', 85, 'Vaporeon', { defender: { item: 'Chilan Berry' } }));
  scenario('resist-berry-eaten', itemState('berry', {}, { item: '', prevItem: 'Chilan Berry' }), [
    crunch('b0', 1),
    { ...damageEvent({ id: 'b1', turn: 2, moveName: 'Body Slam', damage: berryRoll }), defenderSnapshot: { consumedItem: 'Chilan Berry', itemLost: true } },
    { ...damageEvent({ id: 'b2', turn: 3, moveName: 'Body Slam', damage: median(forwardMoveRolls(spread, 'Body Slam', 85, 'Vaporeon')) }), defenderSnapshot: { itemLost: true } },
  ]);

  // Mew's Normal Gem (x1.3) was spent on its Body Slam
  const gemRoll = median(forwardMoveRolls(spread, 'Body Slam', 85, 'Vaporeon', { attacker: { item: 'Normal Gem' } }));
  scenario('gem-spent', itemState('gem', { prevItem: 'Normal Gem' }), [
    crunch('g0', 1),
    { ...damageEvent({ id: 'g1', turn: 2, moveName: 'Body Slam', damage: gemRoll }), attackerSnapshot: { consumedItem: 'Normal Gem', itemLost: true } },
  ]);

  // Mew's Choice Band was knocked off on turn 3: both earlier hits used it
  const bandRoll = median(forwardMoveRolls(spread, 'Body Slam', 85, 'Vaporeon', { attacker: { item: 'Choice Band' } }));
  scenario('band-knocked-off-later', itemState('band', { prevItem: 'Choice Band' }), [
    damageEvent({ id: 'k1', turn: 1, moveName: 'Body Slam', damage: bandRoll }),
    damageEvent({ id: 'k2', turn: 2, moveName: 'Body Slam', damage: bandRoll }),
  ]);

  // control: no item, ever
  scenario('control-no-item', itemState('none'), [
    crunch('n0', 1),
    damageEvent({ id: 'n1', turn: 2, moveName: 'Body Slam', damage: median(forwardMoveRolls(spread, 'Body Slam', 85, 'Vaporeon')) }),
  ]);

  FAILED = results.some((result) => !result.ok);
} else if (MODE === 'sweep') {
  // observation pairs proven jointly feasible + both-interior by the forward oracle (MODE=forward)
  const pairs = [[60,188],[60,192],[60,197],[60,201],[60,205],[60,210],[60,214],[63,188],[63,192],[63,197],[63,201],[63,205],[63,208],[66,188],[66,197],[66,205],[57,188],[57,197],[57,205],[70,197],[70,205],[70,214],[73,205],[73,214]];

  for (const [bulky, frail] of pairs) {
    const a = damageEvent({ id: 'a', turn: 1, moveName: 'Body Slam', damage: bulky, target: 'Vaporeon' });
    const b = damageEvent({ id: 'b', turn: 2, moveName: 'Body Slam', damage: frail, target: 'Deoxys-Attack' });
    results.push({ pair: [bulky, frail], alone_a: report('a-' + bulky, [a]), alone_b: report('b-' + frail, [b]), both: report('both-' + bulky + '-' + frail, [a, b]) });
  }
} else {
  // FROZEN FIXTURE SET (architect-owned; the implementer must not edit this file).
  // edge-low / edge-high are observation pairs proven by MODE=forward to be jointly reachable by a
  // single Atk stat with BOTH observations strictly INSIDE their roll ranges (edge-low: Atk stats
  // 220,222,224,226,228,231; edge-high: 219,221,224,226,229,231,232). The current tree nonetheless
  // parks each small-damage observation on a range ENDPOINT -- that is the defect this slice fixes.
  results.push(report('edge-low', [
    damageEvent({ id: 'el1', turn: 1, moveName: 'Body Slam', damage: 60, target: 'Vaporeon' }),
    damageEvent({ id: 'el2', turn: 2, moveName: 'Body Slam', damage: 205, target: 'Deoxys-Attack' }),
  ]));
  results.push(report('edge-high', [
    damageEvent({ id: 'eh1', turn: 1, moveName: 'Body Slam', damage: 66, target: 'Vaporeon' }),
    damageEvent({ id: 'eh2', turn: 2, moveName: 'Body Slam', damage: 188, target: 'Deoxys-Attack' }),
  ]));
  results.push(report('multihit', [
    damageEvent({ id: 'm1', turn: 1, moveName: 'Bullet Seed', damage: 96, target: 'Vaporeon', hits: 5 }),
  ]));
  results.push(report('crit', [
    damageEvent({ id: 'c1', turn: 1, moveName: 'Body Slam', damage: 104, target: 'Vaporeon', crit: true }),
    damageEvent({ id: 'c2', turn: 2, moveName: 'Body Slam', damage: 70, target: 'Vaporeon' }),
  ]));
  results.push(report('ko-censored', [
    damageEvent({ id: 'k1', turn: 1, moveName: 'Body Slam', damage: 251, target: 'Deoxys-Attack', ko: true }),
    damageEvent({ id: 'k2', turn: 2, moveName: 'Body Slam', damage: 70, target: 'Vaporeon' }),
  ]));
  results.push(report('speed-plus-damage', [
    damageEvent({ id: 's1', turn: 1, moveName: 'Body Slam', damage: 70, target: 'Vaporeon' }),
    speedEvent({ id: 's2', turn: 1 }),
  ]));
}

process.stdout.write(JSON.stringify(results, null, 1) + '\n');

if (FAILED) {
  process.exitCode = 1;
}
`;

const compile = (config) => new Promise((resolve, reject) => {
  webpack(config, (error, stats) => {
    if (error) {
      reject(error);
      return;
    }

    if (stats?.hasErrors()) {
      reject(new Error(stats.toString({ all: false, errors: true, warnings: true })));
      return;
    }

    resolve();
  });
});

try {
  await writeFile(entryPath, entrySource);
  await writeFile(calcShimPath, [
    "export { calcPokemonSpreadStats } from '" + path.join(repoRoot, 'src/utils/calc/calcPokemonSpreadStats.ts') + "';",
    "export { createSmogonField } from '" + path.join(repoRoot, 'src/utils/calc/createSmogonField.ts') + "';",
    "export { createSmogonMove } from '" + path.join(repoRoot, 'src/utils/calc/createSmogonMove.ts') + "';",
    "export { createSmogonPokemon } from '" + path.join(repoRoot, 'src/utils/calc/createSmogonPokemon.ts') + "';",
  ].join('\n'));
  await writeFile(battleShimPath, [
    "export { clonePlayerSide } from '" + path.join(repoRoot, 'src/utils/battle/cloneBattleState.ts') + "';",
    "export { countRuinAbilities } from '" + path.join(repoRoot, 'src/utils/battle/countRuinAbilities.ts') + "';",
    "export { ruinAbilitiesActive } from '" + path.join(repoRoot, 'src/utils/battle/ruinAbilitiesActive.ts') + "';",
  ].join('\n'));
  await compile({
    mode: 'production',
    target: 'node',
    entry: entryPath,
    output: { path: tempDirectory, filename: path.basename(outputPath) },
    resolve: {
      alias: {
        '@showdex/utils/battle$': battleShimPath,
        '@showdex/utils/calc$': calcShimPath,
        '@showdex': path.join(repoRoot, 'src'),
      },
      modules: [path.join(repoRoot, 'node_modules'), 'node_modules'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
    module: {
      rules: [{
        test: /\.(?:[cm]?[jt]sx?)$/i,
        exclude: /node_modules/,
        use: {
          loader: 'swc-loader',
          options: {
            jsc: { parser: { syntax: 'typescript', tsx: true } },
            module: { type: 'es6' },
          },
        },
      }],
    },
    plugins: [new webpack.DefinePlugin({ __DEV__: 'false', 'process.env.NODE_ENV': JSON.stringify('production') })],
    optimization: { minimize: false },
  });

  // a clause-failing MODE must still print its verdict table before the non-zero exit, so the child's
  // stdout is captured on BOTH paths and its exit code propagated rather than thrown away
  let stdout = '';
  let stderr = '';
  let childExitCode = 0;

  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [outputPath], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    stdout = error?.stdout || '';
    stderr = error?.stderr || '';
    childExitCode = typeof error?.code === 'number' ? error.code : 1;

    if (!stdout) {
      throw error;
    }
  }

  if (stderr) {
    throw new Error(stderr);
  }

  process.stdout.write(stdout);

  if (childExitCode) {
    process.exitCode = childExitCode;
  }
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
