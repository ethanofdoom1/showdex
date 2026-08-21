import { describe, expect, it } from 'vitest';
import { Alpha, damageEventLogLikelihood, Tau } from './damageLikelihood';

const Grid = Array.from({ length: 301 }, (_, index) => 100 + index);
const rolls = (a: number, c: number): number[] => (
  Array.from({ length: 16 }, (_, index) => Math.floor((a * c * (85 + index)) / 100))
);

const modelLikelihood = (
  rollSet: number[],
  observed: number,
  alpha: number,
  tau: number,
): number => {
  const safeObserved = Math.max(0.5, observed);
  const rollCount = rollSet.length;
  const pModel = rollSet.filter((roll) => roll === observed).length / rollCount;
  const qContam = rollSet.reduce((sum, roll) => {
    const logRatio = Math.log(safeObserved / Math.max(0.5, roll));

    return sum + tau / (Math.PI * (tau ** 2 + logRatio ** 2));
  }, 0) / (rollCount * safeObserved);

  return Math.log((1 - alpha) * pModel + alpha * qContam);
};

const llA = (a: number): number => damageEventLogLikelihood(rolls(a, 1), 200);
const llB = (a: number): number => damageEventLogLikelihood(rolls(a, 0.1), 17);
const rangeIncludes = (eventRolls: number[], observed: number): boolean => (
  Math.min(...eventRolls) <= observed && observed <= Math.max(...eventRolls)
);

const argmaxSet = (score: (a: number) => number): number[] => {
  const scores = Grid.map((a) => score(a));
  const maximum = Math.max(...scores);

  return Grid.filter((_, index) => Math.abs(scores[index] - maximum) < 1e-12);
};

const argminSet = (score: (a: number) => number): number[] => {
  const scores = Grid.map((a) => score(a));
  const minimum = Math.min(...scores);

  return Grid.filter((_, index) => Math.abs(scores[index] - minimum) < 1e-12);
};

const currentObjective = (a: number): number => [
  { c: 1, observed: 200 },
  { c: 0.1, observed: 17 },
].reduce((total, event) => {
  const eventRolls = rolls(a, event.c);
  const sorted = [...eventRolls].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const rangeDistance = Math.max(
    0,
    Math.min(...eventRolls) - event.observed,
    event.observed - Math.max(...eventRolls),
  );
  const centerDistance = Math.abs(median - event.observed);

  return total
    + ((rangeDistance ** 2 + rangeDistance) * 1e6)
    + (centerDistance ** 2 + centerDistance);
}, 0);

describe('M1 probabilistic damage fitting', () => {
  it('has the frozen non-degenerate feasible regions', () => {
    const aFeasible = Grid.filter((a) => rangeIncludes(rolls(a, 1), 200));
    const bFeasible = Grid.filter((a) => rangeIncludes(rolls(a, 0.1), 17));
    const intersection = Grid.filter((a) => aFeasible.includes(a) && bFeasible.includes(a));

    expect(aFeasible).toEqual(Array.from({ length: 37 }, (_, index) => 200 + index));
    expect(bFeasible).toEqual(Array.from({ length: 42 }, (_, index) => 170 + index));
    expect(intersection).toEqual(Array.from({ length: 12 }, (_, index) => 200 + index));
  });

  it('selects the true generating value as the unique likelihood maximum', () => {
    expect(argmaxSet((a) => llA(a) + llB(a))).toEqual([200]);
    expect(llA(200) + llB(200)).toBeCloseTo(-3.969838073949, 9);
  });

  it('keeps the current objective as a negative control at the feasibility boundary', () => {
    expect(argminSet(currentObjective)).toEqual([211]);
  });

  it('keeps the likelihood maximum under the frozen sensitivity grid', () => {
    const alphas = [0.005, 0.02, 0.05, 0.10];
    const taus = [0.10, 0.25, 0.50];

    alphas.forEach((alpha) => {
      taus.forEach((tau) => {
        expect(argmaxSet((a) => (
          modelLikelihood(rolls(a, 1), 200, alpha, tau)
          + modelLikelihood(rolls(a, 0.1), 17, alpha, tau)
        ))).toEqual([200]);
      });
    });
  });

  it('uses the frozen default hyperparameters for the fixture score', () => {
    expect(llA(200) + llB(200)).toBeCloseTo(
      modelLikelihood(rolls(200, 1), 200, Alpha, Tau)
        + modelLikelihood(rolls(200, 0.1), 17, Alpha, Tau),
      9,
    );
  });
});
