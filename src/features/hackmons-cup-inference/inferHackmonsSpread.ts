import {
  type AbilityName,
  type ItemName,
  type MoveName,
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
import { logger, runtimer } from '@showdex/utils/debug';
import { getGenDexForFormat, getMaxMove } from '@showdex/utils/dex';
import {
  damageEventLogLikelihood,
  ErrorEventLogLikelihood,
  observedDamagePmf,
  speedEventLogLikelihood,
  type ObservedDamagePmfEntry,
} from './damageLikelihood';
import { isInferenceFormat } from './isInferenceFormat';
import {
  type HackmonsDamageMatch,
  type HackmonsDamageOutlier,
  type HackmonsExtremalFeasibility,
  type HackmonsInferredModifier,
  type HackmonsInferenceFieldSnapshot,
  type HackmonsInferenceEvent,
  type HackmonsInferenceMap,
  type HackmonsInferencePokemonSnapshot,
  type HackmonsInferenceSideSnapshot,
  type HackmonsInferenceState,
  type HackmonsModifierClass,
  type HackmonsModifierSlot,
} from './types';

const StatNames: Showdown.StatName[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const DefaultIv = 15;
const DefaultEv = 128;
const CandidateIvs = Array.from({ length: 32 }, (_, i) => i);
const CoordinateCandidateEvs = [0, 32, 64, 96, DefaultEv, 160, 192, 224, 252];
const MaxDamageContextGroups = 48;
const MaxCandidateCount = 4000;
const NeutralNature = 'Serious' as Showdown.PokemonNature;
const CacheVersion = 'likelihood-fit-v24';

// keyed per defending Pokemon `calcdexId` + that mon's event signature, so a new battle log step
// only re-searches the mon(s) whose events actually changed (see inferHackmonsSpread())
const InferenceCache = new Map<string, HackmonsInferenceState>();
const SpeedDependentMoves = new Set(['electroball', 'gyroball']);

// perf audit remedy #4: rolls survive across syncs (unlike `rollCache` itself, which is local to one
// inferHackmonsSpread() call) since an old event's roll doesn't change just because a new event
// appended -- keyed per `calcdexId` + `participantSignature` (NOT the event signature, which is the
// whole point) so a reveal still starts a fresh roll cache instead of reusing rolls computed against a
// stale non-candidate ability/item, same poisoned-cache hazard `participantSignature` already guards
// against for `InferenceCache` above
interface CachedDamageRolls {
  rolls: number[];
  rawRolls?: number[];
}

type RollCache = Map<string, CachedDamageRolls>;

const RollCacheStore = new Map<string, RollCache>();
const MaxRollCacheEntriesPerMon = 20_000;

const l = logger('@showdex/features/hackmons-cup-inference/inferHackmonsSpread()');
const lSearchCandidates = logger('@showdex/features/hackmons-cup-inference/inferHackmonsSpread():searchBestCandidates()');
const lSearchModifiers = logger('@showdex/features/hackmons-cup-inference/inferHackmonsSpread():searchModifierHypotheses()');

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
    // audit fix A1: split from the old bundled 'item-atk-1.5' (Choice Band + Gorilla Tactics +
    // Hustle) -- Choice Band is a real Choice item (locks, disqualifiable by a lock violation);
    // Gorilla Tactics/Hustle are abilities that don't share that disqualifier (see ability-atk-1.5
    // below). Bundling them under slot 'item' let an item reveal or a lock violation wrongly
    // eliminate the ability-side explanations too.
    id: 'item-atk-1.5',
    slot: 'item',
    scope: 'global-atk',
    multiplier: 1.5,
    representative: 'Choice Band',
    examples: ['Choice Band'],
    disqualifiers: ['choice-lock'],
  },
  {
    // Gorilla Tactics locks like a Choice item; Hustle doesn't. A lock violation can't distinguish
    // the two, so (unlike the item-slot class above) this class carries no disqualifier -- accepted
    // imprecision, per audit finding A1.
    id: 'ability-atk-1.5',
    slot: 'ability',
    scope: 'global-atk',
    multiplier: 1.5,
    representative: 'Gorilla Tactics',
    examples: ['Gorilla Tactics', 'Hustle'],
  },
  {
    id: 'item-atk-1.1',
    slot: 'item',
    scope: 'global-atk',
    multiplier: 1.1,
    representative: 'Muscle Band',
    examples: ['Muscle Band'],
  },
  {
    id: 'item-spa-1.5',
    slot: 'item',
    scope: 'global-spa',
    multiplier: 1.5,
    representative: 'Choice Specs',
    examples: ['Choice Specs'],
    disqualifiers: ['choice-lock'],
  },
  {
    id: 'item-spa-1.1',
    slot: 'item',
    scope: 'global-spa',
    multiplier: 1.1,
    representative: 'Wise Glasses',
    examples: ['Wise Glasses'],
  },
  {
    id: 'item-both-1.3',
    slot: 'item',
    scope: 'global-both',
    multiplier: 1.3,
    representative: 'Life Orb',
    examples: ['Life Orb'],
    disqualifiers: ['no-recoil'],
  },
  {
    id: 'ability-atk-0.5',
    slot: 'ability',
    scope: 'global-atk',
    multiplier: 0.5,
    representative: 'Slow Start',
    examples: ['Slow Start'],
    // audit fix A2: Slow Start's Atk half and Spe half are the SAME ability but live in separate
    // damage/speed searches -- without this link, adopting one pins the ability slot and permanently
    // blocks the other from ever co-adopting, even though observing both is the strongest possible
    // signature. See the `additionallyPinned` computation in inferHackmonsSpread().
    pairedClassId: 'ability-spe-0.5',
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
    // Heatproof and Water Bubble's defensive half are damage-indistinguishable (both Fire ×0.5
    // taken) -- merged into one class, same policy as Filter/Solid Rock/Prism Armor above. NOT
    // merged with Purifying Salt below: that's a different type (Ghost), not a shape match.
    id: 'ability-heatproof-fire-taken-0.5',
    slot: 'ability',
    scope: { type: 'Fire' },
    multiplier: 0.5,
    representative: 'Heatproof',
    examples: ['Heatproof', 'Water Bubble'],
  },
  {
    id: 'ability-purifyingsalt-ghost-taken-0.5',
    slot: 'ability',
    scope: { type: 'Ghost' },
    multiplier: 0.5,
    representative: 'Purifying Salt',
    examples: ['Purifying Salt'],
  },
  {
    // `too-high` twin (spec §4 Group 2's last row, cataloged since the original slice but never
    // implemented until this audit): the candidate as DEFENDER takes MORE than max roll from a Fire
    // hit. Separate class from Dry Skin below -- different multiplier, not damage-indistinguishable.
    id: 'ability-fluffy-fire-taken-2',
    slot: 'ability',
    scope: { type: 'Fire' },
    multiplier: 2,
    representative: 'Fluffy',
    examples: ['Fluffy'],
  },
  {
    id: 'ability-dryskin-fire-taken-1.25',
    slot: 'ability',
    scope: { type: 'Fire' },
    multiplier: 1.25,
    representative: 'Dry Skin',
    examples: ['Dry Skin'],
  },
  {
    // offensive half of Water Bubble -- a second multiplier tier alongside the ×1.3/×1.5
    // type-boost-ability template below (that template is parameterized per-type at one multiplier
    // each; ×2 needs its own entry rather than a third generated tier for a single type)
    id: 'ability-waterbubble-water-dealt-2',
    slot: 'ability',
    scope: { type: 'Water' },
    multiplier: 2,
    representative: 'Water Bubble',
    examples: ['Water Bubble'],
  },
  {
    // attacker-side mirror of Filter/Solid Rock's defender-side 'super-effective-taken' scope --
    // cheaper than the deferred Expert Belt (spec §4 Group 3) since effectiveness is already parsed
    id: 'ability-tintedlens-resisted-dealt-2',
    slot: 'ability',
    scope: 'resisted-dealt',
    multiplier: 2,
    representative: 'Tinted Lens',
    examples: ['Tinted Lens'],
  },
  {
    // first species-conditional class: proposeWhen (see ModifierProposalRules) reads
    // `dex.species.get(...).nfe`, the same dex-accessor pattern used throughout this file rather
    // than hand-rolling an NFE species list
    id: 'item-eviolite-defspd-1.5',
    slot: 'item',
    scope: 'global-both',
    multiplier: 1.5,
    representative: 'Eviolite',
    examples: ['Eviolite'],
  },
  {
    id: 'item-spe-1.5',
    slot: 'item',
    scope: 'spe',
    multiplier: 1.5,
    representative: 'Choice Scarf',
    examples: ['Choice Scarf'],
    disqualifiers: ['choice-lock'],
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
    pairedClassId: 'ability-atk-0.5',
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

// audit fix A3: Transistor was nerfed from x1.5 to x1.3 in gen 9 (SV) -- the generator previously
// hardcoded x1.5 for every type, mislabeling the Electric entry's class id/multiplier even though the
// damage math itself was correct (the calc applies the real 'Transistor' ability, not this constant).
const TypeBoostAbilityMultiplierByType: Partial<Record<Showdown.TypeName, number>> = {
  Electric: 1.3,
};

const TypeBoostAbilityExtraExamplesByType: Partial<Record<Showdown.TypeName, string[]>> = {
  Steel: ['Steely Spirit'],
};

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
): HackmonsModifierClass => {
  const multiplier = TypeBoostAbilityMultiplierByType[type] || 1.5;

  return {
    id: `ability-type-${formatId(type)}-${multiplier}`,
    slot: 'ability',
    scope: { type },
    multiplier,
    representative: TypeBoostAbilityByType[type],
    examples: [TypeBoostAbilityByType[type], ...(TypeBoostAbilityExtraExamplesByType[type] || [])],
  };
};

const AdaptabilityModifier: HackmonsModifierClass = {
  id: 'ability-stab-2',
  slot: 'ability',
  scope: 'stab',
  multiplier: 2,
  representative: 'Adaptability',
  examples: ['Adaptability'],
};

// Group 4 (-ate abilities, T4): unlike Group 3's damage-only scoping, these retype Normal moves to
// `scope.type` AND boost them x1.2 -- both effects come straight from @smogon/calc's own (dex-accurate)
// ability mechanic once `representative` is set as the candidate's ability override, so there's no
// separate multiplier/retype math to write here, same as every other real-ability class above.
const AteModifierByType: Partial<Record<Showdown.TypeName, HackmonsModifierClass>> = {
  Fairy: {
    id: 'ability-ate-fairy', slot: 'ability', scope: { type: 'Fairy' }, multiplier: 1.2, representative: 'Pixilate', examples: ['Pixilate'], directEvidence: true,
  },
  Flying: {
    id: 'ability-ate-flying', slot: 'ability', scope: { type: 'Flying' }, multiplier: 1.2, representative: 'Aerilate', examples: ['Aerilate'], directEvidence: true,
  },
  Ice: {
    id: 'ability-ate-ice', slot: 'ability', scope: { type: 'Ice' }, multiplier: 1.2, representative: 'Refrigerate', examples: ['Refrigerate'], directEvidence: true,
  },
  Electric: {
    id: 'ability-ate-electric', slot: 'ability', scope: { type: 'Electric' }, multiplier: 1.2, representative: 'Galvanize', examples: ['Galvanize'], directEvidence: true,
  },
};

// Normalize (Group 4's mirror): turns every OTHER type of move into Normal (same x1.2 boost)
const NormalizeModifier: HackmonsModifierClass = {
  id: 'ability-normalize',
  slot: 'ability',
  scope: { type: 'Normal' },
  multiplier: 1.2,
  representative: 'Normalize',
  examples: ['Normalize'],
  directEvidence: true,
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

const formatModifierEffect = (
  modifier: HackmonsModifierClass,
): string => {
  const scopeLabel = formatModifierScope(modifier.scope);
  const isDamageTakenReduction = modifier.multiplier < 1 && (
    modifier.scope === 'global-def'
      || modifier.scope === 'global-spd'
      || modifier.scope === 'global-both'
      || modifier.scope === 'super-effective-taken'
      || modifier.scope === 'full-hp-taken'
      || (typeof modifier.scope !== 'string' && modifier.id.includes('-taken-'))
  );

  if (!isDamageTakenReduction) {
    return `${scopeLabel} ×${modifier.multiplier}`;
  }

  if (modifier.scope === 'global-def') {
    return `physical damage ×${modifier.multiplier} taken`;
  }

  if (modifier.scope === 'global-spd') {
    return `special damage ×${modifier.multiplier} taken`;
  }

  if (modifier.scope === 'global-both') {
    return `damage ×${modifier.multiplier} taken`;
  }

  return `${scopeLabel} damage ×${modifier.multiplier} taken`;
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

const medianDamagePmf = (
  pmf: ObservedDamagePmfEntry[],
): number => {
  let cumulative = 0;

  for (const entry of pmf) {
    cumulative += entry.p;

    if (cumulative >= 0.5) {
      return entry.value;
    }
  }

  return pmf.at(-1)?.value ?? null;
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

// Supreme Overlord / Last Respects scale off how many allies had fainted AT THE TIME -- a counter
// that only grows, so the live value over-boosts every earlier event in the log
const applyEventFaintCount = (
  pokemon: CalcdexPokemon,
  faintCount?: number,
): CalcdexPokemon => (
  typeof faintCount === 'number'
    ? { ...pokemon, faintCounter: faintCount, dirtyFaintCounter: null }
    : pokemon
);

// screens are a flat damage multiplier and Tailwind feeds the speed-based moves, so a past event has
// to be calculated against the side conditions that were up when it happened, not the current ones
const applyEventPlayerSide = (
  player: CalcdexBattleState[CalcdexPlayerKey],
  snapshot?: HackmonsInferenceSideSnapshot,
): CalcdexBattleState[CalcdexPlayerKey] => (
  player && snapshot
    ? {
      ...player,
      side: {
        ...player.side,
        isReflect: !!snapshot.isReflect,
        isLightScreen: !!snapshot.isLightScreen,
        isAuroraVeil: !!snapshot.isAuroraVeil,
        isTailwind: !!snapshot.isTailwind,
      },
    }
    : player
);

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

// Showdown only logs `-hitcount` for a multi-hit move whose `smartTarget` isn't a boolean, so a
// smart-targeting multi-hit move (Dragon Darts) lands twice with NO hit count in the log -- falling
// back to 1 there would hand the calc a single-hit move to explain two hits' worth of observed
// damage. The `-damage` lines actually counted for this move use are the reliable fallback.
const resolveEventHitCount = (event: HackmonsInferenceEvent): number => (
  event.hits || event.hitDamages?.length || 1
);

const resolveEventMoveName = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  attacker?: CalcdexPokemon,
): MoveName => {
  const dex = getGenDexForFormat(state.format);
  const loggedMove = dex?.moves.get(formatId(event.moveName) as never);

  if (!event.attackerDynamaxed || !loggedMove?.isMax) {
    return event.moveName;
  }

  const pokemon = attacker || findPokemonByLogName(
    state,
    event.attackerName,
    event.attackerKey,
    event.attackerId,
  )?.pokemon;

  return pokemon?.moves?.find((moveName) => {
    const move = dex?.moves.get(formatId(moveName) as never);

    return !!move?.maxMove
      && !move.isMax
      && getMaxMove(moveName, {
        speciesForme: pokemon.speciesForme,
        ability: pokemon.dirtyAbility || pokemon.ability,
      }) === event.moveName;
  }) || event.moveName;
};

const getMoveData = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  attacker?: CalcdexPokemon,
) => getGenDexForFormat(state.format)?.moves.get(formatId(resolveEventMoveName(state, event, attacker)) as never) as {
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

// T4 (effectiveness contradiction, Group 4's signature): the multiplier a NATURAL attacking type
// would produce against a (possibly dual-type) defender, read straight off @smogon/calc's own type
// chart -- never reimplemented by hand, same policy as every damage multiplier in this file
const typeEffectivenessMultiplier = (
  dex: ReturnType<typeof getGenDexForFormat>,
  attackingType: Showdown.TypeName,
  defendingTypes: Showdown.TypeName[],
): number => (defendingTypes || []).reduce((multiplier, defendingType) => {
  const value = dex?.types?.get(formatId(attackingType) as never)?.effectiveness?.[defendingType];

  return multiplier * (typeof value === 'number' ? value : 1);
}, 1);

const effectivenessFromMultiplier = (
  multiplier: number,
): HackmonsInferenceEvent['effectiveness'] => {
  if (!multiplier) {
    return 'immune';
  }

  if (multiplier > 1) {
    return 'super';
  }

  if (multiplier < 1) {
    return 'resisted';
  }

  return 'neutral';
};

// whether this event's logged effectiveness line is impossible for the move's NATURAL type against
// the defender's known/snapshotted types -- direct evidence a type-changing ability (Pixilate,
// Normalize, ...) is in play, independent of whether the damage magnitude alone would've read as an
// outlier (Case D: "the effectiveness line is independent, near-conclusive evidence the damage math
// alone can't provide")
const eventEffectivenessContradicts = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  context: DamageEventContext,
): boolean => {
  if (!event?.effectiveness || context?.relation !== 'attacker') {
    return false;
  }

  const moveType = getMoveData(state, event)?.type;
  const defenderTypes = applyEventPokemonSnapshot(
    state.format,
    context.defenderMatch?.pokemon,
    event.defenderSnapshot,
  )?.types;

  if (!moveType || !defenderTypes?.length) {
    return false;
  }

  const dex = getGenDexForFormat(state.format);
  const naturalCategory = effectivenessFromMultiplier(typeEffectivenessMultiplier(dex, moveType, defenderTypes));

  return naturalCategory !== event.effectiveness;
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
  candidateSpreadStats: Partial<Showdown.StatsTable>,
  context: DamageEventContext,
  rollCache?: RollCache,
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
    logLikelihood: ErrorEventLogLikelihood,
    error,
  });

  const {
    dex,
    attackerMatch,
    defenderMatch,
    relation,
    relevantStats,
    eventField,
  } = context;

  if (!dex) {
    return emptyMatch('missing dex');
  }

  if (!attackerMatch?.pokemon) {
    return emptyMatch(`attacker lookup failed ${event.attackerKey || '?'}:${event.attackerName || '(unknown)'}`);
  }

  if (!defenderMatch?.pokemon) {
    return emptyMatch(`defender lookup failed ${event.defenderKey || '?'}:${event.defenderName || '(unknown)'}`);
  }

  if (!relation) {
    return emptyMatch('candidate relation failed');
  }

  // the damage rolls for this event are a pure function of the candidate's stats that actually feed
  // the calc (everything else here -- the non-candidate Pokemon, boosts, status, field, crit, hits --
  // is fixed for a given event), so cache them across the coordinate search to skip redundant calculate()s
  const rollKey = `${context.id}:${relation}:${modifierOverride?.id || 'none'}:${relevantStats
    .map((stat) => candidateSpreadStats?.[stat] ?? '')
    .join(',')}`;

  const cachedRolls = rollCache?.get(rollKey);
  let rolls = cachedRolls?.rolls;
  let rawRolls = cachedRolls?.rawRolls;

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
      useMax: !!event.attackerDynamaxed,
    } : applyInferencePokemonAssumptions(applyEventPokemonSnapshot(state.format, {
      ...attackerMatch.pokemon,
      boosts: cloneBoostSnapshot(event.attackerBoosts),
      status: event.attackerStatus ?? attackerMatch.pokemon.status,
      hitCounter: event.attackerHitCounter || 0,
      moveRepeatCount: event.attackerMoveRepeatCount || 0,
      defenseCurled: !!event.attackerDefenseCurled,
      useMax: !!event.attackerDynamaxed,
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
    const attackerWithEventHp = applyEventHp(
      applyEventFaintCount(attackerCandidate, event.attackerFaintCount),
      event.attackerStartHp,
      event.attackerMaxHp,
    );
    // the defender's HP was previously left at whatever it is RIGHT NOW, several turns after this
    // event -- wrong for anything that reads it (Multiscale, Crush Grip, Super Fang), and the reason
    // the persistent roll cache never survived a turn: the live value is part of the context
    // signature, so every past event re-keyed (and re-calculated) on every sync
    const defenderWithEventHp = applyEventHp(
      applyEventFaintCount(defenderCandidate, event.defenderFaintCount),
      event.startHp,
      event.maxHp,
    );

    try {
      const allPlayers = ['p1', 'p2', 'p3', 'p4']
        .filter((k: CalcdexPlayerKey) => state[k]?.active)
        .map((k: CalcdexPlayerKey) => state[k]);

      const field = createSmogonField(
        state.format,
        state.gameType,
        eventField,
        applyEventPlayerSide(attackerPlayer, event.attackerSide),
        applyEventPlayerSide(defenderPlayer, event.defenderSide),
        allPlayers,
      );

      const attacker = createSmogonPokemon(
        state.format,
        state.gameType,
        attackerWithEventHp,
        context.moveName,
        defenderWithEventHp,
      );

      if (!attacker) {
        return emptyMatch(`invalid attacker ${attackerMatch.pokemon.speciesForme || event.attackerName}`);
      }

      const smogonDefender = createSmogonPokemon(
        state.format,
        state.gameType,
        defenderWithEventHp,
        null,
        attackerWithEventHp,
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
            [context.moveName]: {
              ...attackerWithEventHp.moveOverrides?.[context.moveName],
              // Max moves can be selected as ordinary Hackmons Cup moves. Their dex BP is a display
              // placeholder, while maxMove.basePower carries the actual raw-move value (1); only a
              // logged Dynamax state upgrades an underlying move to its normal Max BP calculation.
              basePower: !event.attackerDynamaxed
                && dex.moves.get(formatId(context.moveName) as never)?.isMax
                ? 1
                : attackerWithEventHp.moveOverrides?.[context.moveName]?.basePower,
              alwaysCriticalHits: !!event.crit,
            },
          },
        },
        context.moveName,
        defenderWithEventHp,
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
        move.hits = resolveEventHitCount(event);
      }

      const mods: ShowdexCalcMods = {
        hitBasePowers: null,
        excludeHazardsDamage: true,
        excludeEotDamage: true,
      };

      const calculatedRolls = extractDamageRolls(calculate(dex, attacker, smogonDefender, move, field, mods));

      if (event.maxHp === 100) {
        rolls = calculatedRolls;
        rawRolls = calculatedRolls;
      } else {
        rolls = convertRollsForObservedHp(
          state,
          calculatedRolls,
          event.maxHp,
          smogonDefender,
        );
      }
    } catch (error) {
      return emptyMatch((error as Error)?.message || `calc failed for ${event.moveName}`);
    }

    if (!rolls.length) {
      return emptyMatch(`empty rolls for ${event.moveName}`);
    }

    rollCache?.set(rollKey, { rolls, rawRolls });

    // now-persistent across syncs (perf audit remedy #4) -- bound an individual mon's growth over a
    // very long battle the same way RollCacheStore bounds the number of mons tracked
    if (rollCache && rollCache.size > MaxRollCacheEntriesPerMon) {
      rollCache.delete(rollCache.keys().next().value);
    }
  }

  const percentPmf = event.maxHp === 100
    && rawRolls?.length
    && typeof candidateSpreadStats.hp === 'number'
    && candidateSpreadStats.hp > 0
    ? observedDamagePmf(rawRolls, event.startHp ?? 0, candidateSpreadStats.hp)
    : undefined;
  const median = percentPmf?.length
    ? medianDamagePmf(percentPmf)
    : medianDamageRoll(rolls);
  const minRoll = percentPmf?.[0]?.value ?? Math.min(...rolls);
  const maxRoll = percentPmf?.at(-1)?.value ?? Math.max(...rolls);

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
  const logLikelihood = damageEventLogLikelihood(
    rolls,
    normalizedObservedDamage,
    event.crit ? 0.25 : 1,
    ko,
    percentPmf,
  );

  return {
    eventId: event.id,
    turn: event.turn,
    moveName: event.moveName,
    observedDamage: normalizedObservedDamage,
    medianDamage: median,
    logLikelihood,
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
  moveName: MoveName;
  eventField: CalcdexBattleField;
  signature: string;
  /** Short stand-in for `signature` (see `internContextId()`), safe to use as a cache key. */
  id: string;
  dex: ReturnType<typeof getGenDexForFormat>;
}

