/**
 * Phase 22 — brand and UI consistency checks that do not need a browser.
 * Run: npm run test:ui:phase22
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
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

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

console.log('\n■ Brand and tokens');

check('product name stays LINKUPCHAT and the logo mark is reusable', () => {
  const logo = read('src/components/ui/Logo.tsx');
  assert.match(logo, /LINKUPCHAT/);
  assert.equal(/LinkUp Chat|WhatsApp/i.test(logo), false);
  assert.match(logo, /useId/);
  assert.match(logo, /whitespace-nowrap/);
});

check('theme boot script matches the stored preference key', () => {
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /linkup-theme/);
  assert.match(layout, /prefers-color-scheme: dark/);
  assert.match(layout, /Skip to content/);
  const theme = read('src/context/ThemeProvider.tsx');
  assert.match(theme, /if \(!ready\) return/);
});

check('design tokens keep light and dark text colors and reduced motion', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /--c-ink: 23 26 43/);
  assert.match(css, /\.dark/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.status-banner/);
  assert.match(css, /#171a2b/);
});

console.log('\n■ Honest copy and navigation');

check('landing does not invent delivery metrics or encryption guarantees', () => {
  const hero = read('src/components/landing/Hero.tsx');
  const features = read('src/components/landing/Features.tsx');
  const landing = `${hero}\n${features}`;
  assert.equal(landing.includes('42 ms'), false);
  assert.equal(/end-to-end|e2ee|encrypted/i.test(landing), false);
  assert.match(hero, /Get Started/);
  assert.match(hero, /\/login/);
  assert.match(hero, /landing-menu/);
  assert.match(features, /Call quality depends on your network/);
});

check('empty chat hint does not treat the wordmark as the new-chat control', () => {
  const page = read('src/app/app/chats/page.tsx');
  assert.match(page, /New chat/);
  assert.equal(page.includes('press the'), false);
});

check('bottom navigation is still six items', () => {
  const nav = read('src/components/app/BottomNav.tsx');
  const hrefs = nav.match(/href: '\/app\/[^']+'/g) ?? [];
  assert.equal(hrefs.length, 6);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
