/**
 * Measures text contrast on the REAL running app, in a real browser.
 *
 * Reading the stylesheet cannot answer "is this readable": the answer depends on
 * what the text actually landed on — an ancestor's background, an overlay, an
 * inherited opacity, a gradient. So this walks the rendered DOM, resolves the
 * first opaque background behind each text node, folds in every ancestor's
 * opacity, and computes the WCAG ratio against the size and weight the browser
 * actually used.
 *
 * Deliberately reports what it CANNOT judge (text over a gradient or an image)
 * instead of scoring it, because a made-up number is worse than a known gap.
 *
 *   node e2e/tools/contrast-audit.mjs            # all pages
 *   node e2e/tools/contrast-audit.mjs /login     # one page
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3200';
const EMAIL = process.env.QA_EMAIL ?? 'ds.qa2@example.com';
const PASSWORD = process.env.QA_PASSWORD ?? 'TestPass123!';

const MARKETING = ['/', '/pricing'];
const AUTH = ['/login', '/register', '/forgot-password'];
const APP = [
  // Only reachable with an UN-onboarded account; a completed one redirects to
  // /dashboard, which would silently audit the dashboard twice.
  ...(process.env.QA_ONBOARDING === '1' ? ['/onboarding'] : []),
  '/dashboard',
  '/employees',
  '/skills',
  '/assist',
  '/knowledge',
  '/workflows',
  '/runs',
  '/schedules',
  '/approvals',
  '/marketplace',
  '/billing',
  '/organization',
  '/team',
];

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];

/** WCAG relative luminance from an sRGB triple. */
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composite a possibly-translucent foreground over a known-opaque backdrop. */
function over(fg, alpha, bg) {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
}

const collect = () => {
  const parse = (css) => {
    const m = /rgba?\(([^)]+)\)/.exec(css || '');
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
  };

  /**
   * Colour stops out of a `background-image`, worst case first.
   *
   * Without this the walk fell through every gradient to `body`, which carries
   * the LIGHT theme's paper colour — so white-on-dark hero text was scored as
   * white-on-white and 47 perfectly readable headings were reported CRITICAL.
   * A gradient's own stops are the honest backdrop.
   */
  const gradientStops = (css) => {
    const out = [];
    const re = /rgba?\(([^)]+)\)|#([0-9a-f]{3,8})\b/gi;
    let m;
    while ((m = re.exec(css))) {
      if (m[1]) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        if (p.length >= 3 && (p.length < 4 || p[3] >= 0.999)) out.push(p.slice(0, 3));
      } else if (m[2]) {
        let h = m[2];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        if (h.length >= 6) {
          out.push([0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
        }
      }
    }
    return out;
  };

  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;

    // A control that is switched off is SUPPOSED to be dimmed, and WCAG exempts
    // disabled components from contrast. Counting them produced three "failures"
    // whose only fix would have been to stop showing that a button is
    // unavailable — recorded, but not scored.
    const disabled =
      el.closest('[disabled], [aria-disabled="true"], .cursor-not-allowed') !== null;

    const fg = parse(cs.color);
    if (!fg) continue;

    // Gradient-filled text (`bg-clip-text` + transparent colour) is painted by
    // its own background, not by `color`. Scoring it as "transparent on X" is
    // meaningless, so it is recorded and left for a human to look at.
    const isGradientText =
      fg.a < 0.01 && /text/.test(cs.webkitBackgroundClip || cs.backgroundClip || '');

    // Every ancestor's opacity multiplies onto this text.
    let effectiveAlpha = fg.a;
    let gradientBehind = false;
    let bg = null;
    let bgFromGradient = false;
    // Translucent fills between the text and the first opaque surface,
    // nearest-first. Composited back-to-front once the bottom is known.
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      effectiveAlpha *= Number(pcs.opacity);

      const pbg = parse(pcs.backgroundColor);
      if (pbg && pbg.a >= 0.999) {
        bg = pbg.rgb;
        break;
      }
      // A translucent fill is still a fill. Skipping it walked straight past
      // `bg-green-600/90` to the white card behind, and reported an Approve
      // button as white-on-white (ratio 1.00) when the honest number is 2.93.
      // Stack the layers instead: keep compositing until something is opaque.
      if (pbg && pbg.a > 0.001) {
        layers.push({ rgb: pbg.rgb, a: pbg.a });
      }
      // A gradient paints over whatever is under it, so it IS the backdrop.
      const img = pcs.backgroundImage;
      if (img && img !== 'none' && !/url\(/.test(img)) {
        const stops = gradientStops(img);
        if (stops.length) {
          gradientBehind = true;
          // Worst case: the stop closest in luminance to the text.
          const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          const fl = lum(fg.rgb);
          bg = stops.reduce((a, b) => (Math.abs(lum(b) - fl) < Math.abs(lum(a) - fl) ? b : a));
          bgFromGradient = true;
          break;
        }
      }
      if (img && /url\(/.test(img)) gradientBehind = true;
    }
    if (!bg) bg = [255, 255, 255]; // the page's own canvas
    // Paint the stack back onto the opaque base, furthest layer first.
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      bg = bg.map((c, k) => Math.round(l.rgb[k] * l.a + c * (1 - l.a)));
    }

    results.push({
      text: text.slice(0, 60),
      tag: el.tagName.toLowerCase(),
      cls: (el.className && String(el.className).slice(0, 70)) || '',
      color: cs.color,
      bg: `rgb(${bg.join(',')})`,
      alpha: Number(effectiveAlpha.toFixed(3)),
      fontSize: parseFloat(cs.fontSize),
      fontWeight: Number(cs.fontWeight) || 400,
      gradientBehind,
      bgFromGradient,
      isGradientText,
      disabled,
      fgRgb: fg.rgb,
      bgRgb: bg,
    });
  }
  return results;
};

