import { spawnSync } from 'child_process';

const runs = Number(process.env.LATENCY_RUNS || 3);

if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('LATENCY_RUNS must be a positive integer.');
}

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};

const runResults = [];

for (let runIndex = 1; runIndex <= runs; runIndex++) {
  const result = spawnSync(process.execPath, ['./scripts/e2e-custom-hackmons-debug.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, SCENARIO: 'latency' },
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');

  const match = [...(result.stdout || '').matchAll(/^eventToEstimateLatencyRun (.+)$/gm)].at(-1);
  if (result.status !== 0 || !match) {
    throw new Error(`Latency battle ${runIndex} failed (exit ${result.status}); no complete trace was collected.`);
  }

  runResults.push({ runIndex, ...JSON.parse(match[1]) });
}

const retainedSamples = runResults.flatMap((run) => run.samples.slice(1).map((sample) => ({
  runIndex: run.runIndex,
  ...sample,
})));
const durations = retainedSamples.map((sample) => sample.totalDurationMs);
const medianBy = (samples, select) => percentile(samples.map(select).filter(Number.isFinite), 0.5);
const byTransitionIndex = Object.values(retainedSamples.reduce((output, sample) => {
  (output[sample.transitionIndex] ||= []).push(sample);
  return output;
}, {})).map((samples) => ({
  transitionIndex: samples[0].transitionIndex,
  count: samples.length,
  medianMs: medianBy(samples, (sample) => sample.totalDurationMs),
  p95Ms: percentile(samples.map((sample) => sample.totalDurationMs), 0.95),
}));
const stageBreakdownMs = [
  'bootstrapScheduled',
  'syncStarted',
  'battleCloned',
  'parseStarted',
  'parseCompleted',
  'inferCompleted',
  'inferenceSynced',
  'reduxPublished',
  'finalPayloadObserved',
].map((stage) => ({
  stage,
  medianSinceDamageMs: medianBy(retainedSamples, (sample) => (
    sample.stageTimestamps?.[stage] - sample.stageTimestamps?.damageObserved
  )),
}));
const invalidSamples = retainedSamples.filter((sample) => (
  !sample.estimateVisible || sample.modifiers !== '[]' || sample.totalDurationMs < 0 || sample.totalDurationMs > 10000
));
const invalidFinalSnapshots = runResults.filter((run) => (
  !run.finalSnapshot?.estimateVisible
  || JSON.stringify(run.finalSnapshot?.modifiers) !== '[]'
  || run.finalSnapshot?.damageMismatches?.length
));
const summary = {
  successfulBattles: runResults.length,
  retainedSampleCount: retainedSamples.length,
  progressTimeoutCount: runResults.reduce((count, run) => count + run.progressTimeoutCount, 0),
  runs: runResults,
  retainedSamples,
  perTransitionIndex: byTransitionIndex,
  stageBreakdownMs,
  invalidSampleCount: invalidSamples.length,
  invalidFinalSnapshotCount: invalidFinalSnapshots.length,
  aggregateMs: {
    median: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
  },
};

console.log(`eventToEstimateLatencySummary ${JSON.stringify(summary)}`);

if (
  summary.successfulBattles !== runs
  || summary.retainedSampleCount < 12
  || summary.progressTimeoutCount !== 0
  || summary.invalidSampleCount
  || summary.invalidFinalSnapshotCount
) {
  process.exitCode = 1;
}
