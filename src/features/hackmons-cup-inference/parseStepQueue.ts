import { type MoveName } from '@smogon/calc';
import { PokemonInitialBoosts, PseudoWeatherMap, WeatherMap } from '@showdex/consts/dex';
import { type CalcdexPlayerKey } from '@showdex/interfaces/calc';
import { chunkStepQueueTurns } from '@showdex/utils/battle';
import { formatId } from '@showdex/utils/core';
import { type HackmonsInferenceEvent, type HackmonsInferenceFieldSnapshot, type HackmonsInferencePokemonSnapshot } from './types';

interface PendingMove {
  turn: number;
  stepIndex: number;
  attackerId: string;
  attackerKey?: CalcdexPlayerKey;
  attackerName: string;
  moveName: MoveName;
  boosts: Showdown.StatsTableNoHp;
  status: Showdown.PokemonStatus | '';
  crit?: boolean;
  multiHit?: boolean;
  hits?: number;
}

interface PendingDamageEvent {
  turn: number;
  stepIndex: number;
  attackerId: string;
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
  attackerBoosts: Showdown.StatsTableNoHp;
  defenderBoosts: Showdown.StatsTableNoHp;
  attackerStatus: Showdown.PokemonStatus | '';
  defenderStatus: Showdown.PokemonStatus | '';
  field: HackmonsInferenceFieldSnapshot;
  attackerSnapshot: HackmonsInferencePokemonSnapshot;
  defenderSnapshot: HackmonsInferencePokemonSnapshot;
  rawLine: string;
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
});

const getPokemonSnapshot = (
  pokemonState: Map<string, HackmonsInferencePokemonSnapshot>,
  pokemonId: string,
): HackmonsInferencePokemonSnapshot => clonePokemonSnapshot(pokemonState.get(pokemonId));

const effectId = (
  value: string,
): string => formatId((value || '').replace(/^(move|ability|item):\s*/i, ''));

const parseTypeList = (
  value: string,
): Showdown.TypeName[] => (value || '')
  .split('/')
  .map((typeName) => typeName.trim() as Showdown.TypeName)
  .filter(Boolean);

const parsePokemonToken = (token: string): { id: string; playerKey?: CalcdexPlayerKey; name: string; } => {
  const trimmed = token?.trim() || '';
  const [side, ...nameParts] = trimmed.split(':');
  const name = nameParts.join(':').trim() || trimmed;
  const sideId = side?.trim() || trimmed;
  const playerKey = sideId.match(/^p[1-4]/i)?.[0] as CalcdexPlayerKey;

  return {
    id: formatId(`${sideId}:${name || sideId}`),
    playerKey,
    name,
  };
};

const parseHpToken = (token: string): { hp?: number; maxhp?: number; } => {
  const [value] = (token || '').split(' ');
  const [hp, maxhp] = (value || '').split('/').map((n) => Number(n));

  return {
    hp: Number.isFinite(hp) ? hp : null,
    maxhp: Number.isFinite(maxhp) ? maxhp : null,
  };
};

