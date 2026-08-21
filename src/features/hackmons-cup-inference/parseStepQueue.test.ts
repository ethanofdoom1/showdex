import { describe, expect, it } from 'vitest';
import { parseHackmonsInferenceEvents } from './parseStepQueue';

describe('parseHackmonsInferenceEvents()', () => {
  it('ignores Shed Tail self-damage while preserving the user HP for later hits', () => {
    const { events, ignoredEventCount } = parseHackmonsInferenceEvents([
      '|switch|p1a: Basculegion|Basculegion, L50|100/100',
      '|switch|p2a: Gengar|Gengar, L50|100/100',
      '|turn|1',
      '|move|p1a: Basculegion|Shed Tail',
      '|-damage|p1a: Basculegion|50/100',
      '|-start|p1a: Basculegion|Substitute',
      '|move|p2a: Gengar|Shadow Ball',
      '|-damage|p1a: Basculegion|25/100',
    ], 'shed-tail-self-damage');

    const damageEvents = events.filter((event) => event.eventType !== 'speed');

    expect(ignoredEventCount).toBe(0);
    expect(damageEvents).toHaveLength(1);
    expect(damageEvents[0]).toMatchObject({
      moveName: 'Shadow Ball',
      attackerName: 'Gengar',
      defenderName: 'Basculegion',
      startHp: 50,
      endHp: 25,
      damage: 25,
    });
  });
});
