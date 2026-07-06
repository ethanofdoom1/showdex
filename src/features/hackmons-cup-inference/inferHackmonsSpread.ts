import {
  type AbilityName,
  type ItemName,
  type ShowdexCalcMods,
  calculate,
} from '@smogon/calc';
import { PokemonNatures, PokemonSpeedReductionItems, PokemonTypeAssociativeItems } from '@showdex/consts/dex';
import {
  type CalcdexBattleField,
  type CalcdexBattleState,
  type CalcdexPlayerKey,
  type CalcdexPokemon,
} from '@showdex/interfaces/calc';
import {
  calcPokemonSpreadStats,
  createSmogonField,
  createSmogonMove,
  createSmogonPokemon,
} from '@showdex/utils/calc';
import { formatId } from '@showdex/utils/core';
import { getGenDexForFormat } from '@showdex/utils/dex';
import {
  type HackmonsDamageMatch,
  type HackmonsDamageOutlier,
  type HackmonsExtremalFeasibility,
  type HackmonsInferredModifier,
  type HackmonsInferenceFieldSnapshot,
  type HackmonsInferenceEvent,
  type HackmonsInferenceMap,
  type HackmonsInferencePokemonSnapshot,
  type HackmonsInferenceState,
  type HackmonsModifierClass,
  type HackmonsModifierSlot,
} from './types';

const StatNames: Showdown.StatName[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const DefaultIv = 15;
const DefaultEv = 128;
const CandidateIvs = Array.from({ length: 32 }, (_, i) => i);
const CoordinateCandidateEvs = [0, 32, 64, 96, DefaultEv, 160, 192, 224, 252];
const MaxScoredEventsPerCategory = 3;
const MaxCandidateCount = 4000;
const NeutralNature = 'Serious' as Showdown.PokemonNature;
const CacheVersion = 'bounded-search-v23';

// keyed per defending Pokemon `calcdexId` + that mon's event signature, so a new battle log step
// only re-searches the mon(s) whose events actually changed (see inferHackmonsSpread())
const InferenceCache = new Map<string, HackmonsInferenceState>();
const SpeedDependentMoves = new Set(['electroball', 'gyroball']);

// out-of-range distance must always dominate median-centering distance in scoreCandidate() -- a
// single unit of infeasibility (an observation the candidate can't produce at all) has to outweigh
// any possible in-range centering difference, or a "closer to median but impossible" spread could
// still beat a "further from median but possible" one
const RangeInfeasibilityWeight = 1e6;
const ModifierComplexityPenalty = 6 * RangeInfeasibilityWeight;

interface ModifierOverride {
  id: string;
  item?: ItemName;
  ability?: AbilityName;
  speedMultiplier?: number;
}

const ModifierCatalog: HackmonsModifierClass[] = [
  {
    id: 'ability-atk-2',
    slot: 'ability',
    scope: 'global-atk',
    multiplier: 2,
    representative: 'Huge Power',
    examples: ['Huge Power', 'Pure Power'],
  },
  {
    id: 'item-atk-1.5',
    slot: 'item',
    scope: 'global-atk',
    multiplier: 1.5,
    representative: 'Choice Band',
    examples: ['Choice Band', 'Gorilla Tactics', 'Hustle'],
  },
  {
    id: 'item-spa-1.5',
    slot: 'item',
    scope: 'global-spa',
    multiplier: 1.5,
    representative: 'Choice Specs',
    examples: ['Choice Specs'],
  },
  {
    id: 'item-both-1.3',
    slot: 'item',
    scope: 'global-both',
    multiplier: 1.3,
    representative: 'Life Orb',
    examples: ['Life Orb'],
  },
  {
    id: 'ability-atk-0.5',
    slot: 'ability',
    scope: 'global-atk',
    multiplier: 0.5,
    representative: 'Slow Start',
    examples: ['Slow Start'],
  },
  {
    id: 'ability-def-2',
    slot: 'ability',
    scope: 'global-def',
    multiplier: 2,
    representative: 'Fur Coat',
    examples: ['Fur Coat'],
  },
  {
    id: 'ability-special-taken-0.5',
    slot: 'ability',
    scope: 'global-spd',
    multiplier: 0.5,
    representative: 'Ice Scales',
    examples: ['Ice Scales'],
  },
  {
    id: 'item-spd-1.5',
    slot: 'item',
    scope: 'global-spd',
    multiplier: 1.5,
    representative: 'Assault Vest',
    examples: ['Assault Vest'],
  },
  {
    id: 'ability-se-taken-0.75',
    slot: 'ability',
    scope: 'super-effective-taken',
    multiplier: 0.75,
    representative: 'Filter',
    examples: ['Filter', 'Solid Rock', 'Prism Armor'],
  },
  {
    id: 'ability-full-hp-taken-0.5',
    slot: 'ability',
    scope: 'full-hp-taken',
    multiplier: 0.5,
    representative: 'Multiscale',
    examples: ['Multiscale', 'Shadow Shield'],
  },
  {
    id: 'ability-thickfat-fireice-0.5',
    slot: 'ability',
    scope: { types: ['Fire', 'Ice'] },
    multiplier: 0.5,
    representative: 'Thick Fat',
    examples: ['Thick Fat'],
  },
  {
    id: 'item-spe-1.5',
    slot: 'item',
    scope: 'spe',
    multiplier: 1.5,
    representative: 'Choice Scarf',
    examples: ['Choice Scarf'],
  },
  {
    id: 'item-spe-0.5',
    slot: 'item',
    scope: 'spe',
    multiplier: 0.5,
    representative: 'Iron Ball',
    examples: ['Iron Ball', 'Power Anklet', 'Power Weight', 'Power Bracer', 'Power Belt', 'Power Lens', 'Power Band', 'Macho Brace'],
  },
  {
    id: 'ability-spe-0.5',
    slot: 'ability',
    scope: 'spe',
    multiplier: 0.5,
    representative: 'Slow Start',
    examples: ['Slow Start'],
  },
];

const modifierById = (
  id: string,
): HackmonsModifierClass => ModifierCatalog.find((modifier) => modifier.id === id);

// Group 3 (scoped offensive boosts, T2): unlike Groups 1/2/5's fixed catalog, "one type x1.2/x1.5"
// is a template parameterized by whichever type the evidence points at, so its classes are generated
// on demand (see itemTypeBoostClass()/abilityTypeBoostClass()) rather than listed in ModifierCatalog.
// Representative real items/abilities per type -- Plates cover every type but Normal (Silk Scarf);
// Transistor-class abilities only exist for these four types in the actual games.
const TypeBoostItemByType: Partial<Record<Showdown.TypeName, ItemName>> = {
  Normal: 'Silk Scarf',
  Fighting: 'Fist Plate',
  Flying: 'Sky Plate',
  Poison: 'Toxic Plate',
  Ground: 'Earth Plate',
  Rock: 'Stone Plate',
  Bug: 'Insect Plate',
  Ghost: 'Spooky Plate',
  Steel: 'Iron Plate',
  Fire: 'Flame Plate',
  Water: 'Splash Plate',
  Grass: 'Meadow Plate',
  Electric: 'Zap Plate',
  Psychic: 'Mind Plate',
  Ice: 'Icicle Plate',
  Dragon: 'Draco Plate',
  Dark: 'Dread Plate',
  Fairy: 'Pixie Plate',
} as Partial<Record<Showdown.TypeName, ItemName>>;

const TypeBoostAbilityByType: Partial<Record<Showdown.TypeName, AbilityName>> = {
  Electric: 'Transistor',
  Rock: 'Rocky Payload',
  Steel: 'Steelworker',
  Dragon: 'Dragon\'s Maw',
} as Partial<Record<Showdown.TypeName, AbilityName>>;

// PokemonTypeAssociativeItems mixes boosting items with type-changers (Drives/Memories, out of scope
// here -- they don't boost damage) and resistance berries (one-shot, announce themselves via
// |-enditem|, also out of scope per the spec's §2) -- filter both out to leave just the classic
// x1.2 type-boost items for the modifier class's display-only `examples` list
const ExcludedTypeBoostItemSuffixes = ['Berry', 'Memory', 'Drive'];

const typeBoostItemExamples = (
  type: Showdown.TypeName,
): string[] => {
  const examples = (Object.entries(PokemonTypeAssociativeItems) as [string, Showdown.TypeName][])
    .filter(([item, itemType]) => (
      itemType === type && !ExcludedTypeBoostItemSuffixes.some((suffix) => item.endsWith(suffix))
    ))
    .map(([item]) => item);

  return examples.length ? examples : [TypeBoostItemByType[type]].filter(Boolean);
};

const itemTypeBoostClass = (
  type: Showdown.TypeName,
): HackmonsModifierClass => ({
  id: `item-type-${formatId(type)}-1.2`,
  slot: 'item',
  scope: { type },
  multiplier: 1.2,
  representative: TypeBoostItemByType[type],
  examples: typeBoostItemExamples(type),
});

const abilityTypeBoostClass = (
  type: Showdown.TypeName,
): HackmonsModifierClass => ({
  id: `ability-type-${formatId(type)}-1.5`,
  slot: 'ability',
  scope: { type },
  multiplier: 1.5,
  representative: TypeBoostAbilityByType[type],
  examples: [TypeBoostAbilityByType[type]],
});

const AdaptabilityModifier: HackmonsModifierClass = {
  id: 'ability-stab-2',
  slot: 'ability',
  scope: 'stab',
  multiplier: 2,
  representative: 'Adaptability',
  examples: ['Adaptability'],
};

const modifierOverrideFromClass = (
  modifier: HackmonsModifierClass,
): ModifierOverride => ({
  id: modifier.id,
  ...(modifier.slot === 'item' ? { item: modifier.representative as ItemName } : null),
  ...(modifier.slot === 'ability' ? { ability: modifier.representative as AbilityName } : null),
  ...(modifier.scope === 'spe' ? { speedMultiplier: modifier.multiplier } : null),
});

// combines a damage-side and speed-side adopted modifier (e.g. Huge Power + Iron Ball) into one
// override -- each targets a different facet (item/ability/speedMultiplier) so there's nothing to
// resolve conflict-wise, just union the fields; `undefined` entries (nothing adopted on that side)
// are skipped
const mergeModifierOverrides = (
  ...overrides: ModifierOverride[]
): ModifierOverride => overrides.filter(Boolean).reduce((merged, override) => ({
  id: merged.id ? `${merged.id}+${override.id}` : override.id,
  item: merged.item || override.item,
  ability: merged.ability || override.ability,
  speedMultiplier: merged.speedMultiplier || override.speedMultiplier,
}), {} as ModifierOverride);

const formatModifierScope = (
  scope: HackmonsModifierClass['scope'],
): string => {
  if (typeof scope !== 'string') {
    if ('type' in scope) {
      return scope.type;
    }

    if ('types' in scope) {
      return scope.types.join('/');
    }

    return scope.moveTag;
  }

  return scope === 'stab' ? 'STAB' : scope;
};

const blankSpread = (value: number): Showdown.StatsTable => StatNames.reduce((output, stat) => {
  output[stat] = value;
  return output;
}, {} as Showdown.StatsTable);

const normalizeName = (value: string): string => formatId((value || '').replace(/^p[1-4][a-d]?\s*:?\s*/i, ''));
const normalizeLogId = (value: string): string => formatId(value || '').replace(/^p([1-4])[a-d]/i, 'p$1');
const normalizePokemonText = (value: string): string[] => [
  normalizeName(value),
  normalizeLogId(value),
].filter(Boolean);

const findPokemonByLogName = (
  state: CalcdexBattleState,
  logName: string,
  playerKeyHint?: CalcdexPlayerKey,
  logId?: string,
): {
  playerKey: CalcdexPlayerKey;
  pokemon: CalcdexPokemon;
} => {
  const side = logName.match(/^p([1-4])/i)?.[0] as CalcdexPlayerKey;
  const idSide = logId?.match(/^p([1-4])/i)?.[0] as CalcdexPlayerKey;
  const wanted = [
    ...normalizePokemonText(logName),
    ...normalizePokemonText(logId),
  ];
  const preferredKeys = (playerKeyHint ? [playerKeyHint] : side ? [side] : idSide ? [idSide] : []) as CalcdexPlayerKey[];
  const keys = [
    ...preferredKeys,
    ...(['p1', 'p2', 'p3', 'p4'] as CalcdexPlayerKey[]).filter((key) => !preferredKeys.includes(key)),
  ];

  for (const playerKey of keys) {
    const pokemon = state?.[playerKey]?.pokemon?.find((p) => [
      p.ident,
      p.searchid,
      p.name,
      p.speciesForme,
      p.transformedForme,
    ].some((name) => {
      const normalized = normalizePokemonText(name);

      return wanted.some((value) => (
        normalized.some((candidate) => (
          candidate === value
            || candidate.startsWith(value)
            || value.startsWith(candidate)
            || candidate.includes(value)
        ))
      ));
    }));

    if (pokemon) {
      return { playerKey, pokemon };
    }
  }

  return null;
};

const reduceCombinedRolls = (
  distribution: number[],
  scaleValue: number,
): number[] => {
  const nextLength = distribution.length / scaleValue;
  const reduced = [];
  const [firstRoll] = distribution;
  reduced[0] = firstRoll;
  reduced[nextLength - 1] = distribution[distribution.length - 1];

  for (let i = 1; i < nextLength - 1; i++) {
    reduced[i] = distribution[Math.round(i * scaleValue + scaleValue / 2)];
  }

  return reduced;
};

const combineDamageDistributions = (
  distributions: number[][],
): number[] => {
  let combined = [0];
  const numRolls = distributions[0]?.length || 0;
  const numAccuracy = (numRolls === 16 && distributions.length === 3) ? 3 : 2;

  for (let i = 0; i < distributions.length; i++) {
    combined = combined
      .flatMap((left) => distributions[i].map((right) => left + right))
      .sort((a, b) => a - b);

    if (i >= numAccuracy) {
      combined = reduceCombinedRolls(combined, distributions[i].length);
    }
  }

  return combined;
};

const extractDamageRolls = (result: unknown): number[] => {
  const damage = (result as { damage?: unknown; })?.damage;

  if (typeof damage === 'number') {
    return [damage];
  }

  if (!Array.isArray(damage)) {
    return [];
  }

  if (typeof damage[0] === 'number') {
    const flat = damage.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    if (flat.length >= 16) {
      return flat;
    }

    if (flat.length >= 2) {
      return [flat.reduce((total, value) => total + value, 0)];
    }

    return flat;
  }

  const distributions = damage
    .filter((part): part is number[] => Array.isArray(part))
    .map((part) => part.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)))
    .filter((part) => part.length);

  if (!distributions.length) {
    return [];
  }

  return combineDamageDistributions(distributions);
};

