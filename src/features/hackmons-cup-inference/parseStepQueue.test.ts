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

  it('keeps the status a switch-in line carries, and clears one it no longer shows', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Skarmory|Skarmory, L50|100/100',
      '|switch|p2a: Garchomp|Garchomp, L50|100/100',
      '|turn|1',
      '|move|p1a: Skarmory|Will-O-Wisp|p2a: Garchomp',
      '|-status|p2a: Garchomp|brn',
      '|turn|2',
      '|switch|p2a: Blissey|Blissey, L50|100/100',
      '|turn|3',
      '|switch|p2a: Garchomp|Garchomp, L50|94/100 brn',
      '|turn|4',
      '|move|p2a: Garchomp|Fire Fang|p1a: Skarmory',
      '|-supereffective|p1a: Skarmory',
      '|-damage|p1a: Skarmory|80/100',
      '|turn|5',
      '|switch|p2a: Blissey|Blissey, L50|100/100',
      '|turn|6',
      '|switch|p2a: Garchomp|Garchomp, L50|88/100',
      '|turn|7',
      '|move|p2a: Garchomp|Fire Fang|p1a: Skarmory',
      '|-supereffective|p1a: Skarmory',
      '|-damage|p1a: Skarmory|50/100',
    ], 'switch-status');

    const damageEvents = events.filter((event) => event.eventType !== 'speed');

    expect(damageEvents.map((event) => event.attackerStatus)).toEqual(['brn', '']);
  });

  it('keeps moves run outside their own turn slot out of the speed order', () => {
    const head = ['|switch|p1a: Vaporeon|Vaporeon, L50|100/100', '|switch|p2a: Mew|Mew, L50|100/100', '|turn|1'];
    const speedPairs = (lines: string[]) => parseHackmonsInferenceEvents([...head, ...lines], `order-${lines.length}`)
      .events
      .filter((event) => event.eventType === 'speed')
      .map((event) => [event.attackerName, event.defenderName, !!event.speedOrderSuppressed]);

    // Magic Bounce: Mew moved first; the reflected Stealth Rock is not a second Mew turn
    expect(speedPairs([
      '|move|p2a: Mew|Body Slam|p1a: Vaporeon',
      '|-damage|p1a: Vaporeon|80/100',
      '|move|p1a: Vaporeon|Stealth Rock|p2a: Mew',
      '|move|p2a: Mew|Stealth Rock|p1a: Vaporeon|[from] ability: Magic Bounce',
    ])).toEqual([['Mew', 'Vaporeon', false]]);

    // Instruct strips its own [from]; the -singleturn before the instructed move is the tell
    expect(speedPairs([
      '|move|p1a: Vaporeon|Instruct|p2a: Mew',
      '|-singleturn|p2a: Mew|move: Instruct|[of] p1a: Vaporeon',
      '|move|p2a: Mew|Body Slam|p1a: Vaporeon',
      '|-damage|p1a: Vaporeon|80/100',
    ])).toEqual([]);

    // Outrage's continuation is still the mon's own turn
    expect(speedPairs([
      '|move|p2a: Mew|Outrage|p1a: Vaporeon|[from] lockedmove',
      '|-damage|p1a: Vaporeon|80/100',
      '|move|p1a: Vaporeon|Scald|p2a: Mew',
      '|-damage|p2a: Mew|80/100',
    ])).toEqual([['Mew', 'Vaporeon', false]]);

    // Quick Claw put Vaporeon first regardless of Speed
    expect(speedPairs([
      '|-activate|p1a: Vaporeon|item: Quick Claw',
      '|move|p1a: Vaporeon|Scald|p2a: Mew',
      '|-damage|p2a: Mew|80/100',
      '|move|p2a: Mew|Body Slam|p1a: Vaporeon',
      '|-damage|p1a: Vaporeon|80/100',
    ])).toEqual([['Vaporeon', 'Mew', true]]);
  });

  it('attributes a Dancer copy\'s damage to the dancer, not the last new mover', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Oricorio|Oricorio, L50|100/100',
      '|switch|p2a: Volcarona|Volcarona, L50|100/100',
      '|turn|1',
      '|move|p1a: Oricorio|Roost|p1a: Oricorio',
      '|move|p2a: Volcarona|Fiery Dance|p1a: Oricorio',
      '|-damage|p1a: Oricorio|70/100',
      '|move|p1a: Oricorio|Fiery Dance|p2a: Volcarona|[from] ability: Dancer',
      '|-damage|p2a: Volcarona|80/100',
    ], 'dancer');

    expect(events.filter((event) => event.eventType !== 'speed').map((event) => [event.attackerName, event.defenderName])).toEqual([
      ['Volcarona', 'Oricorio'],
      ['Oricorio', 'Volcarona'],
    ]);
  });

  it('drops a Future Sight hit instead of merging it into the last move', () => {
    const { events, ignoredEventCount } = parseHackmonsInferenceEvents([
      '|switch|p1a: Vaporeon|Vaporeon, L50|100/100',
      '|switch|p2a: Mew|Mew, L50|100/100',
      '|turn|3',
      '|move|p2a: Mew|Swords Dance|p2a: Mew',
      '|-boost|p2a: Mew|atk|2',
      '|move|p1a: Vaporeon|Scald|p2a: Mew',
      '|-damage|p2a: Mew|80/100',
      '|',
      '|-end|p2a: Mew|move: Future Sight',
      '|-resisted|p2a: Mew',
      '|-damage|p2a: Mew|50/100',
      '|upkeep',
      '|turn|4',
      '|move|p1a: Vaporeon|Scald|p2a: Mew',
      '|-damage|p2a: Mew|30/100',
    ], 'future-sight');

    const damageEvents = events.filter((event) => event.eventType !== 'speed');

    expect(ignoredEventCount).toBe(1);
    expect(damageEvents.map((event) => [event.hitDamages, event.effectiveness, event.startHp])).toEqual([
      [[20], 'neutral', 100],
      [[20], 'neutral', 50],
    ]);
  });

  it('records whether a turn-history move doubled its power', () => {
    const doubled = (lines: string[], name: string) => parseHackmonsInferenceEvents([
      '|switch|p1a: Weavile|Weavile, L50|100/100',
      '|switch|p2a: Mew|Mew, L50|100/100',
      '|turn|1',
      ...lines,
    ], name).events
      .filter((event) => event.eventType !== 'speed')
      .map((event) => [event.moveName, event.powerDoubled]);

    expect(doubled([
      '|move|p2a: Mew|Body Slam|p1a: Weavile', '|-damage|p1a: Weavile|70/100',
      '|move|p1a: Weavile|Avalanche|p2a: Mew', '|-damage|p2a: Mew|80/100',
    ], 'avalanche')).toEqual([['Body Slam', undefined], ['Avalanche', true]]);

    // Bolt Beak doubles only if the target has yet to move; Payback only if it already has
    expect(doubled([
      '|move|p2a: Mew|Bolt Beak|p1a: Weavile', '|-damage|p1a: Weavile|70/100',
      '|move|p1a: Weavile|Payback|p2a: Mew', '|-damage|p2a: Mew|80/100',
    ], 'order')).toEqual([['Bolt Beak', true], ['Payback', true]]);

    // Assurance counts any damage this turn (here Mew's own Life Orb recoil); a fresh switch-in makes
    // Payback plain
    expect(doubled([
      '|move|p2a: Mew|Body Slam|p1a: Weavile', '|-damage|p1a: Weavile|70/100',
      '|-damage|p2a: Mew|90/100|[from] item: Life Orb',
      '|move|p1a: Weavile|Assurance|p2a: Mew', '|-damage|p2a: Mew|60/100',
    ], 'assurance')).toEqual([['Body Slam', undefined], ['Assurance', true]]);
    expect(doubled([
      '|switch|p2a: Blissey|Blissey, L50|100/100',
      '|move|p1a: Weavile|Payback|p2a: Blissey', '|-damage|p2a: Blissey|90/100',
    ], 'payback-switch')).toEqual([['Payback', false]]);

    expect(doubled([
      '|-activate|p2a: Mew|move: Pursuit',
      '|move|p1a: Weavile|Pursuit|p2a: Mew|[from] move: Pursuit', '|-damage|p2a: Mew|70/100',
    ], 'pursuit')).toEqual([['Pursuit', true]]);
  });

  it('marks a hit held at 1 HP as a lower bound', () => {
    const capped = (lines: string[], name: string) => parseHackmonsInferenceEvents([
      '|switch|p1a: Weavile|Weavile, L50|100/100',
      '|switch|p2a: Mew|Mew, L50|100/100',
      '|turn|1',
      ...lines,
    ], name).events
      .filter((event) => event.eventType !== 'speed')
      .map((event) => [event.moveName, event.endHp, !!event.survivalCapped]);

    expect(capped([
      '|move|p2a: Mew|Close Combat|p1a: Weavile',
      '|-enditem|p1a: Weavile|Focus Sash',
      '|-damage|p1a: Weavile|1/100',
      '|move|p1a: Weavile|Knock Off|p2a: Mew',
      '|-damage|p2a: Mew|1/100',
    ], 'sash')).toEqual([['Close Combat', 1, true], ['Knock Off', 1, false]]);

    expect(capped([
      '|move|p2a: Mew|Close Combat|p1a: Weavile',
      '|-ability|p1a: Weavile|Sturdy',
      '|-damage|p1a: Weavile|1/100',
      '|turn|2',
      '|move|p1a: Weavile|False Swipe|p2a: Mew',
      '|-damage|p2a: Mew|1/100',
    ], 'sturdy-false-swipe')).toEqual([['Close Combat', 1, true], ['False Swipe', 1, true]]);
  });

  it('records the item each side held at the time of each hit', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Vaporeon|Vaporeon, L50|100/100',
      '|switch|p2a: Mew|Mew, L50|100/100',
      '|turn|1',
      '|move|p2a: Mew|Body Slam|p1a: Vaporeon',
      '|-enditem|p2a: Mew|Normal Gem|[from] gem',
      '|-enditem|p1a: Vaporeon|Chilan Berry|[eat]',
      '|-enditem|p1a: Vaporeon|Chilan Berry|[weaken]',
      '|-damage|p1a: Vaporeon|80/100',
      '|turn|2',
      '|switch|p2a: Blissey|Blissey, L50|100/100',
      '|move|p1a: Vaporeon|Knock Off|p2a: Blissey',
      '|-damage|p2a: Blissey|90/100',
      '|-enditem|p2a: Blissey|Leftovers|[from] move: Knock Off|[of] p1a: Vaporeon',
      '|turn|3',
      '|move|p1a: Vaporeon|Scald|p2a: Blissey',
      '|-damage|p2a: Blissey|80/100',
    ], 'event-items');

    expect(events.filter((event) => event.eventType !== 'speed').map((event) => [
      event.moveName,
      event.attackerSnapshot?.consumedItem,
      !!event.attackerSnapshot?.itemLost,
      event.defenderSnapshot?.consumedItem,
      !!event.defenderSnapshot?.itemLost,
    ])).toEqual([
      ['Body Slam', 'Normal Gem', true, 'Chilan Berry', true],
      // Knock Off's -enditem follows its own hit: Blissey still held the Leftovers when it landed
      ['Knock Off', undefined, true, undefined, false],
      ['Scald', undefined, true, undefined, true],
    ]);
  });

  it('records the move-failure, faint, stat-drop and Fusion history those moves double on', () => {
    const doubled = (lines: string[], name: string) => parseHackmonsInferenceEvents([
      '|switch|p1a: Groudon|Groudon, L50|100/100',
      '|switch|p2a: Mew|Mew, L50|100/100',
      ...lines,
    ], name).events
      .filter((event) => event.eventType !== 'speed')
      .map((event) => [event.turn, event.moveName, event.powerDoubled]);

    // Stomping Tantrum: last turn's move missed (doubled), then last turn's move landed (not)
    expect(doubled([
      '|turn|1',
      '|move|p1a: Groudon|Precipice Blades|p2a: Mew|[miss]', '|-miss|p1a: Groudon|p2a: Mew',
      '|turn|2',
      '|move|p1a: Groudon|Stomping Tantrum|p2a: Mew', '|-damage|p2a: Mew|70/100',
      '|turn|3',
      '|move|p1a: Groudon|Stomping Tantrum|p2a: Mew', '|-damage|p2a: Mew|50/100',
    ], 'stomping')).toEqual([[2, 'Stomping Tantrum', true], [3, 'Stomping Tantrum', false]]);

    // full paralysis is a failure; recharging is not
    expect(doubled([
      '|turn|1', '|cant|p1a: Groudon|par',
      '|turn|2', '|move|p1a: Groudon|Temper Flare|p2a: Mew', '|-damage|p2a: Mew|70/100',
      '|turn|3', '|cant|p1a: Groudon|recharge',
      '|turn|4', '|move|p1a: Groudon|Temper Flare|p2a: Mew', '|-damage|p2a: Mew|40/100',
    ], 'cant')).toEqual([[2, 'Temper Flare', true], [4, 'Temper Flare', false]]);

    // Retaliate: an ally fainted last turn (doubled); not two turns ago
    expect(doubled([
      '|turn|1', '|move|p2a: Mew|Body Slam|p1a: Groudon', '|-damage|p1a: Groudon|0 fnt', '|faint|p1a: Groudon',
      '|switch|p1a: Tauros|Tauros, L50|100/100',
      '|turn|2', '|move|p1a: Tauros|Retaliate|p2a: Mew', '|-damage|p2a: Mew|60/100',
      '|turn|3', '|move|p1a: Tauros|Retaliate|p2a: Mew', '|-damage|p2a: Mew|20/100',
    ], 'retaliate').filter(([, move]) => move === 'Retaliate')).toEqual([[2, 'Retaliate', true], [3, 'Retaliate', false]]);

    // Lash Out: its stats were lowered earlier this turn
    expect(doubled([
      '|turn|1', '|move|p2a: Mew|Charm|p1a: Groudon', '|-unboost|p1a: Groudon|atk|2',
      '|move|p1a: Groudon|Lash Out|p2a: Mew', '|-damage|p2a: Mew|70/100',
      '|turn|2', '|move|p1a: Groudon|Lash Out|p2a: Mew', '|-damage|p2a: Mew|50/100',
    ], 'lashout')).toEqual([[1, 'Lash Out', true], [2, 'Lash Out', false]]);

    // Fusion Flare right after a successful Fusion Bolt, but not after a missed one
    expect(doubled([
      '|turn|1', '|move|p2a: Mew|Fusion Bolt|p1a: Groudon', '|-immune|p1a: Groudon',
      '|move|p1a: Groudon|Fusion Flare|p2a: Mew', '|-damage|p2a: Mew|70/100',
      '|turn|2', '|move|p2a: Mew|Fusion Bolt|p1a: Groudon', '|-damage|p1a: Groudon|80/100',
      '|move|p1a: Groudon|Fusion Flare|p2a: Mew', '|-damage|p2a: Mew|30/100',
    ], 'fusion').filter(([, move]) => move === 'Fusion Flare')).toEqual([[1, 'Fusion Flare', false], [2, 'Fusion Flare', true]]);
  });

  it('tracks abilities the log reveals by activation, and their state at each hit', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Terapagos|Terapagos-Terastal, L50|100/100',
      '|switch|p2a: Iron Valiant|Iron Valiant, L50|100/100',
      '|-enditem|p2a: Iron Valiant|Booster Energy',
      '|-activate|p2a: Iron Valiant|ability: Quark Drive|[fromitem]',
      '|-start|p2a: Iron Valiant|quarkdrivespe',
      '|turn|1',
      '|move|p2a: Iron Valiant|Moonblast|p1a: Terapagos',
      '|-activate|p1a: Terapagos|ability: Tera Shell',
      '|-resisted|p1a: Terapagos',
      '|-damage|p1a: Terapagos|80/100',
      '|move|p1a: Terapagos|Tera Starstorm|p2a: Iron Valiant',
      '|-damage|p2a: Iron Valiant|60/100',
      '|turn|2',
      '|-end|p2a: Iron Valiant|Quark Drive',
      '|move|p2a: Iron Valiant|Moonblast|p1a: Terapagos',
      '|-damage|p1a: Terapagos|55/100',
      '|turn|3',
      '|switch|p2a: Regigigas|Regigigas, L50|100/100',
      '|-start|p2a: Regigigas|ability: Slow Start',
      '|move|p2a: Regigigas|Body Slam|p1a: Terapagos',
      '|-damage|p1a: Terapagos|45/100',
    ], 'activations');

    expect(events.filter((event) => event.eventType !== 'speed').map((event) => [
      event.turn,
      event.moveName,
      event.attackerSnapshot?.abilityConfirmed,
      event.attackerSnapshot?.boostedStat,
      event.attackerSnapshot?.slowStart,
      !!event.defenderSnapshot?.teraShell,
    ])).toEqual([
      [1, 'Moonblast', true, 'spe', false, true],
      // Terapagos's Tera Shell was revealed on the hit before, so its ability is known from then on
      [1, 'Tera Starstorm', true, null, false, false],
      [2, 'Moonblast', true, null, false, false],
      [3, 'Body Slam', true, null, true, false],
    ]);
  });

  it('keeps a Smack Down grounding until the grounded mon switches out', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Tornadus|Tornadus, L50|100/100',
      '|switch|p2a: Garchomp|Garchomp, L50|100/100',
      '|turn|1',
      '|move|p2a: Garchomp|Smack Down|p1a: Tornadus', '|-damage|p1a: Tornadus|85/100', '|-start|p1a: Tornadus|Smack Down',
      '|turn|2',
      '|move|p2a: Garchomp|Earthquake|p1a: Tornadus', '|-damage|p1a: Tornadus|50/100',
      '|turn|3',
      '|switch|p1a: Tornadus|Tornadus, L50|50/100',
      '|move|p2a: Garchomp|Stone Edge|p1a: Tornadus', '|-supereffective|p1a: Tornadus', '|-damage|p1a: Tornadus|20/100',
    ], 'smack-down');

    expect(events.filter((event) => event.eventType !== 'speed').map((event) => [event.moveName, !!event.defenderSnapshot?.grounded]))
      .toEqual([['Smack Down', false], ['Earthquake', true], ['Stone Edge', false]]);
  });

  it('resolves each hit to the item held then, once a later Trick reveals it', () => {
    const { events } = parseHackmonsInferenceEvents([
      '|switch|p1a: Scizor|Scizor, L50|100/100',
      '|switch|p2a: Mew|Mew, L50|100/100',
      '|turn|1',
      '|move|p1a: Scizor|Bullet Punch|p2a: Mew', '|-damage|p2a: Mew|80/100',
      '|move|p2a: Mew|Body Slam|p1a: Scizor', '|-resisted|p1a: Scizor', '|-damage|p1a: Scizor|90/100',
      '|turn|2',
      '|move|p2a: Mew|Trick|p1a: Scizor',
      '|-activate|p2a: Mew|move: Trick|[of] p1a: Scizor',
      '|-item|p1a: Scizor|Leftovers|[from] move: Trick',
      '|-item|p2a: Mew|Choice Band|[from] move: Trick',
      '|move|p1a: Scizor|Bullet Punch|p2a: Mew', '|-damage|p2a: Mew|65/100',
      '|turn|3',
      '|move|p2a: Mew|Body Slam|p1a: Scizor', '|-resisted|p1a: Scizor', '|-damage|p1a: Scizor|70/100',
    ], 'trick');

    expect(events.filter((event) => event.eventType !== 'speed').map((event) => [
      event.turn,
      event.moveName,
      event.attackerSnapshot?.heldItem,
      event.defenderSnapshot?.heldItem,
    ])).toEqual([
      [1, 'Bullet Punch', 'Choice Band', 'Leftovers'],
      [1, 'Body Slam', 'Leftovers', 'Choice Band'],
      [2, 'Bullet Punch', 'Leftovers', 'Choice Band'],
      [3, 'Body Slam', 'Choice Band', 'Leftovers'],
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
