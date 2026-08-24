import { type MoveName } from '@smogon/calc';
import { PokemonInitialBoosts } from '@showdex/consts/dex/stats';
import { PseudoWeatherMap } from '@showdex/consts/dex/terrain';
import { WeatherMap } from '@showdex/consts/dex/weather';
import { type CalcdexPlayerKey } from '@showdex/interfaces/calc';
import { chunkStepQueueTurns } from '@showdex/utils/battle/chunkStepQueueTurns';
import { formatId } from '@showdex/utils/core/formatId';
import {
  type HackmonsDamageEffectiveness,
  type HackmonsInferenceEvent,
  type HackmonsInferenceFieldSnapshot,
  type HackmonsInferencePokemonSnapshot,
  type HackmonsInferenceSideSnapshot,
  type HackmonsIllusionReveal,
} from './types';

interface PendingMove {
  turn: number;
  stepIndex: number;
  attackerSlot?: string;
  attackerId: string;
  attackerKey?: CalcdexPlayerKey;
  attackerName: string;
  moveName: MoveName;
  boosts: Showdown.StatsTableNoHp;
  status: Showdown.PokemonStatus | '';
  crit?: boolean;

  /**
   * Targets whose NEXT hit of this move crit -- Showdown logs `-crit` immediately before that hit's
   * own `-damage` line, so a multi-hit move that crits on only some of its hits is knowable here
   * (and nowhere else).
   */
  pendingCritTargets?: Set<string>;
  multiHit?: boolean;
  hits?: number;
  effectiveness?: HackmonsDamageEffectiveness;
  dynamaxed?: boolean;
  hitCounter?: number;
  moveRepeatCount?: number;
  defenseCurled?: boolean;
  attackerStint?: number;
}

interface PendingDamageEvent {
  turn: number;
  stepIndex: number;
  attackerSlot?: string;
  attackerId: string;
  defenderSlot?: string;
  defenderId: string;
  defenderKey?: CalcdexPlayerKey;
  attackerName: string;
  defenderName: string;
  moveName: MoveName;
  attackerStartHp?: number;
  attackerMaxHp?: number;
  startHp: number;
  endHp: number;
  maxHp: number;
  totalDamage: number;
  hitDamages: number[];
  critHits: boolean[];
  recoilObserved?: boolean;
  effectiveness?: HackmonsDamageEffectiveness;
  attackerBoosts: Showdown.StatsTableNoHp;
  defenderBoosts: Showdown.StatsTableNoHp;
  attackerStatus: Showdown.PokemonStatus | '';
  defenderStatus: Showdown.PokemonStatus | '';
  field: HackmonsInferenceFieldSnapshot;
  attackerSide: HackmonsInferenceSideSnapshot;
  defenderSide: HackmonsInferenceSideSnapshot;
  attackerFaintCount: number;
  defenderFaintCount: number;
  attackerSnapshot: HackmonsInferencePokemonSnapshot;
  defenderSnapshot: HackmonsInferencePokemonSnapshot;
  rawLine: string;
  defenderStint?: number;
}

const cloneBoosts = (
  boosts?: Partial<Showdown.StatsTableNoHp>,
): Showdown.StatsTableNoHp => ({
  atk: boosts?.atk || 0,
  def: boosts?.def || 0,
  spa: boosts?.spa || 0,
  spd: boosts?.spd || 0,
  spe: boosts?.spe || 0,
});

const statFromLog = (value: string): Showdown.StatNameNoHp => {
  switch (formatId(value)) {
    case 'atk':
    case 'def':
    case 'spa':
    case 'spd':
    case 'spe':
      return formatId(value) as Showdown.StatNameNoHp;
    case 'spc':
      return 'spa';
    default:
      return null;
  }
};

const getBoosts = (
  boostState: Map<string, Showdown.StatsTableNoHp>,
  pokemonId: string,
): Showdown.StatsTableNoHp => {
  if (!boostState.has(pokemonId)) {
    boostState.set(pokemonId, cloneBoosts(PokemonInitialBoosts));
  }

  return boostState.get(pokemonId);
};

const clearBoosts = (
  boostState: Map<string, Showdown.StatsTableNoHp>,
  pokemonId: string,
): void => {
  boostState.set(pokemonId, cloneBoosts(PokemonInitialBoosts));
};

const getStatus = (
  statusState: Map<string, Showdown.PokemonStatus | ''>,
  pokemonId: string,
): Showdown.PokemonStatus | '' => statusState.get(pokemonId) || '';

const getHp = (
  hpState: Map<string, number>,
  pokemonId: string,
): number => hpState.get(pokemonId);

const getMaxHp = (
  maxHpState: Map<string, number>,
  pokemonId: string,
): number => maxHpState.get(pokemonId);

const cloneFieldSnapshot = (
  field: HackmonsInferenceFieldSnapshot,
): HackmonsInferenceFieldSnapshot => ({
  weather: field.weather || null,
  terrain: field.terrain || null,
  isMagicRoom: !!field.isMagicRoom,
  isWonderRoom: !!field.isWonderRoom,
  isGravity: !!field.isGravity,
});

const clonePokemonSnapshot = (
  snapshot?: HackmonsInferencePokemonSnapshot,
): HackmonsInferencePokemonSnapshot => ({
  types: snapshot?.types?.length ? [...snapshot.types] : null,
  typeChanged: !!snapshot?.typeChanged,
  teraType: snapshot?.teraType || null,
  terastallized: !!snapshot?.terastallized,
  abilityConfirmed: !!snapshot?.abilityConfirmed,
  itemConfirmed: !!snapshot?.itemConfirmed,
  revealedItem: snapshot?.revealedItem || null,
});