const convertRollsForObservedHp = (
  state: CalcdexBattleState,
  rolls: number[],
  observedMaxHp: number,
  defender: unknown,
): number[] => {
  if (!state.rules?.hpPercentage) {
    return rolls;
  }

  const candidateMaxHp = (
    observedMaxHp === 100
      ? (defender as { rawStats?: Partial<Showdown.StatsTable>; })?.rawStats?.hp
      : observedMaxHp
  );

  if (!candidateMaxHp) {
    return rolls;
  }

  return rolls.map((roll) => Math.round((roll / candidateMaxHp) * 100));
};

const normalizeObservedDamage = (
  state: CalcdexBattleState,
  damage: number,
  maxHp: number,
): number => {
  if (!state.rules?.hpPercentage || !maxHp) {
    return damage;
  }

  return Math.round((damage / maxHp) * 100);
};

const medianDamageRoll = (
  rolls: number[],
): number => {
  if (!rolls.length) {
    return null;
  }

  const sorted = [...rolls].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const cloneBoostSnapshot = (
  boosts?: Partial<Showdown.StatsTableNoHp>,
): Showdown.StatsTableNoHp => ({
  atk: boosts?.atk || 0,
  def: boosts?.def || 0,
  spa: boosts?.spa || 0,
  spd: boosts?.spd || 0,
  spe: boosts?.spe || 0,
});

const applyEventHp = (
  pokemon: CalcdexPokemon,
  hp?: number,
  maxHp?: number,
): CalcdexPokemon => {
  if (typeof hp !== 'number' || typeof maxHp !== 'number' || !maxHp) {
    return pokemon;
  }

  const spreadHp = pokemon.spreadStats?.hp || pokemon.maxhp || maxHp;
  const dirtyHp = maxHp === spreadHp
    ? hp
    : Math.floor((hp / maxHp) * spreadHp);

  return {
    ...pokemon,
    hp,
    maxhp: maxHp,
    dirtyHp,
  };
};

const applyEventFieldSnapshot = (
  field: CalcdexBattleField,
  snapshot?: HackmonsInferenceFieldSnapshot,
): CalcdexBattleField => ({
  ...field,
  ...snapshot,
  autoWeather: null,
  autoTerrain: null,
  dirtyWeather: null,
  dirtyTerrain: null,
});

const applyEventPokemonSnapshot = (
  format: string,
  pokemon: CalcdexPokemon,
  snapshot?: HackmonsInferencePokemonSnapshot,
): CalcdexPokemon => {
  if (!snapshot) {
    return pokemon;
  }

  const dex = getGenDexForFormat(format);
  const speciesTypes = dex?.species.get((pokemon.transformedForme || pokemon.speciesForme) as never)?.types as Showdown.TypeName[];
  const types = snapshot.typeChanged && snapshot.types?.length
    ? snapshot.types
    : speciesTypes?.length
      ? speciesTypes
      : pokemon.types;
  const abilityId = formatId(pokemon.dirtyAbility || pokemon.ability);

  return {
    ...pokemon,
    types: types?.length ? [...types] : pokemon.types,
    dirtyTypes: [],
    teraType: snapshot.teraType || null,
    dirtyTeraType: null,
    terastallized: !!snapshot.terastallized,
    abilityToggled: snapshot.typeChanged && ['protean', 'libero'].includes(abilityId)
      ? false
      : pokemon.abilityToggled,
  };
};

// Illuminate has no onModify*/onDamage*/onBasePower* hooks anywhere in the (patched) @smogon/calc
// mechanics files -- it's a safe "no ability" sentinel for the search-candidate mon specifically
const NeutralAbility = 'Illuminate' as AbilityName;

const applyInferencePokemonAssumptions = (
  pokemon: CalcdexPokemon,
  neutralizeUnconfirmedAbility?: boolean,
  modifierOverride?: ModifierOverride,
): CalcdexPokemon => ({
  ...pokemon,

  // Hackmons Cup item/ability are random. Until this feature explicitly infers them, do not let
  // preset-suggested overrides bias spread inference damage rolls. A preset-suggested `ability` (as
  // opposed to a confirmed reveal from a `|-ability|` log line) is just as much of an unearned bias as
  // a `dirtyAbility` override, so the search-candidate mon's ability is neutralized until confirmed.
  dirtyAbility: null,
  dirtyItem: null,
  abilityToggled: pokemon.ability ? pokemon.abilityToggled : false,
  dirtyBoostedStat: null,

  // the event's own stat stages (e.g. a self-inflicted Def/SpDef drop from Armor Cannon) are set
  // explicitly via `boosts: event.(attacker|defender)Boosts` in evaluateCandidateEvent(), but
  // createSmogonPokemon() reads `dirtyBoosts` in PREFERENCE to `boosts` -- and dirtyBoosts is set by
  // manual Calcdex boost edits (PokeStats arrows), which persist on the live mon across syncs. Left
  // uncleared, a user's current boost override silently replaces the HISTORICAL stages on every past
  // event's calc, skewing modeled ranges (e.g. falsely tripping the too-high outlier tagger on a hit
  // that landed under a real self-inflicted drop). All four drop-timing/geometry combinations verify
  // clean in e2e (which can't click the UI), so this is the only remaining override channel.
  dirtyBoosts: null,
  ...(neutralizeUnconfirmedAbility ? { ability: NeutralAbility } : null),
  ...(modifierOverride?.item ? { item: modifierOverride.item } : null),
  ...(modifierOverride?.ability ? { ability: modifierOverride.ability } : null),
});

function resolveEventRelation(
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
): EventRelation {
  const attackerMatch = findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
  const defenderMatch = findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId);

  if (attackerMatch?.pokemon?.calcdexId === candidatePokemon.calcdexId) {
    return 'attacker';
  }

  if (defenderMatch?.pokemon?.calcdexId === candidatePokemon.calcdexId) {
    return 'defender';
  }

  return null;
}

const getMoveData = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
) => getGenDexForFormat(state.format)?.moves.get(formatId(event.moveName) as never) as {
  category?: Showdown.MoveCategory;
  priority?: number;
  type?: Showdown.TypeName;
  overrideOffensiveStat?: Showdown.StatNameNoHp;
  overrideDefensiveStat?: Showdown.StatNameNoHp;
  overrideOffensivePokemon?: 'source' | 'target';
  overrideDefensivePokemon?: 'source' | 'target';
};

// STAB scope (Adaptability, Group 3): whether this event's move shares a type with the candidate's
// own known/snapshotted types at the time of the event (mirrors evaluateCandidateEvent()'s own
// applyEventPokemonSnapshot() call for type-change handling, e.g. Protean)
const isEventStabMove = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
): boolean => {
  const moveType = getMoveData(state, event)?.type;

  if (!moveType) {
    return false;
  }

  const types = applyEventPokemonSnapshot(state.format, candidatePokemon, event.attackerSnapshot)?.types;

  return !!types?.includes(moveType);
};

const getMoveInfluence = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
): {
  category?: Showdown.MoveCategory;
  offensiveStat?: Showdown.StatNameNoHp;
  defensiveStat?: Showdown.StatNameNoHp;
  offensivePokemon: 'source' | 'target';
  defensivePokemon: 'source' | 'target';
  dependsOnSpeed: boolean;
} => {
  const move = getMoveData(state, event);
  const category = move?.category;
  const physical = category === 'Physical';

  return {
    category,
    offensiveStat: move?.overrideOffensiveStat || (category === 'Special' ? 'spa' : physical ? 'atk' : null),
    defensiveStat: move?.overrideDefensiveStat || (physical ? 'def' : category === 'Special' ? 'spd' : null),
    offensivePokemon: move?.overrideOffensivePokemon || 'source',
    defensivePokemon: move?.overrideDefensivePokemon || 'target',
    dependsOnSpeed: SpeedDependentMoves.has(formatId(event.moveName)),
  };
};

