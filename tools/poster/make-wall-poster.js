#!/usr/bin/env node
// The expo wall poster: one sheet where the Sunburn flowchart is built from the real blocks of the program,
// each with a plain-English note, plus the whole workspace at a glance, the buttons, the colour key and a
// glossary. The other 54 blocks (helpers) are in the full poster / booklet, which this sheet points to.
//
//   node tools/poster/make-wall-poster.js [--sheet A1|A0] [--out docs/poster] [--cache <dir>] [--harness <module>]
//
// Writes sunburn-wall-poster-<size>.pdf (one page), sunburn-wall-poster-<size>-tiles-A3.pdf (the same poster
// cut into A3 sheets to print on an A3 printer and join: 4 for A1, 8 for A0) and wall-poster.png.
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./make-poster.js');
const { spec, capture, esc, ROOT, OUT, CACHE } = P;
const args = process.argv.slice(2);
const argOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SIZE = (argOf('--sheet', 'A1') || 'A1').toUpperCase();
if (!['A1', 'A0'].includes(SIZE)) { console.error('--sheet must be A1 or A0'); process.exit(1); }
const [W_MM, H_MM] = SIZE === 'A1' ? [594, 841] : [841, 1189];
const SCALE_UP = Math.min(W_MM / 594, H_MM / 841);   // the poster is laid out as A1 and scaled for A0 (A-series sheets are not exactly proportional, so the smaller factor)
const MARGIN = 12;   // mm
const PX = 96 / 25.4;

// The flowchart, row by row: the block, and the words of the flowchart box it implements
const ROWS = [
  [['fn deviceTurnsOn', 'Device turns on'], ['fn readUvSensor', 'Read the UV sensor'], ['fn sensorReadingInRange', 'Is the reading believable?'], ['fn showCheckSensor', 'No: CHECK SENSOR, try again in 5 s']],
  [['fn phoneSendingOnlineUv', 'Is the phone sending the online UV index?'], ['fn chooseUvValue', 'Pick the UV value: the higher of sensor and online'], ['fn uvBand', 'How strong is the sun?']],
  [['fn showHappyFace', '0 to 2, low: happy face'], ['fn moderateOrHighUv', '3 to 7, moderate or high: flash and slow beep until A'], ['fn veryHighUv', '8 to 10, very high: flash and fast beep until A'], ['fn extremeUv', '11 and above, extreme: tap the arm until A']],
  [['fn alreadyProtected', 'Sunscreen already on: just a tick'], ['fn sunscreenApplied', 'A pressed: sunscreen is on'], ['fn start2HourReapplyTimer', 'Start the 2 hour reapply timer'], ['fn standbyUntilButton', 'Sleep until any button is pressed']],
  [['fn wait5Minutes', 'Wait 5 minutes'], ['on Button.AB', 'A and B held?'], ['fn deviceTurnsOff', 'Yes: device turns off']],
  [['fn reapplyTimerExpired', 'Is it time for more sunscreen?'], ['fn showReapplySunscreen', 'Yes: show Reapply sunscreen']],
];
// Arrows between blocks: from, to, label, route (h = to the right, v = down to the next row, loop = back up to the top)
const EDGES = [
  ['fn deviceTurnsOn', 'fn readUvSensor', '', 'h'],
  ['fn readUvSensor', 'fn sensorReadingInRange', '', 'h'],
  ['fn sensorReadingInRange', 'fn showCheckSensor', 'No', 'h'],
  ['fn showCheckSensor', 'fn readUvSensor', 'try again', 'loopTop'],
  ['fn sensorReadingInRange', 'fn phoneSendingOnlineUv', 'Yes', 'v'],
  ['fn phoneSendingOnlineUv', 'fn chooseUvValue', 'Yes or No', 'h'],
  ['fn chooseUvValue', 'fn uvBand', '', 'h'],
  ['fn uvBand', 'fn showHappyFace', '0 to 2', 'v'],
  ['fn uvBand', 'fn moderateOrHighUv', '3 to 7', 'v'],
  ['fn uvBand', 'fn veryHighUv', '8 to 10', 'v'],
  ['fn uvBand', 'fn extremeUv', '11 and above', 'v'],
  ['fn moderateOrHighUv', 'fn alreadyProtected', 'sunscreen already on', 'v'],
  ['fn moderateOrHighUv', 'fn sunscreenApplied', 'A pressed', 'v'],
  ['fn veryHighUv', 'fn sunscreenApplied', 'A pressed', 'v'],
  ['fn sunscreenApplied', 'fn start2HourReapplyTimer', '', 'h'],
  ['fn extremeUv', 'fn standbyUntilButton', '', 'v'],
  ['fn showHappyFace', 'fn wait5Minutes', '', 'laneLeft'],
  ['fn alreadyProtected', 'fn wait5Minutes', '', 'v'],
  ['fn start2HourReapplyTimer', 'fn wait5Minutes', '', 'v'],
  ['fn standbyUntilButton', 'fn readUvSensor', 'a button was pressed', 'loopRight'],
  ['fn wait5Minutes', 'on Button.AB', '', 'h'],
  ['on Button.AB', 'fn deviceTurnsOff', 'Yes', 'h'],
  ['on Button.AB', 'fn reapplyTimerExpired', 'No', 'v'],
  ['fn reapplyTimerExpired', 'fn showReapplySunscreen', 'Yes', 'h'],
  ['fn reapplyTimerExpired', 'fn readUvSensor', 'No: back to the top', 'loopLeft'],
  ['fn showReapplySunscreen', 'fn readUvSensor', 'then back to the top', 'loopLeft'],
];
const WALL_KEYS = ROWS.flat().map(r => r[0]);
const FW = ((/let firmwareVersion = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'main.ts'), 'utf8')) || [])[1]) || '';
const LEGEND = [['variables', 'Variables: remember a value'], ['functions', 'Functions: a step with a name'], ['basic', 'Basic: the lights, pauses'], ['input', 'Input: buttons and time'], ['loops', 'Loops: repeat'], ['logic', 'Logic: if, compare'], ['math', 'Maths'], ['text', 'Text'], ['arrays', 'Arrays: lists'], ['music', 'Music: beeps'], ['pins', 'Pins: sensor, motor, screen'], ['bluetooth', 'Bluetooth: the phone'], ['serial', 'Serial: the USB cable'], ['control', 'Control: timing']];

