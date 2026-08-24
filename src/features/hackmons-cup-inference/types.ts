import { type MoveName } from '@smogon/calc';
import { type CalcdexPlayerKey } from '@showdex/interfaces/calc';

export type HackmonsInferenceConfidence = 'low' | 'medium' | 'high';

/**
 * Direction a damage event's observed value falls outside the best candidate's modeled roll range.
 *
 * * `'too-high'` -- observed damage exceeds the modeled max, hinting at an uninferred damage-boosting
 *   item/ability (e.g. Choice Band, Life Orb, Huge Power) or an unmodeled move mechanic.
 * * `'too-low'` -- observed damage falls under the modeled min, hinting at an uninferred
 *   damage-reducing item/ability (e.g. Assault Vest, Filter) on whichever side is defending.
 * * Neither case is resolved by this feature yet -- the tag only marks *why* an event didn't fit, so a
 *   later modifier search (see the feature's handoff doc) has something to act on.
 *
 * @since 1.3.0
 */
export type HackmonsDamageOutlier = 'too-high' | 'too-low';
export type HackmonsDamageEffectiveness = 'super' | 'resisted' | 'immune' | 'neutral';
export type HackmonsModifierSlot = 'item' | 'ability';
export type HackmonsModifierScope =
  | 'global-atk'
  | 'global-spa'
  | 'global-def'
  | 'global-spd'
  | 'global-both'
  | 'super-effective-taken'
  | 'resisted-dealt'
  | 'full-hp-taken'
  | 'stab'
  | 'extra-hit'
  | 'spe'
  | { type: Showdown.TypeName; }
  | { types: Showdown.TypeName[]; }
  | { moveTag: string; };

export interface HackmonsModifierClass {
  id: string;
  slot: HackmonsModifierSlot;
  scope: HackmonsModifierScope;
  multiplier: number;
  representative: string;
  examples: string[];

  /**
   * Whether this class's supporting evidence is direct (hit-shape, effectiveness contradiction, ...)
   * rather than magnitude-outlier based -- bypasses `searchModifierHypotheses()`'s "requires an
   * eliminated outlier" adoption gate the same way Parental Bond and the -ate/Normalize classes do.
   *
   * @since 1.3.0
   */
  directEvidence?: boolean;

  /**
   * Id of another `ModifierCatalog` class whose trigger corroborates this one (e.g. Slow Start's Atk
   * half and Spe half are the same ability, but live in separate damage/speed searches that would
   * otherwise pin each other out of the ability slot). When both fire together, they co-adopt instead
   * of competing.
   *
   * @since 1.3.0
   */
  pairedClassId?: string;

  /**
   * Per-mon disqualifying evidence (extension, spec §11) that rules this class out outright
   * regardless of outlier support -- `'choice-lock'` (two distinct moves used without switching,
   * proving no Choice item) and `'no-recoil'` (Life Orb's unconditional recoil line never observed on
   * a supporting hit).
   *
   * @since 1.3.0
   */
  disqualifiers?: ('choice-lock' | 'no-recoil')[];
}

export interface HackmonsInferredModifier {
  modifier: HackmonsModifierClass;
  adopted: boolean;
  relation: 'attacker' | 'defender';
  supportingEventIds: string[];
  corroboration?: string[];

  /**
   * The nature/IV/EV spread the search converged on when this modifier was assumed true, rather than
   * the published estimate's spread -- which, while the modifier is unconfirmed, compensates for it
   * via free stat investment (e.g. maxing SpDef to explain damage Ice Scales would otherwise account
   * for). Selecting this modifier in the UI should apply this spread alongside the ability/item, so
   * the two stay coherent instead of leaving the compensating assumption stale.
   *
   * @since 1.3.0
   */
  candidateSpread?: {
    nature: Showdown.PokemonNature;
    ivs: Showdown.StatsTable;
    evs: Showdown.StatsTable;
  };
}

export interface HackmonsInferenceFieldSnapshot {
  weather?: import('@smogon/calc').Weather | null;
  terrain?: import('@smogon/calc').Terrain | null;
  isMagicRoom?: boolean;
  isWonderRoom?: boolean;
  isGravity?: boolean;
}

/**
 * Side conditions in effect for one player as of a given event.
 *
 * * Screens are a straight damage multiplier and *Tailwind* a speed one, so modelling a past event
 *   with whatever is up RIGHT NOW (as this feature did before) silently mis-scores every event that
 *   happened on the other side of a `-sidestart`/`-sideend`.
 *
 * @since 1.3.0
 */