const evaluateCandidateEvent = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
  nature: Showdown.PokemonNature,
  ivs: Showdown.StatsTable,
  evs: Showdown.StatsTable,
  context: DamageEventContext,
  rollCache?: Map<string, number[]>,
  modifierOverride?: ModifierOverride,
): HackmonsDamageMatch => {
  if (event.eventType === 'speed') {
    return null;
  }

  const normalizedObservedDamage = normalizeObservedDamage(state, event.damage || 0, event.maxHp);

  const emptyMatch = (error: string): HackmonsDamageMatch => ({
    eventId: event.id,
    turn: event.turn,
    moveName: event.moveName,
    observedDamage: normalizedObservedDamage,
    maxHp: event.maxHp,
    error,
  });

  const dex = getGenDexForFormat(state.format);

  if (!dex) {
    return emptyMatch('missing dex');
  }

  const {
    attackerMatch,
    defenderMatch,
    relation,
    relevantStats,
    eventField,
  } = context;

  if (!attackerMatch?.pokemon) {
    return emptyMatch(`attacker lookup failed ${event.attackerKey || '?'}:${event.attackerName || '(unknown)'}`);
  }

  if (!defenderMatch?.pokemon) {
    return emptyMatch(`defender lookup failed ${event.defenderKey || '?'}:${event.defenderName || '(unknown)'}`);
  }

  if (!relation) {
    return emptyMatch('candidate relation failed');
  }

  const candidateSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature,
    ivs,
    evs,
  });

  // the damage rolls for this event are a pure function of the candidate's stats that actually feed
  // the calc (everything else here -- the non-candidate Pokemon, boosts, status, field, crit, hits --
  // is fixed for a given event), so cache them across the coordinate search to skip redundant calculate()s
  const rollKey = `${event.id}:${relation}:${modifierOverride?.id || 'none'}:${relevantStats
    .map((stat) => candidateSpreadStats?.[stat] ?? '')
    .join(',')}`;

  let rolls = rollCache?.get(rollKey);

  if (!rolls?.length) {
    const attackerPlayer = state[attackerMatch.playerKey];
    const defenderPlayer = state[defenderMatch.playerKey];
    const attackerCandidate: CalcdexPokemon = relation === 'attacker' ? {
      ...applyInferencePokemonAssumptions(applyEventPokemonSnapshot(
        state.format,
        candidatePokemon,
        event.attackerSnapshot,
      ), !event.attackerSnapshot?.abilityConfirmed, modifierOverride),
      nature,
      ivs,
      evs,
      boosts: cloneBoostSnapshot(event.attackerBoosts),
      status: event.attackerStatus ?? candidatePokemon.status,
      spreadStats: candidateSpreadStats,
      // Rage Fist's base power depends on how many times the attacker has been hit prior to this
      // move; the live/candidate hitCounter reflects the current battle state, not this historical
      // event, so it must come from the event itself
      hitCounter: event.attackerHitCounter || 0,
      // same idea for Fury Cutter/Rollout's consecutive-use power scaling & Rollout's Defense Curl combo
      moveRepeatCount: event.attackerMoveRepeatCount || 0,
      defenseCurled: !!event.attackerDefenseCurled,
    } : applyInferencePokemonAssumptions(applyEventPokemonSnapshot(state.format, {
      ...attackerMatch.pokemon,
      boosts: cloneBoostSnapshot(event.attackerBoosts),
      status: event.attackerStatus ?? attackerMatch.pokemon.status,
      hitCounter: event.attackerHitCounter || 0,
      moveRepeatCount: event.attackerMoveRepeatCount || 0,
      defenseCurled: !!event.attackerDefenseCurled,
    }, event.attackerSnapshot));
    const defenderCandidate: CalcdexPokemon = relation === 'defender' ? {
      ...applyInferencePokemonAssumptions(applyEventPokemonSnapshot(
        state.format,
        candidatePokemon,
        event.defenderSnapshot,
      ), !event.defenderSnapshot?.abilityConfirmed, modifierOverride),
      nature,
      ivs,
      evs,
      boosts: cloneBoostSnapshot(event.defenderBoosts),
      status: event.defenderStatus ?? candidatePokemon.status,
      spreadStats: candidateSpreadStats,
    } : applyInferencePokemonAssumptions(applyEventPokemonSnapshot(state.format, {
      ...defenderMatch.pokemon,
      boosts: cloneBoostSnapshot(event.defenderBoosts),
      status: event.defenderStatus ?? defenderMatch.pokemon.status,
    }, event.defenderSnapshot));
    const attackerWithEventHp = applyEventHp(attackerCandidate, event.attackerStartHp, event.attackerMaxHp);

    try {
      const allPlayers = ['p1', 'p2', 'p3', 'p4']
        .filter((k: CalcdexPlayerKey) => state[k]?.active)
        .map((k: CalcdexPlayerKey) => state[k]);

      const field = createSmogonField(
        state.format,
        state.gameType,
        eventField,
        attackerPlayer,
        defenderPlayer,
        allPlayers,
      );

      const attacker = createSmogonPokemon(
        state.format,
        state.gameType,
        attackerWithEventHp,
        event.moveName,
        defenderCandidate,
      );

      if (!attacker) {
        return emptyMatch(`invalid attacker ${attackerMatch.pokemon.speciesForme || event.attackerName}`);
      }

      const smogonDefender = createSmogonPokemon(
        state.format,
        state.gameType,
        defenderCandidate,
        null,
        attackerCandidate,
      );

      if (!smogonDefender) {
        return emptyMatch(`invalid defender ${defenderCandidate.speciesForme || event.defenderName}`);
      }

      // pass the observed crit through the attacker's moveOverrides so it's baked into the SmogonMove's
      // construction options: createSmogonMove() overrides move.clone() to rebuild from those options,
      // and @smogon/calc's (patched) calculate() clones the move before the damage calc -- so a
      // post-construction `move.isCrit = ...` mutation is silently dropped by the clone (unlike `hits`,
      // which the custom clone explicitly carries over)
      const moveResult = createSmogonMove(
        state.format,
        {
          ...attackerWithEventHp,
          moveOverrides: {
            ...attackerWithEventHp.moveOverrides,
            [event.moveName]: {
              ...attackerWithEventHp.moveOverrides?.[event.moveName],
              alwaysCriticalHits: !!event.crit,
            },
          },
        },
        event.moveName,
        defenderCandidate,
        eventField,
      );

      if (!moveResult?.[0]) {
        return emptyMatch(`invalid move ${event.moveName}`);
      }

      const [move] = moveResult;

      // Parental Bond hypothesis: @smogon/calc's own Parental Bond mechanic (a real `move.hits === 1`
      // check in its patched mechanics) computes the correct 100%+25% split distribution ONLY when
      // `move.hits` is left at the move's natural (un-doubled) value -- forcing it to the REAL
      // observed hit count (2, from the `-hitcount` line this ability itself causes) would disable
      // that check and fall back to a naive "2 equal-power hits" calc instead
      if (modifierOverride?.ability !== ('Parental Bond' as AbilityName)) {
        move.hits = event.hits || 1;
      }

      const mods: ShowdexCalcMods = {
        hitBasePowers: null,
        excludeHazardsDamage: true,
        excludeEotDamage: true,
      };

      rolls = convertRollsForObservedHp(
        state,
        extractDamageRolls(calculate(dex, attacker, smogonDefender, move, field, mods)),
        event.maxHp,
        smogonDefender,
      );
    } catch (error) {
      return emptyMatch((error as Error)?.message || `calc failed for ${event.moveName}`);
    }

    if (!rolls.length) {
      return emptyMatch(`empty rolls for ${event.moveName}`);
    }

    rollCache?.set(rollKey, rolls);
  }

  const median = medianDamageRoll(rolls);
  const minRoll = Math.min(...rolls);
  const maxRoll = Math.max(...rolls);

  // a KO hit's observed damage is truncated at the defender's remaining HP -- the real roll was AT
  // LEAST the observation -- so score it one-sided (any candidate whose max roll covers the observed
  // HP loss fits perfectly) instead of dragging the search toward matching the truncated value exactly
  const ko = event.endHp === 0;

  // feasibility distance for scoreCandidate(): 0 whenever this spread can actually produce the
  // observation (in-range), and only positive when it's genuinely unreachable by this spread. This is
  // what lets the search prefer any spread that keeps every past observation possible over one that's
  // merely closest-to-median but infeasible for at least one event -- KO stays one-sided since the
  // truncated observation is only ever a lower bound on the real roll
  const rangeDistance = ko
    ? Math.max(0, normalizedObservedDamage - maxRoll)
    : Math.max(0, minRoll - normalizedObservedDamage, normalizedObservedDamage - maxRoll);

  return {
    eventId: event.id,
    turn: event.turn,
    moveName: event.moveName,
    observedDamage: normalizedObservedDamage,
    medianDamage: median,
    distance: ko
      ? Math.max(0, normalizedObservedDamage - maxRoll)
      : Math.abs(median - normalizedObservedDamage),
    rangeDistance,
    maxHp: event.maxHp,
    crit: !!event.crit,
    ko,
    attackerBoosts: cloneBoostSnapshot(event.attackerBoosts),
    defenderBoosts: cloneBoostSnapshot(event.defenderBoosts),
    attackerStatus: event.attackerStatus || '',
    defenderStatus: event.defenderStatus || '',
    rollRange: [minRoll, maxRoll],
  };
};

// `getPokemonRawStat()`'s `spreadStats`/`serverStats` are pre-item numbers -- when the OTHER mon in a
// speed comparison is the auth player's own (fully known, not hypothesized) Pokemon, its real item's
// speed effect must still be applied, or a real Choice Scarf/Iron Ball on OUR side reads as a false
// speed contradiction on the CANDIDATE and produces a wrong modifier hypothesis (e.g. "Likely: Scarf"
// on the opponent when the true explanation was our own known Scarf all along)
const KnownItemSpeedMultiplier: Record<string, number> = {
  choicescarf: 1.5,
  ironball: 0.5,
  ...PokemonSpeedReductionItems.reduce((output, item) => {
    output[formatId(item)] = 0.5;

    return output;
  }, {} as Record<string, number>),
};

const knownItemSpeedMultiplier = (
  pokemon: CalcdexPokemon,
): number => KnownItemSpeedMultiplier[formatId(pokemon?.dirtyItem || pokemon?.item)] || 1;

const getPokemonRawStat = (
  pokemon: CalcdexPokemon,
  stat: Showdown.StatName,
): number => pokemon?.spreadStats?.[stat]
  || pokemon?.serverStats?.[stat]
  || (stat === 'hp' ? pokemon?.maxhp : null);

const applyStatBoost = (
  stat: number,
  boost = 0,
): number => {
  if (!Number.isFinite(stat)) {
    return null;
  }

  if (boost > 0) {
    return Math.floor((stat * (2 + boost)) / 2);
  }

  if (boost < 0) {
    return Math.floor((stat * 2) / (2 - boost));
  }

  return stat;
};

const applySpeedModifiers = (
  speed: number,
  boosts?: Partial<Showdown.StatsTableNoHp>,
  status?: Showdown.PokemonStatus | '',
  multiplier?: number,
): number => {
  let modified = applyStatBoost(speed, boosts?.spe || 0);

  if (status === 'par') {
    modified = Math.floor(modified / 2);
  }

  if (multiplier) {
    modified = Math.floor(modified * multiplier);
  }

  return modified;
};

const hasSpeedModifier = (
  boosts?: Partial<Showdown.StatsTableNoHp>,
  status?: Showdown.PokemonStatus | '',
): boolean => !!(boosts?.spe || status === 'par');

interface DamageEventContext {
  attackerMatch: ReturnType<typeof findPokemonByLogName>;
  defenderMatch: ReturnType<typeof findPokemonByLogName>;
  relation: EventRelation;
  influence: ReturnType<typeof getMoveInfluence>;
  relevantStats: Showdown.StatName[];
  eventField: CalcdexBattleField;
}

interface SpeedEventContext {
  relation: EventRelation;
  samePriority: boolean;
  otherRawSpe: number;
  otherItemSpeedMultiplier: number;
}

// everything below is invariant across the entire coordinate-descent search for a given defending
// Pokemon (the fuzzy roster lookups, move data/dex lookups, and field snapshot never depend on the
// candidate's nature/IVs/EVs) -- resolved once per event in searchBestCandidates() instead of on
// every one of the (up to thousands of) per-candidate evaluateCandidateEvent()/
// evaluateCandidateSpeedEvent() calls
const resolveDamageEventContext = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
): DamageEventContext => {
  const attackerMatch = findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
  const defenderMatch = findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId);
  const relation: EventRelation = attackerMatch?.pokemon?.calcdexId === candidatePokemon.calcdexId
    ? 'attacker'
    : defenderMatch?.pokemon?.calcdexId === candidatePokemon.calcdexId
      ? 'defender'
      : null;
  const influence = getMoveInfluence(state, event);
  const relevantStats = new Set<Showdown.StatName>();

  if (influence.offensiveStat && (
    (influence.offensivePokemon === 'source' && relation === 'attacker')
      || (influence.offensivePokemon === 'target' && relation === 'defender')
  )) {
    relevantStats.add(influence.offensiveStat);
  }

  if (influence.defensiveStat && (
    (influence.defensivePokemon === 'target' && relation === 'defender')
      || (influence.defensivePokemon === 'source' && relation === 'attacker')
  )) {
    relevantStats.add(influence.defensiveStat);
  }

  // the candidate's HP only changes the rolls when it's the one taking damage in a %-HP battle
  // (it normalizes the rolls into the same % space as the observed damage)
  if (state.rules?.hpPercentage && relation === 'defender') {
    relevantStats.add('hp');
  }

  if (influence.dependsOnSpeed) {
    relevantStats.add('spe');
  }

  return {
    attackerMatch,
    defenderMatch,
    relation,
    influence,
    relevantStats: StatNames.filter((stat) => relevantStats.has(stat)),
    eventField: applyEventFieldSnapshot(state.field, event.field),
  };
};