interface SpeedEventContext {
  relation: EventRelation;
  samePriority: boolean;
  otherRawSpe: number;
  otherItemSpeedMultiplier: number;
}

// `hpOverridden` mirrors applyEventHp()'s own guard: when the event carries this side's HP, the
// live hp/maxhp/dirtyHp never reach the calc, so keeping them here would only make the signature --
// and with it the roll cache key -- churn on every turn for no modelled difference
const damagePokemonSignature = (
  pokemon?: CalcdexPokemon,
  hpOverridden?: boolean,
  faintCountOverridden?: boolean,
): unknown[] => [
  pokemon?.calcdexId,
  pokemon?.source,
  pokemon?.speciesForme,
  pokemon?.transformedForme,
  pokemon?.baseStats,
  pokemon?.dirtyBaseStats,
  pokemon?.transformedBaseStats,
  pokemon?.level,
  pokemon?.transformedLevel,
  pokemon?.gender,
  pokemon?.types,
  pokemon?.dirtyTypes,
  pokemon?.terastallized,
  pokemon?.teraType,
  pokemon?.dirtyTeraType,
  pokemon?.ability,
  pokemon?.dirtyAbility,
  pokemon?.abilityToggled,
  pokemon?.item,
  pokemon?.dirtyItem,
  pokemon?.nature,
  pokemon?.moves,
  pokemon?.moveOverrides,
  pokemon?.spreadStats,
  pokemon?.ivs,
  pokemon?.evs,
  hpOverridden ? null : pokemon?.hp,
  hpOverridden ? null : pokemon?.maxhp,
  hpOverridden ? null : pokemon?.dirtyHp,
  pokemon?.status,
  pokemon?.dirtyStatus,
  // toxicCounter (and saltcure below it in `volatiles`) only ever feed end-of-turn damage, which
  // ShowdexCalcMods excludes from every calc this file runs -- hashing a counter that ticks every
  // turn but can't move a roll only churns the cache key
  null,
  pokemon?.boosts,
  pokemon?.dirtyBoosts,
  pokemon?.boostedStat,
  pokemon?.dirtyBoostedStat,
  faintCountOverridden ? null : pokemon?.faintCounter,
  faintCountOverridden ? null : pokemon?.dirtyFaintCounter,
  pokemon?.useMax,
  pokemon?.volatiles,
];

