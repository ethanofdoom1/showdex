import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';

const showdownUrl = 'http://localhost.psim.us';
const showdownOrigins = [
  'http://localhost.psim.us',
  'https://localhost.psim.us',
];
const scenarioName = process.env.SCENARIO || 'mixed';
// all scenarios run in Pure Hackmons: Balanced Hackmons' banlist silently rejects otherwise-legal
// moves (Storm Throw, Rage Fist, ...) and the harness only sees this as a "battle room never
// appeared" timeout with no clear error, which is easy to mistake for a connection flake
const formatId = 'gen9purehackmons';
const formatLabel = 'Pure Hackmons';
const runId = `${process.pid}-${Date.now()}`;
const nameSuffix = Date.now().toString(36).slice(-6);
const playerNames = [`sdxa${nameSuffix}`, `sdxb${nameSuffix}`];
const profileDirs = {
  a: path.resolve(`.tmp/playwright-chrome-profile-hackmons-${runId}-a`),
  b: path.resolve(`.tmp/playwright-chrome-profile-hackmons-${runId}-b`),
};

// base stats for every species used across the scenarios below (needed to convert the inferred
// IV/EV/nature back into stats for spreadVerification). All scenarios reuse Mew (opponent, inferred)
// vs. Vaporeon (viewer, known), so the harness only needs these two.
const speciesBaseStats = {
  Mew: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
  Vaporeon: { hp: 130, atk: 65, def: 60, spa: 110, spd: 95, spe: 65 },
};

const teamA = (evs, nature, moves, { item = 'Leftovers', ability = 'Pressure', ivs } = {}) => `=== [${formatId}] Showdex Custom A ===

Vaporeon @ ${item}
Ability: ${ability}
Level: 100
EVs: ${evs}
${nature} Nature
${ivs ? `IVs: ${ivs}\n` : ''}${moves.map((move) => `- ${move}`).join('\n')}
`;

const teamB = (evs, nature, moves, { item = 'Leftovers', ability = 'Pressure', ivs } = {}) => `=== [${formatId}] Showdex Custom B ===

Mew @ ${item}
Ability: ${ability}
Level: 100
EVs: ${evs}
${nature} Nature
${ivs ? `IVs: ${ivs}\n` : ''}${moves.map((move) => `- ${move}`).join('\n')}
`;

// team A with a second Pokemon (a "backup") behind Vaporeon -- needed for scenarios where the
// viewer's own mon has to faint or switch out (e.g. testing reload behavior against a mon that's no
// longer active). `vaporeon`/`backup` each take { evs, nature, moves, item, ability }
const teamAWithBackup = (vaporeon, backup) => `=== [${formatId}] Showdex Custom A ===

Vaporeon @ ${vaporeon.item || 'Leftovers'}
Ability: ${vaporeon.ability || 'Pressure'}
Level: 100
EVs: ${vaporeon.evs}
${vaporeon.nature} Nature
${vaporeon.moves.map((move) => `- ${move}`).join('\n')}

${backup.species} @ ${backup.item || 'Leftovers'}
Ability: ${backup.ability || 'Pressure'}
Level: 100
EVs: ${backup.evs}
${backup.nature} Nature
${backup.moves.map((move) => `- ${move}`).join('\n')}
`;

// opponent (inferred) side with a backup behind Mew -- needed for scenarios where Mew has to faint
// but the battle must keep going (so the room isn't torn down before we can snapshot). `mew`/`backup`
// each take { evs, nature, moves, item, ability }; `backup` also takes { species }
const teamBWithBackup = (mew, backup) => `=== [${formatId}] Showdex Custom B ===

Mew @ ${mew.item || 'Leftovers'}
Ability: ${mew.ability || 'Pressure'}
Level: 100
EVs: ${mew.evs}
${mew.nature} Nature
${mew.moves.map((move) => `- ${move}`).join('\n')}

${backup.species} @ ${backup.item || 'Leftovers'}
Ability: ${backup.ability || 'Pressure'}
Level: 100
EVs: ${backup.evs}
${backup.nature} Nature
${backup.moves.map((move) => `- ${move}`).join('\n')}
`;

