import { type CalcdexBattleState } from '@showdex/interfaces/calc';
import { parseHackmonsInferenceEvents } from './parseStepQueue';
import { inferHackmonsSpread } from './inferHackmonsSpread';
import { traceHackmonsLatency } from './latencyTrace';
import { type HackmonsInferenceMap } from './types';

export const syncHackmonsInference = (
  state: CalcdexBattleState,
  stepQueue: string[],
): HackmonsInferenceMap => {
  traceHackmonsLatency('parseStarted', { battleId: state.battleId, stepQueueLength: stepQueue.length });
  const parsed = parseHackmonsInferenceEvents(stepQueue, state.battleId);
  traceHackmonsLatency('parseCompleted', { battleId: state.battleId, eventCount: parsed.events.length });

  const inference = inferHackmonsSpread(state, parsed.events, parsed.ignoredEventCount);
  traceHackmonsLatency('inferCompleted', { battleId: state.battleId, eventCount: parsed.events.length });

  return inference;
};
