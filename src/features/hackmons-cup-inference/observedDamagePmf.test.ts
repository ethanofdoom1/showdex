import { describe, expect, it } from 'vitest';
import { ceilPct, observedDamagePmf } from './damageLikelihood';

const maxHp = 404;
const rolls = [
  20, 20, 20, 20,
  21, 21, 21, 21,
  22, 22, 22,
  23, 23, 23,
  24, 24,
];

const expectPmf = (
  actual: { value: number; p: number }[],
  expected: { value: number; p: number }[],
): void => {
  expect(actual).toHaveLength(expected.length);

  actual.forEach((entry, index) => {
    expect(entry.value).toBe(expected[index].value);
    expect(entry.p).toBeCloseTo(expected[index].p, 9);
  });
};

describe('Showdown HP quantization', () => {
  it('uses Showdown’s ceil and 99-clamp rules', () => {
    expect(ceilPct(404, 404)).toBe(100);
    expect(ceilPct(403, 404)).toBe(99);
    expect(ceilPct(1, 404)).toBe(1);
    expect(ceilPct(0, 404)).toBe(0);
  });

  it('marginalises the observed damage at three bar positions', () => {
    const full = observedDamagePmf(rolls, 100, maxHp);
    const nearFull = observedDamagePmf(rolls, 89, maxHp);
    const midBar = observedDamagePmf(rolls, 79, maxHp);

    expect(full).toHaveLength(2);
    expectPmf(full, [{ value: 4, p: 0.25 }, { value: 5, p: 0.75 }]);

    expect(nearFull).toHaveLength(2);
    expectPmf(nearFull, [{ value: 5, p: 0.578125 }, { value: 6, p: 0.421875 }]);

    expect(midBar).toHaveLength(3);
    expectPmf(midBar, [
      { value: 4, p: 0.0625 },
      { value: 5, p: 0.703125 },
      { value: 6, p: 0.234375 },
    ]);
  });

  it('collapses an all-KO roll set to the remaining bar', () => {
    const pmf = observedDamagePmf([200, 205, 210], 30, maxHp);

    expect(pmf).toHaveLength(1);
    expectPmf(pmf, [{ value: 30, p: 1 }]);
  });

  it('normalises each frozen pmf with positive entries', () => {
    const pmfs = [
      observedDamagePmf(rolls, 100, maxHp),
      observedDamagePmf(rolls, 89, maxHp),
      observedDamagePmf(rolls, 79, maxHp),
      observedDamagePmf([200, 205, 210], 30, maxHp),
    ];

    pmfs.forEach((pmf) => {
      expect(pmf.reduce((sum, entry) => sum + entry.p, 0)).toBeCloseTo(1, 9);
      pmf.forEach((entry) => expect(entry.p).toBeGreaterThan(0));
    });
  });
});