const resolveSpeedEventContext = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
): SpeedEventContext => {
  const fasterMove = getMoveData(state, event);
  const slowerMove = getGenDexForFormat(state.format)?.moves.get(formatId(event.slowerMoveName) as never) as { priority?: number; };
  const samePriority = (fasterMove?.priority || 0) === (slowerMove?.priority || 0);
  const fasterMatch = findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
  const slowerMatch = findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId);
  const relation: EventRelation = !fasterMatch?.pokemon || !slowerMatch?.pokemon
    ? null
    : fasterMatch.pokemon.calcdexId === candidatePokemon.calcdexId
      ? 'attacker'
      : slowerMatch.pokemon.calcdexId === candidatePokemon.calcdexId
        ? 'defender'
        : null;
  const otherPokemon = !samePriority || !relation
    ? null
    : relation === 'attacker'
      ? slowerMatch.pokemon
      : fasterMatch.pokemon;
  const otherRawSpe = otherPokemon ? getPokemonRawStat(otherPokemon, 'spe') : null;
  const otherItemSpeedMultiplier = knownItemSpeedMultiplier(otherPokemon);

  return {
    relation, samePriority, otherRawSpe, otherItemSpeedMultiplier,
  };
};

const evaluateCandidateSpeedEvent = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
  nature: Showdown.PokemonNature,
  ivs: Showdown.StatsTable,
  evs: Showdown.StatsTable,
  context: SpeedEventContext,
  modifierOverride?: ModifierOverride,
): number => {
  if (!context.samePriority) {
    return 0;
  }

  if (!context.relation || !context.otherRawSpe) {
    return 32;
  }

  const candidateSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature,
    ivs,
    evs,
  });
  const candidateRawSpe = candidateSpreadStats?.spe;

  if (!candidateRawSpe) {
    return 32;
  }

  const { relation, otherRawSpe, otherItemSpeedMultiplier } = context;
  // modifierOverride is a HYPOTHESIS applied only to the candidate; the other (known) mon's speed
  // instead uses its own real, already-revealed item (otherItemSpeedMultiplier) -- ignoring that (as
  // this used to) makes a real Scarf/Iron Ball on our own side look like a speed contradiction on the
  // candidate and produces a false modifier hypothesis for them instead
  const candidateSpeed = relation === 'attacker'
    ? applySpeedModifiers(candidateRawSpe, event.attackerBoosts, event.attackerStatus, modifierOverride?.speedMultiplier)
    : applySpeedModifiers(candidateRawSpe, event.defenderBoosts, event.defenderStatus, modifierOverride?.speedMultiplier);
  const otherSpeed = relation === 'attacker'
    ? applySpeedModifiers(otherRawSpe, event.defenderBoosts, event.defenderStatus, otherItemSpeedMultiplier)
    : applySpeedModifiers(otherRawSpe, event.attackerBoosts, event.attackerStatus, otherItemSpeedMultiplier);

  // Showdown breaks exact speed ties by coin flip, so moving first only requires >= (not strictly >)
  // the other mon's speed -- and moving second only requires <=. Treating equality as a violation
  // (the previous +1/-1) fabricates a contradiction whenever a mon is observed on both sides of a
  // true tie, which pushes the search away from the correct Spe instead of settling on it.
  if (relation === 'attacker') {
    return Math.max(0, otherSpeed - candidateSpeed);
  }

  return Math.max(0, candidateSpeed - otherSpeed);
};

const scoreCandidate = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  defender: CalcdexPokemon,
  nature: Showdown.PokemonNature,
  ivs: Showdown.StatsTable,
  evs: Showdown.StatsTable,
  damageContexts: Map<string, DamageEventContext>,
  speedContexts: Map<string, SpeedEventContext>,
  rollCache?: Map<string, number[]>,
  modifierOverride?: ModifierOverride,
): number => events.reduce((score, event) => {
  if (event.eventType === 'speed') {
    // speed is a one-sided constraint only: penalize candidates that contradict the observed turn
    // order (too slow when they moved first, too fast when they moved second). We deliberately do NOT
    // center Spe within the feasible range -- with a one-sided bound there is nothing to center on, and
    // doing so fabricates an inflated point estimate. Spe is surfaced as a bound in the UI instead.
    const boundDistance = evaluateCandidateSpeedEvent(state, event, defender, nature, ivs, evs, speedContexts.get(event.id), modifierOverride);
    const normalizedDistance = Math.min(32, boundDistance / 4);

    return score - (normalizedDistance * normalizedDistance + normalizedDistance);
  }

  const match = evaluateCandidateEvent(state, event, defender, nature, ivs, evs, damageContexts.get(event.id), rollCache, modifierOverride);
  const weight = event.crit ? 0.25 : 1;
  const rangeDistance = match?.rangeDistance ?? 8;
  const rangeCost = rangeDistance * rangeDistance + rangeDistance;

  // median-centering only discriminates *within* an already-feasible range (RangeInfeasibilityWeight
  // guarantees it can never outweigh a single unit of infeasibility) and is skipped entirely for KO
  // hits, whose truncated observation isn't a real target to center on
  const centerDistance = match?.ko ? 0 : (match?.distance ?? 0);
  const centerCost = centerDistance * centerDistance + centerDistance;

  return score - (((rangeCost * RangeInfeasibilityWeight) + centerCost) * weight);
}, 0);

const isInRangeMatch = (
  match: HackmonsDamageMatch,
): boolean => (
  !match?.error
    && !!match?.rollRange
    // a KO's observed damage is overkill-truncated at the defender's remaining HP, so any roll range
    // whose max covers the observation is a perfect fit -- only the upper bound applies
    && (match.ko || match.observedDamage >= match.rollRange[0])
    && match.observedDamage <= match.rollRange[1]
);

// tags a non-error match that missed the modeled roll range with *why*: observed damage above the
// modeled max points at an uninferred damage-boosting factor, below the modeled min at a
// damage-reducing one. This never blocks publishing the rest of the estimate -- it's groundwork for a
// later curated item/ability modifier search (deferred), not a search feature itself yet
const outlierDirection = (
  match: HackmonsDamageMatch,
): HackmonsDamageOutlier | null => {
  if (match?.error || !match?.rollRange) {
    return null;
  }

  if (match.observedDamage > match.rollRange[1]) {
    return 'too-high';
  }

  // a KO's observed damage is truncated at the defender's remaining HP, so landing under the modeled
  // min is expected (overkill), not evidence of a damage-reducing modifier
  if (!match.ko && match.observedDamage < match.rollRange[0]) {
    return 'too-low';
  }

  return null;
};

const extremalSpread = (
  format: string,
  stats: Showdown.StatName[],
  direction: 'high' | 'low',
): { nature: Showdown.PokemonNature; ivs: Showdown.StatsTable; evs: Showdown.StatsTable; } => {
  const ivs = blankSpread(DefaultIv);
  const evs = blankSpread(DefaultEv);

  stats.forEach((stat) => {
    ivs[stat] = direction === 'high' ? 31 : 0;
    evs[stat] = direction === 'high' ? 252 : 0;
  });

  if (stats.length !== 1) {
    return {
      nature: NeutralNature,
      ivs,
      evs,
    };
  }

  const [stat] = stats;
  const nature = PokemonNatures.find((candidateNature) => {
    const natureData = getGenDexForFormat(format)?.natures.get(formatId(candidateNature) as never) as {
      plus?: Showdown.StatNameNoHp;
      minus?: Showdown.StatNameNoHp;
    };

    return direction === 'high'
      ? natureData?.plus === stat
      : natureData?.minus === stat;
  }) || NeutralNature;

  return { nature, ivs, evs };
};

const evaluateExtremalFeasibility = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
  context: DamageEventContext,
  rollCache?: Map<string, number[]>,
  modifierOverride?: ModifierOverride,
): HackmonsExtremalFeasibility => {
  const stats = context.relevantStats.filter((stat) => stat !== 'hp') as Showdown.StatNameNoHp[];

  if (!stats.length || event.crit || event.eventType === 'speed') {
    return {};
  }

  const high = extremalSpread(state.format, stats, 'high');
  const low = extremalSpread(state.format, stats, 'low');
  const highMatch = evaluateCandidateEvent(
    state,
    event,
    candidatePokemon,
    high.nature,
    high.ivs,
    high.evs,
    context,
    rollCache,
    modifierOverride,
  );
  const lowMatch = evaluateCandidateEvent(
    state,
    event,
    candidatePokemon,
    low.nature,
    low.ivs,
    low.evs,
    context,
    rollCache,
    modifierOverride,
  );

  return {
    high: highMatch,
    low: lowMatch,
    highInfeasible: outlierDirection(highMatch) === 'too-high',
    lowInfeasible: !lowMatch?.ko && outlierDirection(lowMatch) === 'too-low',
  };
};

interface ModifierTrigger {
  event: HackmonsInferenceEvent;
  context: DamageEventContext;
  outlier: HackmonsDamageOutlier;
  feasibility: HackmonsExtremalFeasibility;
}

interface ModifierSearchResult {
  candidate: SpreadCandidate;
  matches: HackmonsDamageMatch[];
  inferredModifier: HackmonsInferredModifier;
  remainingOutliers: number;
  score: number;
}

const candidateAbilityPinned = (
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  contexts: Map<string, DamageEventContext>,
): boolean => events.some((event) => {
  const context = contexts.get(event.id);

  return (
    (context?.relation === 'attacker' && event.attackerSnapshot?.abilityConfirmed)
      || (context?.relation === 'defender' && event.defenderSnapshot?.abilityConfirmed)
  ) && !!candidatePokemon;
});

const candidateItemPinned = (
  candidatePokemon: CalcdexPokemon,
): boolean => !!formatId(candidatePokemon?.item);

// disqualifying evidence (extension, §11): Life Orb's `[from] item: Life Orb` recoil is unconditional
// on every hit except under Magic Guard/some Sheer Force interactions -- both rare, and abilities are
// usually unconfirmed in Hackmons, so this can't be a certainty check. If the candidate has ever
// landed an attacking hit and recoil never once showed up, reject the Life-Orb-shaped hypothesis
// outright (accepted false-negative risk on the rare exception abilities, documented in the spec)
const candidateRecoilObserved = (
  events: HackmonsInferenceEvent[],
  contexts: Map<string, DamageEventContext>,
): boolean => events.some((event) => (
  event.eventType !== 'speed'
    && contexts.get(event.id)?.relation === 'attacker'
    && !!event.recoilObserved
));

// disqualifying evidence (extension, §11): a Choice item locks the holder into repeating the same
// move until it switches out, so two DISTINCT moves observed while continuously active (same
// `attackerStint`) prove no Choice item is held, for the rest of the battle -- a per-mon fact, not
// per-event. V1 only checks DAMAGING moves (no non-damaging move-usage stream is threaded through
// the parser yet), so a status move used mid-lock isn't caught -- documented limitation.
const hasChoiceLockViolation = (
  events: HackmonsInferenceEvent[],
  contexts: Map<string, DamageEventContext>,
): boolean => {
  const movesByStint = new Map<number, Set<string>>();

  events.forEach((event) => {
    if (event.eventType === 'speed' || contexts.get(event.id)?.relation !== 'attacker') {
      return;
    }

    const stint = event.attackerStint ?? 0;
    const moves = movesByStint.get(stint) || new Set<string>();

    moves.add(formatId(event.moveName));
    movesByStint.set(stint, moves);
  });

  return [...movesByStint.values()].some((moves) => moves.size > 1);
};