export interface HackmonsInferenceSideSnapshot {
  isReflect?: boolean;
  isLightScreen?: boolean;
  isAuroraVeil?: boolean;
  isTailwind?: boolean;
}

export interface HackmonsInferencePokemonSnapshot {
  types?: Showdown.TypeName[];
  typeChanged?: boolean;
  teraType?: Showdown.TypeName | null;
  terastallized?: boolean;

  /**
   * Whether this Pokemon's ability had been directly revealed (via a `|-ability|` log line) as of
   * this event. Abilities are random in Hackmons Cup, so an unconfirmed `pokemon.ability` is most
   * likely a preset/usage-stats guess -- inference should not let that bias damage rolls.
   *
   * @since 1.3.0
   */
  abilityConfirmed?: boolean;

  /**
   * Whether this Pokemon's item had been directly revealed (via a `-item`/`-enditem` log line, or a
   * `[from] item: X` tag on a damage/heal line) as of this event. Once confirmed, the item is pinned
   * as ground truth and the hypothesis search stops proposing item classes for this mon entirely.
   *
   * @since 1.3.0
   */
  itemConfirmed?: boolean;

  /**
   * The `formatId()`'d item name confirmed via `itemConfirmed`, e.g. `'lifeorb'`.
   *
   * @since 1.3.0
   */
  revealedItem?: string;
}

export interface HackmonsInferenceAssumptions {
  nature?: Showdown.PokemonNature;
  attackerItem?: string;
  defenderItem?: string;
  notes?: string[];
}

export interface HackmonsInferenceEvent {
  eventType?: 'damage' | 'speed';
  id: string;
  turn: number;
  attackerSlot?: string;
  attackerId: string;
  attackerKey?: CalcdexPlayerKey;
  defenderSlot?: string;
  defenderId: string;
  defenderKey?: CalcdexPlayerKey;
  attackerName: string;
  defenderName: string;
  moveName: MoveName;
  slowerMoveName?: MoveName;
  damage?: number;
  attackerStartHp?: number;
  attackerMaxHp?: number;
  startHp?: number;
  endHp?: number;
  maxHp?: number;
  crit?: boolean;
  multiHit?: boolean;
  hits?: number;
  effectiveness?: HackmonsDamageEffectiveness;
  speedOrderSuppressed?: boolean;

  /**
   * Whether the attacker was Dynamaxed when this move was used. A literal Max move can occur in
   * Hackmons Cup's random move pool at its placeholder power, so this must come from the log state
   * rather than the move name alone.
   */
  attackerDynamaxed?: boolean;

  /**
   * Raw per-hit damage values for this move use, in landing order. Populated alongside the
   * aggregated `damage` total; used to detect Parental Bond's distinctive 2-hit (~100% + ~25%)
   * shape, and as the hit count for a multi-hit move Showdown logs no `-hitcount` line for (smart
   * targeting suppresses it, so `multiHit`/`hits` are both falsy for e.g. Dragon Darts).
   *
   * @since 1.3.0
   */
  hitDamages?: number[];

  /**
   * Which of this move use's hits crit, in landing order (parallel to `hitDamages`). A multi-hit
   * move crits per hit, so `crit` alone (true when ANY hit crit) would model a single critting hit
   * of Triple Axel as all three critting.
   *
   * @since 1.3.0
   */
  critHits?: boolean[];

  /**
   * Whether a `[from] item: X` recoil line was observed on the ATTACKER immediately after this hit
   * (e.g. Life Orb's unconditional 10% recoil). Absence across every supporting event is
   * disqualifying evidence against a Life-Orb-shaped hypothesis (see the recoil-absence exclusion
   * in `inferHackmonsSpread.ts`).
   *
   * @since 1.3.0
   */
  recoilObserved?: boolean;

  /**
   * Which continuous "stint" (time between switch-ins) the attacker was in when this move was used
   * -- two events sharing an `attackerId` but a DIFFERENT move within the SAME stint prove the mon
   * wasn't Choice-locked at the time (a real Choice item can't be un-selected without switching
   * out). Incremented on every switch-in; not reset by fainting/reviving distinctions.
   *
   * @since 1.3.0
   */
  attackerStint?: number;
  defenderStint?: number;

  /**
   * Number of times the attacker has been directly hit by a damaging move prior to this move
   * (persists across switches, unlike boosts/status). Feeds Rage Fist's variable base power.
   *
   * @since 1.3.0
   */
  attackerHitCounter?: number;

  /**
   * Number of consecutive prior turns the attacker has successfully landed this exact move. Feeds
   * *Fury Cutter* & *Rollout*'s variable base power, which doubles with each consecutive successful use.
   *
   * @since 1.3.0
   */
  attackerMoveRepeatCount?: number;