const damageContextSignature = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  context: Omit<DamageEventContext, 'signature' | 'id' | 'dex'>,
): string => {
  // exactly applyEventHp()'s guard, for each side
  const hpOverridden = (hp?: number, maxHp?: number): boolean => (
    typeof hp === 'number' && typeof maxHp === 'number' && !!maxHp
  );

  const playerSignature = (playerKey?: CalcdexPlayerKey, sideOverridden?: boolean): unknown => {
    const player = playerKey ? state[playerKey] : null;
    const selected = typeof player?.selectionIndex === 'number'
      ? player.pokemon?.[player.selectionIndex]
      : null;

    return [
      // the screens & Tailwind now come from the event, so only the rest of the side still matters
      // here (Helping Hand, Friend Guard, the pledges, ... -- none of which are snapshotted yet)
      sideOverridden
        ? {
          ...player?.side,
          isReflect: null,
          isLightScreen: null,
          isAuroraVeil: null,
          isTailwind: null,
        }
        : player?.side,
      player?.selectionIndex,
      player?.activeIndices,
      selected?.calcdexId,
      selected?.ability,
      selected?.dirtyAbility,
    ];
  };

  // createSmogonField() reads nothing but the Ruin counters off the OTHER players' sides
  const ruinSignature = (playerKey?: CalcdexPlayerKey): unknown => {
    const side = (playerKey ? state[playerKey] : null)?.side;

    return [side?.ruinBeadsCount, side?.ruinSwordCount, side?.ruinTabletsCount, side?.ruinVesselCount];
  };

  return JSON.stringify([
    event.attackerSlot,
    event.attackerId,
    event.attackerKey,
    event.attackerName,
    event.defenderSlot,
    event.defenderId,
    event.defenderKey,
    event.defenderName,
    event.attackerStartHp,
    event.attackerMaxHp,
    event.startHp,
    event.maxHp,
    event.attackerSide,
    event.defenderSide,
    event.attackerFaintCount,
    event.defenderFaintCount,
    !!event.crit,
    resolveEventHitCount(event),
    !!event.attackerDynamaxed,
    event.attackerHitCounter || 0,
    event.attackerMoveRepeatCount || 0,
    !!event.attackerDefenseCurled,
    cloneBoostSnapshot(event.attackerBoosts),
    cloneBoostSnapshot(event.defenderBoosts),
    event.attackerStatus || '',
    event.defenderStatus || '',
    event.attackerSnapshot,
    event.defenderSnapshot,
    context.attackerMatch?.playerKey,
    damagePokemonSignature(
      context.attackerMatch?.pokemon,
      hpOverridden(event.attackerStartHp, event.attackerMaxHp),
      typeof event.attackerFaintCount === 'number',
    ),
    context.defenderMatch?.playerKey,
    damagePokemonSignature(
      context.defenderMatch?.pokemon,
      hpOverridden(event.startHp, event.maxHp),
      typeof event.defenderFaintCount === 'number',
    ),
    context.relation,
    context.influence,
    context.relevantStats,
    context.moveName,
    context.eventField,
    playerSignature(context.attackerMatch?.playerKey, !!event.attackerSide),
    playerSignature(context.defenderMatch?.playerKey, !!event.defenderSide),
    (['p1', 'p2', 'p3', 'p4'] as CalcdexPlayerKey[]).map(ruinSignature),
  ]);
};

