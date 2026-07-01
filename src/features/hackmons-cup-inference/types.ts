import { type MoveName } from '@smogon/calc';
import { type CalcdexPlayerKey } from '@showdex/interfaces/calc';

export type HackmonsInferenceConfidence = 'low' | 'medium' | 'high';

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
