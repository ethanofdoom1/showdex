import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';

// Live smoke test for Gen 8 Hackmons Cup Dynamax handling. Random-team format (no fixed ground-truth
// spread to compare against, unlike the custom scripted scenarios), so this checks that a Max move
// resolves through Showdex's inference without errors/freezes -- both dmax-attacker-vs-non-dmax-defender
// and dmax-vs-dmax -- rather than exact spread accuracy (that's covered by e2e-custom-hackmons-debug.mjs).
const showdownUrl = 'http://localhost.psim.us';
const showdownOrigins = [
  'http://localhost.psim.us',
  'https://localhost.psim.us',
];
const formatId = 'gen8hackmonscup';
const turnsPerPhase = Number(process.env.TURNS) || 3;
const profileDirs = {
  a: path.resolve('.tmp/playwright-chrome-profile-gen8dmax-a'),
  b: path.resolve('.tmp/playwright-chrome-profile-gen8dmax-b'),
};

const phases = [
  { name: 'dmax-attacker-vs-non-dmax', dynamaxSides: ['a'] },
  { name: 'dmax-vs-dmax', dynamaxSides: ['a', 'b'] },
];

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
      '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPrompt,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  for (const origin of showdownOrigins) {
    await context.grantPermissions(['local-network-access'], { origin }).catch(() => null);
  }

  return context;
};

const createClientPage = async (context, errors) => {
  const existingPages = context.pages();

  await Promise.all(existingPages.map(async (page) => {
    const url = page.url();

    if (!url || url.startsWith('chrome-extension://') || url.startsWith('devtools://')) {
      return;
    }

    await page.close().catch(() => null);
  }));

  const page = await context.newPage();

  page.on('pageerror', (error) => errors.push(`pageerror: ${error?.message || error}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console: ${msg.text()}`);
    }
  });

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
});

const waitForClientReady = async (page) => page.waitForFunction(() => {
  const username = window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null;

  return !!username || document.body.innerText.includes('Choose name') || document.body.innerText.includes('Home');
}, null, { timeout: 20000 });