export const parseHackmonsInferenceEvents = (
  stepQueue: string[],
): {
  events: HackmonsInferenceEvent[];
  ignoredEventCount: number;
} => {
  const chunks = chunkStepQueueTurns(stepQueue);
  const events: HackmonsInferenceEvent[] = [];
  let ignoredEventCount = 0;
  const boostState = new Map<string, Showdown.StatsTableNoHp>();
  const statusState = new Map<string, Showdown.PokemonStatus | ''>();
  const hpState = new Map<string, number>();
  const maxHpState = new Map<string, number>();
  const pokemonState = new Map<string, HackmonsInferencePokemonSnapshot>();
  const fieldState: HackmonsInferenceFieldSnapshot = {
    weather: null,
    terrain: null,
    isMagicRoom: false,
    isWonderRoom: false,
    isGravity: false,
  };

  chunks.forEach((steps, chunkIndex) => {
    const turn = steps.find((step) => step.startsWith('|turn|'))?.split('|')[2];
    const turnNumber = Number(turn) || chunkIndex;
    const pendingMoves = new Map<string, PendingMove>();
    const moveOrder: PendingMove[] = [];
    const pendingDamageEvents = new Map<string, PendingDamageEvent>();

    const flushPendingDamageEvents = () => {
      pendingDamageEvents.forEach((pendingEvent) => {
        const pendingMove = pendingMoves.get(pendingEvent.attackerId);

        events.push({
          id: `${pendingEvent.turn}:${pendingEvent.stepIndex}:${pendingEvent.attackerId}:${pendingEvent.defenderId}:${formatId(pendingEvent.moveName)}`,
          turn: pendingEvent.turn,
          attackerId: pendingEvent.attackerId,
          attackerKey: pendingMove?.attackerKey,
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
          crit: pendingMove?.crit,
          multiHit: pendingMove?.multiHit,
          hits: pendingMove?.hits,
          attackerBoosts: cloneBoosts(pendingEvent.attackerBoosts),
          defenderBoosts: cloneBoosts(pendingEvent.defenderBoosts),
          attackerStatus: pendingEvent.attackerStatus,
          defenderStatus: pendingEvent.defenderStatus,
          field: cloneFieldSnapshot(pendingEvent.field),
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
          attackerId: fasterMove.attackerId,
          attackerKey: fasterMove.attackerKey,
          defenderId: slowerMove.attackerId,
          defenderKey: slowerMove.attackerKey,
          attackerName: fasterMove.attackerName,
          defenderName: slowerMove.attackerName,
          moveName: fasterMove.moveName,
          slowerMoveName: slowerMove.moveName,
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

        pendingMoves.set(attacker.id, {
          turn: turnNumber,
          stepIndex,
          attackerId: attacker.id,
          attackerKey: attacker.playerKey,
          attackerName: attacker.name,
          moveName,
          boosts: cloneBoosts(getBoosts(boostState, attacker.id)),
          status: getStatus(statusState, attacker.id),
        });
        moveOrder.push(pendingMoves.get(attacker.id));

        return;
      }

      if (['switch', 'drag', 'replace'].includes(type)) {
        flushPendingDamageEvents();

        const pokemon = parsePokemonToken(parts[2]);
        const hp = parseHpToken(parts[4]);

        if (pokemon.id) {
          clearBoosts(boostState, pokemon.id);
          statusState.delete(pokemon.id);
          const snapshot = pokemonState.get(pokemon.id);

          if (snapshot) {
            pokemonState.set(pokemon.id, {
              teraType: snapshot.teraType || null,
              terastallized: !!snapshot.terastallized,
              typeChanged: false,
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

      if (!['-damage', '-heal', '-immune', '-miss'].includes(type)) {
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

        ignoredEventCount++;
        return;
      }

      const pendingMove = [...pendingMoves.values()].at(-1);
      const attackerStartHp = pendingMove ? getHp(hpState, pendingMove.attackerId) : null;
      const attackerMaxHp = pendingMove ? getMaxHp(maxHpState, pendingMove.attackerId) : null;
      const startHp = getHp(hpState, defender.id) ?? hp.maxhp;
      const damage = typeof startHp === 'number' && typeof hp.hp === 'number'
        ? startHp - hp.hp
        : null;

      if (!pendingMove || !defender.id || typeof damage !== 'number' || damage <= 0 || !hp.maxhp) {
        ignoredEventCount++;
        return;
      }

      const damageKey = [
        pendingMove.attackerId,
        defender.id,
        formatId(pendingMove.moveName),
      ].join(':');
      const pendingDamage = pendingDamageEvents.get(damageKey);

      if (pendingDamage) {
        pendingDamage.endHp = hp.hp;
        pendingDamage.maxHp = hp.maxhp;
        pendingDamage.totalDamage += damage;
      } else {
        pendingDamageEvents.set(damageKey, {
          turn: turnNumber,
          stepIndex,
          attackerId: pendingMove.attackerId,
          defenderId: defender.id,
          defenderKey: defender.playerKey,
          attackerName: pendingMove.attackerName,
          defenderName: defender.name,
          moveName: pendingMove.moveName,
          attackerStartHp,
          attackerMaxHp,
          startHp,
          endHp: hp.hp,
          maxHp: hp.maxhp,
          totalDamage: damage,
          attackerBoosts: cloneBoosts(getBoosts(boostState, pendingMove.attackerId)),
          defenderBoosts: cloneBoosts(getBoosts(boostState, defender.id)),
          attackerStatus: getStatus(statusState, pendingMove.attackerId),
          defenderStatus: getStatus(statusState, defender.id),
          field: cloneFieldSnapshot(fieldState),
          attackerSnapshot: getPokemonSnapshot(pokemonState, pendingMove.attackerId),
          defenderSnapshot: getPokemonSnapshot(pokemonState, defender.id),
          rawLine: step,
        });
      }

      hpState.set(defender.id, hp.hp);
      maxHpState.set(defender.id, hp.maxhp);
    });

    flushPendingDamageEvents();
    flushSpeedOrderEvents();
  });

  return {
    events,
    ignoredEventCount,
  };
};