// each scenario exercises a different inference path; pick one with SCENARIO=<name> (default: mixed)
const scenarios = {
  // special attacker (Mew) -> SpA/SpD inference + speed bound from Electro Ball / turn order
  mixed: {
    teams: {
      a: teamA('252 HP / 4 Def / 252 SpA', 'Modest', ['Body Slam', 'Water Spout', 'Psyshock', 'Recover']),
      b: teamB('252 HP / 4 Atk / 252 SpA', 'Quiet', ['Electro Ball', 'Leaf Storm', 'Body Slam', 'Recover']),
    },
    plannedTurns: [
      { a: 'Psyshock', b: 'Electro Ball' },
      { a: 'Psyshock', b: 'Electro Ball' },
      { a: 'Water Spout', b: 'Leaf Storm' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Psyshock', b: 'Body Slam' },
      { a: 'Water Spout', b: 'Electro Ball' },
      { a: 'Psyshock', b: 'Leaf Storm' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Water Spout', b: 'Electro Ball' },
    ],
  },

  // physical attacker on both sides -> Atk (Mew hitting Vaporeon) + Def (Mew taking hits) inference.
  // note: A and B use *disjoint* damaging move names so the harness's (turn, moveName) pairing in
  // damageMismatches stays unambiguous (the same move on both sides would pair the wrong events)
  physical: {
    teams: {
      a: teamA('252 HP / 252 Atk', 'Adamant', ['Waterfall', 'Crunch', 'Aqua Tail', 'Recover']),
      b: teamB('252 HP / 252 Atk / 4 Def', 'Adamant', ['Body Slam', 'Earthquake', 'Zen Headbutt', 'Recover']),
    },
    plannedTurns: [
      { a: 'Waterfall', b: 'Body Slam' },
      { a: 'Crunch', b: 'Earthquake' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Waterfall', b: 'Zen Headbutt' },
      { a: 'Crunch', b: 'Body Slam' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Waterfall', b: 'Earthquake' },
      { a: 'Crunch', b: 'Body Slam' },
    ],
  },

  // multi-hit move -> tests per-hit damage aggregation + hit-count handling (Atk inference).
  // A only chips with Waterfall; B's multi-hit moves are disjoint from A's moves
  multihit: {
    teams: {
      a: teamA('252 HP / 252 Def', 'Bold', ['Recover', 'Waterfall', 'Scald', 'Ice Beam']),
      b: teamB('252 HP / 252 Atk', 'Adamant', ['Bullet Seed', 'Rock Blast', 'Body Slam', 'Recover']),
    },
    plannedTurns: [
      { a: 'Recover', b: 'Bullet Seed' },
      { a: 'Recover', b: 'Rock Blast' },
      { a: 'Waterfall', b: 'Bullet Seed' },
      { a: 'Recover', b: 'Rock Blast' },
      { a: 'Recover', b: 'Bullet Seed' },
      { a: 'Waterfall', b: 'Body Slam' },
      { a: 'Recover', b: 'Rock Blast' },
    ],
  },

  // crit handling -> BH bans all guaranteed-crit moves (Storm Throw, Frost Breath, Wicked Blow, ...),
  // so we force crits the legal way: Merciless (on Mew) always crits a poisoned target. Vaporeon
  // self-poisons via Toxic Orb + Magic Guard (Magic Guard zeroes the poison chip but the 'tox' status
  // still applies). The Toxic Orb lands at the END of turn 1, so turn 1 must use a move with NO status
  // chance (Earthquake) -- otherwise Body Slam's paralysis can statuse Vaporeon first and block the
  // poison (and thus Merciless). Once 'tox' is locked in, later Body Slam para attempts no-op and every
  // hit crits: a non-crit turn 1 then guaranteed crits, exercising crit detection + down-weighting.
  // A only chips with Waterfall (disjoint from B's damaging moves).
  crit: {
    teams: {
      a: teamA('252 HP / 252 Def', 'Bold', ['Recover', 'Waterfall', 'Scald', 'Ice Beam'], { item: 'Toxic Orb', ability: 'Magic Guard' }),
      b: teamB('252 HP / 252 Atk', 'Adamant', ['Body Slam', 'Earthquake', 'Crunch', 'Recover'], { ability: 'Merciless' }),
    },
    plannedTurns: [
      { a: 'Recover', b: 'Earthquake' },
      { a: 'Recover', b: 'Body Slam' },
      { a: 'Recover', b: 'Earthquake' },
      { a: 'Waterfall', b: 'Body Slam' },
      { a: 'Recover', b: 'Earthquake' },
      { a: 'Recover', b: 'Body Slam' },
      { a: 'Recover', b: 'Earthquake' },
    ],
  },

  // event-time state snapshots -> weather affects Weather Ball, terrain affects Terrain Pulse, and
  // Protean changes Mew's type before damage. This catches regressions where old damage events are
  // replayed against the final live field/type state instead of the state at that log line.
  temporary: {
    teams: {
      a: teamA('252 HP / 252 SpA', 'Modest', ['Rain Dance', 'Weather Ball', 'Electric Terrain', 'Terrain Pulse']),
      b: teamB('252 HP / 252 SpA', 'Quiet', ['Recover', 'Magical Leaf', 'Shadow Ball', 'Body Slam'], { ability: 'Protean' }),
    },
    plannedTurns: [
      { a: 'Rain Dance', b: 'Magical Leaf' },
      { a: 'Rain Dance', b: 'Magical Leaf' },
      { a: 'Weather Ball', b: 'Recover' },
      { a: 'Terrain Pulse', b: 'Recover' },
      { a: 'Electric Terrain', b: 'Recover' },
      { a: 'Terrain Pulse', b: 'Shadow Ball' },
      { a: 'Weather Ball', b: 'Recover' },
      { a: 'Rain Dance', b: 'Recover' },
    ],
  },

  // exact speed tie -> Vaporeon (72 Spe EV, neutral-Spe nature) and Mew (0 Spe IV/EV, Quiet) are
  // engineered to both land on Spe 184, so every equal-priority turn is a genuine 50/50 coin flip on
  // who moves first. This exercises two bugs: (1) evaluateCandidateSpeedEvent/describeSpeedBound used
  // to treat equality as a bound violation (excluding the legal tie), which -- once both directions are
  // observed across enough turns -- forced a contradiction that pushed the search away from the correct
  // Spe; (2) describeSpeedBound used to emit one note per event instead of collapsing repeated
  // observations down to the single tightest bound. Every turn (including Recover/Recover) produces a
  // same-priority speed-order event, so 12 turns give ~12 independent coin flips -- overwhelmingly
  // likely (>99.9%) to land on both directions and so exercise the tie contradiction.
  speedtie: {
    teams: {
      a: teamA('252 HP / 72 Spe / 186 SpA', 'Modest', ['Psychic', 'Recover']),
      b: teamB('252 HP / 252 SpA / 4 Def', 'Quiet', ['Shadow Ball', 'Recover'], { ivs: '0 Spe' }),
    },
    plannedTurns: [
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Psychic', b: 'Shadow Ball' },
      { a: 'Recover', b: 'Recover' },
    ],
  },

  // Rage Fist -> its base power scales with how many times the USER has been hit by a damaging move
  // this battle (50 * (1 + hitCounter)). Vaporeon chips Mew with Waterfall across several turns while
  // Mew Recovers, so Mew's hit counter climbs to 3, 4, then 5 by the time it fires three separate Rage
  // Fists -- giving three distinct, escalating BP values (200/250/300) to verify the scaling landed on
  // the right historical count, not the live/zero value.
  ragefist: {
    teams: {
      a: teamA('252 HP / 252 Atk', 'Adamant', ['Waterfall', 'Recover']),
      b: teamB('252 HP / 252 Atk / 4 Def', 'Adamant', ['Rage Fist', 'Recover']),
    },
    plannedTurns: [
      { a: 'Waterfall', b: 'Recover' },
      { a: 'Waterfall', b: 'Recover' },
      { a: 'Waterfall', b: 'Recover' },
      { a: 'Recover', b: 'Rage Fist' },
      { a: 'Waterfall', b: 'Recover' },
      { a: 'Recover', b: 'Rage Fist' },
      { a: 'Waterfall', b: 'Recover' },
      { a: 'Recover', b: 'Rage Fist' },
    ],
  },

  // Rollout -> @smogon/calc treats it as a flat 30 BP move (no consecutive-use doubling, no Defense
  // Curl synergy), so every hit after the Defense Curl setup is a guaranteed "too-high" outlier that
  // will never land in the modeled roll range. Vaporeon only Recovers (deals no damage back), so
  // Mew's ENTIRE damage evidence is unmatchable Rollout hits -- this is the exact shape of the bug
  // report: before the graceful-degradation fix, zero in-range matches meant the whole "Estimated
  // Spread" UI vanished instead of publishing a low-confidence estimate with outlier tags.
  rollout: {
    teams: {
      a: teamA('252 HP / 252 Def', 'Bold', ['Recover']),
      b: teamB('252 HP / 252 Atk / 4 Def', 'Adamant', ['Defense Curl', 'Rollout']),
    },
    plannedTurns: [
      { a: 'Recover', b: 'Defense Curl' },
      { a: 'Recover', b: 'Rollout' },
      { a: 'Recover', b: 'Rollout' },
      { a: 'Recover', b: 'Rollout' },
      { a: 'Recover', b: 'Rollout' },
    ],
  },

  // Upper Hand -> only deals damage if the target is ALSO using a priority move this turn (otherwise
  // it fails outright); Vaporeon's Quick Attack supplies that condition every attacking turn. This is
  // a plain fixed-BP Dark move with no known @smogon/calc modeling gap, so this scenario exists to
  // confirm-or-refute the "Upper Hand" half of the bug report (hypothesized to be a red herring
  // riding along with the real Rollout bug, not a separate modeling issue).
  upperhand: {
    teams: {
      a: teamA('252 HP / 252 Atk', 'Adamant', ['Quick Attack', 'Recover']),
      b: teamB('252 HP / 252 Atk / 4 Def', 'Adamant', ['Upper Hand', 'Recover']),
    },
    plannedTurns: [
      { a: 'Quick Attack', b: 'Upper Hand' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Quick Attack', b: 'Upper Hand' },
      { a: 'Recover', b: 'Recover' },
      { a: 'Quick Attack', b: 'Upper Hand' },
    ],
  },

  // Huge Power -> a passive onModifyAtk-only ability with no `|-ability|` reveal line anywhere in its
  // real implementation (unlike message-generating abilities like Intimidate/Drizzle), so it never
  // gets confirmed for the rest of the battle. Vaporeon only Recovers (deals no damage back), so
  // Mew's entire evidence is Body Slam hits at ~2x its true (neutral-ability) modeled max -- every
  // hit should land as a "too-high" outlier rather than dragging the inferred Atk EV/IV down to
  // (incorrectly) explain away a boost the search doesn't know about.
  hugepower: {
    teams: {
      a: teamA('252 HP / 252 Def', 'Bold', ['Recover']),
      b: teamB('252 HP / 252 Atk / 4 Def', 'Adamant', ['Body Slam', 'Recover'], { ability: 'Huge Power' }),
    },
    plannedTurns: [
      { a: 'Recover', b: 'Body Slam' },
      { a: 'Recover', b: 'Body Slam' },
      { a: 'Recover', b: 'Body Slam' },
      { a: 'Recover', b: 'Body Slam' },
    ],
  },

  // SAME-TURN self-inflicted defense drop on the CANDIDATE defender -> matches the manually observed
  // bug geometry (Snivy used Armor Cannon, then Hyperspace Hole hit it THAT SAME TURN -> falsely
  // flagged `too-high`), with Snivy as the inferred opponent. The other three geometry cells were
  // verified clean (cross-turn x either defender; same-turn x non-candidate defender), so this covers
  // the last one: the CANDIDATE Mew (base 100 Spe, naturally faster than Vaporeon) uses Armor Cannon
  // FIRST in the turn (dropping its own -1 Def/SpDef mid-turn), then Vaporeon's Hyperspace Hole (the
  // exact move from the report) hits the freshly-dropped Mew before the turn ends. Turns alternate
  // same-turn hits (T1 at -1, T3 at -2 -- the drops stack) with cross-turn control hits at the same
  // stages (T2 at -1, T5 at -2): if only the same-turn events outlier/mismatch, the drop is being
  // registered a turn late for the candidate's own search. Correctness: NO Hyperspace Hole event
  // outlier-tagged, no damageMismatches, Mew's SpD delta small.
  defdrop: {
    teams: {
      a: teamA('252 HP / 252 SpA', 'Modest', ['Hyperspace Hole', 'Recover']),
      b: teamB('252 HP / 252 SpD', 'Calm', ['Armor Cannon', 'Recover']),
    },
    plannedTurns: [
      { a: 'Hyperspace Hole', b: 'Armor Cannon' }, // SAME turn: Mew drops itself to -1, then gets hit at -1
      { a: 'Hyperspace Hole', b: 'Recover' }, // cross-turn control: hit at -1
      { a: 'Hyperspace Hole', b: 'Armor Cannon' }, // SAME turn: drop to -2, then hit at -2
      { a: 'Recover', b: 'Recover' },
      { a: 'Hyperspace Hole', b: 'Recover' }, // cross-turn control: hit at -2
    ],
  },

  // reload mid-battle -> the VIEWER's own Vaporeon chips Mew with Waterfall, then VOLUNTARILY
  // switches out to a Blissey backup; the page is then reloaded and rejoins the same battle room.
  // This reproduces a real bug: right after reload, Showdown's `battle.myPokemon` (the source of the
  // auth player's roster -- see syncBattle.ts) is transiently empty until the next `|request|`
  // message arrives (a separate, later websocket message than the stepQueue replay that reconstructs
  // the visible log), so a switched-out mon can briefly be missing from state[authPlayerKey].pokemon.
  // Vaporeon's Waterfall hits against Mew are historical events whose ATTACKER (Vaporeon) lookup must
  // still resolve after the reload for Mew's Def to be inferred -- if `InferenceCache` baked in a
  // lookup failure from that transient window, it would never self-heal since the event signature
  // doesn't change once the roster completes.
  //
  // A voluntary switch (not a faint) is used deliberately: faint timing depends on damage rolls and a
  // bulky backup can stall the battle indefinitely, whereas a scripted switch is exact. Mew only ever
  // Recovers, so it deals no damage back -- the battle can't stall out or KO Vaporeon early, and the
  // only damage events are Vaporeon -> Mew (which is what we want to reconstruct across the reload).
  reload: {
    teams: {
      a: teamAWithBackup(
        { evs: '252 Atk', nature: 'Adamant', moves: ['Waterfall', 'Recover'] },
        { species: 'Blissey', evs: '252 HP / 252 Def', nature: 'Bold', moves: ['Recover'] },
      ),
      b: teamB('252 HP / 252 Def / 4 SpD', 'Bold', ['Recover']),
    },
    plannedTurns: [
      { a: 'Waterfall', b: 'Recover' },
      { a: 'Waterfall', b: 'Recover' },
      { a: 'Switch', b: 'Recover' }, // Vaporeon voluntarily switches to Blissey; reload fires after this
    ],
    reloadAfterTurn: 2,
  },

  // fainted-CANDIDATE lookup across a reload (Bug B) -> the inferred opponent Mew is KO'd BY DAMAGE
  // (leaving the real `0 fnt` condition on its roster entry -- a self-faint like Memento never
  // produces one), and then the VIEWER's page reloads while p2's replacement is still pending. The
  // viewer instance is the one that reconstructs the battle from the log replay, so it's the instance
  // that must re-identify the fainted Mew as the defender of both historical Waterfall events for its
  // estimate to survive. Determinism: Choice Band + Huge Power Vaporeon's Waterfall rolls 276-324 vs
  // Mew's 404 HP -- one hit can never KO (max 324 < 404) and two hits always do (min 552 > 404), so
  // Mew faints on EXACTLY the second Waterfall regardless of rolls. Mew holds Air Balloon (inert vs
  // Waterfall, no Leftovers healing to shift the math) and only Celebrates (never heals, deals no
  // damage back). Earlier variants (opponent Memento self-faint; auth-side Memento faint) both passed,
  // so this pins the remaining untested trigger: a damage-KO'd `0 fnt` candidate across a reload.
  // Correctness: post-reload, Mew's two Waterfall events still resolve (backendMatchCount 2, not a
  // reverted neutral prior).
  faintreload: {
    teams: {
      a: teamAWithBackup(
        {
          evs: '252 HP / 252 Atk',
          nature: 'Adamant',
          moves: ['Waterfall', 'Recover'],
          item: 'Choice Band',
          ability: 'Huge Power',
        },
        { species: 'Blissey', evs: '252 HP / 252 Def', nature: 'Bold', moves: ['Recover'] },
      ),
      b: teamBWithBackup(
        { evs: '252 HP / 252 SpD', nature: 'Calm', moves: ['Celebrate'], item: 'Air Balloon' },
        { species: 'Chansey', evs: '252 HP / 252 Def', nature: 'Bold', moves: ['Recover'] },
      ),
    },
    plannedTurns: [
      { a: 'Waterfall', b: 'Celebrate' }, // Def evidence #1 (~70%, can never KO)
      { a: 'Waterfall', b: 'Celebrate' }, // Mew is KO'd by damage -> `0 fnt`; reload fires while p2's replacement is pending
    ],
    reloadAfterTurn: 1,
  },
};

const scenario = scenarios[scenarioName];

if (!scenario) {
  throw new Error(`Unknown SCENARIO "${scenarioName}". Available: ${Object.keys(scenarios).join(', ')}`);
}

console.log(`Using scenario: ${scenarioName}`);

const customTeamImports = scenario.teams;

const natureModifiers = {
  Hardy: {},
  Lonely: { plus: 'atk', minus: 'def' },
  Brave: { plus: 'atk', minus: 'spe' },
  Adamant: { plus: 'atk', minus: 'spa' },
  Naughty: { plus: 'atk', minus: 'spd' },
  Bold: { plus: 'def', minus: 'atk' },
  Docile: {},
  Relaxed: { plus: 'def', minus: 'spe' },
  Impish: { plus: 'def', minus: 'spa' },
  Lax: { plus: 'def', minus: 'spd' },
  Timid: { plus: 'spe', minus: 'atk' },
  Hasty: { plus: 'spe', minus: 'def' },
  Serious: {},
  Jolly: { plus: 'spe', minus: 'spa' },
  Naive: { plus: 'spe', minus: 'spd' },
  Modest: { plus: 'spa', minus: 'atk' },
  Mild: { plus: 'spa', minus: 'def' },
  Quiet: { plus: 'spa', minus: 'spe' },
  Bashful: {},
  Rash: { plus: 'spa', minus: 'spd' },
  Calm: { plus: 'spd', minus: 'atk' },
  Gentle: { plus: 'spd', minus: 'def' },
  Sassy: { plus: 'spd', minus: 'spe' },
  Careful: { plus: 'spd', minus: 'spa' },
  Quirky: {},
};

const parseSpreadLine = (line) => {
  const spread = {};

  for (const [, value, stat] of line.matchAll(/(\d+)\s+(HP|ATK|DEF|SPA|SPD|SPE)/gi)) {
    spread[stat.toLowerCase()] = Number(value);
  }

  return spread;
};

const parseTeamSpread = (importText) => {
  const species = importText.match(/\n?([A-Za-z0-9 -]+)\s*@/)?.[1]?.trim();
  const level = Number(importText.match(/\nLevel:\s*(\d+)/)?.[1]) || 100;
  const nature = importText.match(/\n([A-Za-z]+)\s+Nature/)?.[1] || 'Serious';
  const evs = {
    hp: 0,
    atk: 0,
    def: 0,
    spa: 0,
    spd: 0,
    spe: 0,
    ...parseSpreadLine(importText.match(/\nEVs:\s*([^\n]+)/)?.[1] || ''),
  };
  const ivs = {
    hp: 31,
    atk: 31,
    def: 31,
    spa: 31,
    spd: 31,
    spe: 31,
    ...parseSpreadLine(importText.match(/\nIVs:\s*([^\n]+)/)?.[1] || ''),
  };

  return {
    species,
    level,
    nature,
    ivs,
    evs,
  };
};

const calcStat = (species, stat, level, nature, iv, ev) => {
  const base = speciesBaseStats[species]?.[stat];

  if (typeof base !== 'number') {
    return null;
  }

  if (stat === 'hp') {
    return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
  }

  const neutral = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5;
  const modifier = natureModifiers[nature]?.plus === stat
    ? 1.1
    : natureModifiers[nature]?.minus === stat
      ? 0.9
      : 1;

  return Math.floor(neutral * modifier);
};

const StatKeys = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

const calcSpreadStats = ({ species, level, nature, ivs, evs }) => StatKeys.reduce((stats, stat) => {
  stats[stat] = calcStat(species, stat, level, nature, ivs[stat], evs[stat]);
  return stats;
}, {});

const realOpponentSpread = parseTeamSpread(customTeamImports.b);
const realOpponentStats = calcSpreadStats(realOpponentSpread);

const plannedTurns = scenario.plannedTurns;

const battleUiSettleMs = 250;

const attachPageGuards = (page) => {
  page.on('dialog', async (dialog) => {
    console.log(`Auto-accepting dialog: ${dialog.message()}`);
    await dialog.accept().catch(() => null);
  });
};

const dismissExternalAccessPrompt = async (page) => {
  const promptText = page.getByText(/access other apps and services on this device/i);

  if (!await promptText.isVisible().catch(() => false)) {
    return false;
  }

  for (const label of ['Allow', 'Continue', 'OK', 'Open']) {
    const button = page.getByRole('button', { name: label });

    if (await button.isVisible().catch(() => false)) {
      await button.click({ force: true });
      return true;
    }
  }

  return false;
};

const resolveExtensionDir = () => {
  const candidates = [
    path.resolve('build/chrome'),
    path.resolve('dist/chrome'),
  ];

  const existing = candidates.find((dir) => fs.existsSync(path.join(dir, 'manifest.json')));

  if (existing) {
    return existing;
  }

  console.log('No unpacked Chrome extension output found. Building dist/chrome...');

  const result = spawnSync('pnpm', ['build:chrome'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error('Failed to build Chrome extension output.');
  }

  const built = candidates.find((dir) => fs.existsSync(path.join(dir, 'manifest.json')));

  if (!built) {
    throw new Error('Chrome extension build completed, but no unpacked manifest was found.');
  }

  return built;
};

const extensionDir = resolveExtensionDir();

const createContext = async (label) => {
  const userDataDir = profileDirs[label];
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--mute-audio',
      '--allow-insecure-localhost',
      '--disable-web-security',
      '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPrompt,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
      `--unsafely-treat-insecure-origin-as-secure=${showdownOrigins.join(',')}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  context.on('page', attachPageGuards);
  context.pages().forEach(attachPageGuards);

  for (const origin of showdownOrigins) {
    await context.grantPermissions(['local-network-access'], { origin }).catch(() => null);
  }

  return context;
};

const createClientPage = async (context) => {
  const existingPages = context.pages();

  await Promise.all(existingPages.map(async (page) => {
    const url = page.url();

    if (!url || url.startsWith('chrome-extension://') || url.startsWith('devtools://')) {
      return;
    }

    await page.close().catch(() => null);
  }));

  const page = await context.newPage();
  attachPageGuards(page);
  return page;
};

const getCurrentUsername = async (page) => page.evaluate(
  () => window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null,
);

const muteClient = async (page) => page.evaluate(() => {
  try {
    const prefs = window.Storage?.prefs;

    if (typeof prefs === 'function') {
      prefs('mute', true, true);
      prefs('effectvolume', 0, true);
      prefs('musicvolume', 0, true);
      prefs('notifvolume', 0, true);
    }
  } catch {}

  try {
    if (window.BattleSound?.setMute) {
      window.BattleSound.setMute(true);
    }
  } catch {}

  try {
    if (window.BattleBGM?.sound) {
      window.BattleBGM.sound.muted = true;
      window.BattleBGM.sound.volume = 0;
    }
  } catch {}
});

const waitForClientReady = async (page) => page.waitForFunction(() => {
  const username = window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null;

  return !!username || document.body.innerText.includes('Choose name') || document.body.innerText.includes('Home');
}, null, { timeout: 5000 });

const ensureConnected = async (page) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await dismissExternalAccessPrompt(page);
    await waitForClientReady(page).catch(() => null);

    const bodyText = await page.evaluate(() => document.body.innerText || '');

    if (!bodyText.includes('Couldn\'t connect to server!') && !bodyText.includes('Connecting...')) {
      return;
    }

    const retryWithHttpButton = page.getByRole('button', { name: 'Retry with HTTP' });
    const retryButton = page.getByRole('button', { name: 'Retry' });

    if (await retryWithHttpButton.isVisible().catch(() => false)) {
      await retryWithHttpButton.click();
    } else if (await retryButton.isVisible().catch(() => false)) {
      await retryButton.click();
    }

    await page.waitForTimeout(1000);
  }
};

// claims/reclaims a guest identity on the current connection. The client's own "Choose name" popup
// button (when visible) drives a real login-flow handshake that a raw `/trn name,0,` cannot replicate
// -- on a *second* connection under the same persistent browser profile, the server rejects a bare
// unauthenticated `/trn` for a name it's already seen claimed this session (`|nametaken|...|Your
// authentication token was invalid.`), but going through the popup button succeeds because the client
// handles whatever token/handshake the server actually wants. Always prefer the button path; `/trn` is
// only a fallback for the (first-connection) case where no popup is shown at all
const claimUsername = async (page, username) => {
  const currentUser = await getCurrentUsername(page);

  if (currentUser === username) {
    return true;
  }

  const chooseNameButton = page.getByText('Choose name');

  if (await chooseNameButton.isVisible().catch(() => false)) {
    await chooseNameButton.click();
    await page.locator('.ps-popup input').waitFor({ timeout: 5000 });
    await page.locator('.ps-popup input').fill(username);
    await page.locator('.ps-popup').getByRole('button', { name: 'Choose name' }).click();
  } else {
    await page.evaluate((name) => window.app.send(`/trn ${name},0,`), username);
  }

  const waitForUsername = async (timeoutMs) => page.waitForFunction(
    (expected) => (window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null) === expected,
    username,
    { timeout: timeoutMs },
  );

  const popupInput = page.locator('.ps-popup input');
  const popupChooseButton = page.locator('.ps-popup').getByRole('button', { name: 'Choose name' });

  if (await popupInput.isVisible().catch(() => false)) {
    await popupInput.fill(username);
    await popupChooseButton.click();
  }

  await ensureConnected(page);

  let registered = await waitForUsername(5000).then(() => true).catch(() => false);

  if (!registered) {
    await page.evaluate((name) => window.app.send(`/trn ${name},0,`), username);
    await ensureConnected(page);
    registered = await waitForUsername(5000).then(() => true).catch(() => false);
  }

  if (!registered && await popupInput.isVisible().catch(() => false)) {
    await popupInput.fill(username);
    await popupChooseButton.last().click({ force: true });
    await ensureConnected(page);
    registered = await waitForUsername(5000).then(() => true).catch(() => false);
  }

  return registered;
};

const chooseName = async (page, username) => {
  await page.goto(showdownUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await muteClient(page);
  await ensureConnected(page);
  await waitForClientReady(page);

  const registered = await claimUsername(page, username);

  if (!registered) {
    throw new Error(`Name handshake failed for ${username}: ${JSON.stringify(await snapshotClient(page), null, 2)}`);
  }
};

const resetClientState = async (page, forfeit = false) => page.evaluate(async (shouldForfeit) => {
  const battleIds = Object.keys(window.app?.rooms || {}).filter((id) => id.startsWith('battle-'));

  for (const roomId of battleIds) {
    const room = window.app.rooms[roomId];

    window.app.focusRoom(roomId);

    if (shouldForfeit) {
      room?.forfeit?.();
      window.app.send('/forfeit');
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    room?.closeAndMainMenu?.();
    window.app.leaveRoom(roomId);
  }

  window.app.focusRoom('lobby');
  window.app.send('/cancelsearch');

  return battleIds;
}, forfeit);

const seedCustomTeam = async (page, importText, teamName) => page.evaluate((payload) => {
  const teams = window.Storage?.importTeam?.(payload.importText, true);

  if (!Array.isArray(teams) || !teams.length) {
    throw new Error('Failed to import custom team text into Showdown storage.');
  }

  window.Storage.saveTeams?.();

  return {
    teamName: payload.teamName,
    format: payload.format,
    importedCount: teams.length,
    storedTeams: (window.Storage.teams || []).map((candidate) => `${candidate.name}:${candidate.format}`),
  };
}, {
  importText,
  format: formatId,
  teamName,
});

const safePageEvaluate = async (page, evaluator, ...args) => {
  if (page.isClosed()) {
    return null;
  }

  try {
    return await page.evaluate(evaluator, ...args);
  } catch {
    return null;
  }
};

const useTeamForNextBattle = async (page, teamName) => page.evaluate((name) => {
  const team = (window.Storage?.teams || []).find((candidate) => candidate?.name === name);

  if (!team || typeof window.Storage?.packTeam !== 'function') {
    throw new Error(`Could not pack team ${name}.`);
  }

  const packedTeam = Array.isArray(team.team)
    ? window.Storage.packTeam(team.team)
    : team.team;

  if (!packedTeam || typeof packedTeam !== 'string') {
    throw new Error(`Could not resolve packed team payload for ${name}.`);
  }

  window.app.send(`/utm ${packedTeam}`);
}, teamName);

const getActiveBattleRoom = async (page) => safePageEvaluate(page, () => (
  Object.keys(window.app?.rooms || {}).find((id) => {
    const room = window.app.rooms[id];

    return id.startsWith('battle-')
      && room?.battle
      && ['move', 'switch', 'wait'].includes(room?.request?.requestType);
  }) || null
));

const getBattleRoom = async (page) => safePageEvaluate(page, () => (
  Object.keys(window.app?.rooms || {}).find((id) => id.startsWith('battle-') && window.app.rooms[id]?.battle) || null
));

const waitForAnyBattleRoom = async (page, timeout = 5000) => {
  await page.waitForFunction(
    () => Object.keys(window.app?.rooms || {}).some((id) => id.startsWith('battle-') && window.app.rooms[id]?.battle),
    null,
    { timeout },
  ).catch(() => null);

  return getBattleRoom(page);
};

const waitForBattleRoom = async (page, existingBattleIds = []) => {
  await page.waitForFunction(
    (knownIds) => Object.keys(window.app?.rooms || {}).find((id) => id.startsWith('battle-') && !knownIds.includes(id)) || null,
    existingBattleIds,
    { timeout: 60000 },
  );

  return page.evaluate(
    (knownIds) => Object.keys(window.app.rooms).find((id) => id.startsWith('battle-') && !knownIds.includes(id)),
    existingBattleIds,
  );
};

const focusBattleRoom = async (page, battleId) => {
  await page.evaluate((roomId) => window.app.focusRoom(roomId), battleId);
  await page.waitForTimeout(battleUiSettleMs);
};

// gates on the actual first move request rather than `battle.turn > 0` -- the turn counter can lag a
// tick behind the request that unlocks it, and (unlike turn) this is exactly the state the "blank
// neutral-prior" snapshot cares about: battle UI mounted, first real decision pending, zero events yet
const waitForMoveRequest = async (page, battleId) => page.waitForFunction(
  (roomId) => window.app?.rooms?.[roomId]?.request?.requestType === 'move',
  battleId,
  { timeout: 30000 },
);

// `room.request` briefly goes missing during phase transitions (post-reload rejoin, right after a
// switch/faint resolves) -- submitting a choice while it's absent crashes with requestType=undefined.
// Callers should wait for it to be present before attempting to act on it
const waitForRequestPresent = async (page, battleId, timeoutMs = 15000) => page.waitForFunction(
  (roomId) => !!(window.app?.rooms?.[roomId]?.request),
  battleId,
  { timeout: timeoutMs },
).catch(() => null);

// team preview must be explicitly resolved by both sides before anything else can happen. Nothing
// else in this script sends the team-preview choice outside of the main planned-turn loop, so this
// must be called directly wherever team preview needs resolving before that loop has started --
// otherwise any wait for turn/request progress deadlocks for its full timeout, since nobody ever
// leaves team preview
const submitTeamPreview = async (page, battleId) => page.evaluate((roomId) => {
  const room = window.app?.rooms?.[roomId];
  const requestType = room?.request?.requestType;

  if (requestType === 'teampreview' || requestType === 'team') {
    window.app.send('/choose team 1', roomId);
  }
}, battleId);

// simulates a real browser refresh mid-battle: navigates directly to the room's URL (which
// re-authenticates the same guest session from the persistent profile and rejoins the in-progress
// battle), rather than assuming the client auto-restores the previously open room tab
const reloadAndRejoinBattle = async (page, username, battleId) => {
  // TEMPORARY diagnostic: capture raw websocket frames around the post-reload identity handshake so a
  // failed /trn rename can be told apart from a slow one (does the server ever send |nametaken| or
  // |updateuser|, or is nothing coming back at all?). Remove once the reload identity bug is resolved
  const socketFrames = [];

  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => socketFrames.push({ dir: 'recv', payload: String(frame.payload).slice(0, 300) }));
    ws.on('framesent', (frame) => socketFrames.push({ dir: 'sent', payload: String(frame.payload).slice(0, 300) }));
  });

  await page.goto(`${showdownUrl}/${battleId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await muteClient(page);
  await ensureConnected(page);
  await waitForClientReady(page);

  // guest identity (unregistered, no password) is NOT restored automatically by the client on a
  // fresh connection the way a real login session would be -- re-assert it BEFORE anything else on
  // this connection, since the room-join that follows needs to happen as the correct player, not as
  // a fresh anonymous guest. Reuses the same button-first handshake as the initial `chooseName` login
  // -- a raw `/trn name,0,` alone gets rejected by the server on this second connection
  // (`|nametaken|...|Your authentication token was invalid.`), but the "Choose name" popup succeeds
  const renamed = await claimUsername(page, username);

  if (!renamed) {
    console.log(`Reload identity handshake failed for ${username}; proceeding anyway (diagnostics below will show the stuck state).`);
  }

  // TEMPORARY diagnostic: print anything trn/rename/identity-related seen on the wire. Remove alongside
  // the frame capture above once the reload identity bug is resolved
  const identityFrames = socketFrames.filter((frame) => /trn|nametaken|updateuser|challstr/i.test(frame.payload));
  console.log('Reload identity websocket frames:', JSON.stringify(identityFrames));

  const diagnostics = await page.evaluate((roomId) => ({
    url: window.location.href,
    username: window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null,
    rooms: Object.keys(window.app?.rooms || {}),
    roomExists: !!window.app?.rooms?.[roomId],
    stepQueueLength: window.app?.rooms?.[roomId]?.battle?.stepQueue?.length || 0,
    requestType: window.app?.rooms?.[roomId]?.request?.requestType || null,
  }), battleId);

  console.log('Reload diagnostics (after identity re-assert, before explicit rejoin):', JSON.stringify(diagnostics));

  // the URL-based navigation may have attempted to join the room before identity was reasserted
  // above (as a fresh anonymous guest, not the original player) -- explicitly (re)join now that
  // we're confirmed to be the right user, so the server sends us the player-specific request state
  await page.evaluate((roomId) => window.app.send(`/join ${roomId}`), battleId);

  // the room object appears in window.app.rooms almost immediately as an empty placeholder --
  // actual log/state streams in asynchronously afterward, so wait for real content (a populated
  // stepQueue), not just the room's existence, or every snapshot after "reload" reads as empty
  await page.waitForFunction(
    (roomId) => (window.app?.rooms?.[roomId]?.battle?.stepQueue?.length || 0) > 0,
    battleId,
    { timeout: 30000 },
  );

  await focusBattleRoom(page, battleId);

  const postJoinDiagnostics = await page.evaluate((roomId) => ({
    stepQueueLength: window.app?.rooms?.[roomId]?.battle?.stepQueue?.length || 0,
    requestType: window.app?.rooms?.[roomId]?.request?.requestType || null,
  }), battleId);

  console.log('Reload diagnostics (after explicit rejoin + focus):', JSON.stringify(postJoinDiagnostics));
};

const waitForBattleProgress = async (page, battleId, previousLength) => page.waitForFunction(
  ({ roomId, length }) => {
    const room = window.app?.rooms?.[roomId];

    return (room?.battle?.stepQueue?.length || 0) > length;
  },
  { roomId: battleId, length: previousLength },
  { timeout: 2500 },
);

// a forced-switch decision (after a faint) is a separate replacement phase from a normal simultaneous
// move turn, and can take longer than the standard progress-wait to be server-confirmed. Submitting
// another action while `requestType` is still 'switch' re-sends an already-in-flight decision, which
// crashes Showdown's own client-side UI code (getPlayerChoicesHTML) -- so explicitly wait for the
// request type to move on before letting the planned-turn loop continue
const waitForSwitchResolved = async (page, battleId) => page.waitForFunction(
  (roomId) => window.app?.rooms?.[roomId]?.request?.requestType !== 'switch',
  battleId,
  { timeout: 10000 },
).catch(() => null);

const normalizeMoveName = (value) => (
  (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
);

const choosePlannedAction = async (page, moveName) => {
  const attempt = async () => page.evaluate((expectedMoveName) => {
    const roomId = Object.keys(window.app?.rooms || {}).find((id) => {
      const room = window.app.rooms[id];

      return id.startsWith('battle-') && room?.battle;
    });

    if (!roomId) {
      return {
        handled: false,
        reason: `missing battle room; rooms=${Object.keys(window.app?.rooms || {}).filter((id) => id.startsWith('battle-')).join(',')}`,
      };
    }

    const room = window.app.rooms[roomId];
    const requestType = room?.request?.requestType;

    if (requestType === 'teampreview' || requestType === 'team') {
      window.app.send('/choose team 1', roomId);
      return { handled: true, action: 'choose-team:1' };
    }

    if (requestType === 'wait') {
      return { handled: true, action: 'wait' };
    }

    if (requestType === 'switch') {
      const requestPokemon = room?.request?.side?.pokemon || [];
      const legalSwitches = requestPokemon
        .map((pokemon, index) => ({
          index: index + 1,
          disabled: !!pokemon?.active || /\bfnt\b/i.test(pokemon?.condition || ''),
        }))
        .filter((pokemon) => !pokemon.disabled);

      const selectedSwitch = legalSwitches[0];

      if (!selectedSwitch) {
        return { handled: false, reason: 'no legal switches' };
      }

      // send the choice over the wire directly rather than via room.chooseSwitch(): the latter also
      // synchronously re-renders the client's own battle controls, and in this client build that
      // re-render (getPlayerChoicesHTML) throws on a fainted-mon replacement, aborting the whole run.
      // The move branch below already uses this same `/choose` send for the same reason
      window.app.send(`/choose switch ${selectedSwitch.index}`, roomId);

      return { handled: true, action: `switch:${selectedSwitch.index}` };
    }

    // a planned action of 'Switch' means "voluntarily switch out this turn" (a normal move-phase
    // request, not a forced post-faint replacement) -- used to deterministically move the viewer's
    // own attacker off the field without depending on it fainting to a damage roll
    if (requestType === 'move' && expectedMoveName === 'Switch') {
      const benchPokemon = room?.request?.side?.pokemon || [];
      const target = benchPokemon
        .map((pokemon, index) => ({
          index: index + 1,
          disabled: !!pokemon?.active || /\bfnt\b/i.test(pokemon?.condition || ''),
        }))
        .find((pokemon) => !pokemon.disabled);

      if (!target) {
        return { handled: false, reason: 'no legal voluntary switch target' };
      }

      window.app.send(`/choose switch ${target.index}`, roomId);

      return { handled: true, action: `switch:${target.index}` };
    }

    return {
      handled: false,
      reason: `requestType=${requestType}; expected=${expectedMoveName}`,
    };
  }, moveName);

  let handled = await attempt();

  if (!handled?.handled && /(missing (battle room|legal move)|chooseMove error|requestType=move|move button not visible)/.test(handled?.reason || '')) {
    for (let retry = 0; retry < 2 && !handled?.handled; retry++) {
      await page.waitForTimeout(battleUiSettleMs);
      handled = await attempt();
    }
  }

  if (!handled?.handled && /requestType=move/.test(handled?.reason || '')) {
    for (let retry = 0; retry < 10; retry++) {
      const moveButton = page.getByRole('button', { name: moveName }).first();

      try {
        await moveButton.waitFor({ state: 'visible', timeout: 1000 });
        await moveButton.click({ force: true });
        return { handled: true, action: `click:${moveName}` };
      } catch {}

      await page.waitForTimeout(battleUiSettleMs);
    }

    const moveHandled = await page.evaluate((expectedMoveName) => {
      const roomId = Object.keys(window.app?.rooms || {}).find((id) => {
        const room = window.app.rooms[id];

        return id.startsWith('battle-') && room?.battle;
      });

      const room = roomId ? window.app.rooms[roomId] : null;
      const requestMoves = room?.request?.active?.[0]?.moves || [];
      const wantedId = expectedMoveName.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const selectedMove = requestMoves
        .map((move, index) => ({
          index: index + 1,
          name: move?.move || move?.name || '',
          disabled: !!move?.disabled || !!move?.disabledSource || move?.pp === 0,
        }))
        .find((move) => !move.disabled && move.name.toLowerCase().replace(/[^a-z0-9]+/g, '') === wantedId)
        || requestMoves
          .map((move, index) => ({
            index: index + 1,
            name: move?.move || move?.name || '',
            disabled: !!move?.disabled || !!move?.disabledSource || move?.pp === 0,
          }))
          .find((move) => !move.disabled);

      if (!room || !selectedMove) {
        return false;
      }

      if (typeof room.chooseMove === 'function') {
        room.chooseMove(selectedMove.index);
      }

      window.app.send(`/choose move ${selectedMove.index}`, roomId);

      return true;
    }, moveName).catch(() => false);

    if (moveHandled) {
      return { handled: true, action: `choose:${moveName}` };
    }

    const moveState = await page.evaluate((expectedMoveName) => {
      const roomId = Object.keys(window.app?.rooms || {}).find((id) => {
        const room = window.app.rooms[id];

        return id.startsWith('battle-') && room?.battle;
      });

      const room = roomId ? window.app.rooms[roomId] : null;
      const requestMoves = room?.request?.active?.[0]?.moves || [];

      return {
        requestType: room?.request?.requestType || null,
        moves: requestMoves.map((move, index) => ({
          index: index + 1,
          move: move?.move || move?.name || null,
          pp: move?.pp ?? null,
          disabled: !!move?.disabled || !!move?.disabledSource || move?.pp === 0,
          expected: expectedMoveName,
        })),
      };
    }, moveName).catch(() => null);

    return {
      handled: false,
      reason: `move wait failed; state=${JSON.stringify(moveState)}`,
    };
  }

  if (!handled?.handled) {
    throw new Error(handled?.reason || `Could not submit planned move ${moveName}.`);
  }

  return handled;
};

const snapshotBattle = async (page, battleId) => page.evaluate(({ roomId, realSpread, realStats, baseStats, natureMods, scenarioName }) => {
  const room = window.app?.rooms?.[roomId];
  const stepQueue = room?.battle?.stepQueue || [];
  const bodyText = document.body.innerText || '';
  const estimatedSpreadIndex = bodyText.indexOf('Estimated Spread');
  const estimateExcerpt = estimatedSpreadIndex > -1
    ? bodyText.slice(estimatedSpreadIndex, estimatedSpreadIndex + 1600)
    : null;
  const estimateNode = document.querySelector('[data-hackmons-estimate-events]');
  const parseJsonAttr = (name, fallback) => {
    try {
      return JSON.parse(estimateNode?.getAttribute(name) || '') || fallback;
    } catch {
      return fallback;
    }
  };
  const backendEstimateEvents = parseJsonAttr('data-hackmons-estimate-events', []);
  const backendSpeedNotes = parseJsonAttr('data-hackmons-speed-notes', []);
  const backendEventCount = Number(estimateNode?.getAttribute('data-hackmons-event-count')) || 0;
  const backendMatchCount = Number(estimateNode?.getAttribute('data-hackmons-match-count')) || 0;
  const parsePokemonId = (token) => {
    const [side, ...nameParts] = (token || '').split(':');
    return `${side || ''}:${nameParts.join(':').trim() || side || ''}`.toLowerCase().replace(/[^a-z0-9:]+/g, '');
  };
  const parseHp = (token) => {
    const [value] = (token || '').split(' ');
    const [hp, maxHp] = value.split('/').map((part) => Number(part));

    return {
      hp: Number.isFinite(hp) ? hp : null,
      maxHp: Number.isFinite(maxHp) ? maxHp : null,
    };
  };
  const hpByPokemon = new Map();
  const realDamageEvents = [];
  let currentTurn = 0;
  let pendingMove = null;
  // tracks the in-progress multi-hit damage event so consecutive hits from the same move onto the
  // same target are aggregated into one total (matching how the inference reports multi-hit damage)
  let lastDamageKey = null;

  stepQueue.forEach((line) => {
    const parts = line.split('|');
    const type = parts[1];

    if (type === 'turn') {
      currentTurn = Number(parts[2]) || currentTurn;
      lastDamageKey = null;
      return;
    }

    if (type === 'move') {
      pendingMove = {
        turn: currentTurn,
        moveName: parts[3],
      };
      lastDamageKey = null;
      return;
    }

    if (['switch', 'drag', 'replace', '-heal'].includes(type)) {
      const pokemonId = parsePokemonId(parts[2]);
      const hp = parseHp(type === '-heal' ? parts[3] : parts[4]);

      if (pokemonId && typeof hp.hp === 'number') {
        hpByPokemon.set(pokemonId, hp.hp);
      }

      lastDamageKey = null;
      return;
    }

    if (type !== '-damage' || line.includes('|[from]') || !pendingMove) {
      return;
    }

    const pokemonId = parsePokemonId(parts[2]);
    const hp = parseHp(parts[3]);
    const startHp = hpByPokemon.get(pokemonId) ?? hp.maxHp;
    const damage = typeof startHp === 'number' && typeof hp.hp === 'number'
      ? startHp - hp.hp
      : null;

    if (pokemonId && typeof hp.hp === 'number') {
      hpByPokemon.set(pokemonId, hp.hp);
    }

    if (typeof damage !== 'number' || damage <= 0 || !hp.maxHp) {
      return;
    }

    const damageKey = `${pokemonId}:${pendingMove.moveName}`;
    const lastEvent = realDamageEvents[realDamageEvents.length - 1];

    if (lastDamageKey === damageKey && lastEvent) {
      lastEvent.rawDamage += damage;
      lastEvent.maxHp = hp.maxHp;
      lastEvent.observedDamage = Math.round((lastEvent.rawDamage / hp.maxHp) * 100);
      lastEvent.line = line;
      return;
    }

    lastDamageKey = damageKey;

    realDamageEvents.push({
      turn: pendingMove.turn,
      moveName: pendingMove.moveName,
      observedDamage: Math.round((damage / hp.maxHp) * 100),
      rawDamage: damage,
      maxHp: hp.maxHp,
      line,
    });
  });
  const estimateDamageEvents = (backendEstimateEvents.length ? backendEstimateEvents : [...(estimateExcerpt || '').matchAll(/Turn (\d+) ([^:]+): observed ([\d.]+)%/g)])
    .map((match) => ({
      turn: Number(match.turn ?? match[1]),
      moveName: match.moveName ?? match[2],
      observedDamage: Number(match.observedDamage ?? match[3]),
    }));
  const defaultStats = () => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
  const parseSpread = (text, label) => {
    const match = text?.match(new RegExp(`${label}\\n([^\\n]+)`, 'i'));
    const spread = defaultStats();

    for (const [, stat, value] of (match?.[1] || '').matchAll(/(HP|ATK|DEF|SPA|SPD|SPE)\s+(\d+)/gi)) {
      spread[stat.toLowerCase()] = Number(value);
    }

    return spread;
  };
  const estimateNature = estimateExcerpt?.match(/\nNature\n([A-Za-z]+)/)?.[1] || null;
  const estimateSpread = estimateExcerpt ? {
    species: realSpread.species,
    level: realSpread.level,
    nature: estimateNature,
    ivs: parseSpread(estimateExcerpt, 'IVs'),
    evs: parseSpread(estimateExcerpt, 'EVs'),
  } : null;
  const calcEstimateStat = (stat) => {
    const base = baseStats[realSpread.species]?.[stat];

    if (!estimateSpread || typeof base !== 'number') {
      return null;
    }

    const iv = estimateSpread.ivs[stat] ?? 0;
    const ev = estimateSpread.evs[stat] ?? 0;

    if (stat === 'hp') {
      return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * estimateSpread.level) / 100) + estimateSpread.level + 10;
    }

    const neutral = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * estimateSpread.level) / 100) + 5;
    const modifier = natureMods[estimateSpread.nature]?.plus === stat
      ? 1.1
      : natureMods[estimateSpread.nature]?.minus === stat
        ? 0.9
        : 1;

    return Math.floor(neutral * modifier);
  };
  const estimateStats = estimateSpread ? Object.keys(defaultStats()).reduce((stats, stat) => {
    stats[stat] = calcEstimateStat(stat);
    return stats;
  }, {}) : null;
  const percentDelta = (estimate, real) => (
    typeof estimate === 'number' && typeof real === 'number' && real
      ? Number((((estimate - real) / real) * 100).toFixed(2))
      : null
  );
  const pickStats = (stats, names) => names.reduce((output, stat) => {
    output[stat] = stats?.[stat] ?? null;
    return output;
  }, {});
  const attackingStats = ['atk', 'spa', 'spe'];
  const spreadVerification = estimateStats ? {
    expected: {
      spread: realSpread,
      stats: realStats,
      physicalBulk: realStats.hp * realStats.def,
      specialBulk: realStats.hp * realStats.spd,
      attackingStats: pickStats(realStats, attackingStats),
    },
    estimate: {
      spread: estimateSpread,
      stats: estimateStats,
      physicalBulk: estimateStats.hp * estimateStats.def,
      specialBulk: estimateStats.hp * estimateStats.spd,
      attackingStats: pickStats(estimateStats, attackingStats),
    },
    deltas: {
      stats: Object.keys(defaultStats()).reduce((deltas, stat) => {
        deltas[stat] = percentDelta(estimateStats[stat], realStats[stat]);
        return deltas;
      }, {}),
      physicalBulk: percentDelta(estimateStats.hp * estimateStats.def, realStats.hp * realStats.def),
      specialBulk: percentDelta(estimateStats.hp * estimateStats.spd, realStats.hp * realStats.spd),
      attackingStats: attackingStats.reduce((deltas, stat) => {
        deltas[stat] = percentDelta(estimateStats[stat], realStats[stat]);
        return deltas;
      }, {}),
    },
  } : null;
  const damageMismatches = estimateDamageEvents
    .map((estimate) => {
      const real = realDamageEvents.find((event) => (
        event.turn === estimate.turn
          && event.moveName === estimate.moveName
      ));

      if (!real || real.observedDamage === estimate.observedDamage) {
        return null;
      }

      return {
        turn: estimate.turn,
        moveName: estimate.moveName,
        estimateObserved: estimate.observedDamage,
        realObserved: real.observedDamage,
        rawDamage: real.rawDamage,
        maxHp: real.maxHp,
        line: real.line,
      };
    })
    .filter(Boolean);
  const temporaryEventChecks = scenarioName === 'temporary'
    ? ['Weather Ball', 'Terrain Pulse'].map((moveName) => {
      const realEvents = realDamageEvents.filter((event) => event.moveName === moveName);
      const estimatedEvents = estimateDamageEvents.filter((event) => event.moveName === moveName);
      const missingEstimatedEvents = realEvents.filter((real) => !estimatedEvents.some((estimate) => (
        estimate.turn === real.turn
          && estimate.observedDamage === real.observedDamage
      )));
      const realDamageValues = [...new Set(realEvents.map((event) => event.observedDamage))];

      return {
        moveName,
        realEventCount: realEvents.length,
        estimatedEventCount: estimatedEvents.length,
        realDamageValues,
        missingEstimatedEvents,
        ok: realEvents.length >= 2
          && estimatedEvents.length >= 2
          && realDamageValues.length >= 2
          && !missingEstimatedEvents.length,
      };
    })
    : [];

  return {
    battleId: roomId,
    title: room?.title || null,
    turn: room?.battle?.turn || null,
    requestType: room?.request?.requestType || null,
    stepQueueTail: stepQueue.slice(-40),
    stepQueueLength: stepQueue.length,
    damageLines: stepQueue.filter((line) => line.startsWith('|-damage|')).slice(-16),
    ended: stepQueue.some((line) => line.startsWith('|win|') || line.startsWith('|tie|')),
    estimateVisible: bodyText.includes('Estimated Spread'),
    estimateExcerpt,
    estimateDamageEvents,
    backendEventCount,
    backendMatchCount,
    backendSpeedNotes,
    damageMismatches,
    temporaryEventChecks,
    spreadVerification,
  };
}, {
  roomId: battleId,
  realSpread: realOpponentSpread,
  realStats: realOpponentStats,
  baseStats: speciesBaseStats,
  natureMods: natureModifiers,
  scenarioName,
});

const applyVisibleEstimate = async (page) => {
  const applyButton = page.getByRole('button', { name: 'Apply' }).first();

  if (!await applyButton.isVisible().catch(() => false)) {
    return false;
  }

  await applyButton.click({ force: true });
  await page.waitForTimeout(500);

  return true;
};

const snapshotClient = async (page) => safePageEvaluate(page, () => ({
  username: window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null,
  currentRoom: window.app?.curRoom?.id || null,
  rooms: Object.keys(window.app?.rooms || {}),
  location: window.location.href,
  bodySnippet: document.body.innerText.slice(0, 1500),
}));

const dismissPopup = async (page) => {
  const okButton = page.getByRole('button', { name: 'OK' });

  if (await okButton.isVisible().catch(() => false)) {
    await okButton.click({ force: true });
    await page.waitForTimeout(300);
  }
};

const contexts = [];

try {
  console.log('Using extension dir:', extensionDir);

  for (const label of ['a', 'b']) {
    contexts.push(await createContext(label));
  }

  const pages = await Promise.all(contexts.map((context) => createClientPage(context)));

  await Promise.all([
    chooseName(pages[0], playerNames[0]),
    chooseName(pages[1], playerNames[1]),
  ]);

  console.log('Named clients:', playerNames.join(', '));

  const existingBattleIds = [];
  existingBattleIds[0] = await resetClientState(pages[0], true);
  await pages[0].waitForTimeout(1000);
  existingBattleIds[1] = await resetClientState(pages[1], false);
  await pages[0].waitForTimeout(1000);
  await pages[1].waitForTimeout(1000);

  const seededTeams = await Promise.all([
    seedCustomTeam(pages[0], customTeamImports.a, 'Showdex Custom A'),
    seedCustomTeam(pages[1], customTeamImports.b, 'Showdex Custom B'),
  ]);

  console.log('Seeded custom teams:');
  console.log(JSON.stringify(seededTeams, null, 2));

  await Promise.all([
    useTeamForNextBattle(pages[0], 'Showdex Custom A'),
    useTeamForNextBattle(pages[1], 'Showdex Custom B'),
  ]);

  await pages[0].evaluate(
    ({ opponent, format }) => window.app.send(`/challenge ${opponent}, ${format}`),
    { opponent: playerNames[1], format: formatId },
  );

  let battleIds = await Promise.all(pages.map((page) => waitForAnyBattleRoom(page)));

  if (!battleIds[0] || !battleIds[1]) {
    try {
      const acceptButton = pages[1].locator('button').filter({ hasText: /^Accept$/ }).last();
      await acceptButton.waitFor({ timeout: 10000 });
      await useTeamForNextBattle(pages[1], 'Showdex Custom B');
      await acceptButton.click({ force: true });
    } catch (error) {
      battleIds = await Promise.all(pages.map((page) => waitForAnyBattleRoom(page, 3000)));

      if (!battleIds[0] || !battleIds[1]) {
        console.log('Challenge wait failed. Client snapshots:');
        console.log(JSON.stringify({
          challenger: await snapshotClient(pages[0]),
          challenged: await snapshotClient(pages[1]),
        }, null, 2));

        throw error;
      }
    }

    battleIds = await Promise.all(pages.map((page, index) => waitForBattleRoom(page, existingBattleIds[index])));
  }

  await Promise.all(pages.map((page, index) => focusBattleRoom(page, battleIds[index])));

  console.log('Battle rooms:', battleIds);

  // resolve team preview for both sides directly -- the planned-turn loop below (which normally sends
  // this choice) hasn't started yet, and nothing else will ever leave team preview on its own
  await Promise.all(pages.map((page, index) => waitForRequestPresent(page, battleIds[index])));
  await Promise.all(pages.map((page, index) => submitTeamPreview(page, battleIds[index])));

  // captured right as turn 1 begins (after team preview resolves, before any planned move is
  // submitted) -- this is the "battle just started, zero events observed" moment the blank
  // neutral-prior estimate should already be visible for. Team preview itself is too early: Calcdex's
  // per-Pokemon battle UI isn't mounted until the battle proper begins, so waiting is expected there
  await waitForMoveRequest(pages[0], battleIds[0]).catch(() => null);
  const initialSnapshot = await snapshotBattle(pages[0], battleIds[0]);

  console.log('Initial snapshot (before any planned turn):');
  console.log(JSON.stringify(initialSnapshot, null, 2));

  const appliedEstimates = new Set();
  const snapshots = [];

  for (let turnIndex = 0; turnIndex < plannedTurns.length; turnIndex++) {
    const plan = plannedTurns[turnIndex];
    await Promise.all(pages.map((page, index) => focusBattleRoom(page, battleIds[index])));
    const previousStepQueueLength = await pages[0].evaluate((roomId) => (
      window.app?.rooms?.[roomId]?.battle?.stepQueue?.length || 0
    ), battleIds[0]);

    // request briefly goes missing during phase transitions (e.g. right after the previous turn's
    // switch/faint resolves) -- wait for it to be back before submitting the next planned choice,
    // rather than racing it and crashing with requestType=undefined
    await Promise.all(pages.map((page, index) => waitForRequestPresent(page, battleIds[index])));

    const actions = await Promise.all([
      choosePlannedAction(pages[0], plan.a),
      choosePlannedAction(pages[1], plan.b),
    ]);

    console.log(`Submitted planned turn ${turnIndex + 1}:`);
    console.log(JSON.stringify({
      turn: turnIndex + 1,
      plan,
      actions,
    }, null, 2));

    if (actions.some((action) => action?.action?.startsWith('switch:'))) {
      await waitForSwitchResolved(pages[0], battleIds[0]);
    }

    if (turnIndex > 0) {
      await waitForBattleProgress(pages[0], battleIds[0], previousStepQueueLength).catch((error) => {
        console.log(`Progress wait timed out after submitting planned turn ${turnIndex + 1}:`, error?.message || error);
      });
    }

    const snapshot = await snapshotBattle(pages[0], battleIds[0]);
    snapshots.push(snapshot);

    console.log(`After planned turn ${turnIndex + 1}:`);
    console.log(JSON.stringify(snapshot, null, 2));

    if (snapshot.estimateVisible && snapshot.estimateExcerpt && !appliedEstimates.has(snapshot.estimateExcerpt)) {
      const applied = await applyVisibleEstimate(pages[0]);

      if (applied) {
        appliedEstimates.add(snapshot.estimateExcerpt);

        const appliedSnapshot = await snapshotBattle(pages[0], battleIds[0]);
        snapshots.push(appliedSnapshot);

        console.log(`After applying estimate on turn ${turnIndex + 1}:`);
        console.log(JSON.stringify(appliedSnapshot, null, 2));
      }
    }

    if (scenario.reloadAfterTurn === turnIndex) {
      console.log(`Reloading ${playerNames[0]} and rejoining the battle after planned turn ${turnIndex + 1}...`);
      await reloadAndRejoinBattle(pages[0], playerNames[0], battleIds[0]);

      // best-effort attempt to catch the transient window: this snapshot is taken as soon as the
      // rejoined room has a populated stepQueue, which may be BEFORE Showdown re-sends the `|request|`
      // that repopulates the auth player's roster -- exactly when a switched-out attacker lookup can
      // fail. It's timing-dependent, so a clean result here doesn't prove the bug is absent
      const postReloadSnapshot = await snapshotBattle(pages[0], battleIds[0]);
      snapshots.push(postReloadSnapshot);

      console.log(`Snapshot immediately after reload (after planned turn ${turnIndex + 1}):`);
      console.log(JSON.stringify(postReloadSnapshot, null, 2));

      // now let the client fully restore (wait for the move request to come back), then submit one
      // more harmless turn (Blissey Recover / Mew Recover) to force a fresh inference sync tick with
      // the now-complete roster. This is the reliable check: after this, Mew's Waterfall events must
      // resolve without an attacker-lookup failure (i.e. the fix's "don't cache a tainted result"
      // let it self-heal). Submitting a move without waiting for the request is what previously
      // crashed with requestType=undefined, so gate on the request being present first
      await pages[0].waitForFunction(
        (roomId) => !!(window.app?.rooms?.[roomId]?.request),
        battleIds[0],
        { timeout: 20000 },
      ).catch(() => null);
      await pages[0].waitForTimeout(1000);

      const resyncPrevLength = await pages[0].evaluate((roomId) => (
        window.app?.rooms?.[roomId]?.battle?.stepQueue?.length || 0
      ), battleIds[0]);
      const resyncActions = await Promise.all([
        choosePlannedAction(pages[0], 'Recover'),
        choosePlannedAction(pages[1], 'Recover'),
      ]);

      console.log('Post-reload re-sync turn actions:');
      console.log(JSON.stringify(resyncActions, null, 2));

      await waitForBattleProgress(pages[0], battleIds[0], resyncPrevLength).catch(() => null);
      await pages[0].waitForTimeout(500);

      const healedSnapshot = await snapshotBattle(pages[0], battleIds[0]);
      snapshots.push(healedSnapshot);

      console.log('Snapshot after post-reload re-sync (self-heal / correctness check):');
      console.log(JSON.stringify(healedSnapshot, null, 2));

      // the reload IS the end of this scenario -- don't fall through to more scripted move turns
      // (Vaporeon is now benched; there are no further planned turns that make sense)
      break;
    }

    if ((snapshots.at(-1) || snapshot).ended) {
      console.log(`Battle ended after planned turn ${turnIndex + 1}; stopping planned move loop.`);
      break;
    }
  }

  await pages[0].waitForTimeout(1000);
  const finalSnapshot = await snapshotBattle(pages[0], battleIds[0]);

  console.log('Final custom Hackmons debug snapshot:');
  console.log(JSON.stringify(finalSnapshot, null, 2));

  if (scenarioName === 'temporary') {
    const failedChecks = finalSnapshot.temporaryEventChecks.filter((check) => !check.ok);

    if (failedChecks.length) {
      throw new Error(`Temporary state repeated-move checks failed: ${JSON.stringify(failedChecks, null, 2)}`);
    }
  }
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => null)));
}
