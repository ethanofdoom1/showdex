import { type HackmonsInferredModifier, type HackmonsModifierSelection } from './types';

type ModifierSelectionSource = Pick<HackmonsInferredModifier, 'selection' | 'candidateSpread'>;

export const buildModifierSelectionPayload = (
  modifier: ModifierSelectionSource,
) => ({
  dirtyAbility: modifier.selection.dirtyAbility,
  dirtyItem: modifier.selection.dirtyItem,
  evs: { ...modifier.candidateSpread.evs },
  ivs: { ...modifier.candidateSpread.ivs },
  nature: modifier.candidateSpread.nature,
});

export const buildHypothesisPayload = buildModifierSelectionPayload;

export type { HackmonsModifierSelection };