// the roll cache is keyed by damage-event context, and a context's `signature` is a multi-KB JSON
// blob -- rehashing it on every one of the (candidates x contexts) roll-cache lookups was ~2/3 of
// the search's self time. Each distinct signature is interned to a short id used in its place. Ids
// are never reused (the counter only ever increases), so an evicted signature just misses the roll
// cache on its next sync instead of colliding with another context's rolls
const ContextIdStore = new Map<string, string>();
const MaxContextIdEntries = 4096;
let contextIdCounter = 0;

const internContextId = (
  signature: string,
): string => {
  const existing = ContextIdStore.get(signature);

  if (existing) {
    return existing;
  }

  const id = `c${++contextIdCounter}`;

  ContextIdStore.set(signature, id);

  if (ContextIdStore.size > MaxContextIdEntries) {
    ContextIdStore.delete(ContextIdStore.keys().next().value);
  }

  return id;
};

// the same (mon, event) context is resolved from every stage of the pipeline -- event selection,
// grouping, the phase 1 search and one re-search per modifier hypothesis -- so an event's signature
// was being rebuilt a dozen-plus times per sync, which is what made the cost scale with a long
// battle log. `state` doesn't change during a sync, so the resolution is memoized for the duration
// of one inferHackmonsSpread() call and cleared on its next entry
const DamageContextMemo = new Map<string, DamageEventContext>();

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
  const memoKey = `${candidatePokemon?.calcdexId || ''}|${event.id}`;
  const memoized = DamageContextMemo.get(memoKey);

  if (memoized) {
    return memoized;
  }

  const attackerMatch = findPokemonByLogName(state, event.attackerName, event.attackerKey, event.attackerId);
  const defenderMatch = findPokemonByLogName(state, event.defenderName, event.defenderKey, event.defenderId);
  const relation: EventRelation = attackerMatch?.pokemon?.calcdexId === candidatePokemon.calcdexId
    ? 'attacker'
    : defenderMatch?.pokemon?.calcdexId === candidatePokemon.calcdexId
      ? 'defender'
      : null;
  const moveName = resolveEventMoveName(state, event, attackerMatch?.pokemon);
  const influence = getMoveInfluence(state, { ...event, moveName });
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

  const context: Omit<DamageEventContext, 'signature' | 'id' | 'dex'> = {
    attackerMatch,
    defenderMatch,
    relation,
    influence,
    relevantStats: StatNames.filter((stat) => relevantStats.has(stat)),
    moveName,
    eventField: applyEventFieldSnapshot(state.field, event.field),
  };

  const signature = damageContextSignature(state, event, context);
  const resolved: DamageEventContext = {
    ...context,
    signature,
    id: internContextId(signature),
    // invariant for the whole search (it only depends on the format), but getGenDexForFormat()
    // rebuilds the entire dex object on every call, so resolving it per candidate was ~14% of the
    // search on its own
    dex: getGenDexForFormat(state.format),
  };

  DamageContextMemo.set(memoKey, resolved);

  return resolved;
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

interface CandidateSpeedValues {
  candidateSpeed: number;
  otherSpeed: number;
}

