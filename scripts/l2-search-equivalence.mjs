import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import webpack from 'webpack';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'showdex-l2-equivalence-'));
const entryPath = path.join(tempDirectory, 'entry.mjs');
const battleShimPath = path.join(tempDirectory, 'battle-shim.mjs');
const calcShimPath = path.join(tempDirectory, 'calc-shim.mjs');
const outputPath = path.join(tempDirectory, 'bundle.cjs');

const entrySource = String.raw`
import { Generations } from '@smogon/calc';
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

const stats = (hp, atk, def, spa, spd, spe) => ({ hp, atk, def, spa, spd, spe });
const zeroStats = stats(0, 0, 0, 0, 0, 0);
const fullIvs = stats(31, 31, 31, 31, 31, 31);
const blankEvs = stats(0, 0, 0, 0, 0, 0);

const pokemon = ({ side, name, speciesForme, calcdexId, baseStats, types, evs, nature, moves }) => ({
  calcdexId,
  ident: side + ': ' + name,
  searchid: side + ': ' + name,
  name,
  speciesForme,
  playerKey: side,
  source: 'server',
  level: 100,
  baseStats,
  types,
  ability: 'Pressure',
  item: 'Leftovers',
  hp: 400,
  maxhp: 400,
  status: '',
  nature,
  ivs: fullIvs,
  evs,
  boosts: zeroStats,
  dirtyTypes: [],
  moves,
  volatiles: {},
});

const createState = (suffix) => {
  const vaporeon = pokemon({
    side: 'p1', name: 'Vaporeon', speciesForme: 'Vaporeon', calcdexId: 'p1-vaporeon-' + suffix,
    baseStats: stats(130, 65, 60, 110, 95, 65), types: ['Water'],
    evs: stats(252, 0, 252, 0, 4, 0), nature: 'Bold', moves: ['Waterfall', 'Ice Beam', 'Recover'],
  });
  const mew = pokemon({
    side: 'p2', name: 'Mew', speciesForme: 'Mew', calcdexId: 'p2-mew-' + suffix,
    baseStats: stats(100, 100, 100, 100, 100, 100), types: ['Psychic'],
    evs: stats(252, 252, 4, 0, 0, 0), nature: 'Adamant', moves: ['Body Slam', 'Crunch', 'Thunderbolt'],
  });

  return {
    operatingMode: 'battle', battleId: 'l2-equivalence-' + suffix, gen: 9, format: 'gen9hackmonscup',
    legacy: false, gameType: 'Singles', playerCount: 2, playerKey: 'p1', authPlayerKey: 'p1', opponentKey: 'p2',
    field: { isGravity: false }, sheetsNonce: '',
    p1: { active: true, selectionIndex: 0, activeIndices: [0], pokemon: [vaporeon], side: {} },
    p2: { active: true, selectionIndex: 0, activeIndices: [0], pokemon: [mew], side: {} },
  };
};

const damageEvent = ({ id, turn, moveName, damage, attacker = 'p2', effectiveness = 'neutral' }) => ({
  eventType: 'damage', id, turn, attackerKey: attacker, defenderKey: attacker === 'p2' ? 'p1' : 'p2',
  attackerId: attacker + 'a: ' + (attacker === 'p2' ? 'Mew' : 'Vaporeon'),
  defenderId: (attacker === 'p2' ? 'p1' : 'p2') + 'a: ' + (attacker === 'p2' ? 'Vaporeon' : 'Mew'),
  attackerName: attacker + ': ' + (attacker === 'p2' ? 'Mew' : 'Vaporeon'),
  defenderName: (attacker === 'p2' ? 'p1' : 'p2') + ': ' + (attacker === 'p2' ? 'Vaporeon' : 'Mew'),
  moveName, damage, attackerStartHp: 400, attackerMaxHp: 400, startHp: 400,
  endHp: Math.max(1, 400 - damage), maxHp: 400, effectiveness, rawLine: '|-damage|',
});

const speedEvent = ({ id, turn, attacker = 'p2', moveName = 'Body Slam', slowerMoveName = 'Waterfall' }) => ({
  eventType: 'speed', id, turn, attackerKey: attacker, defenderKey: attacker === 'p2' ? 'p1' : 'p2',
  attackerId: attacker + 'a: ' + (attacker === 'p2' ? 'Mew' : 'Vaporeon'),
  defenderId: (attacker === 'p2' ? 'p1' : 'p2') + 'a: ' + (attacker === 'p2' ? 'Vaporeon' : 'Mew'),
  attackerName: attacker + ': ' + (attacker === 'p2' ? 'Mew' : 'Vaporeon'),
  defenderName: (attacker === 'p2' ? 'p1' : 'p2') + ': ' + (attacker === 'p2' ? 'Vaporeon' : 'Mew'),
  moveName, slowerMoveName, rawLine: '|move|',
});

const cases = [
  ['no-modifier', [damageEvent({ id: 'n1', turn: 1, moveName: 'Body Slam', damage: 80 }), speedEvent({ id: 'n2', turn: 1 })]],
  ['physical-pair', [damageEvent({ id: 'p1', turn: 1, moveName: 'Body Slam', damage: 82 }), damageEvent({ id: 'p2', turn: 2, moveName: 'Crunch', damage: 70 }), speedEvent({ id: 'p3', turn: 2 })]],
  ['special-pair', [damageEvent({ id: 's1', turn: 1, moveName: 'Thunderbolt', damage: 110 }), damageEvent({ id: 's2', turn: 2, moveName: 'Ice Beam', damage: 75, attacker: 'p1' }), speedEvent({ id: 's3', turn: 2, attacker: 'p1', moveName: 'Ice Beam', slowerMoveName: 'Crunch' })]],
  ['defender-first', [damageEvent({ id: 'd1', turn: 1, moveName: 'Waterfall', damage: 64, attacker: 'p1' }), damageEvent({ id: 'd2', turn: 2, moveName: 'Body Slam', damage: 84 }), speedEvent({ id: 'd3', turn: 2 })]],
  ['modifier-hypothesis', [damageEvent({ id: 'm1', turn: 1, moveName: 'Body Slam', damage: 180 }), damageEvent({ id: 'm2', turn: 2, moveName: 'Crunch', damage: 158 }), speedEvent({ id: 'm3', turn: 2 })]],
  ['mixed-order', [damageEvent({ id: 'x1', turn: 1, moveName: 'Thunderbolt', damage: 132 }), damageEvent({ id: 'x2', turn: 2, moveName: 'Waterfall', damage: 68, attacker: 'p1' }), damageEvent({ id: 'x3', turn: 3, moveName: 'Body Slam', damage: 88 }), speedEvent({ id: 'x4', turn: 3 })]],
];

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((output, key) => {
    if (value[key] !== undefined) output[key] = canonicalize(value[key]);
    return output;
  }, {});
  return value;
};

const output = cases.map(([name, events]) => ({
  name,
  output: inferHackmonsSpread(createState(name), events, 0),
}));

process.stdout.write(JSON.stringify(canonicalize(output)) + '\n');
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

  const { stdout, stderr } = await execFileAsync(process.execPath, [outputPath]);

  if (stderr) {
    throw new Error(stderr);
  }

  process.stdout.write(stdout);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