const getPokemonSnapshot = (
  pokemonState: Map<string, HackmonsInferencePokemonSnapshot>,
  pokemonId: string,
): HackmonsInferencePokemonSnapshot => clonePokemonSnapshot(pokemonState.get(pokemonId));

// side conditions that change what the damage calc produces (screens are a flat multiplier; Tailwind
// feeds the speed-based moves) -- everything else on a side is either hazards (excluded from the
// calc by ShowdexCalcMods) or purely cosmetic here
const ScreenConditions = ['reflect', 'lightscreen', 'auroraveil'];

const effectId = (
  value: string,
): string => formatId((value || '').replace(/^(move|ability|item):\s*/i, ''));

const parseTypeList = (
  value: string,
): Showdown.TypeName[] => (value || '')
  .split('/')
  .map((typeName) => typeName.trim() as Showdown.TypeName)
  .filter(Boolean);

const parsePokemonToken = (token: string): { id: string; slot?: string; playerKey?: CalcdexPlayerKey; name: string; } => {
  const trimmed = token?.trim() || '';
  const [side, ...nameParts] = trimmed.split(':');
  const name = nameParts.join(':').trim() || trimmed;
  const sideId = side?.trim() || trimmed;
  const playerKey = sideId.match(/^p[1-4]/i)?.[0] as CalcdexPlayerKey;

  return {
    id: formatId(`${sideId}:${name || sideId}`),
    slot: formatId(sideId),
    playerKey,
    name,
  };
};

const parseSpeciesName = (
  details: string,
): string => (details || '').split(',')[0]?.trim() || '';

const parseHpToken = (token: string): { hp?: number; maxhp?: number; } => {
  const [value] = (token || '').split(' ');
  const [hp, maxhp] = (value || '').split('/').map((n) => Number(n));

  return {
    hp: Number.isFinite(hp) ? hp : null,
    maxhp: Number.isFinite(maxhp) ? maxhp : null,
  };
};

interface ChunkMutableState {
  boostState: Map<string, Showdown.StatsTableNoHp>;
  statusState: Map<string, Showdown.PokemonStatus | ''>;
  hpState: Map<string, number>;
  maxHpState: Map<string, number>;
  pokemonState: Map<string, HackmonsInferencePokemonSnapshot>;
  hitCounterState: Map<string, number>;
  moveRepeatState: Map<string, { moveId: string; count: number; }>;
  defenseCurlState: Set<string>;
  dynamaxedState: Set<string>;
  activeStintState: Map<string, number>;
  activeSlotStintState: Map<string, number>;
  trickRoomActive: boolean;
  tailwindState: Set<CalcdexPlayerKey>;
  // damage-relevant side conditions per player (`'reflect'`, `'lightscreen'`, `'auroraveil'`)
  screenState: Map<CalcdexPlayerKey, Set<string>>;
  // running count of Pokemon fainted per player -- Supreme Overlord's "allies fainted"
  faintState: Map<CalcdexPlayerKey, number>;
  fieldState: HackmonsInferenceFieldSnapshot;
}

const createParserState = (): ChunkMutableState => ({
  boostState: new Map(),
  statusState: new Map(),
  hpState: new Map(),
  maxHpState: new Map(),
  // times each Pokemon has been directly hit by a damaging move this battle (Rage Fist's power scales
  // off this). Unlike boosts/status, this does NOT reset on switch -- it's a persistent battle stat,
  // matching the real mechanic (and how Last Respects' faintCounter is already treated in this codebase)
  pokemonState: new Map(),
  hitCounterState: new Map(),
  // tracks, per attacker, the move most recently landed & how many consecutive prior turns it landed
  // in a row -- Fury Cutter/Rollout's power doubles off this. Resets on a different move, a miss/immune,
  // or a switch-out (see the `move`/`-miss`/`-immune`/`switch` handlers below)
  moveRepeatState: new Map(),
  // attackers who've used Defense Curl since their last switch-in -- doubles Rollout's power on top of
  // moveRepeatState's own scaling, and (unlike moveRepeatState) never resets on a miss/different move
  defenseCurlState: new Set(),
  dynamaxedState: new Set(),
  // per-mon count of how many times it's been sent out (bumped on every switch-in) -- two of a mon's
  // moves sharing a stint but NOT sharing a moveName prove it wasn't Choice-locked during that stint
  activeStintState: new Map(),
  activeSlotStintState: new Map(),
  trickRoomActive: false,
  tailwindState: new Set(),
  screenState: new Map(),
  faintState: new Map(),
  fieldState: {
    weather: null,
    terrain: null,
    isMagicRoom: false,
    isWonderRoom: false,
    isGravity: false,
  },
});

// deep enough to isolate a cached snapshot from further mutation -- per-mon boost records are
// mutated in place elsewhere (`boosts[stat] = ...`), so a shallow Map copy would let live processing
// after this point corrupt a snapshot that's supposed to stay frozen for the next incremental resume
const getSideSnapshot = (
  screenState: Map<CalcdexPlayerKey, Set<string>>,
  tailwindState: Set<CalcdexPlayerKey>,
  playerKey?: CalcdexPlayerKey,
): HackmonsInferenceSideSnapshot => {
  const screens = (playerKey && screenState.get(playerKey)) || new Set<string>();

  return {
    isReflect: screens.has('reflect'),
    isLightScreen: screens.has('lightscreen'),
    isAuroraVeil: screens.has('auroraveil'),
    isTailwind: !!playerKey && tailwindState.has(playerKey),
  };
};

