import { describe, expect, it } from 'vitest';
import {
  Alpha,
  damageEventLogLikelihood,
  ErrorEventLogLikelihood,
  speedEventLogLikelihood,
  Tau,
} from './damageLikelihood';

const R16 = Array.from({ length: 16 }, (_, index) => 100 + index);
const R16B = Array.from({ length: 16 }, (_, index) => 1000 + (index * 10));
const HALF = [...Array(8).fill(50), ...Array(8).fill(60)];
const SHUF = [...HALF].reverse();

describe('damageEventLogLikelihood()', () => {
  it('D1: supports the minimum roll', () => {
    expect(damageEventLogLikelihood(R16, 100)).toBeCloseTo(-2.789027426932, 9);
  });

  it('D2: supports a centre roll', () => {
    expect(damageEventLogLikelihood(R16, 107)).toBeCloseTo(-2.789022696904, 9);
  });

  it('D3: supports the maximum roll', () => {
    expect(damageEventLogLikelihood(R16, 115)).toBeCloseTo(-2.789497979148, 9);
  });

  it('D4: uses contamination for an unreachable observation', () => {
    expect(damageEventLogLikelihood(R16, 120)).toBeCloseTo(-8.646450037826, 9);
  });

  it('D5: handles a tenfold damage scale', () => {
    expect(damageEventLogLikelihood(R16B, 1200)).toBeCloseTo(-10.949035130820, 9);
  });

  it('D6: preserves roll multiplicity', () => {
    expect(damageEventLogLikelihood(HALF, 50)).toBeCloseTo(-0.712491312609, 9);
  });

  it('D7: is invariant to roll order', () => {
    expect(damageEventLogLikelihood(SHUF, 50)).toBeCloseTo(-0.712491312609, 9);
  });

  it('D8: gives a full-multiplicity match its expected likelihood', () => {
    expect(damageEventLogLikelihood(Array(16).fill(50), 50)).toBeCloseTo(-0.019683152699, 9);
  });

  it('D9: applies the likelihood tempering weight', () => {
    expect(damageEventLogLikelihood(R16, 100, 0.25)).toBeCloseTo(-0.697256856733, 9);
  });

  it('D10: gives a one-unit miss a finite contamination likelihood', () => {
    expect(damageEventLogLikelihood(R16, 116)).toBeCloseTo(-8.532140184248, 9);
  });

  it('D11: gives a fifteen-unit miss a finite contamination likelihood', () => {
    expect(damageEventLogLikelihood(R16, 130)).toBeCloseTo(-8.989503514800, 9);
  });

  it('D12: gives a distant miss a finite contamination likelihood', () => {
    expect(damageEventLogLikelihood(R16, 200)).toBeCloseTo(-10.930767530213, 9);
  });

  it('D13: treats a censored observation inside the range as survival', () => {
    expect(damageEventLogLikelihood(R16, 108, 1, true)).toBeCloseTo(-0.693421459715, 9);
  });

  it('D14: treats a censored observation below the range as certain survival', () => {
    expect(damageEventLogLikelihood(R16, 90, 1, true)).toBeCloseTo(-0.006159316875, 9);
  });

  it('D15: treats a censored observation above the range as failed survival', () => {
    expect(damageEventLogLikelihood(R16, 200, 1, true)).toBeCloseTo(-6.014560128755, 9);
  });

  it('D16: degrades monotonically as an uncensored miss moves away', () => {
    const d1 = damageEventLogLikelihood(R16, 100);
    const d10 = damageEventLogLikelihood(R16, 116);
    const d11 = damageEventLogLikelihood(R16, 130);
    const d12 = damageEventLogLikelihood(R16, 200);

    expect(d1).toBeGreaterThan(d10);
    expect(d10).toBeGreaterThan(d11);
    expect(d11).toBeGreaterThan(d12);
  });

  it('returns the finite error likelihood for empty rolls', () => {
    expect(damageEventLogLikelihood([], 100)).toBeCloseTo(ErrorEventLogLikelihood, 9);
  });
});

describe('speedEventLogLikelihood()', () => {
  it('S1: favors a strict speed-consistent result', () => {
    expect(speedEventLogLikelihood(-50, 200, 150)).toBeCloseTo(-0.015565953675, 9);
  });

  it('S2: scores an exact speed tie as a coin flip', () => {
    expect(speedEventLogLikelihood(0, 150, 150)).toBeCloseTo(-0.693147180560, 9);
  });

  it('S3: gives a contradicted speed event a contamination likelihood', () => {
    expect(speedEventLogLikelihood(50, 150, 200)).toBeCloseTo(-5.391624238352, 9);
  });

  it('S4: gives a larger contradiction a lower likelihood', () => {
    expect(speedEventLogLikelihood(150, 150, 300)).toBeCloseTo(-6.117630440736, 9);
  });

  it('exports the frozen hyperparameters', () => {
    expect(Alpha).toBeCloseTo(0.02, 9);
    expect(Tau).toBeCloseTo(0.25, 9);
  });
});