const resolveCandidateSpeedValues = (
  event: HackmonsInferenceEvent,
  candidateSpreadStats: Partial<Showdown.StatsTable>,
  context: SpeedEventContext,
  modifierOverride?: ModifierOverride,
): CandidateSpeedValues | null => {
  if (!context?.relation || !context.otherRawSpe) {
    return null;
  }

  const candidateRawSpe = candidateSpreadStats?.spe;

  if (!candidateRawSpe) {
    return null;
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

  return { candidateSpeed, otherSpeed };
};

const evaluateCandidateSpeedEvent = (
  event: HackmonsInferenceEvent,
  candidateSpreadStats: Partial<Showdown.StatsTable>,
  context: SpeedEventContext,
  modifierOverride?: ModifierOverride,
): number => {
  if (!context?.samePriority) {
    return 0;
  }

  const speedValues = resolveCandidateSpeedValues(
    event,
    candidateSpreadStats,
    context,
    modifierOverride,
  );

  if (!speedValues) {
    return 32;
  }

  // Showdown breaks exact speed ties by coin flip, so moving first only requires >= (not strictly >)
  // the other mon's speed -- and moving second only requires <=. Treating equality as a violation
  // (the previous +1/-1) fabricates a contradiction whenever a mon is observed on both sides of a
  // true tie, which pushes the search away from the correct Spe instead of settling on it.
  if (context.relation === 'attacker') {
    return speedValues.otherSpeed - speedValues.candidateSpeed;
  }

  return speedValues.candidateSpeed - speedValues.otherSpeed;
};

interface DamageEventGroup {
  event: HackmonsInferenceEvent;
  context: DamageEventContext;
  count: number;
}

const scoreCandidate = (
  state: CalcdexBattleState,
  damageGroups: DamageEventGroup[],
  speedEvents: HackmonsInferenceEvent[],
  defender: CalcdexPokemon,
  nature: Showdown.PokemonNature,
  ivs: Showdown.StatsTable,
  evs: Showdown.StatsTable,
  speedContexts: Map<string, SpeedEventContext>,
  rollCache?: RollCache,
  modifierOverride?: ModifierOverride,
): number => {
  const candidateSpreadStats = calcPokemonSpreadStats(state.format, {
    ...defender,
    nature,
    ivs,
    evs,
  });
  let score = 0;

  speedEvents.forEach((event) => {
    const context = speedContexts.get(event.id);

    if (!context?.samePriority) {
      return;
    }

    const speedValues = resolveCandidateSpeedValues(
      event,
      candidateSpreadStats,
      context,
      modifierOverride,
    );

    if (!speedValues) {
      score += ErrorEventLogLikelihood;
      return;
    }

    const margin = context.relation === 'attacker'
      ? speedValues.otherSpeed - speedValues.candidateSpeed
      : speedValues.candidateSpeed - speedValues.otherSpeed;

    score += speedEventLogLikelihood(margin, speedValues.candidateSpeed, speedValues.otherSpeed);
  });

  damageGroups.forEach(({ event, context, count }) => {
    const match = evaluateCandidateEvent(
      state,
      event,
      defender,
      nature,
      ivs,
      evs,
      candidateSpreadStats,
      context,
      rollCache,
      modifierOverride,
    );

    score += match.logLikelihood * count;
  });

  return score;
};

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
  rollCache?: RollCache,
  modifierOverride?: ModifierOverride,
): HackmonsExtremalFeasibility => {
  const stats = context.relevantStats.filter((stat) => stat !== 'hp') as Showdown.StatNameNoHp[];

  if (!stats.length || event.crit || event.eventType === 'speed') {
    return {};
  }

  const high = extremalSpread(state.format, stats, 'high');
  const low = extremalSpread(state.format, stats, 'low');
  const highSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature: high.nature,
    ivs: high.ivs,
    evs: high.evs,
  });
  const lowSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature: low.nature,
    ivs: low.ivs,
    evs: low.evs,
  });
  const highMatch = evaluateCandidateEvent(
    state,
    event,
    candidatePokemon,
    high.nature,
    high.ivs,
    high.evs,
    highSpreadStats,
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
    lowSpreadStats,
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

// audit fold F3: replaces the old hardcoded 'ChoiceModifierIds'/'item-both-1.3' id checks -- a
// class's disqualifying evidence is now declared on the catalog entry itself (see A1's split above,
// where the item-slot Choice Band class keeps 'choice-lock' but the ability-slot Gorilla
// Tactics/Hustle class doesn't), so adding a future disqualifiable class is a data change, not a new
// branch here or at the speed-side call site below
const disqualifiedByEvidence = (
  modifier: HackmonsModifierClass,
  choiceLockDisqualified: boolean,
  recoilDisqualifiesLifeOrb: boolean,
): boolean => (
  (modifier.disqualifiers?.includes('choice-lock') && choiceLockDisqualified)
    || (modifier.disqualifiers?.includes('no-recoil') && recoilDisqualifiesLifeOrb)
);

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

// the candidate's own CalcdexPokemon for this event's role -- resolveEventRelation() already
// guarantees attackerMatch/defenderMatch resolves to the candidate on whichever side `relation`
// names, so this is just picking the right side rather than a fresh lookup
const eventCandidatePokemon = (
  context: DamageEventContext,
): CalcdexPokemon => (
  context?.relation === 'attacker' ? context.attackerMatch?.pokemon : context.defenderMatch?.pokemon
);

// species-conditional predicate (Eviolite): reads the real dex's `nfe` flag rather than hand-rolling
// an NFE species list, same accessor pattern as every other dex lookup in this file
const isCandidateNfe = (
  state: CalcdexBattleState,
  context: DamageEventContext,
): boolean => {
  const pokemon = eventCandidatePokemon(context);
  const dex = getGenDexForFormat(state.format);
  const speciesId = formatId(pokemon?.transformedForme || pokemon?.speciesForme);

  return !!speciesId && !!dex?.species.get(speciesId as never)?.nfe;
};

interface ModifierProposalRule {
  id: string;
  relation: 'attacker' | 'defender';
  outlierDirection: HackmonsDamageOutlier;
  offensiveStats?: ('atk' | 'spa')[];
  defensiveStats?: ('def' | 'spd')[];
  proposeWhen?: (state: CalcdexBattleState, event: HackmonsInferenceEvent, context: DamageEventContext) => boolean;
}

// audit fold F2: one data row per T1 magnitude class, replacing the old inline if-chain --
// `directEvidence` classes (Parental Bond, Group 4's -ate/Normalize) aren't here, they're proposed by
// their own trigger collectors instead (collectParentalBondTriggers/collectTypeChangeTrigger), since
// their evidence shape isn't a single-event magnitude outlier at all
const ModifierProposalRules: ModifierProposalRule[] = [
  {
    id: 'ability-atk-2', relation: 'attacker', outlierDirection: 'too-high', offensiveStats: ['atk'],
  },
  {
    id: 'item-atk-1.5', relation: 'attacker', outlierDirection: 'too-high', offensiveStats: ['atk'],
  },
  {
    id: 'ability-atk-1.5', relation: 'attacker', outlierDirection: 'too-high', offensiveStats: ['atk'],
  },
  {
    id: 'item-atk-1.1', relation: 'attacker', outlierDirection: 'too-high', offensiveStats: ['atk'],
  },
  {
    id: 'item-both-1.3', relation: 'attacker', outlierDirection: 'too-high', offensiveStats: ['atk', 'spa'],
  },
  {
    id: 'item-spa-1.5', relation: 'attacker', outlierDirection: 'too-high', offensiveStats: ['spa'],
  },
  {
    id: 'item-spa-1.1', relation: 'attacker', outlierDirection: 'too-high', offensiveStats: ['spa'],
  },
  {
    id: 'ability-waterbubble-water-dealt-2',
    relation: 'attacker',
    outlierDirection: 'too-high',
    offensiveStats: ['atk', 'spa'],
    proposeWhen: (state, event) => getMoveData(state, event)?.type === 'Water',
  },
  {
    id: 'ability-tintedlens-resisted-dealt-2',
    relation: 'attacker',
    outlierDirection: 'too-high',
    proposeWhen: (_state, event) => event.effectiveness === 'resisted',
  },
  {
    id: 'ability-atk-0.5', relation: 'attacker', outlierDirection: 'too-low', offensiveStats: ['atk'],
  },
  {
    id: 'ability-def-2', relation: 'defender', outlierDirection: 'too-low', defensiveStats: ['def'],
  },
  {
    id: 'ability-special-taken-0.5', relation: 'defender', outlierDirection: 'too-low', defensiveStats: ['spd'],
  },
  {
    id: 'item-spd-1.5', relation: 'defender', outlierDirection: 'too-low', defensiveStats: ['spd'],
  },
  {
    id: 'item-eviolite-defspd-1.5',
    relation: 'defender',
    outlierDirection: 'too-low',
    defensiveStats: ['def', 'spd'],
    proposeWhen: (state, _event, context) => isCandidateNfe(state, context),
  },
  {
    id: 'ability-se-taken-0.75',
    relation: 'defender',
    outlierDirection: 'too-low',
    proposeWhen: (_state, event) => event.effectiveness === 'super',
  },
  {
    id: 'ability-full-hp-taken-0.5',
    relation: 'defender',
    outlierDirection: 'too-low',
    proposeWhen: (_state, event) => event.startHp === event.maxHp,
  },
  {
    id: 'ability-thickfat-fireice-0.5',
    relation: 'defender',
    outlierDirection: 'too-low',
    proposeWhen: (state, event) => ['Fire', 'Ice'].includes(getMoveData(state, event)?.type),
  },
  {
    id: 'ability-heatproof-fire-taken-0.5',
    relation: 'defender',
    outlierDirection: 'too-low',
    proposeWhen: (state, event) => getMoveData(state, event)?.type === 'Fire',
  },
  {
    id: 'ability-purifyingsalt-ghost-taken-0.5',
    relation: 'defender',
    outlierDirection: 'too-low',
    proposeWhen: (state, event) => getMoveData(state, event)?.type === 'Ghost',
  },
  {
    // `too-high` twins: the defender takes MORE than max roll from a Fire hit
    id: 'ability-fluffy-fire-taken-2',
    relation: 'defender',
    outlierDirection: 'too-high',
    proposeWhen: (state, event) => getMoveData(state, event)?.type === 'Fire',
  },
  {
    id: 'ability-dryskin-fire-taken-1.25',
    relation: 'defender',
    outlierDirection: 'too-high',
    proposeWhen: (state, event) => getMoveData(state, event)?.type === 'Fire',
  },
];

const modifierClassesForTrigger = (
  state: CalcdexBattleState,
  trigger: ModifierTrigger,
  pinnedSlots: Set<'item' | 'ability'>,
  contradictingEventIds: Set<string>,
): HackmonsModifierClass[] => {
  const { event, context, outlier } = trigger;

  // an effectiveness-contradicting event (T4's signature) can ONLY be explained by a type-changing
  // ability (Group 4) -- a plain magnitude ability/item never touches the battle log's effectiveness
  // line, so proposing one here would just be a wrong explanation that happens to also fit the damage
  // numbers (Case D). typeChangeModifierClasses() is what proposes the correct hypothesis for it.
  // Audit fold F4: the contradicting-event set is computed once by collectTypeChangeTrigger() and
  // passed in here, rather than re-running eventEffectivenessContradicts() per trigger.
  if (contradictingEventIds.has(event.id)) {
    return [];
  }

  return ModifierProposalRules
    .filter((rule) => (
      rule.relation === context.relation
        && rule.outlierDirection === outlier
        && (!rule.offensiveStats || rule.offensiveStats.includes(context.influence.offensiveStat as 'atk' | 'spa'))
        && (!rule.defensiveStats || rule.defensiveStats.includes(context.influence.defensiveStat as 'def' | 'spd'))
        && (!rule.proposeWhen || rule.proposeWhen(state, event, context))
    ))
    .map((rule) => modifierById(rule.id))
    .filter((modifier) => modifier && !pinnedSlots.has(modifier.slot));
};

const collectModifierTriggers = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  matches: HackmonsDamageMatch[],
  contexts: Map<string, DamageEventContext>,
  rollCache?: RollCache,
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
  directEvidence: true,
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
// Parental Bond's own `onPrepareHit()` in the sim bails out on a move that's already `multihit`, so a
// 2-hit shape on a real dex multi-hit move is the move's own doing and never this ability. Dragon
// Darts is the case that gets here: smart targeting suppresses its `-hitcount` line, so it arrives
// looking exactly like a Parental Bond hit pair, and a second hit truncated by the KO it caused lands
// the ratio right inside the window below.
const parentalBondCanApply = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
): boolean => {
  const move = getGenDexForFormat(state.format)?.moves.get(formatId(event.moveName) as never) as {
    multihit?: number | number[];
  };

  return !move?.multihit;
};