const ChoiceModifierIds = new Set(['item-atk-1.5', 'item-spa-1.5', 'item-spe-1.5']);

// shared between the damage-side and speed-side hypothesis searches so an already-adopted modifier
// on one side (e.g. a damage-side item) isn't also offered as a speed-side item hypothesis -- a mon
// can only hold one item, though item + ability modifiers can coexist
const computePinnedSlots = (
  candidatePokemon: CalcdexPokemon,
  events: HackmonsInferenceEvent[],
  contexts: Map<string, DamageEventContext>,
  additionallyPinned?: HackmonsModifierSlot,
): Set<'item' | 'ability'> => {
  const pinned = new Set<'item' | 'ability'>();

  if (candidateItemPinned(candidatePokemon)) {
    pinned.add('item');
  }

  if (candidateAbilityPinned(events, candidatePokemon, contexts)) {
    pinned.add('ability');
  }

  if (additionallyPinned) {
    pinned.add(additionallyPinned);
  }

  return pinned;
};

const modifierClassesForTrigger = (
  state: CalcdexBattleState,
  trigger: ModifierTrigger,
  pinnedSlots: Set<'item' | 'ability'>,
): HackmonsModifierClass[] => {
  const { event, context, outlier } = trigger;
  const classes = new Set<string>();
  const add = (id: string) => {
    const modifier = modifierById(id);

    if (modifier && !pinnedSlots.has(modifier.slot)) {
      classes.add(modifier.id);
    }
  };

  if (context.relation === 'attacker' && outlier === 'too-high') {
    if (context.influence.offensiveStat === 'atk') {
      add('ability-atk-2');
      add('item-atk-1.5');
      add('item-both-1.3');
    }

    if (context.influence.offensiveStat === 'spa') {
      add('item-spa-1.5');
      add('item-both-1.3');
    }
  }

  if (context.relation === 'attacker' && outlier === 'too-low' && context.influence.offensiveStat === 'atk') {
    add('ability-atk-0.5');
  }

  if (context.relation === 'defender' && outlier === 'too-low') {
    if (context.influence.defensiveStat === 'def') {
      add('ability-def-2');
    }

    if (context.influence.defensiveStat === 'spd') {
      add('ability-special-taken-0.5');
      add('item-spd-1.5');
    }

    if (event.effectiveness === 'super') {
      add('ability-se-taken-0.75');
    }

    if (event.startHp === event.maxHp) {
      add('ability-full-hp-taken-0.5');
    }

    if (['Fire', 'Ice'].includes(getMoveData(state, event)?.type)) {
      add('ability-thickfat-fireice-0.5');
    }
  }

  return [...classes].map(modifierById).filter(Boolean);
};

const collectModifierTriggers = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  matches: HackmonsDamageMatch[],
  contexts: Map<string, DamageEventContext>,
  rollCache?: Map<string, number[]>,
): ModifierTrigger[] => events
  .filter((event) => event.eventType !== 'speed' && !event.crit)
  .map((event) => {
    const match = matches.find((candidateMatch) => candidateMatch?.eventId === event.id);
    const outlier = outlierDirection(match);
    const context = contexts.get(event.id);

    if (!outlier || match?.error || !context?.relation) {
      return null;
    }

    const feasibility = evaluateExtremalFeasibility(state, event, candidatePokemon, context, rollCache);

    if (
      (outlier === 'too-high' && !feasibility.highInfeasible)
        || (outlier === 'too-low' && !feasibility.lowInfeasible)
    ) {
      return null;
    }

    return {
      event,
      context,
      outlier,
      feasibility,
    };
  })
  .filter(Boolean);

interface JointConflictTrigger {
  offensiveStat: 'atk' | 'spa';
  outlierEvents: { event: HackmonsInferenceEvent; context: DamageEventContext; }[];
  inRangeEvents: { event: HackmonsInferenceEvent; context: DamageEventContext; }[];
}

// T2 (joint conflict, Group 3's signature): unlike T1, no single event here needs to be
// extremal-infeasible -- the signature is that the CURRENT best joint candidate already leaves some
// same-stat, same-relation events outlier-tagged while others of the same stat fit fine (Case C:
// Thunderbolt too-high, Water Pulse in-range, both ruled by the same SpA)
const collectJointConflictTriggers = (
  events: HackmonsInferenceEvent[],
  matches: HackmonsDamageMatch[],
  contexts: Map<string, DamageEventContext>,
): JointConflictTrigger[] => {
  const byStat = new Map<'atk' | 'spa', { event: HackmonsInferenceEvent; context: DamageEventContext; match: HackmonsDamageMatch; }[]>();

  events
    .filter((event) => event.eventType !== 'speed' && !event.crit)
    .forEach((event) => {
      const context = contexts.get(event.id);
      const match = matches.find((candidateMatch) => candidateMatch?.eventId === event.id);

      if (
        context?.relation !== 'attacker'
          || match?.error
          || !['atk', 'spa'].includes(context.influence.offensiveStat)
      ) {
        return;
      }

      const stat = context.influence.offensiveStat as 'atk' | 'spa';
      const list = byStat.get(stat) || [];

      list.push({ event, context, match });
      byStat.set(stat, list);
    });

  const triggers: JointConflictTrigger[] = [];

  byStat.forEach((list, offensiveStat) => {
    const outlierEvents = list
      .filter(({ match }) => outlierDirection(match) === 'too-high')
      .map(({ event, context }) => ({ event, context }));
    const inRangeEvents = list
      .filter(({ match }) => isInRangeMatch(match))
      .map(({ event, context }) => ({ event, context }));

    if (outlierEvents.length && inRangeEvents.length) {
      triggers.push({ offensiveStat, outlierEvents, inRangeEvents });
    }
  });

  return triggers;
};

// scope selection (§5): the boosted subset must share the scope dimension AND the unboosted subset
// must fall outside it -- Case C's "Electric scope fits, 'special moves' scope doesn't". Global
// classes are deliberately NOT proposed here (that's T1's job); A2's collateral check downstream is
// what actually rejects a global hypothesis if one gets proposed by T1 for the same events
const jointConflictModifierClasses = (
  state: CalcdexBattleState,
  candidatePokemon: CalcdexPokemon,
  trigger: JointConflictTrigger,
  pinnedSlots: Set<'item' | 'ability'>,
): HackmonsModifierClass[] => {
  const classes: HackmonsModifierClass[] = [];
  const outlierMoveTypes = new Set(trigger.outlierEvents.map(({ event }) => getMoveData(state, event)?.type).filter(Boolean));
  const inRangeMoveTypes = new Set(trigger.inRangeEvents.map(({ event }) => getMoveData(state, event)?.type).filter(Boolean));

  if (outlierMoveTypes.size === 1) {
    const [type] = [...outlierMoveTypes];

    if (!inRangeMoveTypes.has(type)) {
      if (!pinnedSlots.has('item') && TypeBoostItemByType[type]) {
        classes.push(itemTypeBoostClass(type));
      }

      if (!pinnedSlots.has('ability') && TypeBoostAbilityByType[type]) {
        classes.push(abilityTypeBoostClass(type));
      }
    }
  }

  if (!pinnedSlots.has('ability')) {
    const outlierAllStab = trigger.outlierEvents.every(({ event }) => isEventStabMove(state, event, candidatePokemon));
    const inRangeNoneStab = trigger.inRangeEvents.every(({ event }) => !isEventStabMove(state, event, candidatePokemon));

    if (outlierAllStab && inRangeNoneStab) {
      classes.push(AdaptabilityModifier);
    }
  }

  return classes;
};

const ParentalBondModifier: HackmonsModifierClass = {
  id: 'ability-parental-bond',
  slot: 'ability',
  scope: 'extra-hit',
  multiplier: 1.25,
  representative: 'Parental Bond',
  examples: ['Parental Bond'],
};

// Parental Bond's second hit is 25% power in gen 9; allow for roll variance on BOTH hits
// independently (each rolls ~85-100% of its own max) rather than requiring an exact 0.25 ratio
const ParentalBondSecondHitRatioRange: [number, number] = [0.15, 0.35];

interface ParentalBondTrigger {
  event: HackmonsInferenceEvent;
  context: DamageEventContext;
}

// direct hit-shape evidence (extension, §11), independent of outlier magnitude -- Showdown's own log
// marks Parental Bond's extra hit with a `-hitcount|...|2` line, same as any real dex multi-hit move
// (Double Kick, Bullet Seed, ...), so `multiHit`/`hits` alone can't distinguish it -- the naive
// "2 equal-power hits" assumption `evaluateCandidateEvent()` otherwise applies would silently produce
// a plausible-looking but WRONG (low) Atk/SpA fit with no outlier warning at all. The distinguishing
// signature is the RATIO: a real 2-hit move's hits are roughly equal, Parental Bond's second is ~25%
// of the first -- near-impossible for an equal-power move to land by chance.
const collectParentalBondTriggers = (
  events: HackmonsInferenceEvent[],
  contexts: Map<string, DamageEventContext>,
): ParentalBondTrigger[] => events
  .filter((event) => (
    event.eventType !== 'speed'
      && !event.crit
      && event.hitDamages?.length === 2
      && contexts.get(event.id)?.relation === 'attacker'
  ))
  .filter((event) => {
    const [first, second] = event.hitDamages;

    if (!first) {
      return false;
    }

    const ratio = second / first;

    return ratio >= ParentalBondSecondHitRatioRange[0] && ratio <= ParentalBondSecondHitRatioRange[1];
  })
  .map((event) => ({ event, context: contexts.get(event.id) }));

const parentalBondModifierClasses = (
  pinnedSlots: Set<'item' | 'ability'>,
): HackmonsModifierClass[] => (pinnedSlots.has('ability') ? [] : [ParentalBondModifier]);

const evaluatePublishedMatches = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  candidate: SpreadCandidate,
  contexts: Map<string, DamageEventContext>,
  rollCache?: Map<string, number[]>,
  modifierOverride?: ModifierOverride,
): HackmonsDamageMatch[] => events
  .filter((event) => event.eventType !== 'speed')
  .map((event) => {
    const context = contexts.get(event.id) || resolveDamageEventContext(state, event, candidatePokemon);
    const match = evaluateCandidateEvent(
      state,
      event,
      candidatePokemon,
      candidate.nature,
      candidate.ivs,
      candidate.evs,
      context,
      rollCache,
      modifierOverride,
    );

    return { ...match, outlier: outlierDirection(match) };
  });