const cloneParserState = (
  state: ChunkMutableState,
): ChunkMutableState => ({
  boostState: new Map([...state.boostState].map(([id, boosts]) => [id, cloneBoosts(boosts)])),
  statusState: new Map(state.statusState),
  hpState: new Map(state.hpState),
  maxHpState: new Map(state.maxHpState),
  pokemonState: new Map([...state.pokemonState].map(([id, snapshot]) => [id, clonePokemonSnapshot(snapshot)])),
  hitCounterState: new Map(state.hitCounterState),
  moveRepeatState: new Map([...state.moveRepeatState].map(([id, entry]) => [id, { ...entry }])),
  defenseCurlState: new Set(state.defenseCurlState),
  dynamaxedState: new Set(state.dynamaxedState),
  activeStintState: new Map(state.activeStintState),
  activeSlotStintState: new Map(state.activeSlotStintState),
  trickRoomActive: state.trickRoomActive,
  tailwindState: new Set(state.tailwindState),
  screenState: new Map([...state.screenState].map(([key, screens]) => [key, new Set(screens)])),
  faintState: new Map(state.faintState),
  fieldState: cloneFieldSnapshot(state.fieldState),
});

// processes a single turn-chunk against the running (mutable) parser state, returning just that
// chunk's events -- factored out of parseHackmonsInferenceEvents() so the incremental resume path
// below can replay only the chunks that actually need it instead of the whole stepQueue every time
const processChunk = (
  steps: string[],
  turnNumber: number,
  state: ChunkMutableState,
): {
  events: HackmonsInferenceEvent[];
  illusionReveals: HackmonsIllusionReveal[];
  ignoredEventCount: number;
} => {
  const {
    boostState,
    statusState,
    hpState,
    maxHpState,
    pokemonState,
    hitCounterState,
    moveRepeatState,
    defenseCurlState,
    dynamaxedState,
    activeStintState,
    activeSlotStintState,
    tailwindState,
    screenState,
    faintState,
    fieldState,
  } = state;

  const events: HackmonsInferenceEvent[] = [];
  const illusionReveals: HackmonsIllusionReveal[] = [];
  let ignoredEventCount = 0;

  {
    const pendingMoves = new Map<string, PendingMove>();
    const moveOrder: PendingMove[] = [];
    const pendingDamageEvents = new Map<string, PendingDamageEvent>();

    const flushPendingDamageEvents = () => {
      pendingDamageEvents.forEach((pendingEvent) => {
        const pendingMove = pendingMoves.get(pendingEvent.attackerId);

        events.push({
          id: `${pendingEvent.turn}:${pendingEvent.stepIndex}:${pendingEvent.attackerId}:${pendingEvent.defenderId}:${formatId(pendingEvent.moveName)}`,
          turn: pendingEvent.turn,
          attackerSlot: pendingEvent.attackerSlot,
          attackerId: pendingEvent.attackerId,
          attackerKey: pendingMove?.attackerKey,
          defenderSlot: pendingEvent.defenderSlot,
          defenderId: pendingEvent.defenderId,
          defenderKey: pendingEvent.defenderKey,
          attackerName: pendingEvent.attackerName,
          defenderName: pendingEvent.defenderName,
          moveName: pendingEvent.moveName,
          damage: pendingEvent.totalDamage,
          attackerStartHp: pendingEvent.attackerStartHp,
          attackerMaxHp: pendingEvent.attackerMaxHp,
          startHp: pendingEvent.startHp,
          endHp: pendingEvent.endHp,
          maxHp: pendingEvent.maxHp,
          crit: pendingEvent.critHits.some(Boolean) || pendingMove?.crit,
          critHits: [...pendingEvent.critHits],
          multiHit: pendingMove?.multiHit,
          hits: pendingMove?.hits,
          effectiveness: pendingEvent.effectiveness || pendingMove?.effectiveness || 'neutral',
          attackerDynamaxed: !!pendingMove?.dynamaxed,
          attackerHitCounter: pendingMove?.hitCounter,
          attackerMoveRepeatCount: pendingMove?.moveRepeatCount,
          attackerDefenseCurled: pendingMove?.defenseCurled,
          attackerStint: pendingMove?.attackerStint,
          defenderStint: pendingEvent.defenderStint,
          hitDamages: [...pendingEvent.hitDamages],
          recoilObserved: !!pendingEvent.recoilObserved,
          attackerBoosts: cloneBoosts(pendingEvent.attackerBoosts),
          defenderBoosts: cloneBoosts(pendingEvent.defenderBoosts),
          attackerStatus: pendingEvent.attackerStatus,
          defenderStatus: pendingEvent.defenderStatus,
          field: cloneFieldSnapshot(pendingEvent.field),
          attackerSide: { ...pendingEvent.attackerSide },
          defenderSide: { ...pendingEvent.defenderSide },
          attackerFaintCount: pendingEvent.attackerFaintCount,
          defenderFaintCount: pendingEvent.defenderFaintCount,
          attackerSnapshot: clonePokemonSnapshot(pendingEvent.attackerSnapshot),
          defenderSnapshot: clonePokemonSnapshot(pendingEvent.defenderSnapshot),
          rawLine: pendingEvent.rawLine,
        });
      });

      pendingDamageEvents.clear();
    };

    const flushSpeedOrderEvents = () => {
      const activeMoves = moveOrder.filter((move) => !!move.attackerId && !!move.moveName);

      for (let i = 0; i < activeMoves.length - 1; i++) {
        const fasterMove = activeMoves[i];
        const slowerMove = activeMoves[i + 1];

        if (fasterMove.attackerId === slowerMove.attackerId) {
          continue;
        }

        events.push({
          eventType: 'speed',
          id: `${turnNumber}:speed:${fasterMove.attackerId}:${slowerMove.attackerId}:${formatId(fasterMove.moveName)}:${formatId(slowerMove.moveName)}`,
          turn: turnNumber,
          attackerSlot: fasterMove.attackerSlot,
          attackerId: fasterMove.attackerId,
          attackerKey: fasterMove.attackerKey,
          defenderSlot: slowerMove.attackerSlot,
          defenderId: slowerMove.attackerId,
          defenderKey: slowerMove.attackerKey,
          attackerName: fasterMove.attackerName,
          defenderName: slowerMove.attackerName,
          moveName: fasterMove.moveName,
          slowerMoveName: slowerMove.moveName,
          attackerStint: fasterMove.attackerStint,
          defenderStint: slowerMove.attackerStint,
          speedOrderSuppressed: state.trickRoomActive
            || tailwindState.has(fasterMove.attackerKey)
            || tailwindState.has(slowerMove.attackerKey),
          attackerBoosts: cloneBoosts(fasterMove.boosts),
          defenderBoosts: cloneBoosts(slowerMove.boosts),
          attackerStatus: fasterMove.status,
          defenderStatus: slowerMove.status,
          field: cloneFieldSnapshot(fieldState),
          attackerSnapshot: getPokemonSnapshot(pokemonState, fasterMove.attackerId),
          defenderSnapshot: getPokemonSnapshot(pokemonState, slowerMove.attackerId),
          rawLine: `|speed|${fasterMove.attackerName}|${fasterMove.moveName}|${slowerMove.attackerName}|${slowerMove.moveName}`,
        });
      }
    };

    steps.forEach((step, stepIndex) => {
      const parts = step.split('|');
      const type = parts[1];

      if (type === 'move') {
        flushPendingDamageEvents();

        const attacker = parsePokemonToken(parts[2]);
        const moveName = parts[3] as MoveName;

        if (!attacker.id || !moveName) {
          ignoredEventCount++;
          return;
        }

        const moveId = formatId(moveName);
        const repeatEntry = moveRepeatState.get(attacker.id);

        if (moveId === 'defensecurl') {
          defenseCurlState.add(attacker.id);
        }

        pendingMoves.set(attacker.id, {
          turn: turnNumber,
          stepIndex,
          attackerSlot: attacker.slot,
          attackerId: attacker.id,
          attackerKey: attacker.playerKey,
          attackerName: attacker.name,
          moveName,
          dynamaxed: dynamaxedState.has(attacker.id),
          boosts: cloneBoosts(getBoosts(boostState, attacker.id)),
          status: getStatus(statusState, attacker.id),
          hitCounter: hitCounterState.get(attacker.id) || 0,
          moveRepeatCount: repeatEntry?.moveId === moveId ? repeatEntry.count : 0,
          defenseCurled: defenseCurlState.has(attacker.id),
          attackerStint: (attacker.slot ? activeSlotStintState.get(attacker.slot) : null) || activeStintState.get(attacker.id) || 0,
        });
        moveOrder.push(pendingMoves.get(attacker.id));

        return;
      }

      if (['switch', 'drag', 'replace'].includes(type)) {
        flushPendingDamageEvents();

        const pokemon = parsePokemonToken(parts[2]);
        const hp = parseHpToken(parts[4]);

        if (pokemon.id) {
          if (type === 'replace' && pokemon.slot) {
            const revealedName = pokemon.name || parseSpeciesName(parts[3]);
            const revealedSpecies = parseSpeciesName(parts[3]) || revealedName;

            if (revealedName) {
              illusionReveals.push({
                slot: pokemon.slot,
                revealedName,
                revealedId: formatId(`${pokemon.slot}:${revealedName}`),
                revealedSpecies,
                turn: turnNumber,
                revealedStint: activeSlotStintState.get(pokemon.slot) || 0,
              });
            }
          }

          clearBoosts(boostState, pokemon.id);
          statusState.delete(pokemon.id);
          moveRepeatState.delete(pokemon.id);
          defenseCurlState.delete(pokemon.id);
          dynamaxedState.delete(pokemon.id);
          activeStintState.set(pokemon.id, (activeStintState.get(pokemon.id) || 0) + 1);
          if (pokemon.slot) {
            activeSlotStintState.set(pokemon.slot, (activeSlotStintState.get(pokemon.slot) || 0) + 1);
          }
          const snapshot = pokemonState.get(pokemon.id);

          if (snapshot) {
            pokemonState.set(pokemon.id, {
              teraType: snapshot.teraType || null,
              terastallized: !!snapshot.terastallized,
              typeChanged: false,
              // once revealed, the ability/item stay known even after switching out (unlike types,
              // which do revert to base on switch)
              abilityConfirmed: !!snapshot.abilityConfirmed,
              itemConfirmed: !!snapshot.itemConfirmed,
              revealedItem: snapshot.revealedItem || null,
            });
          }

          if (typeof hp.hp === 'number') {
            hpState.set(pokemon.id, hp.hp);
          } else {
            hpState.delete(pokemon.id);
          }
          if (typeof hp.maxhp === 'number') {
            maxHpState.set(pokemon.id, hp.maxhp);
          } else {
            maxHpState.delete(pokemon.id);
          }
        }

        return;
      }

      if (type === '-weather') {
        const weather = WeatherMap[effectId(parts[2])];
        fieldState.weather = weather || null;
        return;
      }

      if (type === '-fieldstart' || type === '-fieldend') {
        const condition = effectId(parts[2]);
        const active = type === '-fieldstart';
        const terrain = PseudoWeatherMap[condition];

        if (terrain) {
          fieldState.terrain = active ? terrain : null;
          return;
        }

        if (condition === 'magicroom') {
          fieldState.isMagicRoom = active;
          return;
        }

        if (condition === 'wonderroom') {
          fieldState.isWonderRoom = active;
          return;
        }

        if (condition === 'gravity') {
          fieldState.isGravity = active;
          return;
        }

        if (condition === 'trickroom') {
          state.trickRoomActive = active;
          return;
        }
      }

      if (type === '-sidestart' || type === '-sideend') {
        const side = parsePokemonToken(parts[2]);
        const condition = effectId(parts[3]);

        if (side.playerKey && condition === 'tailwind') {
          if (type === '-sidestart') {
            tailwindState.add(side.playerKey);
          } else {
            tailwindState.delete(side.playerKey);
          }
        }

        if (side.playerKey && ScreenConditions.includes(condition)) {
          const screens = screenState.get(side.playerKey) || new Set<string>();

          if (type === '-sidestart') {
            screens.add(condition);
          } else {
            screens.delete(condition);
          }

          screenState.set(side.playerKey, screens);
        }

        return;
      }

      if (type === 'faint') {
        const pokemon = parsePokemonToken(parts[2]);

        if (pokemon.playerKey) {
          faintState.set(pokemon.playerKey, (faintState.get(pokemon.playerKey) || 0) + 1);
        }

        return;
      }

      if (type === '-terastallize' || type === 'terastallize') {
        const pokemon = parsePokemonToken(parts[2]);
        const teraType = parts[3] as Showdown.TypeName;

        if (pokemon.id && teraType) {
          pokemonState.set(pokemon.id, {
            ...clonePokemonSnapshot(pokemonState.get(pokemon.id)),
            teraType,
            terastallized: true,
          });
        }

        return;
      }

      if (type === '-start' && effectId(parts[3]) === 'typechange') {
        const pokemon = parsePokemonToken(parts[2]);
        const changedTypes = parseTypeList(parts[4]);

        if (pokemon.id && changedTypes.length) {
          pokemonState.set(pokemon.id, {
            ...clonePokemonSnapshot(pokemonState.get(pokemon.id)),
            types: changedTypes,
            typeChanged: true,
          });
        }

        return;
      }

      if ((type === '-start' || type === '-end') && effectId(parts[3]) === 'dynamax') {
        const pokemon = parsePokemonToken(parts[2]);

        if (pokemon.id) {
          if (type === '-start') {
            dynamaxedState.add(pokemon.id);
          } else {
            dynamaxedState.delete(pokemon.id);
          }
        }

        return;
      }

      if (type === '-start' && effectId(parts[3]) === 'typeadd') {
        const pokemon = parsePokemonToken(parts[2]);
        const addedType = parts[4] as Showdown.TypeName;

        if (pokemon.id && addedType) {
          const snapshot = clonePokemonSnapshot(pokemonState.get(pokemon.id));

          pokemonState.set(pokemon.id, {
            ...snapshot,
            types: [...(snapshot.types || []), addedType],
            typeChanged: true,
          });
        }

        return;
      }

      if (type === '-end' && ['typechange', 'typeadd'].includes(effectId(parts[3]))) {
        const pokemon = parsePokemonToken(parts[2]);

        if (pokemon.id) {
          pokemonState.set(pokemon.id, {
            ...clonePokemonSnapshot(pokemonState.get(pokemon.id)),
            types: null,
            typeChanged: false,
          });
        }

        return;
      }

      if (type === '-ability') {
        const pokemon = parsePokemonToken(parts[2]);

        if (pokemon.id) {
          pokemonState.set(pokemon.id, {
            ...clonePokemonSnapshot(pokemonState.get(pokemon.id)),
            abilityConfirmed: true,
          });
        }

        return;
      }

      // direct item reveals (Group 6 ground truth) -- `-item` (e.g. Frisk/Trick exposing it) and
      // `-enditem` (consumption/Knock Off) both confirm what the mon WAS holding. Applied forward-only
      // like `abilityConfirmed` above (events already parsed aren't retroactively updated); a
      // revealed-then-consumed item incorrectly still reads as held for later events -- known,
      // documented limitation (spec §2 "item consumption timelines")
      if (type === '-item' || type === '-enditem') {
        const pokemon = parsePokemonToken(parts[2]);
        const item = effectId(parts[3]);

        if (pokemon.id && item) {
          pokemonState.set(pokemon.id, {
            ...clonePokemonSnapshot(pokemonState.get(pokemon.id)),
            itemConfirmed: true,
            revealedItem: item,
          });
        }

        return;
      }

      if (type === '-status') {
        const pokemon = parsePokemonToken(parts[2]);
        const status = formatId(parts[3] || '') as Showdown.PokemonStatus | '';

        if (pokemon.id) {
          statusState.set(pokemon.id, status);
        }

        return;
      }

      if (type === '-curestatus' || type === 'curestatus') {
        const pokemon = parsePokemonToken(parts[2]);

        if (pokemon.id) {
          statusState.delete(pokemon.id);
        }

        return;
      }

      if (type === '-boost' || type === '-unboost' || type === '-setboost') {
        const pokemon = parsePokemonToken(parts[2]);
        const stat = statFromLog(parts[3]);
        const amount = Number(parts[4]);

        if (!pokemon.id || !stat || !Number.isFinite(amount)) {
          ignoredEventCount++;
          return;
        }

        const boosts = getBoosts(boostState, pokemon.id);

        if (type === '-setboost') {
          boosts[stat] = Math.max(-6, Math.min(6, amount));
        } else {
          const delta = type === '-unboost' ? -amount : amount;
          boosts[stat] = Math.max(-6, Math.min(6, (boosts[stat] || 0) + delta));
        }

        return;
      }

      if (type === '-clearboost') {
        const pokemon = parsePokemonToken(parts[2]);

        if (pokemon.id) {
          clearBoosts(boostState, pokemon.id);
        }

        return;
      }

      if (type === '-clearallboost') {
        boostState.forEach((_, pokemonId) => clearBoosts(boostState, pokemonId));
        return;
      }

      if (type === '-swapboost') {
        const source = parsePokemonToken(parts[2]);
        const target = parsePokemonToken(parts[3]);
        const sourceBoosts = cloneBoosts(getBoosts(boostState, source.id));
        const targetBoosts = cloneBoosts(getBoosts(boostState, target.id));
        const filteredStats = parts.slice(4)
          .map(statFromLog)
          .filter((stat): stat is Showdown.StatNameNoHp => !!stat);

        if (!source.id || !target.id || !filteredStats.length) {
          ignoredEventCount++;
          return;
        }

        filteredStats.forEach((stat) => {
          sourceBoosts[stat] = getBoosts(boostState, target.id)[stat] || 0;
          targetBoosts[stat] = getBoosts(boostState, source.id)[stat] || 0;
        });

        boostState.set(source.id, sourceBoosts);
        boostState.set(target.id, targetBoosts);
        return;
      }

      if (type === '-crit') {
        const target = parsePokemonToken(parts[2]);
        const lastMove = [...pendingMoves.values()].at(-1);

        if (target.id && lastMove) {
          lastMove.crit = true;

          if (!lastMove.pendingCritTargets) {
            lastMove.pendingCritTargets = new Set();
          }

          lastMove.pendingCritTargets.add(target.id);
        }

        return;
      }

      if (type === '-hitcount') {
        const target = parsePokemonToken(parts[2]);
        const hits = Number(parts[3]);
        const lastMove = [...pendingMoves.values()].at(-1);

        if (target.id && lastMove && Number.isFinite(hits)) {
          lastMove.multiHit = true;
          lastMove.hits = hits;
        }

        return;
      }

      if (['-supereffective', '-resisted', '-immune'].includes(type)) {
        const effectiveness = ({
          '-supereffective': 'super',
          '-resisted': 'resisted',
          '-immune': 'immune',
        } as Record<string, HackmonsDamageEffectiveness>)[type];
        const lastMove = [...pendingMoves.values()].at(-1);

        if (lastMove?.attackerId) {
          lastMove.effectiveness = effectiveness;

          const pendingEvent = [...pendingDamageEvents.values()]
            .reverse()
            .find((event) => event.attackerId === lastMove.attackerId);

          if (pendingEvent) {
            pendingEvent.effectiveness = effectiveness;
          }
        }

        if (type !== '-immune') {
          return;
        }
      }

      if (type === '-miss' || type === '-immune') {
        // the move never landed, so whatever repeat-power streak (Fury Cutter/Rollout) it might've
        // continued is broken -- the next use of any move starts that attacker fresh at count 0
        const lastMove = [...pendingMoves.values()].at(-1);

        if (lastMove?.attackerId) {
          moveRepeatState.delete(lastMove.attackerId);
        }

        ignoredEventCount++;
        return;
      }

      if (!['-damage', '-heal'].includes(type)) {
        return;
      }

      if (type === '-heal') {
        const pokemon = parsePokemonToken(parts[2]);
        const hp = parseHpToken(parts[3]);

        if (pokemon.id && typeof hp.hp === 'number') {
          hpState.set(pokemon.id, hp.hp);
          if (typeof hp.maxhp === 'number') {
            maxHpState.set(pokemon.id, hp.maxhp);
          }
        } else {
          ignoredEventCount++;
        }

        return;
      }

      if (type !== '-damage') {
        ignoredEventCount++;
        return;
      }

      const defender = parsePokemonToken(parts[2]);
      const hp = parseHpToken(parts[3]);
      const from = parts.find((part) => part.startsWith('[from]'));

      if (from) {
        // indirect damage (item/ability/hazards/recoil/status) -- not usable for inference, but we
        // still track the resulting HP so the next direct hit computes the right delta
        if (defender.id && typeof hp.hp === 'number') {
          hpState.set(defender.id, hp.hp);
          if (typeof hp.maxhp === 'number') {
            maxHpState.set(defender.id, hp.maxhp);
          }
        }

        // a `[from] item: X` line where the damaged mon IS the currently pending move's own attacker
        // is a self-inflicted item effect (Life Orb recoil being the common case) -- both a general
        // item reveal (Group 6) AND, specifically for Life Orb, the corroborating "recoil observed"
        // signal the adoption guard checks for. Other `[from] item:` shapes (e.g. Rocky Helmet, whose
        // item belongs to the OTHER mon) aren't attributed here -- out of scope for this pass.
        const fromItem = /^\[from\] item:/i.test(from) ? effectId(from) : null;
        const recoilPendingMove = [...pendingMoves.values()].at(-1);

        if (fromItem && defender.id && recoilPendingMove?.attackerId === defender.id) {
          pokemonState.set(defender.id, {
            ...clonePokemonSnapshot(pokemonState.get(defender.id)),
            itemConfirmed: true,
            revealedItem: fromItem,
          });

          const recoilDamageKey = [...pendingDamageEvents.keys()]
            .reverse()
            .find((key) => key.startsWith(`${defender.id}:`));

          if (recoilDamageKey) {
            pendingDamageEvents.get(recoilDamageKey).recoilObserved = true;
          }
        }

        ignoredEventCount++;
        return;
      }

      const pendingMove = [...pendingMoves.values()].at(-1);
      const attackerStartHp = pendingMove ? getHp(hpState, pendingMove.attackerId) : null;
      const attackerMaxHp = pendingMove ? getMaxHp(maxHpState, pendingMove.attackerId) : null;

      // a KO reads `|-damage|p2a: Mew|0 fnt` -- a bare condition with no `/maxhp` -- so parseHpToken()
      // yields maxhp null & the killing blow (often the single largest, most informative damage event)
      // would be silently dropped by the guard below. Fall back to the defender's tracked max HP from
      // its earlier switch-in/damage lines so the KO hit registers like any other direct hit
      const maxHp = hp.maxhp ?? getMaxHp(maxHpState, defender.id);
      const startHp = getHp(hpState, defender.id) ?? maxHp;
      const damage = typeof startHp === 'number' && typeof hp.hp === 'number'
        ? startHp - hp.hp
        : null;

      if (!pendingMove || !defender.id || typeof damage !== 'number' || damage <= 0 || !maxHp) {
        ignoredEventCount++;
        return;
      }

      // Some moves (notably Shed Tail) pay a fixed HP cost on the user with a bare `-damage` line.
      // Inference events describe damage dealt to another Pokemon; keep the HP state current without
      // treating the user's cost as stat-dependent move damage.
      if (pendingMove.attackerId === defender.id) {
        hpState.set(defender.id, hp.hp);
        maxHpState.set(defender.id, maxHp);
        return;
      }

      // count this hit toward the defender's Rage Fist counter -- each individual hit of a multi-hit
      // move increments it once, since each hit gets its own `-damage` line
      hitCounterState.set(defender.id, (hitCounterState.get(defender.id) || 0) + 1);

      // the move landed, so extend the attacker's repeat-power streak by one for its *next* use --
      // `pendingMove.moveRepeatCount` is the count already baked into *this* event (read at the `move`
      // handler, before this hit was known to land)
      moveRepeatState.set(pendingMove.attackerId, {
        moveId: formatId(pendingMove.moveName),
        count: (pendingMove.moveRepeatCount || 0) + 1,
      });

      const damageKey = [
        pendingMove.attackerId,
        defender.id,
        formatId(pendingMove.moveName),
      ].join(':');
      const pendingDamage = pendingDamageEvents.get(damageKey);

      // Set.delete() reports whether the `-crit` line that precedes this hit's `-damage` was for
      // this defender, and consumes it so the NEXT hit starts uncrit again
      const hitCrit = !!pendingMove.pendingCritTargets?.delete(defender.id);

      if (pendingDamage) {
        pendingDamage.endHp = hp.hp;
        pendingDamage.maxHp = maxHp;
        pendingDamage.totalDamage += damage;
        pendingDamage.hitDamages.push(damage);
        pendingDamage.critHits.push(hitCrit);
      } else {
        pendingDamageEvents.set(damageKey, {
          turn: turnNumber,
          stepIndex,
          attackerSlot: pendingMove.attackerSlot,
          attackerId: pendingMove.attackerId,
          defenderSlot: defender.slot,
          defenderId: defender.id,
          defenderKey: defender.playerKey,
          attackerName: pendingMove.attackerName,
          hitDamages: [damage],
          critHits: [hitCrit],
          defenderName: defender.name,
          moveName: pendingMove.moveName,
          attackerStartHp,
          attackerMaxHp,
          startHp,
          endHp: hp.hp,
          maxHp,
          totalDamage: damage,
          effectiveness: pendingMove.effectiveness || 'neutral',
          attackerBoosts: cloneBoosts(getBoosts(boostState, pendingMove.attackerId)),
          defenderBoosts: cloneBoosts(getBoosts(boostState, defender.id)),
          attackerStatus: getStatus(statusState, pendingMove.attackerId),
          defenderStatus: getStatus(statusState, defender.id),
          field: cloneFieldSnapshot(fieldState),
          attackerSide: getSideSnapshot(screenState, tailwindState, pendingMove.attackerKey),
          defenderSide: getSideSnapshot(screenState, tailwindState, defender.playerKey),
          attackerFaintCount: faintState.get(pendingMove.attackerKey) || 0,
          defenderFaintCount: faintState.get(defender.playerKey) || 0,
          attackerSnapshot: getPokemonSnapshot(pokemonState, pendingMove.attackerId),
          defenderSnapshot: getPokemonSnapshot(pokemonState, defender.id),
          rawLine: step,
          defenderStint: (defender.slot ? activeSlotStintState.get(defender.slot) : null) || activeStintState.get(defender.id) || 0,
        });
      }

      hpState.set(defender.id, hp.hp);
      maxHpState.set(defender.id, maxHp);
    });

    flushPendingDamageEvents();
    flushSpeedOrderEvents();
  }

  return {
    events,
    illusionReveals,
    ignoredEventCount,
  };
};