const collectParentalBondTriggers = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  contexts: Map<string, DamageEventContext>,
): ParentalBondTrigger[] => events
  .filter((event) => (
    event.eventType !== 'speed'
      && !event.crit
      && event.hitDamages?.length === 2
      && contexts.get(event.id)?.relation === 'attacker'
      && parentalBondCanApply(state, event)
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

interface TypeChangeTrigger {
  contradictingEventIds: string[];
}

// T4: -ate/Normalize are battle-long ability effects on the candidate (not per-event), so this is a
// single aggregate trigger (mirrors collectSpeedTrigger's shape) rather than a per-event list like T1
const collectTypeChangeTrigger = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  contexts: Map<string, DamageEventContext>,
): TypeChangeTrigger | null => {
  const contradicting = events.filter((event) => (
    event.eventType !== 'speed'
      && !event.crit
      && eventEffectivenessContradicts(state, event, contexts.get(event.id))
  ));

  return contradicting.length ? { contradictingEventIds: contradicting.map((event) => event.id) } : null;
};

// scope/type derivation (§4 Group 4): the changed type is DERIVED, not guessed -- a candidate class
// survives only if it makes EVERY observed effectiveness line, across EVERY event this attacker's
// matching-natural-type moves produced (not just the one(s) that triggered T4), consistent. Multiple
// survivors are a genuine tie (e.g. a pure Dragon defender can't distinguish Ice from Fairy) -- adopted
// via the same best-of ranking every other group uses, same as the rest of this file's ties
const typeChangeModifierClasses = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  contexts: Map<string, DamageEventContext>,
  pinnedSlots: Set<'item' | 'ability'>,
): HackmonsModifierClass[] => {
  if (pinnedSlots.has('ability')) {
    return [];
  }

  const dex = getGenDexForFormat(state.format);
  const attackerEvents = events.filter((event) => (
    event.eventType !== 'speed' && !event.crit && contexts.get(event.id)?.relation === 'attacker' && !!event.effectiveness
  ));

  const isConsistent = (
    naturalType: Showdown.TypeName,
    changedType: Showdown.TypeName,
  ): boolean => attackerEvents
    .filter((event) => getMoveData(state, event)?.type === naturalType)
    .every((event) => {
      const context = contexts.get(event.id);
      const defenderTypes = applyEventPokemonSnapshot(
        state.format,
        context.defenderMatch?.pokemon,
        event.defenderSnapshot,
      )?.types;

      if (!defenderTypes?.length) {
        return true;
      }

      return effectivenessFromMultiplier(typeEffectivenessMultiplier(dex, changedType, defenderTypes)) === event.effectiveness;
    });

  const classes: HackmonsModifierClass[] = [];
  const hasNormalMove = attackerEvents.some((event) => getMoveData(state, event)?.type === 'Normal');

  if (hasNormalMove) {
    (Object.keys(AteModifierByType) as Showdown.TypeName[]).forEach((changedType) => {
      if (isConsistent('Normal', changedType)) {
        classes.push(AteModifierByType[changedType]);
      }
    });
  }

  const nonNormalTypes = new Set(
    attackerEvents.map((event) => getMoveData(state, event)?.type).filter((type) => type && type !== 'Normal'),
  );

  if (nonNormalTypes.size && [...nonNormalTypes].every((type) => isConsistent(type, 'Normal'))) {
    classes.push(NormalizeModifier);
  }

  return classes;
};

const evaluatePublishedMatches = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  candidate: SpreadCandidate,
  contexts: Map<string, DamageEventContext>,
  rollCache?: RollCache,
  modifierOverride?: ModifierOverride,
): HackmonsDamageMatch[] => {
  // eslint-disable-next-line no-use-before-define
  const selectedEvents = selectScoringEvents(state, events, candidatePokemon, contexts);
  const candidateSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature: candidate.nature,
    ivs: candidate.ivs,
    evs: candidate.evs,
  });

  return selectedEvents
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
      candidateSpreadStats,
      context,
      rollCache,
      modifierOverride,
    );

    return { ...match, outlier: outlierDirection(match) };
  });
};