function html(caps, labels, zoom) {
  const flowchart = path.join(ROOT, 'docs', 'sunburn-flowchart.png');
  const flowchartData = fs.existsSync(flowchart) ? 'data:image/png;base64,' + fs.readFileSync(flowchart).toString('base64') : '';
  const colours = Object.assign({ basic: '#1E90FF', input: '#D400D4', music: '#E63022', led: '#5C2D91', bluetooth: '#007EF4', pins: '#A80000', serial: '#002050', control: '#333333' }, Object.fromEntries(Object.entries(caps.colours || {}).filter(([, v]) => v)));
  const fig = (key, chip, cls) => {
    const pic = caps.pictures[key]; if (!pic) throw new Error('no picture for ' + key);
    const note = (spec.plain || {})[key] || (labels[key] || {}).comment || '';
    const name = (spec.eventLabels[key] || {}).name || (labels[key] || {}).name || key;
    const w = Math.round(pic.w * zoom), h = Math.round(pic.h * zoom);
    return `<figure class="${cls || ''}" data-key="${esc(key)}" style="width:${Math.max(w, 230)}px"><span class="chip">${esc(chip)}</span><img src="${pic.data}" width="${w}" height="${h}" alt="${esc(name)}"><figcaption><b>${esc(name)}</b> ${esc(note)}</figcaption></figure>`;
  };
  const rows = ROWS.map((row, i) => `<div class="row${i === 2 ? ' spread' : ''}${i === 3 ? ' indent' : ''}">${row.map(([k, chip]) => fig(k, chip)).join('')}</div>`).join('');
  const buttons = [['on Button.A', 'A: done'], ['on Button.B', 'B: wake up']].map(([k, chip]) => fig(k, chip, 'small')).join('');
  const legend = LEGEND.filter(([ns]) => colours[ns]).map(([ns, what]) => `<li><i style="background:${colours[ns]}"></i>${esc(what)}</li>`).join('');
  const glossary = (spec.glossary || []).map(([term, what]) => `<li><b>${esc(term)}</b> ${esc(what)}</li>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  const N = Object.keys(caps.pictures).length;
  const story = (spec.story || '').replace('{n}', N);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.title)} wall poster</title><style>
    @page { size: ${W_MM}mm ${H_MM}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #fff; color: #1c1917; font: 11pt/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .poster { width: 594mm; height: 841mm; padding: ${MARGIN}mm; background: #fff; position: relative; display: grid; grid-template-rows: auto 1fr auto; gap: 6mm; overflow: hidden; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 8mm; align-items: end; border-bottom: 2px solid #e8401c; padding-bottom: 4mm; }
    header h1 { font-size: 46pt; margin: 0; letter-spacing: -0.015em; line-height: 1; }
    header h1 small { display: block; font-size: 17pt; font-weight: 400; color: #57534e; letter-spacing: 0; margin-top: 3mm; }
    header .story { font-size: 12pt; margin: 3mm 0 0; max-width: 1450px; }
    header .howto { font-size: 10pt; color: #57534e; margin: 2mm 0 0; max-width: 1450px; }
    header .sun { width: 26mm; height: 26mm; border-radius: 50%; background: #e8401c; box-shadow: 0 0 0 7mm rgba(232, 64, 28, 0.14); margin: 0 10mm 6mm 0; }
    .main { display: grid; grid-template-columns: 1fr 470px; gap: 8mm; min-height: 0; }
    .flow { position: relative; padding: 64px 0 0 76px; overflow: hidden; }
    .flow .row { display: flex; align-items: flex-start; gap: 36px; margin-bottom: 64px; }
    .flow .row.spread { justify-content: space-between; }
    .flow.measuring .row.spread { justify-content: flex-start; }
    .flow .row.indent { padding-left: 120px; }
    figure { margin: 0; position: relative; }
    figure img { display: block; border: 1px solid #ece5d6; border-radius: 6px; }
    figure .chip { display: inline-block; background: #e53210; color: #fff; font-weight: 700; font-size: 11.5pt; line-height: 1.2; padding: 4px 10px; border-radius: 7px; margin-bottom: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
    figure figcaption { font-size: 9.5pt; line-height: 1.3; margin-top: 5px; }
    figure figcaption b { display: block; font-size: 10.5pt; margin-bottom: 1px; }
    figure.small { width: 205px !important; }
    figure.small .chip { font-size: 10pt; }
    svg.arrows { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
    svg.arrows path { fill: none; stroke: #f28a2b; stroke-width: 3; stroke-linejoin: round; }
    svg.arrows path.dash { stroke-dasharray: 8 6; }
    svg.arrows text { font-size: 9.5pt; font-weight: 700; fill: #e53210; paint-order: stroke; stroke: #fff; stroke-width: 5px; stroke-linejoin: round; }
    aside { display: flex; flex-direction: column; gap: 5mm; font-size: 9pt; color: #57534e; min-height: 0; }
    aside h3 { font-size: 11.5pt; color: #1c1917; margin: 0 0 1.5mm; }
    aside p { margin: 1mm 0 0; }
    aside img.pic { width: 100%; border: 1px solid #ece5d6; border-radius: 6px; display: block; }
    aside .buttons { display: flex; gap: 12px; align-items: flex-start; }
    aside ul { list-style: none; padding: 0; margin: 0; }
    aside ul.legend { columns: 2; column-gap: 5mm; }
    aside ul.legend li { display: flex; align-items: center; gap: 2mm; margin-bottom: 1.4mm; break-inside: avoid; }
    aside ul.legend i { display: inline-block; width: 6mm; height: 4mm; border-radius: 1.2mm; flex: none; }
    aside ul.glossary li { margin-bottom: 1.6mm; }
    aside ul.glossary b { color: #1c1917; }
    aside .booklet { background: #fff6e6; border: 1px solid #f3dcb8; border-radius: 3mm; padding: 3mm 4mm; font-size: 10pt; color: #1c1917; }
    footer { font-size: 8.5pt; color: #8a857d; display: flex; justify-content: space-between; }
  </style></head><body>
  <div class="poster" id="poster">
    <header>
      <div>
        <h1>${esc(spec.title)}: the program on the wrist<small>The Sunburn Flowchart, built from the real blocks of the program, with what each one does</small></h1>
        <p class="story">${esc(story)}</p>
        <p class="howto">Follow the arrows. Each red label is a box of the flowchart; the coloured picture under it is the actual block of code that does that job, exactly as it looks in the MakeCode editor, and the note says what it does. The forever block runs this plan round and round, all day.</p>
      </div>
      <div class="sun" aria-hidden="true"></div>
    </header>
    <div class="main">
      <div class="flow" id="flow">${rows}<svg class="arrows" id="arrows"></svg></div>
      <aside>
        ${flowchartData ? `<div><h3>The Sunburn Flowchart</h3><img class="pic" src="${flowchartData}" alt="The Sunburn flowchart"><p>The plan the device follows. Every box on it is a block on the left, with the same name.</p></div>` : ''}
        <div><h3>The two buttons</h3><div class="buttons">${buttons}</div><p>Pressing A and B together turns the device off, or on again (see the flowchart).</p></div>
        <div><h3>The whole program</h3><img class="pic" src="${caps.overview}" alt="The whole program in the editor"><p>All ${N} blocks in the editor, in nine sections. The flowchart on this sheet is sections 1 to 4; sections 5 to 9 are the helpers: screen, sound, Bluetooth, maths and the optional screen.</p></div>
        <div><h3>What the block colours mean</h3><ul class="legend">${legend}</ul></div>
        <div><h3>Words used here</h3><ul class="glossary">${glossary}</ul></div>
        <div class="booklet">Every one of the ${N} blocks, with its note, is in the booklet on the table.</div>
      </aside>
    </div>
    <footer><span>${esc(spec.title)} · micro:bit firmware ${FW} · the program follows the Sunburn Flowchart · UV bands follow the WHO UV index · printed ${today}</span><span>${SIZE}</span></footer>
  </div>
  <script>
    // Draws the arrows once everything has its place (called from Node after the page has loaded).
    window.__draw = () => {
    const flow = document.getElementById('flow'), svg = document.getElementById('arrows');
    flow.classList.add('measuring'); const natural = Math.max(...Array.from(flow.querySelectorAll('.row')).map(r => { const f = r.querySelectorAll('figure'); return f[f.length - 1].getBoundingClientRect().right - f[0].getBoundingClientRect().left; })); flow.classList.remove('measuring');
    svg.innerHTML = '';
    const base = flow.getBoundingClientRect();
    const rect = key => { const fig = flow.querySelector('figure[data-key="' + key.replace(/"/g, '\\\\"') + '"]'); const r = fig.querySelector('img').getBoundingClientRect(), f = fig.getBoundingClientRect(); return { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top, cx: (r.left + r.right) / 2 - base.left, cy: (r.top + r.bottom) / 2 - base.top, fb: f.bottom - base.top + 4, rb: fig.closest('.row').getBoundingClientRect().bottom - base.top }; };
    const chipTop = key => { const el = flow.querySelector('figure[data-key="' + key.replace(/"/g, '\\\\"') + '"]'); return el.getBoundingClientRect().top - base.top; };
    const ns = 'http://www.w3.org/2000/svg';
    const path = (d, dash) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('marker-end', 'url(#head)'); if (dash) p.setAttribute('class', 'dash'); svg.append(p); };
    const label = (x, y, text, anchor, rotate) => { if (!text) return; const t = document.createElementNS(ns, 'text'); t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('text-anchor', anchor || 'middle'); if (rotate) t.setAttribute('transform', 'rotate(-90 ' + x + ' ' + y + ')'); t.textContent = text; svg.append(t); };
    svg.innerHTML = '<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#f28a2b" stroke="none"/></marker></defs>';
    const EDGES = ${JSON.stringify(EDGES)};
    let loopsLeft = 0, loopsRight = 0;
    const topLane = 30;   // the lane above the first row for the arrows back to the top
    for (const [from, to, text, route] of EDGES) {
      const a = rect(from), b = rect(to);
      if (route === 'h') {   // to the right, into the chip of the next block
        const y = Math.min(a.cy, b.cy); const x2 = b.l - 4;
        if (Math.abs(a.cy - b.cy) < 2) path('M' + a.r + ',' + y + ' H' + x2); else path('M' + a.r + ',' + a.cy + ' H' + ((a.r + b.l) / 2) + ' V' + b.cy + ' H' + x2);
        label((a.r + b.l) / 2, Math.min(a.cy, b.cy) - 9, text);
      } else if (route === 'v') {   // down from below the caption to the next row, entering above the chip
        const yTop = chipTop(to) - 4; const gapY = a.rb + (yTop - a.rb) * 0.5;   // the horizontal part runs below the whole row, clear of every caption
        const straight = Math.abs(a.cx - b.cx) < 2;
        path(straight ? 'M' + a.cx + ',' + a.fb + ' V' + yTop : 'M' + a.cx + ',' + a.fb + ' V' + gapY + ' H' + b.cx + ' V' + yTop, /already/.test(to));
        label(straight ? a.cx + 8 : (a.cx + b.cx) / 2, gapY - 6, text, straight ? 'start' : 'middle');
      } else if (route === 'laneLeft') {   // down the left edge, past a row, into the side of the target
        const x = 44; path('M' + a.l + ',' + a.cy + ' H' + x + ' V' + b.cy + ' H' + (b.l - 4)); label(x - 8, (a.cy + b.cy) / 2, text, 'middle', true);
      } else if (route === 'loopLeft') {   // up the left edge and back into the top of the target; the label runs along the vertical lane
        const i = loopsLeft++; const x = 10 + 14 * i; const yTop = chipTop(to) - 4; const laneY = topLane - 4 * i;
        path('M' + a.l + ',' + a.cy + ' H' + x + ' V' + laneY + ' H' + (b.cx - 14 - 14 * i) + ' V' + yTop);
        label(x - 6, (a.cy + laneY) / 2 + (i ? 260 : 0), text, 'middle', true);
      } else if (route === 'loopRight' || route === 'loopTop') {   // up the right edge (or straight up), along the top lane, down into the target
        const i = loopsRight++; const x = flow.clientWidth - 10 - 14 * i; const yTop = chipTop(to) - 4; const laneY = topLane + 12 - 8 * i;
        const start = route === 'loopTop' ? 'M' + a.cx + ',' + chipTop(from) + ' V' + laneY : 'M' + a.r + ',' + a.cy + ' H' + x + ' V' + laneY;
        path(start + ' H' + (b.cx + 14 + 14 * i) + ' V' + yTop);
        if (route === 'loopTop') label(a.cx + 8, chipTop(from) - 12, text, 'start'); else label(x + 6, (a.cy + laneY) / 2, text, 'middle', true);
      }
    }
    // measurements for the fitting loop in Node
    const rows = Array.from(flow.querySelectorAll('.row'));
    return { flowW: flow.clientWidth - 76 - 20, flowH: flow.clientHeight, rowsW: natural, contentH: rows[rows.length - 1].getBoundingClientRect().bottom - base.top, asideH: document.querySelector('aside').scrollHeight, asideBox: document.querySelector('aside').clientHeight };
    };
  </script></body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const labels = P.labels();
  const caps = await capture();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 0.6 });
  // the biggest zoom at which the flowchart fits the sheet
  let zoom = 0.62, doc = '', fit = null;
  for (let i = 0; i < 40; i++) {
    doc = html(caps, labels, zoom);
    await page.setContent(doc, { waitUntil: 'load', timeout: 180000 });
    fit = await page.evaluate(() => window.__draw());
    if (fit.rowsW <= fit.flowW && fit.contentH <= fit.flowH) break;
    zoom = Math.round((zoom - 0.01) * 100) / 100;
  }
  console.log(`blocks at ${Math.round(zoom * 100)}% of their size on screen; flow ${Math.round(fit.rowsW)}/${Math.round(fit.flowW)} wide, ${Math.round(fit.contentH)}/${Math.round(fit.flowH)} tall; sidebar ${Math.round(fit.asideH)}/${Math.round(fit.asideBox)}`);
  if (fit.asideH > fit.asideBox + 1) console.warn('the sidebar is taller than the sheet: shorten the glossary');
  fs.writeFileSync(path.join(CACHE, `wall-${SIZE}.html`), doc);
  if (SCALE_UP !== 1) await page.addStyleTag({ content: `.poster { zoom: ${SCALE_UP}; }` });   // laid out as A1, printed bigger
  const pdf = path.join(OUT, `sunburn-wall-poster-${SIZE}.pdf`);
  await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
  await (await page.$('#poster')).screenshot({ path: path.join(OUT, `wall-poster${SIZE === 'A1' ? '' : '-' + SIZE}.png`) });

  // the same poster as A3 tiles: an A3 printer cannot print A1, but four A3 sheets side by side make one (eight for A0)
  const tileW = 277, tileH = 400;   // mm printed per A3 sheet, inside 10 mm margins
  const cols = Math.round(W_MM / tileW), rowsN = Math.round(H_MM / tileH);   // 2 x 2 for A1, 3 x 3 for A0
  const s = Math.min(cols * tileW / W_MM, rowsN * tileH / H_MM);   // the poster shrinks a little so the tiles fit inside printer margins
  const tiles = [];
  for (let r = 0; r < rowsN; r++) for (let c = 0; c < cols; c++) {
    const n = r * cols + c + 1;
    tiles.push(`<div class="tile"><div class="clip"><div class="shift" style="left:${-c * tileW}mm;top:${-r * tileH}mm"><div class="scaled" style="zoom:${s}">__POSTER__</div></div></div>
      <div class="mark tl"></div><div class="mark tr"></div><div class="mark bl"></div><div class="mark br"></div>
      <div class="lab">${esc(spec.title)} wall poster · tile ${n} of ${cols * rowsN} · row ${r + 1}, column ${c + 1} · cut along the corner marks and join the tiles edge to edge · print at 100%</div></div>`);
  }
  const posterHtml = doc.slice(doc.indexOf('<div class="poster"'), doc.indexOf('<script>'));
  const styles = doc.slice(doc.indexOf('<style>') + 7, doc.indexOf('</style>'));
  const tilesDoc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.title)} wall poster, A3 tiles</title><style>
    ${styles}
    @page { size: A3 portrait; margin: 0; }
    .tile { position: relative; width: 297mm; height: 420mm; padding: 10mm; break-after: page; overflow: hidden; }
    .tile:last-child { break-after: auto; }
    .clip { position: relative; width: ${tileW}mm; height: ${tileH}mm; overflow: hidden; }
    .shift { position: absolute; }
    .scaled .poster { zoom: ${SCALE_UP}; }
    .mark { position: absolute; width: 8mm; height: 8mm; border-color: #999; border-style: solid; border-width: 0; }
    .mark.tl { left: 2mm; top: 2mm; border-right-width: 0.3mm; border-bottom-width: 0.3mm; }
    .mark.tr { right: 2mm; top: 2mm; border-left-width: 0.3mm; border-bottom-width: 0.3mm; }
    .mark.bl { left: 2mm; bottom: 2mm; border-right-width: 0.3mm; border-top-width: 0.3mm; }
    .mark.br { right: 2mm; bottom: 2mm; border-left-width: 0.3mm; border-top-width: 0.3mm; }
    .lab { position: absolute; left: 12mm; right: 12mm; bottom: 3mm; font-size: 7pt; color: #999; text-align: center; }
  </style></head><body>${tiles.join('').split('__POSTER__').join(posterHtml)}</body></html>`;
  // the arrows are drawn by script in the single-sheet version; for the tiles, copy the finished SVG instead
  const arrows = await page.evaluate(() => document.getElementById('arrows').outerHTML);
  const tilesFinal = tilesDoc.split('<svg class="arrows" id="arrows"></svg>').join(arrows);
  await page.setContent(tilesFinal, { waitUntil: 'load', timeout: 180000 });
  const tilesPdf = path.join(OUT, `sunburn-wall-poster-${SIZE}-tiles-A3.pdf`);
  await page.pdf({ path: tilesPdf, preferCSSPageSize: true, printBackground: true });
  await browser.close();
  console.log(`wrote ${path.relative(ROOT, pdf)} (${(fs.statSync(pdf).size / 1e6).toFixed(1)} MB, one ${SIZE} sheet), ${path.relative(ROOT, tilesPdf)} (${cols * rowsN} A3 sheets, poster at ${Math.round(s * 100)}% = ${Math.round(W_MM * s)} x ${Math.round(H_MM * s)} mm), wall-poster${SIZE === 'A1' ? '' : '-' + SIZE}.png`);
}
main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