const searchModifierHypotheses = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  phaseOneMatches: HackmonsDamageMatch[],
  phaseOneContexts: Map<string, DamageEventContext>,
  triggers: ModifierTrigger[],
  jointConflictTriggers: JointConflictTrigger[],
  parentalBondTriggers: ParentalBondTrigger[],
  rollCache?: Map<string, number[]>,
): { adopted?: ModifierSearchResult; possible: HackmonsInferredModifier[]; } => {
  if (!triggers.length && !jointConflictTriggers.length && !parentalBondTriggers.length) {
    return { possible: [] };
  }

  const pinnedSlots = computePinnedSlots(candidatePokemon, events, phaseOneContexts);

  const hypotheses = new Map<string, HackmonsModifierClass>();

  triggers.forEach((trigger) => {
    modifierClassesForTrigger(state, trigger, pinnedSlots)
      .forEach((modifier) => hypotheses.set(modifier.id, modifier));
  });

  // T2 (Group 3, scoped): scope-selection classes are screened/adopted through the SAME pipeline as
  // T1's global classes below -- A2's collateral check is what discriminates a correctly-scoped
  // hypothesis from an incorrectly-global one, not the trigger source
  jointConflictTriggers.forEach((trigger) => {
    jointConflictModifierClasses(state, candidatePokemon, trigger, pinnedSlots)
      .forEach((modifier) => hypotheses.set(modifier.id, modifier));
  });

  // Parental Bond: direct hit-shape evidence, not outlier-magnitude based -- proposed whenever the
  // trigger fires at all, independent of whether phase 1 flagged anything as an outlier
  if (parentalBondTriggers.length) {
    parentalBondModifierClasses(pinnedSlots)
      .forEach((modifier) => hypotheses.set(modifier.id, modifier));
  }

  if (!hypotheses.size) {
    return { possible: [] };
  }

  const allTriggers: ModifierTrigger[] = [
    ...triggers,
    ...jointConflictTriggers.flatMap((trigger) => trigger.outlierEvents.map(({ event, context }) => ({
      event,
      context,
      outlier: 'too-high' as HackmonsDamageOutlier,
      feasibility: {} as HackmonsExtremalFeasibility,
    }))),
    ...parentalBondTriggers.map(({ event, context }) => ({
      event,
      context,
      outlier: 'too-high' as HackmonsDamageOutlier,
      feasibility: {} as HackmonsExtremalFeasibility,
    })),
  ];

  const phaseOneInRangeIds = new Set(phaseOneMatches.filter(isInRangeMatch).map((match) => match.eventId));
  const phaseOneOutlierIds = new Set(phaseOneMatches.filter((match) => !!match?.outlier).map((match) => match.eventId));
  const evaluated: ModifierSearchResult[] = [];
  const possible: HackmonsInferredModifier[] = [];

  // disqualifying evidence (extension, §11): computed once per mon rather than per-hypothesis, since
  // both are per-mon facts (not tied to any one event's support)
  const recoilDisqualifiesLifeOrb = !candidateRecoilObserved(events, phaseOneContexts);
  const choiceLockDisqualified = hasChoiceLockViolation(events, phaseOneContexts);

  [...hypotheses.values()].forEach((modifier) => {
    if (
      (modifier.id === 'item-both-1.3' && recoilDisqualifiesLifeOrb)
        || (ChoiceModifierIds.has(modifier.id) && choiceLockDisqualified)
    ) {
      return;
    }

    const modifierOverride = modifierOverrideFromClass(modifier);
    // eslint-disable-next-line no-use-before-define
    const candidates = searchBestCandidates(state, events, candidatePokemon, rollCache, modifierOverride);
    const [candidate] = candidates;

    if (!candidate) {
      return;
    }

    const matches = evaluatePublishedMatches(
      state,
      events,
      candidatePokemon,
      candidate,
      phaseOneContexts,
      rollCache,
      modifierOverride,
    );
    const supportIds = allTriggers
      .filter((trigger) => {
        const match = matches.find((candidateMatch) => candidateMatch?.eventId === trigger.event.id);

        return isInRangeMatch(match);
      })
      .map((trigger) => trigger.event.id);
    const collateral = matches.some((match) => phaseOneInRangeIds.has(match?.eventId) && !!match?.outlier);
    const remainingOutliers = matches.filter((match) => !!match?.outlier).length;
    const eliminatedOutliers = [...phaseOneOutlierIds].filter((id) => supportIds.includes(id)).length;
    const relation = allTriggers.find((trigger) => supportIds.includes(trigger.event.id))?.context.relation || allTriggers[0]?.context.relation;
    const inferredModifier: HackmonsInferredModifier = {
      modifier,
      adopted: false,
      relation,
      supportingEventIds: supportIds,
    };

    // A1 (feasibility-only adoption) assumes outlier-magnitude evidence -- Parental Bond's hit-SHAPE
    // evidence is direct and doesn't need an outlier to already exist (the shape is proof on its own)
    const requiresEliminatedOutlier = modifier.id !== 'ability-parental-bond';

    if (!supportIds.length || collateral || (requiresEliminatedOutlier && !eliminatedOutliers)) {
      return;
    }

    if (supportIds.length < 2) {
      possible.push(inferredModifier);
      return;
    }

    evaluated.push({
      candidate: {
        ...candidate,
        score: candidate.score - ModifierComplexityPenalty,
      },
      matches,
      inferredModifier: {
        ...inferredModifier,
        adopted: true,
      },
      remainingOutliers,
      score: candidate.score - ModifierComplexityPenalty,
    });
  });

  const adopted = evaluated
    .sort((a, b) => (
      a.remainingOutliers - b.remainingOutliers
        || b.inferredModifier.supportingEventIds.length - a.inferredModifier.supportingEventIds.length
        || b.score - a.score
    ))[0];

  return { adopted, possible: adopted ? [] : possible };
};

interface SpeedTrigger {
  // 'faster' -- the candidate is observed outrunning something even its fastest possible spread
  // couldn't reach (Scarf-class boost); 'slower' -- observed being outrun by something even its
  // slowest possible spread should have beaten (Iron Ball-class reduction)
  direction: 'faster' | 'slower';
  contributingEventIds: string[];
}

// T3: the tightest speed-order evidence is unsatisfiable at the candidate's own extremal Spe spread
// -- checked directly against evaluateCandidateSpeedEvent() rather than describeSpeedBound()'s
// human-readable bound, since that's the same one-sided-violation check the search itself uses
const collectSpeedTrigger = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  speedContexts: Map<string, SpeedEventContext>,
): SpeedTrigger | null => {
  const speedEvents = events.filter((event) => event.eventType === 'speed' && !event.speedOrderSuppressed);

  if (!speedEvents.length) {
    return null;
  }

  const high = extremalSpread(state.format, ['spe'], 'high');
  const low = extremalSpread(state.format, ['spe'], 'low');

  const fasterInfeasible = speedEvents.filter((event) => {
    const context = speedContexts.get(event.id);

    return context?.relation === 'attacker'
      && evaluateCandidateSpeedEvent(state, event, candidatePokemon, high.nature, high.ivs, high.evs, context) > 0;
  });

  if (fasterInfeasible.length) {
    return { direction: 'faster', contributingEventIds: fasterInfeasible.map((event) => event.id) };
  }

  const slowerInfeasible = speedEvents.filter((event) => {
    const context = speedContexts.get(event.id);

    return context?.relation === 'defender'
      && evaluateCandidateSpeedEvent(state, event, candidatePokemon, low.nature, low.ivs, low.evs, context) > 0;
  });

  if (slowerInfeasible.length) {
    return { direction: 'slower', contributingEventIds: slowerInfeasible.map((event) => event.id) };
  }

  return null;
};

const speedModifierClassesForTrigger = (
  trigger: SpeedTrigger,
  pinnedSlots: Set<'item' | 'ability'>,
): HackmonsModifierClass[] => (
  trigger.direction === 'faster' ? ['item-spe-1.5'] : ['item-spe-0.5', 'ability-spe-0.5']
)
  .map(modifierById)
  .filter((modifier) => modifier && !pinnedSlots.has(modifier.slot));

interface SpeedModifierSearchResult {
  candidate: SpreadCandidate;
  inferredModifier: HackmonsInferredModifier;
  score: number;
}

// mirrors searchModifierHypotheses()'s screen-then-adopt shape (A1-A5), specialized for T3: at most
// one speed direction can be contradicted at a time, so there's no multi-trigger merge step, just a
// straight best-of over the 1-2 classes the direction implies
const searchSpeedModifierHypothesis = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  phaseOneMatches: HackmonsDamageMatch[],
  damageContexts: Map<string, DamageEventContext>,
  speedContexts: Map<string, SpeedEventContext>,
  trigger: SpeedTrigger,
  pinnedSlots: Set<'item' | 'ability'>,
  baseOverride: ModifierOverride | undefined,
  rollCache?: Map<string, number[]>,
): { adopted?: SpeedModifierSearchResult; possible: HackmonsInferredModifier[]; } => {
  const classes = speedModifierClassesForTrigger(trigger, pinnedSlots);

  if (!classes.length) {
    return { possible: [] };
  }

  const speedEvents = events.filter((event) => event.eventType === 'speed' && !event.speedOrderSuppressed);
  const phaseOneInRangeIds = new Set(phaseOneMatches.filter(isInRangeMatch).map((match) => match.eventId));
  const evaluated: SpeedModifierSearchResult[] = [];
  const possible: HackmonsInferredModifier[] = [];
  const choiceLockDisqualified = hasChoiceLockViolation(events, damageContexts);

  classes.forEach((modifier) => {
    if (ChoiceModifierIds.has(modifier.id) && choiceLockDisqualified) {
      return;
    }

    const modifierOverride = mergeModifierOverrides(baseOverride, modifierOverrideFromClass(modifier));
    // eslint-disable-next-line no-use-before-define
    const [candidate] = searchBestCandidates(state, events, candidatePokemon, rollCache, modifierOverride);

    if (!candidate) {
      return;
    }

    // A1/A2: adoption must actually eliminate the contradiction, and must not introduce a NEW
    // speed-bound violation anywhere else
    const remainingSpeedViolations = speedEvents.filter((event) => {
      const context = speedContexts.get(event.id);

      return evaluateCandidateSpeedEvent(state, event, candidatePokemon, candidate.nature, candidate.ivs, candidate.evs, context, modifierOverride) > 0;
    }).length;

    if (remainingSpeedViolations) {
      return;
    }

    // A2 (damage side): a speed-dependent move's (Electro Ball/Gyro Ball) roll range shifts with the
    // candidate's now-modified Spe -- reject if that pushes a previously in-range damage event out
    const damageMatches = evaluatePublishedMatches(state, events, candidatePokemon, candidate, damageContexts, rollCache, modifierOverride);
    const collateral = damageMatches.some((match) => phaseOneInRangeIds.has(match?.eventId) && !!match?.outlier);

    if (collateral) {
      return;
    }

    const inferredModifier: HackmonsInferredModifier = {
      modifier,
      adopted: false,
      relation: trigger.direction === 'faster' ? 'attacker' : 'defender',
      supportingEventIds: trigger.contributingEventIds,
    };

    // A3: support threshold -- v1 has no speed-side corroboration source, so require >= 2 raw events
    if (trigger.contributingEventIds.length < 2) {
      possible.push(inferredModifier);
      return;
    }

    evaluated.push({
      candidate: { ...candidate, score: candidate.score - ModifierComplexityPenalty },
      inferredModifier: { ...inferredModifier, adopted: true },
      score: candidate.score - ModifierComplexityPenalty,
    });
  });

  // A4: parsimony -- fewest/simplest modifier wins on a tie
  const adopted = evaluated.sort((a, b) => b.score - a.score)[0];

  return { adopted, possible: adopted ? [] : possible };
};

const eventSnapshotSignature = (
  event: HackmonsInferenceEvent,
): string => JSON.stringify({
  field: event.field,
  attacker: event.attackerSnapshot,
  defender: event.defenderSnapshot,
});

// confidence reflects how much observed damage the estimate actually reproduces (i.e. how many
// distinct damage events fall within the modeled roll range), not the separation between two nearly
// identical candidate spreads (which is ~0 and would pin confidence to 'low' forever)
const confidenceFromMatches = (
  matches: HackmonsDamageMatch[],
): HackmonsInferenceState['estimate']['confidence'] => {
  const inRange = matches.filter(isInRangeMatch).length;

  if (inRange >= 3) {
    return 'high';
  }

  if (inRange >= 2) {
    return 'medium';
  }

  return 'low';
};

interface SpreadCandidate {
  nature: Showdown.PokemonNature;
  ivs: Showdown.StatsTable;
  evs: Showdown.StatsTable;
  score: number;
}

type EventRelation = 'attacker' | 'defender' | null;
type SearchStat = Showdown.StatNameNoHp | 'hp';

const cloneSpread = (spread: Showdown.StatsTable): Showdown.StatsTable => ({ ...spread });

const candidateKey = (
  candidate: SpreadCandidate,
): string => [
  candidate.nature,
  ...StatNames.map((stat) => candidate.ivs[stat]),
  ...StatNames.map((stat) => candidate.evs[stat]),
].join(':');