const searchModifierHypotheses = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  phaseOneMatches: HackmonsDamageMatch[],
  phaseOneContexts: Map<string, DamageEventContext>,
  triggers: ModifierTrigger[],
  jointConflictTriggers: JointConflictTrigger[],
  parentalBondTriggers: ParentalBondTrigger[],
  typeChangeTrigger: TypeChangeTrigger | null,
  rollCache?: RollCache,
  phaseOneBest?: SpreadCandidate,
): { adopted?: ModifierSearchResult; possible: HackmonsInferredModifier[]; } => {
  if (!triggers.length && !jointConflictTriggers.length && !parentalBondTriggers.length && !typeChangeTrigger) {
    return { possible: [] };
  }

  const pinnedSlots = computePinnedSlots(candidatePokemon, events, phaseOneContexts);

  const hypotheses = new Map<string, HackmonsModifierClass>();

  // audit fold F4: computed once here (rather than re-running eventEffectivenessContradicts() per
  // trigger inside modifierClassesForTrigger()) and reused below for typeChangeContradictingEvents too
  const contradictingEventIds = new Set(typeChangeTrigger?.contradictingEventIds || []);

  triggers.forEach((trigger) => {
    modifierClassesForTrigger(state, trigger, pinnedSlots, contradictingEventIds)
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

  // Group 4 (-ate/Normalize): the changed type is derived from every attacker-side event this mon
  // produced, not just the trigger's own contradicting ones -- see typeChangeModifierClasses()
  if (typeChangeTrigger) {
    typeChangeModifierClasses(state, events, phaseOneContexts, pinnedSlots)
      .forEach((modifier) => hypotheses.set(modifier.id, modifier));
  }

  if (!hypotheses.size) {
    return { possible: [] };
  }

  const endTimer = runtimer(lSearchModifiers.scope, lSearchModifiers);

  const typeChangeContradictingEvents = [...contradictingEventIds]
    .map((id) => ({ event: events.find((event) => event.id === id), context: phaseOneContexts.get(id) }))
    .filter(({ event }) => !!event);

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
    ...typeChangeContradictingEvents.map(({ event, context }) => ({
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
    if (disqualifiedByEvidence(modifier, choiceLockDisqualified, recoilDisqualifiesLifeOrb)) {
      return;
    }

    const modifierOverride = modifierOverrideFromClass(modifier);
    // eslint-disable-next-line no-use-before-define
    const candidates = searchBestCandidates(state, events, candidatePokemon, rollCache, modifierOverride, phaseOneBest);
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
      candidateSpread: { nature: candidate.nature, ivs: candidate.ivs, evs: candidate.evs },
    };

    // A1 (feasibility-only adoption) assumes outlier-magnitude evidence -- `directEvidence` classes
    // (Parental Bond's hit-SHAPE, Group 4's effectiveness-CONTRADICTION) are direct and don't need a
    // magnitude outlier to already exist (the shape/contradiction is proof on its own). Audit fold F1:
    // replaces the old hardcoded id checks against 'ability-parental-bond'/'TypeChangeModifierIds'.
    const requiresEliminatedOutlier = !modifier.directEvidence;

    if (!supportIds.length || collateral || (requiresEliminatedOutlier && !eliminatedOutliers)) {
      return;
    }

    if (supportIds.length < 2) {
      possible.push(inferredModifier);
      return;
    }

    evaluated.push({
      candidate,
      matches,
      inferredModifier: {
        ...inferredModifier,
        adopted: true,
      },
      remainingOutliers,
      score: candidate.score,
    });
  });

  const adopted = evaluated
    .sort((a, b) => (
      a.remainingOutliers - b.remainingOutliers
        || b.inferredModifier.supportingEventIds.length - a.inferredModifier.supportingEventIds.length
        || b.score - a.score
    ))[0];

  endTimer('searchModifierHypotheses() ->', hypotheses.size, 'hypotheses searched, adopted:', adopted?.inferredModifier.modifier.id || '(none)');

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
// T3 guard (audit finding, §12): a speed-order event only reflects raw Speed if BOTH moves shared the
// same priority bracket -- flushSpeedOrderEvents() (parseStepQueue.ts) builds a 'speed' event between
// every adjacent differing-attacker pair in a turn's move order with no priority filter at all, so a
// priority move going first (Gale Wings, Prankster, Quick Claw, ...) would otherwise be misread as a
// Speed-infeasibility (false Scarf-class T3 trigger) even though priority alone decided that order,
// independent of either mon's real Speed stat. Mirrors the existing Trick Room/Tailwind suppression
// pattern -- this just excludes the event from evidence entirely rather than proposing a competing
// hypothesis for it.
const eventHasPriorityMismatch = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
): boolean => {
  const dex = getGenDexForFormat(state.format);
  const fasterPriority = dex?.moves.get(formatId(event.moveName) as never)?.priority || 0;
  const slowerPriority = dex?.moves.get(formatId(event.slowerMoveName) as never)?.priority || 0;

  return fasterPriority !== slowerPriority;
};

const collectSpeedTrigger = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  speedContexts: Map<string, SpeedEventContext>,
): SpeedTrigger | null => {
  const speedEvents = events.filter((event) => (
    event.eventType === 'speed' && !event.speedOrderSuppressed && !eventHasPriorityMismatch(state, event)
  ));

  if (!speedEvents.length) {
    return null;
  }

  const high = extremalSpread(state.format, ['spe'], 'high');
  const low = extremalSpread(state.format, ['spe'], 'low');
  const highSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature: high.nature,
    ivs: high.ivs,
    evs: high.evs,
  });
  const lowSpreadStats = calcPokemonSpreadStats(state.format, {
    ...candidatePokemon,
    nature: low.nature,
    ivs: low.ivs,
    evs: low.evs,
  });

  const fasterInfeasible = speedEvents.filter((event) => {
    const context = speedContexts.get(event.id);

    return context?.relation === 'attacker'
      && evaluateCandidateSpeedEvent(event, highSpreadStats, context) > 0;
  });

  if (fasterInfeasible.length) {
    return { direction: 'faster', contributingEventIds: fasterInfeasible.map((event) => event.id) };
  }

  const slowerInfeasible = speedEvents.filter((event) => {
    const context = speedContexts.get(event.id);

    return context?.relation === 'defender'
      && evaluateCandidateSpeedEvent(event, lowSpreadStats, context) > 0;
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
  rollCache?: RollCache,
  seedCandidate?: SpreadCandidate,
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
    if (disqualifiedByEvidence(modifier, choiceLockDisqualified, false)) {
      return;
    }

    const modifierOverride = mergeModifierOverrides(baseOverride, modifierOverrideFromClass(modifier));
    // eslint-disable-next-line no-use-before-define
    const [candidate] = searchBestCandidates(state, events, candidatePokemon, rollCache, modifierOverride, seedCandidate);

    if (!candidate) {
      return;
    }

    const candidateSpreadStats = calcPokemonSpreadStats(state.format, {
      ...candidatePokemon,
      nature: candidate.nature,
      ivs: candidate.ivs,
      evs: candidate.evs,
    });

    // A1/A2: adoption must actually eliminate the contradiction, and must not introduce a NEW
    // speed-bound violation anywhere else
    const remainingSpeedViolations = speedEvents.filter((event) => {
      const context = speedContexts.get(event.id);

      return evaluateCandidateSpeedEvent(event, candidateSpreadStats, context, modifierOverride) > 0;
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
      candidateSpread: { nature: candidate.nature, ivs: candidate.ivs, evs: candidate.evs },
    };

    // A3: support threshold -- v1 has no speed-side corroboration source, so require >= 2 raw events
    if (trigger.contributingEventIds.length < 2) {
      possible.push(inferredModifier);
      return;
    }

    evaluated.push({
      candidate,
      inferredModifier: { ...inferredModifier, adopted: true },
      score: candidate.score,
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
  damageGroups: DamageEventGroup[],
  speedEvents: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  nature: Showdown.PokemonNature,
  ivs: Showdown.StatsTable,
  evs: Showdown.StatsTable,
  speedContexts: Map<string, SpeedEventContext>,
  rollCache?: RollCache,
  modifierOverride?: ModifierOverride,
): SpreadCandidate => ({
  nature,
  ivs: cloneSpread(ivs),
  evs: cloneSpread(evs),
  score: scoreCandidate(state, damageGroups, speedEvents, candidatePokemon, nature, ivs, evs, speedContexts, rollCache, modifierOverride),
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
  candidatePokemon: CalcdexPokemon,
  damageContexts = new Map<string, DamageEventContext>(),
): HackmonsInferenceEvent[] => {
  const selected = new Map<string, HackmonsInferenceEvent>();

  events.forEach((event) => selected.set(event.id, event));

  const contextGroups = new Set<string>();

  return [...selected.values()]
    .sort((a, b) => a.turn - b.turn)
    .filter((event) => {
      if (event.eventType === 'speed') {
        return true;
      }

      const context = damageContexts.get(event.id) || resolveDamageEventContext(state, event, candidatePokemon);

      if (contextGroups.has(context.signature)) {
        return true;
      }

      if (contextGroups.size >= MaxDamageContextGroups) {
        return false;
      }

      contextGroups.add(context.signature);

      return true;
    });
};

const damageEventGroupKey = (
  state: CalcdexBattleState,
  event: HackmonsInferenceEvent,
  context: DamageEventContext,
): string => JSON.stringify({
  context: context.signature,
  observed: normalizeObservedDamage(state, event.damage || 0, event.maxHp),
  ko: event.endHp === 0,
  startHp: event.maxHp === 100 ? event.startHp : undefined,
});

const groupDamageEvents = (
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  damageContexts: Map<string, DamageEventContext>,
): DamageEventGroup[] => {
  const groups = new Map<string, DamageEventGroup>();

  events
    .filter((event) => event.eventType !== 'speed')
    .forEach((event) => {
      const context = damageContexts.get(event.id) || resolveDamageEventContext(state, event, candidatePokemon);
      const key = damageEventGroupKey(state, event, context);
      const existing = groups.get(key);

      if (existing) {
        existing.count += 1;
        return;
      }

      groups.set(key, { event, context, count: 1 });
    });

  return [...groups.values()];
};

function searchBestCandidates(
  state: CalcdexBattleState,
  events: HackmonsInferenceEvent[],
  candidatePokemon: CalcdexPokemon,
  rollCache?: RollCache,
  modifierOverride?: ModifierOverride,
  // warm-start: seed the descent from a nearby known-good candidate (e.g. phase 1's winner) instead of
  // the blank neutral spread -- every pass still sweeps the full IV/EV/nature grid per stat (see below),
  // so this only changes the starting point of an otherwise-unchanged exhaustive search, not its breadth.
  // Perf audit remedy #2 (dropping to 1 coarse pass when seeded) was tried and reverted: the `hustle`
  // scenario converged to a different, wrong hypothesis (`item-atk-1.1` over the intended
  // `ability-atk-1.5`) with only 1 pass, so a modifier's true optimum isn't reliably a local
  // perturbation of phase 1's winner -- this remedy needs a correctness-preserving redesign (e.g. an
  // event-affectedness check backed by @smogon/calc itself, not a pass-count guess) before it's safe.
  seed?: SpreadCandidate,
): SpreadCandidate[] {
  const endTimer = runtimer(lSearchCandidates.scope, lSearchCandidates);
  const scoringEvents = selectScoringEvents(state, events, candidatePokemon);
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

  const damageGroups = groupDamageEvents(state, scoringEvents, candidatePokemon, damageContexts);
  const speedEvents = scoringEvents.filter((event) => event.eventType === 'speed');

  const score = (
    nature: Showdown.PokemonNature,
    ivs: Showdown.StatsTable,
    evs: Showdown.StatsTable,
  ): SpreadCandidate => scoreSpreadCandidate(
    state,
    damageGroups,
    speedEvents,
    candidatePokemon,
    nature,
    ivs,
    evs,
    speedContexts,
    rollCache,
    modifierOverride,
  );

  const baseIvs = seed ? cloneSpread(seed.ivs) : blankSpread(DefaultIv);
  const baseEvs = seed ? cloneSpread(seed.evs) : blankSpread(DefaultEv);
  const baseNature = seed?.nature || NeutralNature;

  let best = score(baseNature, baseIvs, baseEvs);

  const seen = new Map<string, SpreadCandidate>();
  let exhausted = false;
  const remember = (
    nature: Showdown.PokemonNature,
    ivs: Showdown.StatsTable,
    evs: Showdown.StatsTable,
  ) => {
    if (seen.size >= MaxCandidateCount) {
      // Preserve the final score that the previous score-then-cap-check ordering performed before
      // terminating this traversal.
      score(nature, ivs, evs);
      exhausted = true;
      return;
    }

    const key = candidateKey({
      nature,
      ivs,
      evs,
      score: 0,
    });

    if (seen.has(key)) {
      return;
    }

    const candidate = score(nature, ivs, evs);

    seen.set(key, candidate);

    if (candidate.score > best.score) {
      best = candidate;
    }
  };

  seen.set(candidateKey(best), best);

  PokemonNatures.forEach((nature) => remember(nature, best.ivs, best.evs));

  for (let pass = 0; pass < 3 && !exhausted; pass++) {
    for (const stat of searchStats) {
      for (const iv of CandidateIvs) {
        for (const ev of CoordinateCandidateEvs) {
          if (exhausted) {
            break;
          }

          remember(best.nature, { ...best.ivs, [stat]: iv }, { ...best.evs, [stat]: ev });
        }
      }

      for (const nature of PokemonNatures) {
        remember(nature, best.ivs, best.evs);
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

          remember(refinedBest.nature, { ...refinedBest.ivs, [stat]: iv }, { ...refinedBest.evs, [stat]: ev });
        }
      }

      refinedBest = best;

      if (exhausted) {
        break;
      }
    }
  }

  endTimer(
    'searchBestCandidates() ->', seen.size, 'candidates,', scoringEvents.length, 'scoring events,',
    modifierOverride?.id || '(no modifier)',
  );

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
  if (!isInferenceFormat(state?.format)) {
    return {};
  }

  DamageContextMemo.clear();

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
      .map((event) => `${event.id}:${event.damage || ''}:${event.maxHp || ''}:${event.startHp ?? ''}:${eventSnapshotSignature(event)}`)
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

    const endMonTimer = runtimer(l.scope, l);

    // damage rolls are memoized across this mon's ENTIRE search (phase 1 + every modifier hypothesis)
    // and persisted across syncs too (perf audit remedy #4) -- keyed on the candidate stats that feed
    // each calc, so an old event's roll is reused as long as the participants (and thus their real
    // ability/item) haven't changed since it was cached; see RollCacheStore above
    const rollCacheKey = [state.battleId, calcdexId, participantSignature].join('|');
    const rollCache = RollCacheStore.get(rollCacheKey) || new Map<string, CachedDamageRolls>();

    RollCacheStore.set(rollCacheKey, rollCache);

    if (RollCacheStore.size > 64) {
      RollCacheStore.delete(RollCacheStore.keys().next().value);
    }

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
      ? collectParentalBondTriggers(state, candidateEvents, damageContexts)
      : [];
    const typeChangeTrigger = phaseOneBest && candidateEvents.length
      ? collectTypeChangeTrigger(state, candidateEvents, damageContexts)
      : null;
    const modifierSearch = (triggers.length || jointConflictTriggers.length || parentalBondTriggers.length || typeChangeTrigger)
      ? searchModifierHypotheses(
        state,
        candidateEvents,
        candidateMatch,
        phaseOneMatches,
        damageContexts,
        triggers,
        jointConflictTriggers,
        parentalBondTriggers,
        typeChangeTrigger,
        rollCache,
        phaseOneBest,
      )
      : { possible: [] };
    const adoptedModifier = modifierSearch.adopted;

    const speedContexts = new Map<string, SpeedEventContext>();

    candidateEvents
      .filter((event) => event.eventType === 'speed')
      .forEach((event) => speedContexts.set(event.id, resolveSpeedEventContext(state, event, candidateMatch)));

    const speedTrigger = collectSpeedTrigger(state, candidateEvents, candidateMatch, speedContexts);
    // audit fix A2: a damage-side ability adoption normally also pins the speed search's ability slot
    // (a mon can only hold one ability) -- but Slow Start's Atk half and Spe half are the SAME
    // ability, linked via `pairedClassId`, so skip the pin in that case and let the speed search still
    // evaluate (and potentially co-adopt) the paired class instead of being locked out of it entirely
    const speedPinnedSlots = computePinnedSlots(
      candidateMatch,
      candidateEvents,
      damageContexts,
      adoptedModifier && !adoptedModifier.inferredModifier.modifier.pairedClassId
        ? adoptedModifier.inferredModifier.modifier.slot
        : undefined,
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
        adoptedModifier?.candidate || phaseOneBest,
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

    const publishedEventIds = new Set(matches.map((match) => match.eventId));
    const publishedEvents = candidateEvents.filter((event) => (
      event.eventType !== 'speed' && publishedEventIds.has(event.id)
    ));
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
          'Recent direct damage is fit with a roll likelihood and a heavy-tailed multiplier prior.',
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
              + `${formatModifierEffect(modifier.modifier)} `
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

    endMonTimer('inferHackmonsSpread() ->', calcdexId, candidateEvents.length, 'events (cache miss)');

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
