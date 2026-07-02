import { type MoveName } from '@smogon/calc';
import { type CalcdexPlayerKey } from '@showdex/interfaces/calc';

export type HackmonsInferenceConfidence = 'low' | 'medium' | 'high';

/**
 * Direction a damage event's observed value falls outside the best candidate's modeled roll range.
 *
 * * `'too-high'` -- observed damage exceeds the modeled max, hinting at an uninferred damage-boosting
 *   item/ability (e.g. Choice Band, Life Orb, Huge Power) or an unmodeled move mechanic (e.g. Rollout).
 * * `'too-low'` -- observed damage falls under the modeled min, hinting at an uninferred
 *   damage-reducing item/ability (e.g. Assault Vest, Filter) on whichever side is defending.
 * * Neither case is resolved by this feature yet -- the tag only marks *why* an event didn't fit, so a
 *   later modifier search (see the feature's handoff doc) has something to act on.
 *
 * @since 1.3.0
 */
export type HackmonsDamageOutlier = 'too-high' | 'too-low';

export interface HackmonsInferenceFieldSnapshot {
  weather?: import('@smogon/calc').Weather | null;
  terrain?: import('@smogon/calc').Terrain | null;
  isMagicRoom?: boolean;
  isWonderRoom?: boolean;
  isGravity?: boolean;
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
  attackerId: string;
  attackerKey?: CalcdexPlayerKey;
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

  /**
   * Number of times the attacker has been directly hit by a damaging move prior to this move
   * (persists across switches, unlike boosts/status). Feeds Rage Fist's variable base power.
   *
   * @since 1.3.0
   */
  attackerHitCounter?: number;
  attackerBoosts?: Showdown.StatsTableNoHp;
  defenderBoosts?: Showdown.StatsTableNoHp;
  attackerStatus?: Showdown.PokemonStatus | '';
  defenderStatus?: Showdown.PokemonStatus | '';
  field?: HackmonsInferenceFieldSnapshot;
  attackerSnapshot?: HackmonsInferencePokemonSnapshot;
  defenderSnapshot?: HackmonsInferencePokemonSnapshot;
  rawLine: string;
}

export interface HackmonsDamageMatch {
  eventId: string;
  turn: number;
  moveName: MoveName;
  observedDamage: number;
  medianDamage?: number;
  distance?: number;
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

export interface HackmonsSpreadEstimate {
  level: number;
  nature: Showdown.PokemonNature;
  ivs: Showdown.StatsTable;
  evs: Showdown.StatsTable;
  confidence: HackmonsInferenceConfidence;
  confidenceRatio: number;
  score: number;
  matches?: HackmonsDamageMatch[];
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
