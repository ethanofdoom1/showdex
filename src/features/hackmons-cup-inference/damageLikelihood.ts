const LogFloor = 0.5;

export const Alpha = 0.02;
export const Tau = 0.25;
export const ErrorEventLogLikelihood = -12;

export interface ObservedDamagePmfEntry {
  value: number;
  p: number;
}

export const ceilPct = (hp: number, maxHp: number): number => {
  if (hp <= 0) {
    return 0;
  }

  const percentage = Math.ceil((100 * hp) / maxHp);

  return percentage === 100 && hp < maxHp ? 99 : percentage;
};

export const observedDamagePmf = (
  rolls: number[],
  startPercent: number,
  maxHp: number,
): ObservedDamagePmfEntry[] => {
  const startHpValues = Array.from({ length: maxHp }, (_, index) => index + 1)
    .filter((hp) => ceilPct(hp, maxHp) === startPercent);
  const total = startHpValues.length * rolls.length;

  if (!total) {
    return [];
  }

  const counts = new Map<number, number>();

  startHpValues.forEach((hp) => {
    rolls.forEach((roll) => {
      const value = ceilPct(hp, maxHp) - ceilPct(Math.max(0, hp - roll), maxHp);

      counts.set(value, (counts.get(value) || 0) + 1);
    });
  });

  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([value, count]) => ({ value, p: count / total }));
};

export const damageEventLogLikelihood = (
  rolls: number[],
  observed: number,
  weight = 1,
  censored = false,
  modelPmf?: ObservedDamagePmfEntry[],
): number => {
  if (!rolls.length) {
    return ErrorEventLogLikelihood;
  }

  const safeObserved = Math.max(LogFloor, observed);

  if (modelPmf?.length) {
    const pModel = modelPmf.reduce((sum, entry) => (
      sum + (censored
        ? (entry.value >= observed ? entry.p : 0)
        : entry.value === observed ? entry.p : 0)
    ), 0);
    const qContam = modelPmf.reduce((sum, entry) => {
      const logRatio = Math.log(safeObserved / Math.max(LogFloor, entry.value));
      const density = censored
        ? 0.5 - (Math.atan(logRatio / Tau) / Math.PI)
        : Tau / (Math.PI * (Tau ** 2 + logRatio ** 2));

      return sum + (entry.p * density);
    }, 0) / (censored ? 1 : safeObserved);

    return weight * Math.log((1 - Alpha) * pModel + Alpha * qContam);
  }

  const rollCount = rolls.length;
  const modelCount = rolls.reduce((count, roll) => (
    count + (censored ? (roll >= observed ? 1 : 0) : roll === observed ? 1 : 0)
  ), 0);
  const pModel = modelCount / rollCount;
  const qContam = rolls.reduce((sum, roll) => {
    const logRatio = Math.log(safeObserved / Math.max(LogFloor, roll));

    return sum + (censored
      ? 0.5 - (Math.atan(logRatio / Tau) / Math.PI)
      : Tau / (Math.PI * (Tau ** 2 + logRatio ** 2)));
  }, 0) / (censored ? rollCount : rollCount * safeObserved);

  return weight * Math.log((1 - Alpha) * pModel + Alpha * qContam);
};

export const speedEventLogLikelihood = (
  margin: number,
  candidateSpeed: number,
  otherSpeed: number,
): number => {
  const pModel = margin < 0 ? 1 : margin === 0 ? 0.5 : 0;
  const logRatio = Math.abs(Math.log(
    Math.max(LogFloor, otherSpeed) / Math.max(LogFloor, candidateSpeed),
  ));
  const qContam = 0.5 - (Math.atan(logRatio / Tau) / Math.PI);

  return Math.log((1 - Alpha) * pModel + Alpha * qContam);
};
