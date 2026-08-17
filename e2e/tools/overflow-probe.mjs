/**
 * Names the element that makes a page scroll sideways.
 *
 * "scrollWidth > clientWidth" tells you a page overflows but not what did it,
 * and on a dark layout the offender is usually invisible — a fixed-width sidebar
 * that never collapsed, a table, a min-width. This reports the widest boxes that
 * cross the right edge so the fix lands on the cause.
 *
 *   node e2e/tools/overflow-probe.mjs /dashboard 390 844
 */
import { chromium } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3200';
const [path = '/dashboard', w = '390', h = '844'] = process.argv.slice(2);

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.getByRole('textbox', { name: /email/i }).fill(process.env.QA_EMAIL ?? 'ds.qa2@example.com');
await page.getByRole('textbox', { name: /password/i }).fill(process.env.QA_PASSWORD ?? 'TestPass123!');
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForTimeout(3000);

await page.setViewportSize({ width: Number(w), height: Number(h) });
await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 90),
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  return {
    viewport: vw,
    scrollWidth: document.documentElement.scrollWidth,
    // Outermost first: fixing the container usually fixes everything inside it.
    offenders: offenders.slice(0, 8),
  };
});

console.log(JSON.stringify(out, null, 1));
await browser.close();