  /**
   * Whether the attacker has used *Defense Curl* at some prior point while on the field, doubling
   * *Rollout*'s base power on top of `attackerMoveRepeatCount`'s own consecutive-use scaling.
   *
   * @since 1.3.0
   */
  attackerDefenseCurled?: boolean;
  attackerBoosts?: Showdown.StatsTableNoHp;
  defenderBoosts?: Showdown.StatsTableNoHp;
  attackerStatus?: Showdown.PokemonStatus | '';
  defenderStatus?: Showdown.PokemonStatus | '';
  field?: HackmonsInferenceFieldSnapshot;
  attackerSide?: HackmonsInferenceSideSnapshot;
  defenderSide?: HackmonsInferenceSideSnapshot;

  /**
   * Number of Pokemon fainted on each side as of this event, i.e. `faintCounter`'s "allies fainted"
   * at the time -- *Supreme Overlord* scales its damage off this and it only ever grows, so the live
   * counter over-boosts every earlier event in the log.
   *
   * @since 1.3.0
   */
  attackerFaintCount?: number;
  defenderFaintCount?: number;
  attackerSnapshot?: HackmonsInferencePokemonSnapshot;
  defenderSnapshot?: HackmonsInferencePokemonSnapshot;
  rawLine: string;
}

export interface HackmonsIllusionReveal {
  slot: string;
  revealedName: string;
  revealedId: string;
  revealedSpecies: string;
  turn: number;
  revealedStint: number;
}

export interface HackmonsDamageMatch {
  eventId: string;
  turn: number;
  moveName: MoveName;
  observedDamage: number;
  medianDamage?: number;
  logLikelihood: number;
  distance?: number;

  /**
   * Feasibility distance used to identify outliers: `0` whenever the candidate spread can actually
   * produce this observation (i.e. it falls within `rollRange`), and only positive when it's
   * genuinely unreachable by that spread. Distinct from `distance`, which is retained for display
   * purposes even when the observation is already in-range.
   *
   * @since 1.3.0
   */
  rangeDistance?: number;
  maxHp?: number;
  crit?: boolean;
  attackerBoosts?: Showdown.StatsTableNoHp;
  defenderBoosts?: Showdown.StatsTableNoHp;
  attackerStatus?: Showdown.PokemonStatus | '';
  defenderStatus?: Showdown.PokemonStatus | '';
  rollRange?: [min: number, max: number];
  error?: string;

  /**
   * Set when this event's observed damage falls outside the best candidate's modeled roll range --
   * i.e. it didn't factor into the estimate's confidence, but also didn't block the rest of the
   * estimate from publishing (see `inferHackmonsSpread()`'s `shouldPublishEstimate`).
   *
   * @since 1.3.0
   */
  outlier?: HackmonsDamageOutlier | null;
  explainedBy?: string;

  /**
   * Whether this hit KO'd the defender (event `endHp === 0`). A KO's observed damage is truncated at
   * the defender's remaining HP -- the real roll was *at least* the observation -- so distance,
   * in-range, and outlier checks treat it as a one-sided lower bound instead of an exact value
   * (otherwise an overkill hit drags the whole search toward matching the truncated number).
   *
   * @since 1.3.0
   */
  ko?: boolean;
}

export interface HackmonsExtremalFeasibility {
  high?: HackmonsDamageMatch;
  low?: HackmonsDamageMatch;
  highInfeasible?: boolean;
  lowInfeasible?: boolean;
}

export interface HackmonsSpreadEstimate {
  level: number;
  nature: Showdown.PokemonNature;
  ivs: Showdown.StatsTable;
  evs: Showdown.StatsTable;
  confidence: HackmonsInferenceConfidence;
  confidenceRatio: number;
  score: number;
  matches?: HackmonsDamageMatch[];
  inferredModifiers?: HackmonsInferredModifier[];
}

export interface HackmonsInferenceState {
  events: HackmonsInferenceEvent[];
  estimate?: HackmonsSpreadEstimate | null;
  ignoredEventCount: number;
  assumptions: HackmonsInferenceAssumptions;
  updatedTurn?: number;

  /**
   * Human-readable Speed bounds derived from observed turn order, e.g. `'Outsped Vaporeon (Spe ≥ 167)'`.
   *
   * * Speed is only ever inferred as a one-sided bound, never an exact value.
   *
   * @since 1.3.0
   */
  speedNotes?: string[];
}

export type HackmonsInferenceMap = Record<string, HackmonsInferenceState>;
