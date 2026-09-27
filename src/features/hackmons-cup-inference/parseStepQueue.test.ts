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

  it('drops fixed-damage hits from inference but still tracks their HP and Rage Fist hits', () => {
    const { events, ignoredEventCount } = parseHackmonsInferenceEvents([
      '|switch|p1a: Annihilape|Annihilape, L50|100/100',
      '|switch|p2a: Gengar|Gengar, L50|100/100',
      '|turn|1',
      '|move|p2a: Gengar|Seismic Toss|p1a: Annihilape',
      '|-damage|p1a: Annihilape|70/100',
      '|move|p1a: Annihilape|Super Fang|p2a: Gengar',
      '|-damage|p2a: Gengar|50/100',
      '|turn|2',
      '|move|p2a: Gengar|Shadow Ball|p1a: Annihilape',
      '|-supereffective|p1a: Annihilape',
      '|-damage|p1a: Annihilape|40/100',
      '|move|p1a: Annihilape|Rage Fist|p2a: Gengar',
      '|-supereffective|p2a: Gengar',
      '|-damage|p2a: Gengar|10/100',
    ], 'fixed-damage');

    const damageEvents = events.filter((event) => event.eventType !== 'speed');

    expect(ignoredEventCount).toBe(2);
    expect(damageEvents.map((event) => event.moveName)).toEqual(['Shadow Ball', 'Rage Fist']);
    expect(damageEvents[0]).toMatchObject({ startHp: 70, endHp: 40, effectiveness: 'super' });
    expect(damageEvents[1]).toMatchObject({ startHp: 50, endHp: 10, attackerHitCounter: 2 });
  });

  it('records no effectiveness for typeless Struggle, and neutral for an unmarked typed hit', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Skarmory|Skarmory, L50|100/100',
      '|switch|p2a: Blissey|Blissey, L50|100/100',
      '|turn|1',
      '|move|p2a: Blissey|Struggle|p1a: Skarmory',
      '|-damage|p1a: Skarmory|90/100',
      '|turn|2',
      '|move|p2a: Blissey|Body Slam|p1a: Skarmory',
      '|-resisted|p1a: Skarmory',
      '|-damage|p1a: Skarmory|85/100',
      '|turn|3',
      '|move|p2a: Blissey|Flamethrower|p1a: Skarmory',
      '|-damage|p1a: Skarmory|70/100',
    ], 'struggle-typeless');

    const damageEvents = events.filter((event) => event.eventType !== 'speed');

    expect(damageEvents.map((event) => [event.moveName, event.effectiveness])).toEqual([
      ['Struggle', undefined],
      ['Body Slam', 'resisted'],
      ['Flamethrower', 'neutral'],
    ]);
  });

  it('marks a Roosting defender for the rest of that turn only', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Skarmory|Skarmory, L50|100/100',
      '|switch|p2a: Garchomp|Garchomp, L50|100/100',
      '|turn|1',
      '|move|p1a: Skarmory|Roost|p1a: Skarmory',
      '|-singleturn|p1a: Skarmory|move: Roost',
      '|move|p2a: Garchomp|Earthquake|p1a: Skarmory',
      '|-damage|p1a: Skarmory|80/100',
      '|upkeep',
      '|turn|2',
      '|move|p2a: Garchomp|Fire Fang|p1a: Skarmory',
      '|-supereffective|p1a: Skarmory',
      '|-damage|p1a: Skarmory|50/100',
    ], 'roost');

    const damageEvents = events.filter((event) => event.eventType !== 'speed');

    expect(damageEvents.map((event) => [event.moveName, !!event.defenderSnapshot?.roosted])).toEqual([
      ['Earthquake', true],
      ['Fire Fang', false],
    ]);
  });

  it('attributes a multi-hit move\'s crit to the hit it actually landed on', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Weavile|Weavile, L50|100/100',
      '|switch|p2a: Blissey|Blissey, L50|100/100',
      '|turn|1',
      '|move|p1a: Weavile|Triple Axel|p2a: Blissey',
      '|-damage|p2a: Blissey|90/100',
      '|-crit|p2a: Blissey',
      '|-damage|p2a: Blissey|60/100',
      '|-damage|p2a: Blissey|30/100',
      '|-hitcount|p2a: Blissey|3',
    ], 'triple-axel-partial-crit');

    const [damageEvent] = events.filter((event) => event.eventType !== 'speed');

    expect(damageEvent).toMatchObject({
      moveName: 'Triple Axel',
      hits: 3,
      crit: true,
      hitDamages: [10, 30, 30],
      critHits: [false, true, false],
    });
  });
});
