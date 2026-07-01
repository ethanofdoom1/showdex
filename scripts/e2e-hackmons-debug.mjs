import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';

const showdownUrl = 'http://localhost.psim.us';
const formatId = 'gen9hackmonscup';
const playerNames = ['showdexa', 'showdexb'];
const maxTurns = 10;
const profileDirs = {
  a: path.resolve('.tmp/playwright-chrome-profile-hackmons-a'),
  b: path.resolve('.tmp/playwright-chrome-profile-hackmons-b'),
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

  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--mute-audio',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
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

  return context.newPage();
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

const chooseNextMove = async (page) => {
  const handled = await page.evaluate(() => {
    const roomId = Object.keys(window.app?.rooms || {}).find((id) => {
      const room = window.app.rooms[id];

      return id.startsWith('battle-') && ['move', 'switch', 'wait'].includes(room?.request?.requestType);
    });

    if (!roomId) {
      return false;
    }

    const room = window.app.rooms[roomId];
    const moveStateKey = '__SHOWDEX_E2E_MOVE_CURSOR';
    const moveState = window[moveStateKey] || (window[moveStateKey] = {});
    const requestType = room?.request?.requestType;
    if (requestType === 'wait') {
      return true;
    }

    const requestMoves = room?.request?.active?.[0]?.moves || [];
    const legalRequestMoves = requestMoves
      .map((move, index) => ({
        index: index + 1,
        disabled: !!move?.disabled || !!move?.disabledSource || move?.pp === 0,
      }))
      .filter((move) => !move.disabled);
    const requestPokemon = room?.request?.side?.pokemon || [];
    const legalSwitches = requestPokemon
      .map((pokemon, index) => ({
        index: index + 1,
        disabled: !!pokemon?.active || /\bfnt\b/i.test(pokemon?.condition || ''),
      }))
      .filter((pokemon) => !pokemon.disabled);

    const previousCursor = typeof moveState[roomId] === 'number'
      ? moveState[roomId]
      : -1;

    try {
      if (requestType === 'move' && legalRequestMoves.length) {
        const nextCursor = (previousCursor + 1) % legalRequestMoves.length;
        const selectedMove = legalRequestMoves[nextCursor];

        room?.chooseMove?.(selectedMove.index);
        moveState[roomId] = nextCursor;

        return true;
      }

      if (requestType === 'switch' && legalSwitches.length) {
        const nextCursor = (previousCursor + 1) % legalSwitches.length;
        const selectedSwitch = legalSwitches[nextCursor];

        room?.chooseSwitch?.(selectedSwitch.index);
        moveState[roomId] = nextCursor;

        return true;
      }
    } catch {}

    const moveButtons = Array.from(document.querySelectorAll('.movemenu button:not([disabled])'));
    const switchButtons = Array.from(document.querySelectorAll('.switchmenu button:not([disabled])'));

    if (requestType === 'move' && moveButtons.length) {
      const nextCursor = (previousCursor + 1) % moveButtons.length;
      const moveButton = moveButtons[nextCursor];

      moveButton.click();
      moveState[roomId] = nextCursor;

      const targetButton = document.querySelector('.movetarget button:not([disabled])');

      if (targetButton) {
        targetButton.click();
      }

      return true;
    }

    if (requestType === 'switch' && switchButtons.length) {
      const nextCursor = (previousCursor + 1) % switchButtons.length;
      const switchButton = switchButtons[nextCursor];

      switchButton.click();
      moveState[roomId] = nextCursor;

      return true;
    }

    return false;
  });

  if (!handled) {
    throw new Error('Could not submit a move from the active battle room.');
  }
};

const snapshotBattle = async (page, battleId) => page.evaluate((roomId) => {
  const room = window.app?.rooms?.[roomId];
  const bodyText = document.body.innerText || '';
  const estimatedSpreadIndex = bodyText.indexOf('Estimated Spread');
  const estimateExcerpt = estimatedSpreadIndex > -1
    ? bodyText.slice(estimatedSpreadIndex, estimatedSpreadIndex + 1200)
    : null;

  return {
    battleId: roomId,
    title: room?.title || null,
    turn: room?.battle?.turn || null,
    requestType: room?.request?.requestType || null,
    stepQueueTail: room?.battle?.stepQueue?.slice(-30) || [],
    damageLines: (room?.battle?.stepQueue || []).filter((line) => line.startsWith('|-damage|')).slice(-12),
    estimateVisible: bodyText.includes('Estimated Spread'),
    estimateExcerpt,
  };
}, battleId);

const applyVisibleEstimate = async (page) => {
  const applyButton = page.getByRole('button', { name: 'Apply' }).first();

  if (!await applyButton.isVisible().catch(() => false)) {
    return false;
  }

  await applyButton.click({ force: true });
  await page.waitForTimeout(500);

  return true;
};

const snapshotClient = async (page) => page.evaluate(() => ({
  username: window.app?.user?.get?.('name') || window.app?.user?.attributes?.name || null,
  currentRoom: window.app?.curRoom?.id || null,
  rooms: Object.keys(window.app?.rooms || {}),
  location: window.location.href,
  config: window.Config ? {
    server: window.Config.server,
    routes: window.Config.routes,
    domain: window.Config.domain,
  } : null,
  connection: (() => {
    const connection = window.app?.connection || window.PS?.connection;

    if (!connection) {
      return null;
    }

    return {
      connected: connection.connected ?? null,
      reconnectPending: connection.reconnectPending ?? null,
      workerConnected: connection.workerConnected ?? null,
      socketUrl: connection.socket?.url ?? null,
      socketReadyState: connection.socket?.readyState ?? null,
    };
  })(),
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
  await pages[0].waitForTimeout(1500);
  await pages[1].waitForTimeout(1500);

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
    try {
      battleIds = await Promise.all(pages.map((page, index) => waitForBattleRoom(page, existingBattleIds[index])));
    } catch (error) {
      console.log('Battle room wait failed. Client snapshots:');
      console.log(JSON.stringify({
        challenger: await snapshotClient(pages[0]),
        challenged: await snapshotClient(pages[1]),
        activeBattleIds: await Promise.all(pages.map((page) => getActiveBattleRoom(page))),
      }, null, 2));

      throw error;
    }
  }

  await Promise.all(pages.map((page, index) => focusBattleRoom(page, battleIds[index])));

  console.log('Battle rooms:', battleIds);

  const snapshots = [];
  const appliedEstimates = new Set();

  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
    await Promise.all(pages.map((page) => chooseNextMove(page)));
    await pages[0].waitForTimeout(5000);

    const snapshot = await snapshotBattle(pages[0], battleIds[0]);
    snapshots.push(snapshot);

    console.log(`After scripted turn ${turnIndex + 1}:`);
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
  }

  const finalSnapshot = snapshots.at(-1) || await snapshotBattle(pages[0], battleIds[0]);

  console.log('Final Hackmons debug snapshot:');
  console.log(JSON.stringify(finalSnapshot, null, 2));
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => null)));
}