const scoreSpreadCandidate = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  nature: Showdown.PokemonNature,
  ivs: Showdown.StatsTable,
  evs: Showdown.StatsTable,
  damageContexts: Map<string, DamageEventContext>,
  speedContexts: Map<string, SpeedEventContext>,
  rollCache?: Map<string, number[]>,
  modifierOverride?: ModifierOverride,
): SpreadCandidate => ({
  nature,
  ivs: cloneSpread(ivs),
  evs: cloneSpread(evs),
  score: scoreCandidate(state, events, candidatePokemon, nature, ivs, evs, damageContexts, speedContexts, rollCache, modifierOverride),
});

const determineSearchStats = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
): SearchStat[] => {
  const stats = new Set<SearchStat>();

  events.forEach((event) => {
    if (event.eventType === 'speed') {
      stats.add('spe');
      return;
    }

    const influence = getMoveInfluence(state, event);
    const relation = resolveEventRelation(state, event, candidatePokemon);

    if (relation === 'attacker' && influence.offensivePokemon === 'source' && influence.offensiveStat) {
      stats.add(influence.offensiveStat);
    }

    if (relation === 'defender' && influence.offensivePokemon === 'target' && influence.offensiveStat) {
      stats.add(influence.offensiveStat);
    }

    if (relation === 'attacker' && influence.defensivePokemon === 'source' && influence.defensiveStat) {
      stats.add('hp');
      stats.add(influence.defensiveStat);
    }

    if (relation === 'defender' && influence.defensivePokemon === 'target' && influence.defensiveStat) {
      stats.add('hp');
      stats.add(influence.defensiveStat);
    }

    if (influence.dependsOnSpeed) {
      stats.add('spe');
    }
  });

  return [...stats];
};

const selectScoringEvents = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
): HackmonsInferenceEvent[] => {
  const damageEvents = events.filter((event) => event.eventType !== 'speed');
  const speed = events.filter((event) => event.eventType === 'speed').slice(-MaxScoredEventsPerCategory);
  const physical = damageEvents.filter((event) => getMoveInfluence(state, event).defensiveStat === 'def').slice(-MaxScoredEventsPerCategory);
  const special = damageEvents.filter((event) => getMoveInfluence(state, event).defensiveStat === 'spd').slice(-MaxScoredEventsPerCategory);
  const selected = new Map<string, HackmonsInferenceEvent>();

  [...physical, ...special, ...speed].forEach((event) => selected.set(event.id, event));

  if (!selected.size) {
    damageEvents.slice(-MaxScoredEventsPerCategory).forEach((event) => selected.set(event.id, event));
  }

  return [...selected.values()].sort((a, b) => a.turn - b.turn);
};

