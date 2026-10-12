/**
 * Phase 18 — mobile viewport, installability, and service-worker compatibility.
 * No browser. Run: npm run test:mobile:phase18
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IOS_INPUT_ZOOM_FONT_PX,
  avoidsIosInputZoom,
  keyboardInsetPx,
  manifestIsInstallable,
  type WebAppManifest
} from '../src/lib/mobile-viewport';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.error(err);
  }
}

console.log('\n■ Keyboard inset');

check('ignores address-bar chrome and invalid numbers', () => {
  assert.equal(keyboardInsetPx(800, 770, 0), 0);
  assert.equal(keyboardInsetPx(800, 800, 20), 0);
  assert.equal(keyboardInsetPx(Number.NaN, 400, 0), 0);
  assert.equal(keyboardInsetPx(800, 900, 0), 0);
});

check('reports a real keyboard and ignores sub-pixel noise below the threshold', () => {
  assert.equal(keyboardInsetPx(800, 470, 0), 330);
  assert.equal(keyboardInsetPx(844, 500, 12), 332);
});

console.log('\n■ Input zoom');

check('16px is the iOS zoom floor', () => {
  assert.equal(IOS_INPUT_ZOOM_FONT_PX, 16);
  assert.equal(avoidsIosInputZoom(15), false);
  assert.equal(avoidsIosInputZoom(16), true);
});

console.log('\n■ PWA manifest and service worker');

check('manifest is installable and icons exist', () => {
  const root = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8')) as WebAppManifest;
  assert.equal(manifestIsInstallable(manifest), true);
  assert.equal(manifest.start_url, '/app/chats');
  for (const icon of manifest.icons ?? []) {
    assert.equal(fs.existsSync(path.join(root, 'public', icon.src)), true, icon.src);
  }
  assert.equal(fs.existsSync(path.join(root, 'public/icons/apple-touch-icon.png')), true);
});

check('service worker keeps push and does not cache private traffic', () => {
  const sw = fs.readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  assert.match(sw, /addEventListener\('fetch'/);
  assert.match(sw, /\/api\//);
  assert.match(sw, /\/socket\.io/);
  assert.equal(sw.includes('caches.open'), false);
  assert.match(sw, /You're offline/);
});

check('mobile stylesheet keeps the composer above the keyboard inset', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
  assert.match(css, /100dvh - var\(--keyboard-inset/);
  assert.match(css, /font-size: 16px/);
  assert.match(css, /touch-action: manipulation/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
