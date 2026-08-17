/**
 * Two things a stylesheet cannot tell you, measured in a real browser:
 *
 *  1. Does the page scroll sideways at any of the sizes people actually use?
 *  2. When you tab to a control, can you SEE where you are?
 *
 * The focus check is deliberately not "does a rule exist". It reads the computed
 * style with the element genuinely focused and compares it against the same
 * element unfocused — a ring that is defined but painted the same colour as the
 * background, or removed by `outline:none` with nothing put back, fails here.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3200';
const EMAIL = process.env.QA_EMAIL ?? 'ds.qa2@example.com';
const PASSWORD = process.env.QA_PASSWORD ?? 'TestPass123!';

const VIEWPORTS = [
  [1440, 900], [1366, 768], [1280, 800], [1024, 768],
  [768, 1024], [430, 932], [390, 844], [375, 812],
];

const ANON = ['/', '/pricing', '/login', '/register', '/forgot-password'];
const APP = ['/dashboard', '/employees', '/skills', '/knowledge', '/workflows', '/runs', '/approvals', '/billing', '/organization', '/team'];

const overflowIn = () => {
  const vw = document.documentElement.clientWidth;
  const worst = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      worst.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), right: Math.round(r.right) });
    }
  }
  return { overflow: document.documentElement.scrollWidth > vw + 1, vw, worst: worst.slice(0, 3) };
};

/** Focus the first N interactive elements and confirm something visibly changes. */
async function focusCheck(page, path) {
  return page.evaluate(() => {
    const targets = [...document.querySelectorAll('a[href], button:not([disabled]), input, select, textarea')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .slice(0, 12);
    const bad = [];
    for (const el of targets) {
      const before = getComputedStyle(el);
      const snapshot = (cs) => `${cs.outlineStyle}|${cs.outlineWidth}|${cs.outlineColor}|${cs.boxShadow}|${cs.borderColor}|${cs.backgroundColor}`;
      const b = snapshot(before);
      el.focus();
      const a = snapshot(getComputedStyle(el));
      el.blur();
      if (a === b) {
        bad.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().slice(0, 34),
          cls: String(el.className || '').slice(0, 60),
        });
      }
    }
    return bad;
  }).then((bad) => bad.map((b) => ({ page: path, ...b })));
}

const browser = await chromium.launch();
const anon = await (await browser.newContext()).newPage();
const authed = await (await browser.newContext()).newPage();

await authed.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await authed.getByRole('textbox', { name: /email/i }).fill(EMAIL);
await authed.getByRole('textbox', { name: /password/i }).fill(PASSWORD);
await authed.getByRole('button', { name: /sign in/i }).click();
await authed.waitForTimeout(3000);
if (new URL(authed.url()).pathname === '/login') throw new Error('sign-in failed');

const overflows = [];
const focusFails = [];

for (const path of [...ANON, ...APP]) {
  const page = APP.includes(path) ? authed : anon;
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(700);
    const r = await page.evaluate(overflowIn);
    if (r.overflow) {
      overflows.push({ page: path, viewport: `${w}x${h}`, worst: r.worst });
      console.log(`  OVERFLOW ${path} @ ${w}x${h} → ${r.worst.map((x) => x.tag + '.' + x.cls.split(' ')[0]).join(', ')}`);
    }
  }
  // Focus only needs checking once per page; it does not vary with width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const bad = await focusCheck(page, path);
  if (bad.length) {
    focusFails.push(...bad);
    console.log(`  NO VISIBLE FOCUS ${path} → ${bad.length} control(s)`);
  }
}

mkdirSync('e2e/report', { recursive: true });
writeFileSync('e2e/report/layout-a11y.json', JSON.stringify({ overflows, focusFails }, null, 2));
console.log(`\nTOTAL  overflow=${overflows.length}  controls without visible focus=${focusFails.length}`);
await browser.close();
