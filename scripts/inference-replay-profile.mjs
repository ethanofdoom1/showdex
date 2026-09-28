/**
 * Replays a REAL, seeded Pure Hackmons battle through the real parser + inference, one sync per turn,
 * and reports what each sync costs -- the per-turn recalculation the user actually waits on.
 *
 * The battle comes from the local simulator (`../pokemon-showdown`, run in-process with two seeded
 * random-move AIs), seen from p1's side exactly as the client sees it (own HP exact, the opponent's
 * as a percentage). Between syncs the live roster is updated the way the Calcdex does (HP, status,
 * boosts, who's active), so anything live that leaks into a cache key shows up as churn here.
 *
 * `SEED=1,2,3,4` picks the battle; `SYNCS=turn|line` syncs once per turn (default) or once per log
 * line (the worst case: a sync for every step the client plays); `PROFILE=1` also writes a CPU
 * profile of the replay and prints its top self-time functions.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import webpack from 'webpack';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const simRoot = path.resolve(repoRoot, '..', 'pokemon-showdown');
const seed = (process.env.SEED || '1,2,3,4').split(',').map(Number);
const syncMode = process.env.SYNCS || 'turn';
const profile = process.env.PROFILE === '1';

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'showdex-replay-profile-'));
const entryPath = path.join(tempDirectory, 'entry.mjs');
const battleShimPath = path.join(tempDirectory, 'battle-shim.mjs');
const calcShimPath = path.join(tempDirectory, 'calc-shim.mjs');
const outputPath = path.join(tempDirectory, 'bundle.cjs');
const logPath = path.join(tempDirectory, 'battle.json');

const set = (species, item, ability, nature, evs, moves) => ({
  species, item, ability, nature, moves, evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, level: 100,
});
const ev = (hp, atk, def, spa, spd, spe) => ({ hp, atk, def, spa, spd, spe });

// p1 is the viewer (known); p2 is the side being inferred. Varied on purpose: physical & special,
// multi-hit, priority, pivoting, boosting, items that change damage, and abilities that the log never
// reveals -- the things that fan a real battle out into many distinct damage contexts.
const teams = {
  p1: [
    set('Vaporeon', 'Leftovers', 'Water Absorb', 'Bold', ev(252, 0, 252, 0, 4, 0), ['Scald', 'Ice Beam', 'Recover', 'Toxic']),
    set('Garchomp', 'Choice Band', 'Rough Skin', 'Jolly', ev(0, 252, 4, 0, 0, 252), ['Earthquake', 'Outrage', 'Stone Edge', 'Fire Fang']),
    set('Gengar', 'Life Orb', 'Cursed Body', 'Timid', ev(0, 0, 4, 252, 0, 252), ['Shadow Ball', 'Sludge Bomb', 'Focus Blast', 'Thunderbolt']),
    set('Scizor', 'Choice Band', 'Technician', 'Adamant', ev(252, 252, 0, 0, 4, 0), ['Bullet Punch', 'U-turn', 'Close Combat', 'Knock Off']),
    set('Blissey', 'Heavy-Duty Boots', 'Natural Cure', 'Bold', ev(252, 0, 252, 0, 4, 0), ['Seismic Toss', 'Soft-Boiled', 'Toxic', 'Flamethrower']),
    set('Dragapult', 'Choice Specs', 'Infiltrator', 'Timid', ev(0, 0, 0, 252, 4, 252), ['Draco Meteor', 'Shadow Ball', 'Flamethrower', 'Thunderbolt']),
  ],
  p2: [
    set('Mew', 'Life Orb', 'Huge Power', 'Adamant', ev(4, 252, 0, 0, 0, 252), ['Body Slam', 'Earthquake', 'Knock Off', 'Swords Dance']),
    set('Kingambit', 'Leftovers', 'Supreme Overlord', 'Adamant', ev(252, 252, 0, 0, 4, 0), ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Swords Dance']),
    set('Iron Valiant', 'Booster Energy', 'Quark Drive', 'Naive', ev(0, 4, 0, 252, 0, 252), ['Moonblast', 'Close Combat', 'Knock Off', 'Thunderbolt']),
    set('Toxapex', 'Black Sludge', 'Regenerator', 'Bold', ev(252, 0, 252, 0, 4, 0), ['Scald', 'Recover', 'Toxic', 'Haze']),
    set('Volcarona', 'Heavy-Duty Boots', 'Flame Body', 'Timid', ev(0, 0, 4, 252, 0, 252), ['Fiery Dance', 'Bug Buzz', 'Quiver Dance', 'Giga Drain']),
    set('Weavile', 'Choice Band', 'Pressure', 'Jolly', ev(0, 252, 4, 0, 0, 252), ['Triple Axel', 'Knock Off', 'Ice Shard', 'Low Kick']),
  ],
};

// ---- 1. the battle, from the real simulator ----
const simRequire = createRequire(path.join(simRoot, 'package.json'));
const { BattleStream, getPlayerStreams, Teams } = simRequire('./dist/sim');
const { extractChannelMessages } = simRequire('./dist/sim/battle');
const { RandomPlayerAI } = simRequire('./dist/sim/tools/random-player-ai');

const stream = new BattleStream();
const streams = getPlayerStreams(stream);
const p1Lines = [];

new RandomPlayerAI(streams.p1, { move: 0.85, seed: [seed[0], 11, 12, 13] }).start();
new RandomPlayerAI(streams.p2, { move: 0.85, seed: [seed[1], 21, 22, 23] }).start();

const collect = (async () => {
  for await (const chunk of streams.omniscient) {
    // p1's own view: the `|split|` blocks resolve to p1's secret line for p1 and the public one otherwise
    const view = extractChannelMessages(chunk, [0])[0].join('\n');

    view.split('\n').filter((line) => line.startsWith('|') && !line.startsWith('|request|')).forEach((line) => p1Lines.push(line));
  }
})();

void streams.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen9purehackmons', seed })}
>player p1 ${JSON.stringify({ name: 'Viewer', team: Teams.pack(teams.p1) })}
>player p2 ${JSON.stringify({ name: 'Opponent', team: Teams.pack(teams.p2) })}`);

await collect;

const errorLine = p1Lines.find((line) => line.startsWith('|error|'));

if (errorLine) {
  throw new Error('simulator rejected the battle: ' + errorLine);
}

await writeFile(logPath, JSON.stringify({ lines: p1Lines, teams }));

// ---- 2. the replay, against the real parser + inference ----
const entrySource = String.raw`
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Generations } from '@smogon/calc';
import { calcPokemonSpreadStats } from '@showdex/utils/calc';
import { parseHackmonsInferenceEvents } from '@showdex/features/hackmons-cup-inference/parseStepQueue';
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

const { lines, teams } = JSON.parse(readFileSync(${JSON.stringify(logPath)}, 'utf8'));
const SYNCS = ${JSON.stringify(syncMode)};
const gen = Generations.get(9);
const zero = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const midIvs = { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 };
const midEvs = { hp: 128, atk: 128, def: 128, spa: 128, spd: 128, spe: 128 };
const format = 'gen9purehackmons';

const mon = (side, spec, known) => {
  const species = gen.species.get(spec.species.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  const base = {
    calcdexId: side + '-' + species.id,
    ident: side + ': ' + species.name,
    searchid: side + ': ' + species.name,
    name: species.name,
    speciesForme: species.name,
    playerKey: side,
    source: known ? 'server' : 'client',
    level: 100,
    baseStats: species.baseStats,
    types: [...species.types],
    // the opponent's item/ability are unknown until revealed (Hackmons: all random)
    ability: known ? spec.ability : '',
    item: known ? spec.item : '',
    hp: 100,
    maxhp: 100,
    status: '',
    nature: known ? spec.nature : 'Serious',
    ivs: known ? spec.ivs : midIvs,
    evs: known ? spec.evs : midEvs,
    boosts: { ...zero },
    dirtyTypes: [],
    moves: known ? spec.moves : [],
    volatiles: {},
  };

  if (known) {
    base.serverStats = calcPokemonSpreadStats(format, base);
    base.hp = base.serverStats.hp;
    base.maxhp = base.serverStats.hp;
  }

  return base;
};

const state = {
  operatingMode: 'battle', battleId: 'replay-' + ${JSON.stringify(seed.join('-'))}, gen: 9, format,
  legacy: false, gameType: 'Singles', playerCount: 2, playerKey: 'p1', authPlayerKey: 'p1', opponentKey: 'p2',
  field: {}, sheetsNonce: '', rules: { hpPercentage: true },
  p1: { active: true, selectionIndex: 0, activeIndices: [0], pokemon: teams.p1.map((s) => mon('p1', s, true)), side: {} },
  p2: { active: true, selectionIndex: 0, activeIndices: [0], pokemon: teams.p2.map((s) => mon('p2', s, false)), side: {} },
};

const find = (token) => {
  const match = /^(p[12])[a-d]?: (.+)$/.exec(token || '');

  return match ? state[match[1]].pokemon.find((p) => p.name === match[2]) : null;
};
const setHp = (pokemon, condition) => {
  const [hpPart, status] = String(condition || '').split(' ');
  const [hp, maxhp] = hpPart.split('/').map(Number);

  if (!pokemon || !Number.isFinite(hp)) {
    return;
  }

  pokemon.hp = hp;

  if (Number.isFinite(maxhp)) {
    pokemon.maxhp = maxhp;
  }

  pokemon.status = status === 'fnt' ? '' : (status || pokemon.status);
};

// the live roster the Calcdex would show after this line (HP, status, boosts, active slot, reveals)
const applyLive = (line) => {
  const parts = line.split('|');
  const type = parts[1];
  const pokemon = find(parts[2]);

  if (['switch', 'drag'].includes(type) && pokemon) {
    pokemon.boosts = { ...zero };
    state[pokemon.playerKey].selectionIndex = state[pokemon.playerKey].pokemon.indexOf(pokemon);
    state[pokemon.playerKey].activeIndices = [state[pokemon.playerKey].selectionIndex];
    setHp(pokemon, parts[4]);
  } else if (['-damage', '-heal', '-sethp'].includes(type)) {
    setHp(pokemon, parts[3]);
  } else if (type === '-status' && pokemon) {
    pokemon.status = parts[3];
  } else if (type === '-curestatus' && pokemon) {
    pokemon.status = '';
  } else if ((type === '-boost' || type === '-unboost') && pokemon) {
    const stat = parts[3];
    const amount = Number(parts[4]) * (type === '-boost' ? 1 : -1);

    pokemon.boosts = { ...pokemon.boosts, [stat]: Math.max(-6, Math.min(6, (pokemon.boosts[stat] || 0) + amount)) };
  } else if (type === '-clearallboost') {
    [...state.p1.pokemon, ...state.p2.pokemon].forEach((p) => { p.boosts = { ...zero }; });
  } else if (type === '-item' && pokemon) {
    pokemon.item = parts[3];
  } else if (type === '-enditem' && pokemon) {
    pokemon.prevItem = parts[3];
    pokemon.item = '';
  } else if (type === '-ability' && pokemon) {
    pokemon.ability = parts[3];
  } else if (type === 'move' && pokemon && !pokemon.moves.includes(parts[3])) {
    pokemon.moves = [...pokemon.moves, parts[3]];
  }
};

const syncs = [];
let lastEventCount = 0;

const sync = (upTo, turn) => {
  const stepQueue = lines.slice(0, upTo);
  const t0 = performance.now();
  const parsed = parseHackmonsInferenceEvents(stepQueue, state.battleId);
  const t1 = performance.now();
  const output = inferHackmonsSpread(state, parsed.events, parsed.ignoredEventCount);
  const t2 = performance.now();

  syncs.push({
    turn,
    lines: upTo,
    events: parsed.events.length,
    newEvents: parsed.events.length - lastEventCount,
    parseMs: +(t1 - t0).toFixed(2),
    inferMs: +(t2 - t1).toFixed(2),
    mons: Object.keys(output).length,
    modifiers: Object.values(output).reduce((n, m) => n + (m?.estimate?.inferredModifiers?.length || 0), 0),
    // every mon's full published estimate: two builds that agree here produced identical inference
    estimateHash: createHash('sha256').update(JSON.stringify(Object.entries(output).map(([id, m]) => [id, m?.estimate]))).digest('hex').slice(0, 16),
  });
  lastEventCount = parsed.events.length;
};

let turn = 0;

lines.forEach((line, index) => {
  applyLive(line);

  if (line.startsWith('|turn|')) {
    turn = Number(line.split('|')[2]);
  }

  if (SYNCS === 'line' || line.startsWith('|turn|') || index === lines.length - 1) {
    sync(index + 1, turn);
  }
});

const total = (key) => +syncs.reduce((sum, s) => sum + s[key], 0).toFixed(1);
const sorted = (key) => syncs.map((s) => s[key]).sort((a, b) => a - b);
const pct = (key, p) => sorted(key)[Math.min(syncs.length - 1, Math.floor(syncs.length * p))];

process.stdout.write(JSON.stringify({
  seed: ${JSON.stringify(seed)},
  syncMode: SYNCS,
  logLines: lines.length,
  turns: turn,
  syncCount: syncs.length,
  finalEvents: lastEventCount,
  inferMs: { total: total('inferMs'), median: pct('inferMs', 0.5), p95: pct('inferMs', 0.95), max: sorted('inferMs').at(-1) },
  parseMs: { total: total('parseMs'), median: pct('parseMs', 0.5), max: sorted('parseMs').at(-1) },
  syncs,
}, null, 1) + '\n');
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
    "export { chunkStepQueueTurns } from '" + path.join(repoRoot, 'src/utils/battle/chunkStepQueueTurns.ts') + "';",
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

  const repeat = Math.max(1, Number(process.env.REPEAT || 1));
  const nodeArgs = profile ? ['--cpu-prof', '--cpu-prof-dir', tempDirectory, outputPath] : [outputPath];
  // REPEAT=n runs the replay n times in fresh processes (timings are noisy) and reports each run's
  // total alongside the first run's full output
  const runs = [];

  for (let run = 0; run < (profile ? 1 : repeat); run++) {
    const { stdout, stderr } = await execFileAsync(process.execPath, nodeArgs, { maxBuffer: 256 * 1024 * 1024 });

    if (stderr) {
      process.stderr.write(stderr);
    }

    runs.push(stdout);
  }

  if (runs.length > 1) {
    const totals = runs.map((stdout) => JSON.parse(stdout).inferMs.total).sort((a, b) => a - b);
    const first = JSON.parse(runs[0]);

    first.repeatInferTotals = totals;
    first.repeatInferTotalMedian = totals[Math.floor(totals.length / 2)];
    process.stdout.write(JSON.stringify(first, null, 1) + '\n');
  } else {
    process.stdout.write(runs[0]);
  }

  if (profile) {
    const profileFile = (await readdir(tempDirectory)).find((file) => file.endsWith('.cpuprofile'));
    const { nodes, samples, timeDeltas } = JSON.parse(await readFile(path.join(tempDirectory, profileFile), 'utf8'));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const self = new Map();

    samples.forEach((id, index) => {
      const { functionName, url, lineNumber } = byId.get(id).callFrame;
      const key = (functionName || '(anonymous)') + ' ' + path.basename(url || '') + ':' + (lineNumber + 1);

      self.set(key, (self.get(key) || 0) + (timeDeltas[index] || 0));
    });

    const totalUs = [...self.values()].reduce((a, b) => a + b, 0);
    // inclusive time: each sample counts once for every distinct function on its stack
    const parentOf = new Map();

    nodes.forEach((node) => (node.children || []).forEach((child) => parentOf.set(child, node.id)));

    const inclusive = new Map();

    samples.forEach((id, index) => {
      const seen = new Set();

      for (let nodeId = id; nodeId !== undefined; nodeId = parentOf.get(nodeId)) {
        const { functionName, url, lineNumber } = byId.get(nodeId).callFrame;
        const key = (functionName || '(anonymous)') + ' ' + path.basename(url || '') + ':' + (lineNumber + 1);

        if (!seen.has(key)) {
          seen.add(key);
          inclusive.set(key, (inclusive.get(key) || 0) + (timeDeltas[index] || 0));
        }
      }
    });

    process.stdout.write('\nTop self time:\n' + [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(process.env.TOP || 30))
      .map(([key, us]) => `${(us / 1000).toFixed(0).padStart(7)} ms  ${((100 * us) / totalUs).toFixed(1).padStart(5)}%  ${key}`)
      .join('\n') + '\n');

    process.stdout.write('\nTop inclusive time:\n' + [...inclusive.entries()]
      .filter(([key]) => !/^\((root|program|garbage collector)\)|^\(anonymous\) :/.test(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(process.env.TOP || 30))
      .map(([key, us]) => `${(us / 1000).toFixed(0).padStart(7)} ms  ${((100 * us) / totalUs).toFixed(1).padStart(5)}%  ${key}`)
      .join('\n') + '\n');
  }
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