interface ParserCacheEntry {
  cachedStepQueue: string[];
  closedChunkCount: number;
  closedEvents: HackmonsInferenceEvent[];
  closedIllusionReveals: HackmonsIllusionReveal[];
  closedIgnoredCount: number;
  state: ChunkMutableState;
}

// keyed per battleId, so an unrelated battle's saved walk never gets resumed against this one
const ParserStateCache = new Map<string, ParserCacheEntry>();

const isStepQueuePrefix = (
  prefix: string[],
  full: string[],
): boolean => {
  if (full.length < prefix.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i++) {
    if (full[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
};

const revealKey = (
  slot: string,
  stint: number,
): string => `${slot}:${stint}`;

const remapIllusionEvents = (
  events: HackmonsInferenceEvent[],
  illusionReveals: HackmonsIllusionReveal[],
): {
  events: HackmonsInferenceEvent[];
  ignoredEventCount: number;
} => {
  if (!illusionReveals.length) {
    return { events, ignoredEventCount: 0 };
  }

  const revealsBySlotStint = new Map(illusionReveals.map((reveal) => [revealKey(reveal.slot, reveal.revealedStint), reveal]));
  const revealedSlots = new Set(illusionReveals.map((reveal) => reveal.slot));
  let ignoredEventCount = 0;
  const remappedEvents: HackmonsInferenceEvent[] = [];

  events.forEach((event) => {
    let remappedEvent = event;
    let remapped = false;
    let quarantine = false;
    const attackerNeedsCheck = !!event.attackerSlot && revealedSlots.has(event.attackerSlot);
    const defenderNeedsCheck = !!event.defenderSlot && revealedSlots.has(event.defenderSlot);

    if (attackerNeedsCheck) {
      const reveal = typeof event.attackerStint === 'number'
        ? revealsBySlotStint.get(revealKey(event.attackerSlot, event.attackerStint))
        : null;

      if (reveal?.revealedName && reveal.revealedId) {
        remappedEvent = {
          ...remappedEvent,
          attackerName: reveal.revealedName,
          attackerId: reveal.revealedId,
        };
        remapped = true;
      } else if (typeof event.attackerStint !== 'number') {
        quarantine = true;
      }
    }

    if (defenderNeedsCheck) {
      const reveal = typeof event.defenderStint === 'number'
        ? revealsBySlotStint.get(revealKey(event.defenderSlot, event.defenderStint))
        : null;

      if (reveal?.revealedName && reveal.revealedId) {
        remappedEvent = {
          ...remappedEvent,
          defenderName: reveal.revealedName,
          defenderId: reveal.revealedId,
        };
        remapped = true;
      } else if (typeof event.defenderStint !== 'number') {
        quarantine = true;
      }
    }

    if (quarantine && !remapped) {
      ignoredEventCount++;
      return;
    }

    remappedEvents.push(remappedEvent);
  });

  return {
    events: remappedEvents,
    ignoredEventCount,
  };
};

export const parseHackmonsInferenceEvents = (
  stepQueue: string[],
  battleId?: string,
): {
  events: HackmonsInferenceEvent[];
  ignoredEventCount: number;
} => {
  const chunks = chunkStepQueueTurns(stepQueue);

  if (!chunks.length) {
    return { events: [], ignoredEventCount: 0 };
  }

  const cached = battleId ? ParserStateCache.get(battleId) : null;

  // a reload/rejoin rebuilds stepQueue from scratch -- if the previously-parsed content isn't a
  // literal prefix of the new one anymore, the saved walk state is for a different timeline and must
  // be discarded (full reparse) rather than resumed from
  const canResume = !!cached && isStepQueuePrefix(cached.cachedStepQueue, stepQueue);

  // the *last* chunk is always treated as still "open" (more steps may get appended to the same turn
  // before the next `|turn|` line arrives), so only chunks before it are ever trusted as "closed" and
  // reused verbatim across calls
  const startIndex = canResume ? Math.min(cached.closedChunkCount, chunks.length - 1) : 0;
  const runningState = canResume ? cloneParserState(cached.state) : createParserState();
  const preLoopState = cloneParserState(runningState);
  const baseClosedEvents = canResume ? cached.closedEvents : [];
  const baseClosedIllusionReveals = canResume ? cached.closedIllusionReveals : [];
  const baseClosedIgnoredCount = canResume ? cached.closedIgnoredCount : 0;

  const chunkEventLists: HackmonsInferenceEvent[][] = [];
  const chunkIllusionRevealLists: HackmonsIllusionReveal[][] = [];
  const chunkIgnoredCounts: number[] = [];
  let preLastChunkState = preLoopState;

  for (let i = startIndex; i < chunks.length; i++) {
    const steps = chunks[i];
    const turn = steps.find((step) => step.startsWith('|turn|'))?.split('|')[2];
    const turnNumber = Number(turn) || i;
    const {
      events: chunkEvents,
      illusionReveals: chunkIllusionReveals,
      ignoredEventCount: chunkIgnoredCount,
    } = processChunk(steps, turnNumber, runningState);

    chunkEventLists.push(chunkEvents);
    chunkIllusionRevealLists.push(chunkIllusionReveals);
    chunkIgnoredCounts.push(chunkIgnoredCount);

    // snapshot state as of right before the (new) last chunk begins, for the next incremental resume
    if (i === chunks.length - 2) {
      preLastChunkState = cloneParserState(runningState);
    }
  }

  const lastIndex = chunkEventLists.length - 1;
  const closedEvents = [
    ...baseClosedEvents,
    ...chunkEventLists.slice(0, lastIndex).flat(),
  ];
  const closedIllusionReveals = [
    ...baseClosedIllusionReveals,
    ...chunkIllusionRevealLists.slice(0, lastIndex).flat(),
  ];
  const closedIgnoredCount = baseClosedIgnoredCount
    + chunkIgnoredCounts.slice(0, lastIndex).reduce((total, count) => total + count, 0);
  const openEvents = chunkEventLists[lastIndex] || [];
  const openIllusionReveals = chunkIllusionRevealLists[lastIndex] || [];
  const openIgnoredCount = chunkIgnoredCounts[lastIndex] || 0;

  if (battleId) {
    ParserStateCache.set(battleId, {
      cachedStepQueue: [...stepQueue],
      closedChunkCount: chunks.length - 1,
      closedEvents,
      closedIllusionReveals,
      closedIgnoredCount,
      state: preLastChunkState,
    });

    if (ParserStateCache.size > 16) {
      ParserStateCache.delete(ParserStateCache.keys().next().value);
    }
  }

  const remapped = remapIllusionEvents(
    [...closedEvents, ...openEvents],
    [...closedIllusionReveals, ...openIllusionReveals],
  );

  return {
    events: remapped.events,
    ignoredEventCount: closedIgnoredCount + openIgnoredCount + remapped.ignoredEventCount,
  };
};
