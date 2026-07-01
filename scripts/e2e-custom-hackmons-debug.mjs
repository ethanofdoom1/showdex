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
const formatId = scenarioName === 'temporary' ? 'gen9purehackmons' : 'gen9balancedhackmons';
const formatLabel = scenarioName === 'temporary' ? 'Pure Hackmons' : 'Balanced Hackmons';
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

const teamA = (evs, nature, moves, { item = 'Leftovers', ability = 'Pressure' } = {}) => `=== [${formatId}] Showdex Custom A ===

Vaporeon @ ${item}
Ability: ${ability}
Level: 100
EVs: ${evs}
${nature} Nature
${moves.map((move) => `- ${move}`).join('\n')}
`;

const teamB = (evs, nature, moves, { item = 'Leftovers', ability = 'Pressure' } = {}) => `=== [${formatId}] Showdex Custom B ===

Mew @ ${item}
Ability: ${ability}
Level: 100
EVs: ${evs}
${nature} Nature
${moves.map((move) => `- ${move}`).join('\n')}
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

const chooseName = async (page, username) => {
  await page.goto(showdownUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await muteClient(page);
  await ensureConnected(page);
  await waitForClientReady(page);

  const currentUser = await getCurrentUsername(page);

  if (currentUser !== username) {
    const chooseNameButton = page.getByText('Choose name');

    if (await chooseNameButton.isVisible().catch(() => false)) {
      await chooseNameButton.click();
      await page.locator('.ps-popup input').waitFor({ timeout: 5000 });
      await page.locator('.ps-popup input').fill(username);
      await page.locator('.ps-popup').getByRole('button', { name: 'Choose name' }).click();
    } else {
      await page.evaluate((name) => window.app.send(`/trn ${name},0,`), username);
    }
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

  if (!registered && currentUser !== username) {
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

const getChallengeDialog = (page, opponentName) => (
  page.getByText(`Challenge ${opponentName}?`).locator('xpath=ancestor::div[.//button[normalize-space(.)="Random Battle"]][1]')
);

const getFormatTeamScope = (page, opponentName) => (
  opponentName ? getChallengeDialog(page, opponentName) : page.locator('body')
);

const clickPopupButton = async (page, label) => {
  const popupButton = page.locator('.ps-popup').getByRole('button', { name: label });

  if (await popupButton.isVisible().catch(() => false)) {
    await popupButton.last().click({ force: true });
    return true;
  }

  return false;
};

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

const setFormatAndTeam = async (page, teamName, opponentName) => {
  const scope = getFormatTeamScope(page, opponentName);
  const formatButton = scope.getByRole('button', { name: 'Random Battle' });
  if (await formatButton.isVisible().catch(() => false)) {
    await formatButton.first().click({ force: true });
    if (!(await clickPopupButton(page, formatLabel))) {
      await page.getByRole('button', { name: formatLabel }).first().click({ force: true });
    }
  }

  const teamButton = scope.getByRole('button', { name: 'Select a team' });
  if (await teamButton.isVisible().catch(() => false)) {
    await teamButton.first().click({ force: true });
    if (!(await clickPopupButton(page, teamName))) {
      await page.getByRole('button', { name: teamName }).first().click({ force: true });
    }
    return;
  }

  const randomTeamButton = scope.getByRole('button', { name: 'Random team' });
  if (await randomTeamButton.isVisible().catch(() => false)) {
    await randomTeamButton.first().click({ force: true });
    if (!(await clickPopupButton(page, teamName))) {
      await page.getByRole('button', { name: teamName }).first().click({ force: true });
    }
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

const waitForBattleTurn = async (page, battleId, previousTurn) => page.waitForFunction(
  ({ roomId, turn }) => {
    const room = window.app?.rooms?.[roomId];

    return typeof room?.battle?.turn === 'number' && room.battle.turn > turn;
  },
  { roomId: battleId, turn: previousTurn ?? -1 },
  { timeout: 30000 },
);

const waitForBattleProgress = async (page, battleId, previousLength) => page.waitForFunction(
  ({ roomId, length }) => {
    const room = window.app?.rooms?.[roomId];

    return (room?.battle?.stepQueue?.length || 0) > length;
  },
  { roomId: battleId, length: previousLength },
  { timeout: 2500 },
);

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

      room?.chooseSwitch?.(selectedSwitch.index);

      return { handled: true, action: `switch:${selectedSwitch.index}` };
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

  if (scenarioName !== 'temporary') {
    await Promise.all([
      setFormatAndTeam(pages[0], 'Showdex Custom A'),
      setFormatAndTeam(pages[1], 'Showdex Custom B'),
    ]);
  }

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

  const appliedEstimates = new Set();
  const snapshots = [];

  for (let turnIndex = 0; turnIndex < plannedTurns.length; turnIndex++) {
    const plan = plannedTurns[turnIndex];
    await Promise.all(pages.map((page, index) => focusBattleRoom(page, battleIds[index])));
    const previousStepQueueLength = await pages[0].evaluate((roomId) => (
      window.app?.rooms?.[roomId]?.battle?.stepQueue?.length || 0
    ), battleIds[0]);
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
