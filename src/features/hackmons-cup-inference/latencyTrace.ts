type LatencyTraceDetail = Record<string, unknown> & { stage: string; time: number; };

const traceAttribute = 'data-showdex-hackmons-latency-trace';

export const traceHackmonsLatency = (
  stage: string,
  detail: Record<string, unknown> = {},
): void => {
  if (typeof document === 'undefined' || !document.documentElement.hasAttribute(traceAttribute)) {
    return;
  }

  document.dispatchEvent(new CustomEvent<LatencyTraceDetail>('showdex-hackmons-latency-trace', {
    detail: { stage, time: performance.now(), ...detail },
  }));
};
