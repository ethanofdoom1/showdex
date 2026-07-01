import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';

const showdownUrl = 'http://localhost.psim.us';
const userDataDir = path.resolve('.tmp/playwright-chrome-profile-local-showdown');

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
fs.mkdirSync(userDataDir, { recursive: true });

console.log('Using extension dir:', extensionDir);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});

try {
  const page = context.pages()[0] || await context.newPage();

  await page.goto(showdownUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => (
    typeof window?.Dex?.gen === 'number'
      && typeof window.Dex.forGen === 'function'
      && (
        typeof window?.app?.receive === 'function'
          || typeof window?.PS?.startTime === 'number'
      )
  ));

  await page.waitForFunction(() => !!document.getElementById('showdex-script-main'));
  await page.waitForFunction(() => typeof window.__SHOWDEX_INIT === 'string' && !!window.__SHOWDEX_HOST);

  const result = await page.evaluate(() => ({
    title: document.title,
    host: window.location.host,
    showdexInit: window.__SHOWDEX_INIT,
    showdexHost: window.__SHOWDEX_HOST,
    injectedScriptSrc: document.getElementById('showdex-script-main')?.getAttribute('src'),
  }));

  console.log('Showdown loaded and Showdex injected:', result);
} finally {
  await context.close();
}