function severityFor(entry, r) {
  const large =
    entry.fontSize >= 24 || (entry.fontSize >= 18.66 && entry.fontWeight >= 700);
  const need = large ? 3 : 4.5;
  if (r >= need) return null;
  // A control the customer has to read to use the product is worse than a caption.
  const interactive = /button|a|input|label|select|option/.test(entry.tag);
  if (r < 3) return interactive || entry.fontSize >= 16 ? 'CRITICAL' : 'HIGH';
  return interactive ? 'HIGH' : 'MEDIUM';
}

/**
 * A fixed 1.2s wait is a false-pass generator. On the heavier screens (an assist
 * session, an employee detail) it measured the loading skeleton — ten text
 * nodes — and reported CRITICAL=0, which reads exactly like a clean page. So:
 * wait until the node count stops growing, and refuse to score a page that
 * still looks like a skeleton.
 */
async function settle(page) {
  let last = -1;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(700);
    const n = await page.evaluate(
      () => document.body.innerText.replace(/\s+/g, ' ').trim().length,
    );
    if (n === last && n > 0) return;
    last = n;
  }
}

async function auditPage(page, path, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const raw = await page.evaluate(collect);

  const findings = [];
  for (const e of raw) {
    // Painted by a gradient, not by `color` — not scoreable, listed separately.
    if (e.isGradientText || e.disabled) continue;
    const fg = over(e.fgRgb, e.alpha, e.bgRgb);
    const r = ratio(fg, e.bgRgb);
    const sev = severityFor(e, r);
    if (!sev) continue;
    findings.push({
      page: path,
      viewport: viewport.name,
      severity: sev,
      ratio: Number(r.toFixed(2)),
      ...e,
      fgRgb: undefined,
      bgRgb: undefined,
    });
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  // The page we MEASURED, not the one we asked for. A redirect used to be
  // invisible: an app path opened in the anonymous browser bounced to /login
  // and the ten-node sign-in form was reported as that page passing.
  const landedOn = new URL(page.url()).pathname;
  const stillLoading = await page.evaluate(() =>
    /^(loading|loading…|loading\.\.\.)$/i.test(document.body.innerText.trim()),
  );
  return { findings, overflow, textNodes: raw.length, landedOn, stillLoading };
}

async function main() {
  const only = process.argv.slice(2).filter((a) => a.startsWith('/'));
  const pages = only.length ? only : [...MARKETING, ...AUTH, ...APP];

  const browser = await chromium.launch();

  // TWO contexts, deliberately. A signed-in browser redirects /login and
  // /register straight to /dashboard, so auditing them in one session silently
  // measured the dashboard three times and reported it as three passing pages.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();

  const authed = await browser.newContext();
  const authPage = await authed.newPage();
  await authPage.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await authPage.getByRole('textbox', { name: /email/i }).fill(EMAIL);
  await authPage.getByRole('textbox', { name: /password/i }).fill(PASSWORD);
  await authPage.getByRole('button', { name: /sign in/i }).click();
  await authPage.waitForTimeout(3000);
  const landed = new URL(authPage.url()).pathname;
  if (landed === '/login') throw new Error('sign-in failed — cannot audit app screens');
  console.log(`signed in → ${landed}`);

  const needsAuth = (p) => !MARKETING.includes(p) && !AUTH.includes(p);

  const all = [];
  const overflows = [];
  const thinPages = [];
  for (const vp of VIEWPORTS) {
    for (const path of pages) {
      const page = needsAuth(path) ? authPage : anonPage;
      const { findings, overflow, textNodes, landedOn, stillLoading } = await auditPage(page, path, vp);
      if (overflow) overflows.push({ page: path, viewport: vp.name });
      // A screen this thin did not finish rendering. Saying so is the whole
      // point — a silent CRITICAL=0 on a skeleton is a lie, not a pass.
      // Only genuine non-renders: a redirect elsewhere, a bare spinner, or a
      // page with essentially nothing on it. A login form really does have
      // ten text nodes, and calling that unmeasured is noise that trains you
      // to ignore the warning.
      const redirected = landedOn !== path;
      const thin = redirected || stillLoading || textNodes < 6;
      if (thin) {
        thinPages.push({ page: path, viewport: vp.name, textNodes,
          reason: redirected ? `redirected to ${landedOn}` : stillLoading ? 'still loading' : 'almost no text' });
      }
      const c = findings.filter((f) => f.severity === 'CRITICAL').length;
      const h = findings.filter((f) => f.severity === 'HIGH').length;
      const m = findings.filter((f) => f.severity === 'MEDIUM').length;
      console.log(
        `${vp.name}  ${path.padEnd(16)} nodes=${String(textNodes).padStart(4)}  CRIT=${c} HIGH=${h} MED=${m}${overflow ? '  OVERFLOW' : ''}${thin ? '  ⚠ NOT-RENDERED' : ''}`,
      );
      all.push(...findings);
    }
  }

  mkdirSync('e2e/report', { recursive: true });
  writeFileSync('e2e/report/contrast-audit.json', JSON.stringify({ findings: all, overflows, thinPages }, null, 2));
  const by = (s) => all.filter((f) => f.severity === s).length;
  console.log(`\nTOTAL  CRITICAL=${by('CRITICAL')}  HIGH=${by('HIGH')}  MEDIUM=${by('MEDIUM')}  overflow pages=${overflows.length}`);
  if (thinPages.length) {
    console.log(`
⚠  ${thinPages.length} page render(s) never got past a skeleton — NOT measured:`);
    for (const t of thinPages) console.log(`   ${t.viewport}  ${t.page}  — ${t.reason} (${t.textNodes} text nodes)`);
  }

  await browser.close();
}

main();
