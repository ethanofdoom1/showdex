import { type AbilityName } from '@smogon/calc';
import { formatId } from '@showdex/utils/core';

// the ability an inference format's mon has until one is revealed or set. It has to be spelled out:
// @smogon/calc's Pokemon reads an empty ability as the species' FIRST one, with its hidden effects
// (Pure Power, Thick Fat, ...), while every ability is random here. Any name the calc doesn't know is
// inert, and this one is the PS dex's own
export const NoAbility = 'No Ability' as AbilityName;

export const isInferenceFormat = (format: string): boolean => {
  const id = formatId(format);

  return id.includes('hackmons') || id.includes('brokencup');
};