const ensureConnected = async (page) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitForClientReady(page).catch(() => null);

    const bodyText = await page.evaluate(() => document.body.innerText || '');

    if (!bodyText.includes('Couldn\'t connect to server!') && !bodyText.includes('Connecting...')) {
      return;
    }

    const retryButton = page.getByRole('button', { name: 'Retry' });

    if (await retryButton.isVisible().catch(() => false)) {
      await retryButton.click();
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    }

    await page.waitForTimeout(3000);
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
    } else if (currentUser) {
      await page.evaluate((name) => window.app.send(`/trn ${name},0,`), username);
    }
  }

  try {
    await page.waitForFunction(
      (expected) => (window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null) === expected,
      username,
      { timeout: 5000 },
    );
  } catch (error) {
    const popupInput = page.locator('.ps-popup input');
    const popupChooseButton = page.locator('.ps-popup').getByRole('button', { name: 'Choose name' });

    if (await popupInput.isVisible().catch(() => false)) {
      await popupInput.fill(username);
      await popupChooseButton.click();

      await page.waitForFunction(
        (expected) => (window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null) === expected,
        username,
        { timeout: 10000 },
      );

      return;
    }

    console.log('Name wait failed. Client snapshot:');
    console.log(JSON.stringify(await snapshotClient(page), null, 2));
    throw error;
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

const getActiveBattleRoom = async (page) => page.evaluate(() => (
  Object.keys(window.app?.rooms || {}).find((id) => {
    const room = window.app.rooms[id];

    return id.startsWith('battle-')
      && room?.battle
      && room?.request?.requestType === 'move';
  }) || null
));

const waitForBattleRoom = async (page, existingBattleIds = []) => {
  await page.waitForFunction(
    (knownIds) => Object.keys(window.app?.rooms || {}).find((id) => id.startsWith('battle-') && !knownIds.includes(id)) || null,
    existingBattleIds,
    { timeout: 20000 },
  );

  return page.evaluate(
    (knownIds) => Object.keys(window.app.rooms).find((id) => id.startsWith('battle-') && !knownIds.includes(id)),
    existingBattleIds,
  );
};

const focusBattleRoom = async (page, battleId) => {
  await page.evaluate((roomId) => window.app.focusRoom(roomId), battleId);
  await page.waitForTimeout(1000);
};

const dismissPopup = async (page) => {
  const okButton = page.getByRole('button', { name: 'OK' });

  if (await okButton.isVisible().catch(() => false)) {
    await okButton.click({ force: true });
    await page.waitForTimeout(300);
  }
};

const snapshotClient = async (page) => page.evaluate(() => ({
  username: window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null,
  currentRoom: window.app?.curRoom?.id || null,
  rooms: Object.keys(window.app?.rooms || {}),
  bodySnippet: document.body.innerText.slice(0, 1500),
}));

// picks a legal, preferably-damaging move each turn; when wantDynamax is set and the current request
// allows it, checks the client's `input[name=dynamax]` checkbox first -- chooseMove() reads that
// checkbox's live DOM state at click time (it's not a JS parameter), so order matters here. Move
// choice/category comes from the request JSON (clean move ids), not button textContent -- the DOM
// buttons interleave move name/type/PP with no separators, so textContent-based id lookups silently
// fail and always fall through to "first button" while misreporting a bogus default category.
const chooseNextMove = async (page, wantDynamax) => {
  await page.waitForSelector('.movemenu button, .switchmenu button', { timeout: 8000 }).catch(() => null);

  return page.evaluate((wantDynamaxArg) => {
    const roomId = Object.keys(window.app?.rooms || {}).find((id) => {
      const room = window.app.rooms[id];

      return id.startsWith('battle-') && ['move', 'switch', 'wait'].includes(room?.request?.requestType);
    });

    if (!roomId) {
      return { handled: false, reason: 'no active battle room' };
    }

    const room = window.app.rooms[roomId];
    const requestType = room?.request?.requestType;

    if (requestType === 'wait') {
      return { handled: true, action: 'wait' };
    }

    if (requestType === 'switch') {
      const switchButtons = Array.from(document.querySelectorAll('.switchmenu button:not([disabled])'));

      if (!switchButtons.length) {
        return { handled: false, reason: 'no legal switch buttons' };
      }

      switchButtons[0].click();

      return { handled: true, action: 'switch' };
    }

    if (requestType !== 'move') {
      return { handled: false, reason: `unhandled requestType ${requestType}` };
    }

    const canDynamax = !!room?.request?.active?.[0]?.canDynamax;
    let dynamaxed = false;

    if (wantDynamaxArg && canDynamax) {
      const checkbox = document.querySelector('input[name=dynamax]');

      if (checkbox && !checkbox.checked) {
        checkbox.click();
      }

      dynamaxed = !!document.querySelector('input[name=dynamax]')?.checked;
    }

    const requestMoves = room?.request?.active?.[0]?.moves || [];
    const dex = room.battle?.dex;
    const scored = requestMoves.map((move, index) => ({
      index,
      id: move?.id,
      name: move?.move,
      disabled: !!move?.disabled || !!move?.disabledSource || move?.pp === 0,
      category: dex?.moves?.get(move?.id)?.exists ? dex.moves.get(move.id).category : null,
    }));

    const legal = scored.filter((m) => !m.disabled);

    if (!legal.length) {
      return { handled: false, reason: 'no legal moves in request', canDynamax, dynamaxed };
    }

    const damaging = legal.find((m) => m.category && m.category !== 'Status');
    const chosen = damaging || legal[0];

    const moveButtons = Array.from(document.querySelectorAll('.movemenu button'));
    const button = moveButtons[chosen.index];

    if (!button || button.disabled) {
      return { handled: false, reason: `move button at index ${chosen.index} missing/disabled`, canDynamax, dynamaxed };
    }

    button.click();

    const targetButton = document.querySelector('.movetarget button:not([disabled])');

    if (targetButton) {
      targetButton.click();
    }

    return {
      handled: true,
      action: 'move',
      moveName: chosen.name,
      category: chosen.category,
      canDynamax,
      dynamaxed,
    };
  }, wantDynamax);
};

const snapshotBattle = async (page, battleId) => page.evaluate((roomId) => {
  const room = window.app?.rooms?.[roomId];
  const stepQueue = room?.battle?.stepQueue || [];
  const bodyText = document.body.innerText || '';
  const estimatedSpreadIndex = bodyText.indexOf('Estimated Spread');
  const estimateExcerpt = estimatedSpreadIndex > -1
    ? bodyText.slice(estimatedSpreadIndex, estimatedSpreadIndex + 800)
    : null;

  return {
    battleId: roomId,
    turn: room?.battle?.turn || null,
    moveLines: stepQueue.filter((line) => line.startsWith('|move|')),
    damageLines: stepQueue.filter((line) => line.startsWith('|-damage|')),
    estimateVisible: bodyText.includes('Estimated Spread'),
    estimateExcerpt,
  };
}, battleId);

const runPhase = async (pages, playerNames, phase, existingBattleIds) => {
  console.log(`\n=== Phase: ${phase.name} (dynamax sides: ${phase.dynamaxSides.join(', ')}) ===`);

  await pages[0].evaluate(
    ({ opponent, format }) => window.app.send(`/challenge ${opponent}, ${format}`),
    { opponent: playerNames[1], format: formatId },
  );

  let battleIds = await Promise.all(pages.map((page) => getActiveBattleRoom(page)));

  if (!battleIds[0] || !battleIds[1]) {
    try {
      await pages[1].waitForFunction(
        (challenger) => document.body.innerText.includes(`${challenger} wants to battle!`),
        playerNames[0],
        { timeout: 20000 },
      );

      await dismissPopup(pages[1]);
      const acceptButton = pages[1].locator('button').filter({ hasText: /^Accept$/ }).last();
      await acceptButton.waitFor({ timeout: 10000 });
      await acceptButton.click({ force: true });
    } catch (error) {
      battleIds = await Promise.all(pages.map((page) => getActiveBattleRoom(page)));

      if (!battleIds[0] || !battleIds[1]) {
        console.log('Challenge wait failed. Client snapshots:');
        console.log(JSON.stringify({
          challenger: await snapshotClient(pages[0]),
          challenged: await snapshotClient(pages[1]),
        }, null, 2));

        throw error;
      }
    }
  }

  if (!battleIds[0] || !battleIds[1]) {
    battleIds = await Promise.all(pages.map((page, index) => waitForBattleRoom(page, existingBattleIds[index])));
  }

  await Promise.all(pages.map((page, index) => focusBattleRoom(page, battleIds[index])));
  console.log('Battle rooms:', battleIds);

  const turnLog = [];

  for (let turnIndex = 0; turnIndex < turnsPerPhase; turnIndex++) {
    const wantDynamax = [
      phase.dynamaxSides.includes('a') && turnIndex === 0,
      phase.dynamaxSides.includes('b') && turnIndex === 0,
    ];

    const results = await Promise.all(pages.map((page, i) => chooseNextMove(page, wantDynamax[i])));
    await pages[0].waitForTimeout(5000);

    const snapshots = await Promise.all(pages.map((page, i) => snapshotBattle(page, battleIds[i])));

    turnLog.push({ turnIndex: turnIndex + 1, results, snapshots });

    console.log(`Turn ${turnIndex + 1} choices:`, JSON.stringify(results));
    console.log(`Turn ${turnIndex + 1} move/damage lines (A's view):`, JSON.stringify(snapshots[0].moveLines.concat(snapshots[0].damageLines)));
  }

  const finalSnapshots = await Promise.all(pages.map((page, i) => snapshotBattle(page, battleIds[i])));

  console.log(`Final estimate excerpt (A's view of B): ${finalSnapshots[0].estimateExcerpt || '(none)'}`);
  console.log(`Final estimate excerpt (B's view of A): ${finalSnapshots[1].estimateExcerpt || '(none)'}`);

  return { phase: phase.name, turnLog, finalSnapshots };
};

const contexts = [];
const errors = { a: [], b: [] };

try {
  console.log('Using extension dir:', extensionDir);

  for (const label of ['a', 'b']) {
    contexts.push(await createContext(label));
  }

  const pages = await Promise.all(contexts.map((context, i) => createClientPage(context, errors[['a', 'b'][i]])));
  const nameSuffix = Date.now().toString(36).slice(-6);
  const playerNames = [`sdxg8a${nameSuffix}`, `sdxg8b${nameSuffix}`];

  await Promise.all([
    chooseName(pages[0], playerNames[0]),
    chooseName(pages[1], playerNames[1]),
  ]);

  console.log('Named clients:', playerNames.join(', '));

  const allResults = [];

  for (const phase of phases) {
    const existingBattleIds = [];
    existingBattleIds[0] = await resetClientState(pages[0], true);
    await pages[0].waitForTimeout(1000);
    existingBattleIds[1] = await resetClientState(pages[1], false);
    await pages[0].waitForTimeout(1500);
    await pages[1].waitForTimeout(1500);

    const result = await runPhase(pages, playerNames, phase, existingBattleIds);
    allResults.push(result);
  }

  console.log('\n=== Summary ===');

  for (const result of allResults) {
    const allMoveLines = result.turnLog.flatMap((t) => t.snapshots[0].moveLines);
    const allDamageLines = result.turnLog.flatMap((t) => t.snapshots[0].damageLines);
    const turn1Choices = result.turnLog[0]?.results || [];

    console.log(`Phase "${result.phase}":`);
    console.log(`  Turn 1 choices: ${JSON.stringify(turn1Choices)}`);
    console.log(`  Move lines seen: ${JSON.stringify(allMoveLines)}`);
    console.log(`  Damage lines seen: ${JSON.stringify(allDamageLines)}`);
    console.log(`  Estimate visible (A view of B): ${result.finalSnapshots[0].estimateVisible}`);
    console.log(`  Estimate visible (B view of A): ${result.finalSnapshots[1].estimateVisible}`);
  }

  console.log(`Console/page errors -- A: ${JSON.stringify(errors.a)}`);
  console.log(`Console/page errors -- B: ${JSON.stringify(errors.b)}`);
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => null)));
}
