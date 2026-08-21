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
import { createSmogonField, createSmogonMove, createSmogonPokemon } from '@showdex/utils/calc';
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

const results = [];

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

  const { stdout, stderr } = await execFileAsync(process.execPath, [outputPath], { maxBuffer: 64 * 1024 * 1024 });

  if (stderr) {
    throw new Error(stderr);
  }

  process.stdout.write(stdout);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
