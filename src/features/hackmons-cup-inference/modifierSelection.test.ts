import { describe, expect, it } from 'vitest';
import { type AbilityName, type ItemName } from '@smogon/calc';
import { type HackmonsInferredModifier, type HackmonsModifierSelection } from './types';
import { buildModifierSelectionPayload } from './modifierSelection';

const stats = (value: number): Showdown.StatsTable => ({
  hp: value,
  atk: value,
  def: value,
  spa: value,
  spd: value,
  spe: value,
});

const makeHypothesis = (
  selection: HackmonsModifierSelection,
  nature: Showdown.PokemonNature,
  evs: Showdown.StatsTable,
): Pick<HackmonsInferredModifier, 'selection' | 'candidateSpread'> => ({
  selection,
  candidateSpread: {
    nature,
    ivs: stats(31),
    evs,
  },
});

const A = makeHypothesis(
  { dirtyAbility: 'Ice Scales' as AbilityName, dirtyItem: null },
  'Bold',
  stats(0),
);
const B = makeHypothesis(
  { dirtyAbility: null, dirtyItem: 'Assault Vest' as ItemName },
  'Calm',
  { ...stats(0), spd: 252 },
);
const C = makeHypothesis(
  { dirtyAbility: 'Huge Power' as AbilityName, dirtyItem: 'Iron Ball' as ItemName },
  'Jolly',
  { ...stats(0), spe: 252 },
);

describe('buildModifierSelectionPayload()', () => {
  it('returns exactly the five whole-set override keys for every hypothesis', () => {
    [A, B, C].forEach((hypothesis) => {
      expect(Object.keys(buildModifierSelectionPayload(hypothesis)).sort()).toEqual([
        'dirtyAbility',
        'dirtyItem',
        'evs',
        'ivs',
        'nature',
      ]);
    });
  });

  it('preserves each hypothesis’s complete ability and item selection', () => {
    expect(buildModifierSelectionPayload(A).dirtyAbility).toBe('Ice Scales');
    expect(buildModifierSelectionPayload(A).dirtyItem).toBeNull();
    expect(buildModifierSelectionPayload(B).dirtyAbility).toBeNull();
    expect(buildModifierSelectionPayload(B).dirtyItem).toBe('Assault Vest');
    expect(buildModifierSelectionPayload(C).dirtyAbility).toBe('Huge Power');
    expect(buildModifierSelectionPayload(C).dirtyItem).toBe('Iron Ball');
  });

  it('copies each hypothesis’s complete spread tables and nature', () => {
    [A, B, C].forEach((hypothesis) => {
      const payload = buildModifierSelectionPayload(hypothesis);

      expect(payload.nature).toBe(hypothesis.candidateSpread.nature);
      expect(payload.ivs).toEqual(hypothesis.candidateSpread.ivs);
      expect(payload.evs).toEqual(hypothesis.candidateSpread.evs);
      expect(Object.keys(payload.ivs).sort()).toEqual(['atk', 'def', 'hp', 'spa', 'spd', 'spe']);
      expect(Object.keys(payload.evs).sort()).toEqual(['atk', 'def', 'hp', 'spa', 'spd', 'spe']);
    });
  });

  it('is independent of the previously selected hypothesis', () => {
    const firstA = buildModifierSelectionPayload(A);

    buildModifierSelectionPayload(B);

    const secondA = buildModifierSelectionPayload(A);

    expect(secondA).toEqual(firstA);
    expect(firstA).not.toEqual(buildModifierSelectionPayload(B));
  });
});
