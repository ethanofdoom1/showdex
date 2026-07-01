import { type CalcdexBattleState } from '@showdex/interfaces/calc';
import { parseHackmonsInferenceEvents } from './parseStepQueue';
import { inferHackmonsSpread } from './inferHackmonsSpread';
import { type HackmonsInferenceMap } from './types';

export const syncHackmonsInference = (
  state: CalcdexBattleState,
  stepQueue: string[],
): HackmonsInferenceMap => {
  const parsed = parseHackmonsInferenceEvents(stepQueue);

  return inferHackmonsSpread(state, parsed.events, parsed.ignoredEventCount);
};
