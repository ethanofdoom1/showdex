import {
  type AbilityName,
  type ShowdexCalcMods,
  calculate,
} from '@smogon/calc';
import { PokemonNatures } from '@showdex/consts/dex';
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
  type HackmonsInferenceFieldSnapshot,
  type HackmonsInferenceEvent,
  type HackmonsInferenceMap,
  type HackmonsInferencePokemonSnapshot,
  type HackmonsInferenceState,
} from './types';

const StatNames: Showdown.StatName[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const DefaultIv = 15;
const DefaultEv = 128;
const CandidateIvs = Array.from({ length: 32 }, (_, i) => i);
const CoordinateCandidateEvs = [0, 32, 64, 96, DefaultEv, 160, 192, 224, 252];
const MaxScoredEventsPerCategory = 3;
const MaxCandidateCount = 4000;
const NeutralNature = 'Serious' as Showdown.PokemonNature;
const CacheVersion = 'bounded-search-v17';

// keyed per defending Pokemon `calcdexId` + that mon's event signature, so a new battle log step
// only re-searches the mon(s) whose events actually changed (see inferHackmonsSpread())
const InferenceCache = new Map<string, HackmonsInferenceState>();
const SpeedDependentMoves = new Set(['electroball', 'gyroball']);

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
  overrideOffensiveStat?: Showdown.StatNameNoHp;
  overrideDefensiveStat?: Showdown.StatNameNoHp;
  overrideOffensivePokemon?: 'source' | 'target';
  overrideDefensivePokemon?: 'source' | 'target';
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
  rollCache?: Map<string, number[]>,
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

  const attackerMatch = findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
  const defenderMatch = findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId);

  if (!attackerMatch?.pokemon) {
    return emptyMatch(`attacker lookup failed ${event.attackerKey || '?'}:${event.attackerName || '(unknown)'}`);
  }

  if (!defenderMatch?.pokemon) {
    return emptyMatch(`defender lookup failed ${event.defenderKey || '?'}:${event.defenderName || '(unknown)'}`);
  }

  // derive the relation directly from the matches we just looked up (avoids resolveEventRelation()
  // re-running the same fuzzy lookups for every candidate spread)
  const relation: EventRelation = attackerMatch.pokemon.calcdexId === candidatePokemon.calcdexId
    ? 'attacker'
    : defenderMatch.pokemon.calcdexId === candidatePokemon.calcdexId
      ? 'defender'
      : null;

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

  const rollKey = `${event.id}:${relation}:${StatNames
    .filter((stat) => relevantStats.has(stat))
    .map((stat) => candidateSpreadStats?.[stat] ?? '')
    .join(',')}`;

  let rolls = rollCache?.get(rollKey);

  if (!rolls?.length) {
    const attackerPlayer = state[attackerMatch.playerKey];
    const defenderPlayer = state[defenderMatch.playerKey];
    const eventField = applyEventFieldSnapshot(state.field, event.field);
    const attackerCandidate: CalcdexPokemon = relation === 'attacker' ? {
      ...applyInferencePokemonAssumptions(applyEventPokemonSnapshot(
        state.format,
        candidatePokemon,
        event.attackerSnapshot,
      ), !event.attackerSnapshot?.abilityConfirmed),
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
    } : applyInferencePokemonAssumptions(applyEventPokemonSnapshot(state.format, {
      ...attackerMatch.pokemon,
      boosts: cloneBoostSnapshot(event.attackerBoosts),
      status: event.attackerStatus ?? attackerMatch.pokemon.status,
      hitCounter: event.attackerHitCounter || 0,
    }, event.attackerSnapshot));
    const defenderCandidate: CalcdexPokemon = relation === 'defender' ? {
      ...applyInferencePokemonAssumptions(applyEventPokemonSnapshot(
        state.format,
        candidatePokemon,
        event.defenderSnapshot,
      ), !event.defenderSnapshot?.abilityConfirmed),
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

      move.hits = event.hits || 1;

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
  const maxRoll = Math.max(...rolls);

  // a KO hit's observed damage is truncated at the defender's remaining HP -- the real roll was AT
  // LEAST the observation -- so score it one-sided (any candidate whose max roll covers the observed
  // HP loss fits perfectly) instead of dragging the search toward matching the truncated value exactly
  const ko = event.endHp === 0;

  return {
    eventId: event.id,
    turn: event.turn,
    moveName: event.moveName,
    observedDamage: normalizedObservedDamage,
    medianDamage: median,
    distance: ko
      ? Math.max(0, normalizedObservedDamage - maxRoll)
      : Math.abs(median - normalizedObservedDamage),
    maxHp: event.maxHp,
    crit: !!event.crit,
    ko,
    attackerBoosts: cloneBoostSnapshot(event.attackerBoosts),
    defenderBoosts: cloneBoostSnapshot(event.defenderBoosts),
    attackerStatus: event.attackerStatus || '',
    defenderStatus: event.defenderStatus || '',
    rollRange: [Math.min(...rolls), maxRoll],
  };
};

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
): number => {
  let modified = applyStatBoost(speed, boosts?.spe || 0);

  if (status === 'par') {
    modified = Math.floor(modified / 2);
  }

  return modified;
};

