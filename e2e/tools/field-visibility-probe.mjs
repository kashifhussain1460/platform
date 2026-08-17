/**
 * Finds form controls that have become invisible: same background as the surface
 * they sit on AND no border with enough contrast to draw the box.
 *
 * The contrast audit cannot see this. It scores TEXT, and an empty input has
 * none — so a field whose fill and border both vanished into a white card
 * passes every contrast check while being impossible to find on the page.
 * That is exactly what happened when the app moved to a light canvas: the
 * shared `.field-modern` still carried its dark-theme 3%-white fill, and 26
 * controls across 7 screens had a fill AND border ratio of 1.00.
 *
 *   node e2e/tools/field-visibility-probe.mjs /team /knowledge
 */
import { chromium } from '@playwright/test';
const WEB = 'http://localhost:3200';
const PAGES = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(`${WEB}/login`);
await p.getByRole('textbox', { name: /email/i }).fill('ds.qa2@example.com');
await p.getByRole('textbox', { name: /password/i }).fill('TestPass123!');
await p.getByRole('button', { name: /sign in/i }).click();
await p.waitForURL('**/dashboard', { timeout: 20000 });

const probe = () => {
  const lum = ([r, g, b]) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, c) => (Math.max(lum(a), lum(c)) + 0.05) / (Math.min(lum(a), lum(c)) + 0.05);
  const rgb = (css) => {
    const m = /rgba?\(([^)]+)\)/.exec(css || '');
    if (!m) return null;
    const q = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return q.length > 3 && q[3] < 0.999 ? null : q.slice(0, 3);
  };
  const behind = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c) return c;
    }
    return [255, 255, 255];
  };
  const out = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]),textarea,select')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    const own = rgb(cs.backgroundColor);
    const back = behind(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bc = rgb(cs.borderTopColor) ?? back;
    // Either the fill or the border has to separate the control from its surface.
    const fill = own ? ratio(own, back) : 1;
    const edge = bw > 0 ? ratio(bc, back) : 1;
    // A borderless control inside a card that draws its own box is fine —
    // the card IS the field. The AI Assist composer is deliberately built
    // that way, and flagging it every run trains you to skim the output.
    let boxed = false;
    let n = el.parentElement;
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
      const ncs = getComputedStyle(n);
      const nw = parseFloat(ncs.borderTopWidth) || 0;
      const nc = rgb(ncs.borderTopColor);
      if (nw > 0 && nc && ratio(nc, behind(n)) >= 1.25) { boxed = true; break; }
      if (ncs.backgroundImage && ncs.backgroundImage !== 'none') { boxed = true; break; }
    }
    if (fill < 1.05 && edge < 1.35 && !boxed) {
      out.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').slice(0, 80),
                 fill: +fill.toFixed(2), edge: +edge.toFixed(2), name: el.name || el.placeholder || '' });
    }
  }
  return out;
};

for (const path of PAGES) {
  await p.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const bad = await p.evaluate(probe);
  console.log(`${path}  invisible fields: ${bad.length}`);
  for (const f of bad) console.log(`   ${f.tag} fill=${f.fill} edge=${f.edge}  ${f.name} | ${f.cls}`);
}
await b.close();