function searchBestCandidates(
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  rollCache?: Map<string, number[]>,
  modifierOverride?: ModifierOverride,
): SpreadCandidate[] {
  const scoringEvents = selectScoringEvents(state, events);
  const searchStats = determineSearchStats(state, scoringEvents, candidatePokemon);

  // event-level lookups/dex data are invariant across the entire search (only nature/IVs/EVs change
  // between candidates), so they're resolved once here rather than on every per-candidate
  // evaluateCandidateEvent()/evaluateCandidateSpeedEvent() call below
  const damageContexts = new Map<string, DamageEventContext>();
  const speedContexts = new Map<string, SpeedEventContext>();

  scoringEvents.forEach((event) => {
    if (event.eventType === 'speed') {
      speedContexts.set(event.id, resolveSpeedEventContext(state, event, candidatePokemon));
    } else {
      damageContexts.set(event.id, resolveDamageEventContext(state, event, candidatePokemon));
    }
  });

  const score = (
    nature: Showdown.PokemonNature,
    ivs: Showdown.StatsTable,
    evs: Showdown.StatsTable,
  ): SpreadCandidate => scoreSpreadCandidate(
    state,
    scoringEvents,
    candidatePokemon,
    nature,
    ivs,
    evs,
    damageContexts,
    speedContexts,
    rollCache,
    modifierOverride,
  );

  const baseIvs = blankSpread(DefaultIv);
  const baseEvs = blankSpread(DefaultEv);

  let best = score(NeutralNature, baseIvs, baseEvs);

  const seen = new Map<string, SpreadCandidate>();
  let exhausted = false;
  const remember = (candidate: SpreadCandidate) => {
    if (seen.size >= MaxCandidateCount) {
      exhausted = true;
      return;
    }

    seen.set(candidateKey(candidate), candidate);

    if (candidate.score > best.score) {
      best = candidate;
    }
  };

  remember(best);

  PokemonNatures.forEach((nature) => remember(score(nature, best.ivs, best.evs)));

  for (let pass = 0; pass < 3 && !exhausted; pass++) {
    for (const stat of searchStats) {
      for (const iv of CandidateIvs) {
        for (const ev of CoordinateCandidateEvs) {
          if (exhausted) {
            break;
          }

          remember(score(best.nature, { ...best.ivs, [stat]: iv }, { ...best.evs, [stat]: ev }));
        }
      }

      for (const nature of PokemonNatures) {
        remember(score(nature, best.ivs, best.evs));
      }
    }
  }

  const coarseBest = best;
  let refinedBest = coarseBest;

  for (let pass = 0; pass < 2 && !exhausted; pass++) {
    for (const stat of searchStats) {
      const currentEv = refinedBest.evs[stat] ?? DefaultEv;
      const minEv = Math.max(0, currentEv - 24);
      const maxEv = Math.min(252, currentEv + 24);

      for (const iv of CandidateIvs) {
        // step by 4 EVs: a stat only changes every 4 EVs (Math.floor(ev / 4)), so this covers every
        // distinct stat value in the +/-24 window without re-scoring identical spreads
        for (let ev = minEv; ev <= maxEv; ev += 4) {
          if (exhausted) {
            break;
          }

          remember(score(refinedBest.nature, { ...refinedBest.ivs, [stat]: iv }, { ...refinedBest.evs, [stat]: ev }));
        }
      }

      refinedBest = best;

      if (exhausted) {
        break;
      }
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}

interface SpeedObservation {
  relation: 'attacker' | 'defender';
  otherName: string;
  bound: number | null;
  label: string;
}

// turns the candidate mon's speed-order events into human-readable bounds, e.g. "Outsped Vaporeon
// (Spe >= 167)". A numeric bound is only shown when the *other* mon is the viewing player's own
// Pokemon (so its Spe is actually known); same-priority is required or the order isn't speed-based
const describeSpeedBound = (
  state: CalcdexBattleState,
  candidatePokemon: CalcdexPokemon,
  speedEvents: HackmonsInferenceEvent[],
  adoptedSpeedModifier?: HackmonsModifierClass,
): string[] => {
  const observations: SpeedObservation[] = [];

  speedEvents.forEach((event) => {
    const fasterMove = getMoveData(state, event);
    const slowerMove = getGenDexForFormat(state.format)?.moves.get(formatId(event.slowerMoveName) as never) as { priority?: number; };

    if ((fasterMove?.priority || 0) !== (slowerMove?.priority || 0)) {
      return;
    }

    const relation = resolveEventRelation(state, event, candidatePokemon);

    if (!relation) {
      return;
    }

    // in a speed event the attacker is the faster mon, the defender is the slower mon
    const otherName = relation === 'attacker' ? event.defenderName : event.attackerName;
    const otherMatch = relation === 'attacker'
      ? findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId)
      : findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
    const otherRawSpe = otherMatch?.playerKey === state.authPlayerKey
      ? getPokemonRawStat(otherMatch.pokemon, 'spe')
      : null;
    const otherBoosts = relation === 'attacker' ? event.defenderBoosts : event.attackerBoosts;
    const otherStatus = relation === 'attacker' ? event.defenderStatus : event.attackerStatus;
    const candidateBoosts = relation === 'attacker' ? event.attackerBoosts : event.defenderBoosts;
    const candidateStatus = relation === 'attacker' ? event.attackerStatus : event.defenderStatus;
    const otherItemSpeedMultiplier = knownItemSpeedMultiplier(otherMatch?.pokemon);
    const otherModifiedSpe = otherRawSpe
      ? applySpeedModifiers(otherRawSpe, otherBoosts, otherStatus, otherItemSpeedMultiplier)
      : null;
    const speedLabel = hasSpeedModifier(otherBoosts, otherStatus)
      || hasSpeedModifier(candidateBoosts, candidateStatus)
      || otherItemSpeedMultiplier !== 1
      ? 'modified Spe'
      : 'Spe';

    observations.push({
      relation,
      otherName: otherName || 'opponent',
      bound: otherModifiedSpe,
      label: speedLabel,
    });
  });

  if (!observations.length) {
    return [];
  }

  // every numeric observation constrains the SAME candidate's Spe, so collapse each direction down
  // to its single tightest bound instead of emitting one (often redundant, sometimes duplicate-looking
  // but differently-worded) note per event -- e.g. multiple "outsped Vaporeon" events at different
  // boost states should surface only the highest resulting lower bound, not all of them
  const lowerBounds = observations.filter((o) => o.relation === 'attacker' && o.bound != null);
  const upperBounds = observations.filter((o) => o.relation === 'defender' && o.bound != null);
  const nonNumeric = observations.filter((o) => o.bound == null);

  const notes: string[] = [];

  // "raw" here means pre-item/ability -- the modified bound is what was actually observed, the raw
  // one is what the candidate's true (unmodified) Spe stat must be to produce it
  const rawAnnotation = (bound: number): string => (
    adoptedSpeedModifier
      ? ` (×${adoptedSpeedModifier.multiplier} ${adoptedSpeedModifier.slot} assumed → raw ${adoptedSpeedModifier.multiplier > 1 ? '≥' : '≤'} ${Math.round(bound / adoptedSpeedModifier.multiplier)})`
      : ''
  );

  if (lowerBounds.length) {
    const tightest = lowerBounds.reduce((best, o) => (o.bound > best.bound ? o : best));
    const annotation = adoptedSpeedModifier?.multiplier > 1 ? rawAnnotation(tightest.bound) : '';

    notes.push(`Outsped ${tightest.otherName} (${tightest.label} ≥ ${tightest.bound})${annotation}`);
  }

  if (upperBounds.length) {
    const tightest = upperBounds.reduce((best, o) => (o.bound < best.bound ? o : best));
    const annotation = adoptedSpeedModifier?.multiplier < 1 ? rawAnnotation(tightest.bound) : '';

    notes.push(`Outsped by ${tightest.otherName} (${tightest.label} ≤ ${tightest.bound})${annotation}`);
  }

  const seenNonNumeric = new Set<string>();

  nonNumeric.forEach((o) => {
    const note = `${o.relation === 'attacker' ? 'Outsped' : 'Outsped by'} ${o.otherName}`;

    if (!seenNonNumeric.has(note)) {
      seenNonNumeric.add(note);
      notes.push(note);
    }
  });

  return notes;
};

export const inferHackmonsSpread = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  ignoredEventCount: number,
): HackmonsInferenceMap => {
  if (!formatId(state?.format).includes('hackmons')) {
    return {};
  }

  // seed every currently-revealed opponent Pokemon with a blank (zero-event) entry, independent of
  // whether it has any events yet -- this is what lets the Estimated Spread UI show an immediate
  // neutral-prior baseline (default IV/EV/nature, no assumptions) at the start of a battle or right
  // after a reload, instead of nothing at all. Presets Calcdex suggests elsewhere are usually
  // meaningless for Hackmons Cup's random sets, so an explicit "nothing observed yet" from this
  // feature is more honest than leaving that slot blank.
  const grouped = (state[state.opponentKey]?.pokemon || [])
    .filter((pokemon) => !!pokemon?.speciesForme && !!pokemon?.calcdexId)
    .reduce((output, pokemon) => {
      output[pokemon.calcdexId] = [];

      return output;
    }, {} as Record<string, HackmonsInferenceEvent[]>);

  events.forEach((event) => {
    const attackerMatch = findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
    const defenderMatch = findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId);
    const related = [attackerMatch, defenderMatch]
      .filter((match) => match?.playerKey === state.opponentKey && !!match?.pokemon?.calcdexId);

    related.forEach((match) => {
      const id = match.pokemon.calcdexId;
      grouped[id] = [...(grouped[id] || []), event];
    });
  });

  const inference = Object.entries(grouped).reduce((output, [calcdexId, candidateEvents]) => {
    const candidateMatch = ['p1', 'p2', 'p3', 'p4'].flatMap((key: CalcdexPlayerKey) => state[key]?.pokemon || [])
      .find((pokemon) => pokemon.calcdexId === calcdexId);

    if (!candidateMatch) {
      return output;
    }

    // per-mon memoization: only re-run the (expensive) search when *this* mon's events change, so
    // appending a battle log step doesn't recompute every opponent Pokemon from scratch each sync
    const signature = candidateEvents
      .map((event) => `${event.id}:${event.damage || ''}:${event.maxHp || ''}:${eventSnapshotSignature(event)}`)
      .join(';');

    // the key must ALSO capture the calc-relevant identity of every mon the events resolve to: right
    // after a reload, a historical attacker/defender can resolve to a client-sourced roster entry
    // that's missing its server-known item/ability (neither appears in the replayed log without an
    // explicit reveal line), so the evaluation SUCCEEDS but models a plain neutral attacker (e.g. a
    // Choice Band + Huge Power Waterfall at ~1/3 of its real damage). Keyed on events alone, that
    // poisoned result would be pinned forever once cached -- the events never change just because
    // `myPokemon` finishes repopulating a tick later. Folding each participant's ability/item/source
    // in makes the key change when the roster data completes, so the next sync re-searches with it
    const participantTriples: Record<string, { logName: string; playerKey: CalcdexPlayerKey; logId: string; }> = {};

    candidateEvents.forEach((event) => {
      participantTriples[`${event.attackerKey || ''}:${event.attackerId || ''}:${event.attackerName || ''}`] = {
        logName: event.attackerName,
        playerKey: event.attackerKey,
        logId: event.attackerId,
      };
      participantTriples[`${event.defenderKey || ''}:${event.defenderId || ''}:${event.defenderName || ''}`] = {
        logName: event.defenderName,
        playerKey: event.defenderKey,
        logId: event.defenderId,
      };
    });

    const participantSignature = Object.values(participantTriples)
      .map(({ logName, playerKey, logId }) => {
        const participant = findPokemonByLogName(state, logName, playerKey, logId)?.pokemon;

        return participant
          ? [
            participant.calcdexId,
            formatId(participant.dirtyAbility || participant.ability),
            formatId(participant.dirtyItem || participant.item),
            participant.source || '',
          ].join('~')
          : 'unresolved';
      })
      .join(';');

    const monCacheKey = [state.battleId, state.format, CacheVersion, calcdexId, signature, participantSignature].join('|');
    const cachedState = InferenceCache.get(monCacheKey);

    if (cachedState) {
      output[calcdexId] = cachedState.ignoredEventCount === ignoredEventCount
        ? cachedState
        : { ...cachedState, ignoredEventCount };

      return output;
    }

    // damage rolls are memoized for the duration of this one mon's search (and reused below for the
    // winning candidate's published matches), keyed on the candidate stats that feed each calc
    const rollCache = new Map<string, number[]>();
    const candidates = searchBestCandidates(state, candidateEvents, candidateMatch, rollCache);

    const damageContexts = new Map<string, DamageEventContext>();

    candidateEvents
      .filter((event) => event.eventType !== 'speed')
      .forEach((event) => damageContexts.set(event.id, resolveDamageEventContext(state, event, candidateMatch)));

    const [phaseOneBest] = candidates;
    const phaseOneMatches = phaseOneBest ? evaluatePublishedMatches(
      state,
      candidateEvents,
      candidateMatch,
      phaseOneBest,
      damageContexts,
      rollCache,
    ) : [];
    const triggers = phaseOneBest && candidateEvents.length
      ? collectModifierTriggers(state, candidateEvents, candidateMatch, phaseOneMatches, damageContexts, rollCache)
      : [];
    const jointConflictTriggers = phaseOneBest && candidateEvents.length
      ? collectJointConflictTriggers(candidateEvents, phaseOneMatches, damageContexts)
      : [];
    const parentalBondTriggers = phaseOneBest && candidateEvents.length
      ? collectParentalBondTriggers(candidateEvents, damageContexts)
      : [];
    const modifierSearch = (triggers.length || jointConflictTriggers.length || parentalBondTriggers.length)
      ? searchModifierHypotheses(
        state,
        candidateEvents,
        candidateMatch,
        phaseOneMatches,
        damageContexts,
        triggers,
        jointConflictTriggers,
        parentalBondTriggers,
        rollCache,
      )
      : { possible: [] };
    const adoptedModifier = modifierSearch.adopted;

    const speedContexts = new Map<string, SpeedEventContext>();

    candidateEvents
      .filter((event) => event.eventType === 'speed')
      .forEach((event) => speedContexts.set(event.id, resolveSpeedEventContext(state, event, candidateMatch)));

    const speedTrigger = collectSpeedTrigger(state, candidateEvents, candidateMatch, speedContexts);
    const speedPinnedSlots = computePinnedSlots(
      candidateMatch,
      candidateEvents,
      damageContexts,
      adoptedModifier?.inferredModifier.modifier.slot,
    );
    const speedSearch = speedTrigger
      ? searchSpeedModifierHypothesis(
        state,
        candidateEvents,
        candidateMatch,
        phaseOneMatches,
        damageContexts,
        speedContexts,
        speedTrigger,
        speedPinnedSlots,
        adoptedModifier ? modifierOverrideFromClass(adoptedModifier.inferredModifier.modifier) : undefined,
        rollCache,
      )
      : { possible: [] };
    const adoptedSpeedModifier = speedSearch.adopted;

    const best = adoptedSpeedModifier?.candidate || adoptedModifier?.candidate || phaseOneBest;
    const adoptedSupportIds = new Set(adoptedModifier?.inferredModifier.supportingEventIds || []);
    const inferredModifiers = [
      ...(adoptedModifier ? [adoptedModifier.inferredModifier] : []),
      ...(adoptedSpeedModifier ? [adoptedSpeedModifier.inferredModifier] : []),
      ...modifierSearch.possible,
      ...speedSearch.possible,
    ];
    // a speed modifier changes the candidate's assumed Spe, which can shift a speed-dependent move's
    // (Electro Ball/Gyro Ball) roll range too -- so matches are recomputed under the combined override
    // whenever one was adopted, not just reused from the damage-only search
    const matches = adoptedSpeedModifier
      ? evaluatePublishedMatches(
        state,
        candidateEvents,
        candidateMatch,
        best,
        damageContexts,
        rollCache,
        mergeModifierOverrides(
          adoptedModifier ? modifierOverrideFromClass(adoptedModifier.inferredModifier.modifier) : undefined,
          modifierOverrideFromClass(adoptedSpeedModifier.inferredModifier.modifier),
        ),
      ).map((match) => (
        adoptedModifier && adoptedSupportIds.has(match.eventId) && isInRangeMatch(match)
          ? { ...match, outlier: null, explainedBy: adoptedModifier.inferredModifier.modifier.id }
          : match
      ))
      : adoptedModifier
        ? adoptedModifier.matches.map((match) => (
          adoptedSupportIds.has(match.eventId) && isInRangeMatch(match)
            ? {
              ...match,
              outlier: null,
              explainedBy: adoptedModifier.inferredModifier.modifier.id,
            }
            : match
        ))
        : phaseOneMatches;
    const scoredMatches = matches.filter((match) => !match?.error);
    const inRangeMatches = matches.filter(isInRangeMatch);
    const outlierMatches = matches.filter((match) => !!match?.outlier);

    // a lookup failure (attacker/defender/relation) almost always means the OTHER Pokemon involved in
    // that historical event couldn't be found in state[playerKey].pokemon -- most commonly, the auth
    // player's own roster (`myPokemon`) is transiently incomplete right after a page reload, before
    // Showdown's client has repopulated it from the next `|request|` message (this arrives separately
    // from -- and later than -- the stepQueue replay that reconstructs the visible battle log). A mon
    // that has since fainted or switched out can be genuinely missing from the roster for that brief
    // window, even though it's present again a tick or two later. This is NOT the same as a real
    // modeling gap (missing dex data, invalid move, etc.), so it shouldn't be cached below
    const hasLookupFailure = matches.some((match) => (
      /^(?:attacker|defender) lookup failed|^candidate relation failed/.test(match?.error || '')
    ));

    // always publish -- `best` is unconditionally seeded by searchBestCandidates() even with zero
    // events (the plain neutral-nature/default-IV-EV baseline), so this is really just a defensive
    // guard against a malformed score, not a gate on "do we have enough evidence". A mon with zero
    // events publishes that neutral baseline as an honest "nothing observed yet" prior instead of
    // showing nothing; an event that lands outside the modeled range (e.g. an unmodeled move mechanic,
    // or a boosted/reduced hit) is tagged via `outlier` above rather than withholding the rest of an
    // otherwise-good fit
    const shouldPublishEstimate = best && Number.isFinite(best.score);

    const publishedEvents = candidateEvents.filter((event) => event.eventType !== 'speed');
    const speedNotes = describeSpeedBound(
      state,
      candidateMatch,
      candidateEvents.filter((event) => event.eventType === 'speed'),
      adoptedSpeedModifier?.inferredModifier.modifier,
    );

    const monInference: HackmonsInferenceState = {
      events: publishedEvents,
      ignoredEventCount,
      updatedTurn: candidateEvents.length ? Math.max(...candidateEvents.map((event) => event.turn)) : 0,
      speedNotes,
      assumptions: {
        nature: best?.nature || NeutralNature,
        notes: [
          `Unknown spreads start from ${DefaultIv} IV / ${DefaultEv} EV on every stat.`,
          'Preset-suggested item and ability overrides are ignored during spread inference.',
          'Recent direct damage is scored against median rolls with bounded EV refinement.',
          'Only direct move damage is modeled.',
          'Speed is inferred as a bound from turn order, not an exact value.',
          'Unknown volatile effects may lower confidence.',
          ...(!candidateEvents.length ? [
            'No battle events observed yet for this Pokemon -- showing the default neutral spread.',
          ] : []),
          ...(outlierMatches.length ? [
            `${outlierMatches.length} damage event${outlierMatches.length === 1 ? '' : 's'} fell outside `
              + 'the modeled range (see per-event outlier tags) -- possibly a boosted/reduced hit or an '
              + 'unmodeled move mechanic, not yet inferred.',
          ] : []),
          ...(inferredModifiers.map((modifier) => (
            `${modifier.adopted ? 'Likely' : 'Possible'} hidden ${modifier.modifier.slot}: `
              + `${formatModifierScope(modifier.modifier.scope)} ×${modifier.modifier.multiplier} `
              + `(${modifier.modifier.examples.join(' / ')}).`
          ))),
        ],
      },
      estimate: shouldPublishEstimate ? {
        level: candidateMatch.level || state.defaultLevel || 100,
        nature: best.nature,
        ivs: best.ivs,
        evs: best.evs,
        confidence: confidenceFromMatches(matches),
        confidenceRatio: scoredMatches.length ? inRangeMatches.length / scoredMatches.length : 0,
        score: best.score,
        matches,
        inferredModifiers,
      } : null,
    };

    output[calcdexId] = monInference;

    // skip caching a result tainted by a transient lookup failure -- otherwise the event signature
    // that gates the cache key never changes just because a DIFFERENT player's roster later became
    // complete, and the stale error would be pinned forever instead of self-healing on the next tick
    if (!hasLookupFailure) {
      InferenceCache.set(monCacheKey, monInference);

      if (InferenceCache.size > 64) {
        InferenceCache.delete(InferenceCache.keys().next().value);
      }
    }

    return output;
  }, {} as HackmonsInferenceMap);

  return inference;
};
