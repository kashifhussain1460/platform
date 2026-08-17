/** Evidence capture: every audited page, desktop + phone, into e2e/report/screens. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3200';
const ANON = ['/', '/pricing', '/login', '/register'];
const APP = ['/dashboard', '/employees', '/skills', '/assist', '/knowledge', '/workflows', '/runs', '/schedules', '/approvals', '/marketplace', '/billing', '/organization', '/team'];
const SIZES = [
  ['desktop', 1440, 900],
  ['phone', 390, 844],
];

mkdirSync('e2e/report/screens', { recursive: true });

const browser = await chromium.launch();
const anon = await (await browser.newContext()).newPage();
const authed = await (await browser.newContext()).newPage();

await authed.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await authed.getByRole('textbox', { name: /email/i }).fill(process.env.QA_EMAIL ?? 'ds.qa2@example.com');
await authed.getByRole('textbox', { name: /password/i }).fill(process.env.QA_PASSWORD ?? 'TestPass123!');
await authed.getByRole('button', { name: /sign in/i }).click();
await authed.waitForTimeout(3000);

for (const path of [...ANON, ...APP]) {
  const page = APP.includes(path) ? authed : anon;
  for (const [label, w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const name = (path === '/' ? 'home' : path.slice(1).replace(/\//g, '-')) + `-${label}.png`;
    await page.screenshot({ path: `e2e/report/screens/${name}`, fullPage: false });
    console.log('  ', name);
  }
}
await browser.close();