const hasSpeedModifier = (
  boosts?: Partial<Showdown.StatsTableNoHp>,
  status?: Showdown.PokemonStatus | '',
): boolean => !!(boosts?.spe || status === 'par');

const evaluateCandidateSpeedEvent = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  candidatePokemon: CalcdexPokemon,
  nature: Showdown.PokemonNature,
  ivs: Showdown.StatsTable,
  evs: Showdown.StatsTable,
): number => {
  const fasterMove = getMoveData(state, event);
  const slowerMove = getGenDexForFormat(state.format)?.moves.get(formatId(event.slowerMoveName) as never) as { priority?: number; };

  if ((fasterMove?.priority || 0) !== (slowerMove?.priority || 0)) {
    return 0;
  }

  const fasterMatch = findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
  const slowerMatch = findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId);
  const relation = resolveEventRelation(state, event, candidatePokemon);

  if (!fasterMatch?.pokemon || !slowerMatch?.pokemon || !relation) {
    return 32;
  }

  const candidateSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature,
    ivs,
    evs,
  });
  const candidateRawSpe = candidateSpreadStats?.spe;
  const otherRawSpe = relation === 'attacker'
    ? getPokemonRawStat(slowerMatch.pokemon, 'spe')
    : getPokemonRawStat(fasterMatch.pokemon, 'spe');

  if (!candidateRawSpe || !otherRawSpe) {
    return 32;
  }

  const candidateSpeed = relation === 'attacker'
    ? applySpeedModifiers(candidateRawSpe, event.attackerBoosts, event.attackerStatus)
    : applySpeedModifiers(candidateRawSpe, event.defenderBoosts, event.defenderStatus);
  const otherSpeed = relation === 'attacker'
    ? applySpeedModifiers(otherRawSpe, event.defenderBoosts, event.defenderStatus)
    : applySpeedModifiers(otherRawSpe, event.attackerBoosts, event.attackerStatus);

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
  rollCache?: Map<string, number[]>,
): number => events.reduce((score, event) => {
  if (event.eventType === 'speed') {
    // speed is a one-sided constraint only: penalize candidates that contradict the observed turn
    // order (too slow when they moved first, too fast when they moved second). We deliberately do NOT
    // center Spe within the feasible range -- with a one-sided bound there is nothing to center on, and
    // doing so fabricates an inflated point estimate. Spe is surfaced as a bound in the UI instead.
    const boundDistance = evaluateCandidateSpeedEvent(state, event, defender, nature, ivs, evs);
    const normalizedDistance = Math.min(32, boundDistance / 4);

    return score - (normalizedDistance * normalizedDistance + normalizedDistance);
  }

  const match = evaluateCandidateEvent(state, event, defender, nature, ivs, evs, rollCache);
  const distance = match?.distance ?? 8;
  const weight = event.crit ? 0.25 : 1;

  return score - ((distance * distance + distance) * weight);
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
  rollCache?: Map<string, number[]>,
): SpreadCandidate => ({
  nature,
  ivs: cloneSpread(ivs),
  evs: cloneSpread(evs),
  score: scoreCandidate(state, events, candidatePokemon, nature, ivs, evs, rollCache),
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

const searchBestCandidates = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  rollCache?: Map<string, number[]>,
): SpreadCandidate[] => {
  const scoringEvents = selectScoringEvents(state, events);
  const searchStats = determineSearchStats(state, scoringEvents, candidatePokemon);
  const baseIvs = blankSpread(DefaultIv);
  const baseEvs = blankSpread(DefaultEv);

  let best = scoreSpreadCandidate(
    state,
    scoringEvents,
    candidatePokemon,
    NeutralNature,
    baseIvs,
    baseEvs,
    rollCache,
  );

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

  PokemonNatures.forEach((nature) => remember(scoreSpreadCandidate(
    state,
    scoringEvents,
    candidatePokemon,
    nature,
    best.ivs,
    best.evs,
    rollCache,
  )));

  for (let pass = 0; pass < 3 && !exhausted; pass++) {
    for (const stat of searchStats) {
      for (const iv of CandidateIvs) {
        for (const ev of CoordinateCandidateEvs) {
          if (exhausted) {
            break;
          }

          remember(scoreSpreadCandidate(
            state,
            scoringEvents,
            candidatePokemon,
            best.nature,
            {
              ...best.ivs,
              [stat]: iv,
            },
            {
              ...best.evs,
              [stat]: ev,
            },
            rollCache,
          ));
        }
      }

      for (const nature of PokemonNatures) {
        remember(scoreSpreadCandidate(
          state,
          scoringEvents,
          candidatePokemon,
          nature,
          best.ivs,
          best.evs,
          rollCache,
        ));
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

          remember(scoreSpreadCandidate(
            state,
            scoringEvents,
            candidatePokemon,
            refinedBest.nature,
            {
              ...refinedBest.ivs,
              [stat]: iv,
            },
            {
              ...refinedBest.evs,
              [stat]: ev,
            },
            rollCache,
          ));
        }
      }

      refinedBest = best;

      if (exhausted) {
        break;
      }
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
};

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
    const otherModifiedSpe = otherRawSpe
      ? applySpeedModifiers(otherRawSpe, otherBoosts, otherStatus)
      : null;
    const speedLabel = hasSpeedModifier(otherBoosts, otherStatus) || hasSpeedModifier(candidateBoosts, candidateStatus)
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

  if (lowerBounds.length) {
    const tightest = lowerBounds.reduce((best, o) => (o.bound > best.bound ? o : best));

    notes.push(`Outsped ${tightest.otherName} (${tightest.label} ≥ ${tightest.bound})`);
  }

  if (upperBounds.length) {
    const tightest = upperBounds.reduce((best, o) => (o.bound < best.bound ? o : best));

    notes.push(`Outsped by ${tightest.otherName} (${tightest.label} ≤ ${tightest.bound})`);
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

    const [best] = candidates;
    const matches = best ? candidateEvents.filter((event) => event.eventType !== 'speed').map((event) => {
        const match = evaluateCandidateEvent(state, event, candidateMatch, best.nature, best.ivs, best.evs, rollCache);

        return { ...match, outlier: outlierDirection(match) };
      }) : [];
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
    // showing nothing; an event that lands outside the modeled range (e.g. an unmodeled move like
    // Rollout, or a boosted/reduced hit) is tagged via `outlier` above rather than withholding the
    // rest of an otherwise-good fit
    const shouldPublishEstimate = best && Number.isFinite(best.score);

    const publishedEvents = candidateEvents.filter((event) => event.eventType !== 'speed');
    const speedNotes = describeSpeedBound(
      state,
      candidateMatch,
      candidateEvents.filter((event) => event.eventType === 'speed'),
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
