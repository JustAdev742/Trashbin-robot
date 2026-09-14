#!/usr/bin/env node
// Builds the A3 poster set of the whole micro:bit program: every top-level block is captured from the
// real MakeCode editor at full size, labelled with what it does (from the comments in main.ts), and
// packed onto A3 sheets, one overview sheet plus as many sheets as each section needs. Output: a PDF and PNGs.
//
//   node tools/poster/make-poster.js [--sheet A3|A2|A1|A0] [--out docs/poster] [--zoom 0.6] [--text 1] [--cache <dir>] [--sheets] [--harness <module>]
//
// Run it again after any change to main.ts / sunburn-device.mkcd: the captures are cached per version of the
// code, so only the first run for a version opens the editor.
//
// Needs Playwright with Chromium (npm i -g playwright, then npx playwright install chromium).
// --harness is only for sandboxes where the browser cannot reach the network itself: the module must
// export launch({ width, height, scale }) -> { browser, context } with all requests served by Node.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OUT = path.resolve(ROOT, argOf('--out', 'docs/poster'));
const HARNESS = argOf('--harness', '');
const MKCD = path.join(ROOT, 'sunburn-device.mkcd');
const MC_URL = 'https://makecode.microbit.org/?controller=1&nocookiebanner=1';
const SCALE = 2;   // device pixels per CSS pixel for the block captures (print quality)
// Sheet size. A3 is for a home printer; A2, A1 and A0 are for a wall, with bigger blocks and text so they read from a distance.
const SHEETS = { A3: [297, 420, 0.6, 1], A2: [420, 594, 0.6, 1.1], A1: [594, 841, 0.6, 1.1], A0: [841, 1189, 0.7, 1.3] };   // width, height (mm, portrait), default zoom, default text size (the fewest sheets that stay readable up close; raise --zoom and --text for reading from further away)
const SIZE = (argOf('--sheet', 'A3') || 'A3').toUpperCase();
if (!SHEETS[SIZE]) { console.error('--sheet must be one of ' + Object.keys(SHEETS).join(', ')); process.exit(1); }
const [SHEET_W, SHEET_H] = SHEETS[SIZE];
const ZOOM = Number(argOf('--zoom', String(SHEETS[SIZE][2])));   // block size on paper, relative to the editor at 100%
const TEXT = Number(argOf('--text', String(SHEETS[SIZE][3])));   // caption and heading size, relative to the A3 sheets
const CACHE = path.resolve(argOf('--cache', path.join(os.tmpdir(), 'sunburn-poster')));   // captures are kept here and reused while the code is unchanged
const WANT_SHEETS = args.includes('--sheets');   // also write every sheet as a PNG into the cache folder

const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'sections.json'), 'utf8'));
const mkcd = JSON.parse(fs.readFileSync(MKCD, 'utf8'));
const files = JSON.parse(mkcd.source);
const mainTs = fs.readFileSync(path.join(ROOT, 'main.ts'), 'utf8');

// ---------- what each block does, from the comments in main.ts ----------
function parseLabels(ts) {
  const lines = ts.split('\n');
  const labels = {};
  const heads = [
    [/^function (\w+)\(([^)]*)\)(?::\s*(\w+))?/, (m) => ({ key: 'fn ' + m[1], name: m[1], params: m[2], returns: m[3] })],
    [/^input\.onButtonPressed\(Button\.(\w+),/, (m) => ({ key: 'on Button.' + m[1] })],
    [/^basic\.forever\(/, () => ({ key: 'device_forever' })],
    [/^bluetooth\.onBluetoothConnected\(/, () => ({ key: 'bluetooth_on_connected' })],
    [/^bluetooth\.onBluetoothDisconnected\(/, () => ({ key: 'bluetooth_on_disconnected' })],
    [/^bluetooth\.onUartDataReceived\(/, () => ({ key: 'bluetooth_on_data_received' })],
    [/^serial\.onDataReceived\(/, () => ({ key: 'serial_on_data_received' })],
    [/^loops\.everyInterval\(/, () => ({ key: 'every_interval' })],
  ];
  const bodies = {};   // key -> body text, for "calls" and "called from"
  for (let i = 0; i < lines.length; i++) {
    for (const [re, make] of heads) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const info = make(m);
      // the comment lines directly above
      const comment = [];
      for (let j = i - 1; j >= 0 && /^\/\/ ?/.test(lines[j]) && !/^\/\/ =====/.test(lines[j]); j--) comment.unshift(lines[j].replace(/^\/\/ ?/, ''));
      // the body: until the next top-level closing brace
      let k = i + 1; while (k < lines.length && !/^[})]/.test(lines[k])) k++;
      bodies[info.key] = lines.slice(i + 1, k).join('\n');
      labels[info.key] = Object.assign({ comment: comment.join(' ').replace(/\s+/g, ' ').trim() }, info);
    }
  }
  // on start: everything at top level that is not a function or handler
  const onStart = ts.slice(ts.indexOf('// ----- Device turns on -----'));
  bodies['pxt-on-start'] = onStart.slice(0, onStart.indexOf('\n\n\n'));
  labels['pxt-on-start'] = { key: 'pxt-on-start', comment: 'Every setting the program uses comes first (change your hardware and timings here), then the start-up steps: sensor maths, timings, sound, screen, Bluetooth, then "Device turns on". Hold B while switching on for demo timings.' };
  const fnNames = Object.keys(labels).filter(k => k.startsWith('fn ')).map(k => k.slice(3));
  for (const key of Object.keys(labels)) {
    const body = bodies[key] || '';
    labels[key].calls = fnNames.filter(n => n !== labels[key].name && new RegExp('\\b' + n + '\\(').test(body));
  }
  for (const key of Object.keys(labels)) {
    if (!key.startsWith('fn ')) continue;
    const n = key.slice(3);
    labels[key].calledFrom = Object.keys(labels).filter(k => k !== key && new RegExp('\\b' + n + '\\(').test(bodies[k] || ''));
  }
  return labels;
}

// ---------- block ids in the project file -> the same keys ----------
function blockKeys(xml) {
  const keys = {};
  for (const m of xml.matchAll(/<block id="([^"]*)" type="([^"]+)"[^>]*>(?:\s*<mutation name="([^"]+)")?(?:\s*<field name="NAME">([^<]+)<\/field>)?/g)) {
    const [, id, type, fn, name] = m;
    if (type === 'function_definition' && fn) keys[id] = 'fn ' + fn;
    else if (type === 'device_button_event' && name) keys[id] = 'on ' + name;
    else if (['pxt-on-start', 'device_forever', 'bluetooth_on_connected', 'bluetooth_on_disconnected', 'bluetooth_on_data_received', 'serial_on_data_received', 'every_interval'].includes(type)) keys[id] = type;
  }
  return keys;
}

// ---------- the MakeCode editor in a headless browser ----------
async function launchBrowser() {
  if (HARNESS) return require(path.resolve(HARNESS)).launch({ width: 2200, height: 3000, scale: SCALE });
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 2200, height: 3000 }, deviceScaleFactor: SCALE, serviceWorkers: 'block' });
  return { browser, context };
}

async function openEditorWithProject(context) {
  const page = await context.newPage();
  await page.setContent(`<html><body style="margin:0"><iframe id="mc" src="${MC_URL}" style="width:100vw;height:100vh;border:0"></iframe>
  <script>
    window.__msgs = []; window.__seq = 0;
    window.addEventListener('message', e => { const d = e.data; window.__msgs.push(d);
      if (d && d.type === 'pxthost' && d.action === 'workspacesync' && d.response) document.getElementById('mc').contentWindow.postMessage({ type: 'pxthost', id: d.id, action: 'workspacesync', success: true, projects: [], editor: {} }, '*');
    });
    window.__request = m => new Promise((res, rej) => { const id = 'r' + (++window.__seq); m.id = id; m.response = true; m.type = 'pxteditor'; const t0 = Date.now();
      const iv = setInterval(() => { const r = window.__msgs.find(x => x && x.id === id && x.type === 'pxteditor' && ('success' in x)); if (r) { clearInterval(iv); res(r); } else if (Date.now() - t0 > 150000) { clearInterval(iv); rej(new Error('timeout ' + m.action)); } else if (Date.now() - t0 > 40000 && !m.__resent) { m.__resent = true; document.getElementById('mc').contentWindow.postMessage(m, '*'); } }, 100);
      document.getElementById('mc').contentWindow.postMessage(m, '*'); });
  </script></body></html>`);
  let frame; for (let i = 0; i < 600 && !frame; i++) { frame = page.frames().find(f => f.url().startsWith('https://makecode')); if (!frame) await page.waitForTimeout(100); }
  if (!frame) throw new Error('MakeCode did not load');
  await frame.waitForFunction(() => window.pxt && window.pxt.appTarget && window.Blockly, null, { timeout: 180000 });
  await page.waitForTimeout(5000);
  const header = { target: 'microbit', targetVersion: mkcd.meta.targetVersions ? mkcd.meta.targetVersions.target : undefined, editor: mkcd.meta.editor || 'blocksprj', name: mkcd.meta.name || 'Untitled', meta: {}, pubId: '', pubCurrent: false };
  const r = await page.evaluate(m => window.__request(m), { action: 'importproject', project: { header, text: files } });
  if (!r.success) throw new Error('import failed');
  await frame.waitForFunction(() => Array.from(document.querySelectorAll('.blocklyBlockCanvas')).filter(c => !c.closest('.blocklyFlyout')).some(c => c.children.length >= 20), null, { timeout: 180000 });
  await page.waitForTimeout(4000);
  return { page, frame };
}

// ---------- captures (cached, so the layout can be re-run without the editor) ----------
async function capture() {
  const stamp = crypto.createHash('sha1').update(mkcd.source + mainTs + String(SCALE)).digest('hex').slice(0, 12);
  const cacheFile = path.join(CACHE, `captures-${stamp}.json`);
  if (fs.existsSync(cacheFile)) { console.log('using cached captures', path.relative(ROOT, cacheFile)); return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
  const keys = blockKeys(files['main.blocks']);
  const { browser, context } = await launchBrowser();
  const { page, frame } = await openEditorWithProject(context);

  // where every top-level block sits, and the geometry of the workspace on screen
  const info = await frame.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll('.blocklyBlockCanvas')).filter(c => !c.closest('.blocklyFlyout')).sort((a, b) => b.children.length - a.children.length)[0];
    const tops = [];
    for (const g of canvas.children) {
      if (!(g instanceof SVGGElement) || g.classList.contains('blocklyComment')) continue;
      const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(g.getAttribute('transform') || ''); const bb = g.getBBox();
      tops.push({ id: g.getAttribute('data-id') || '', x: m ? +m[1] : 0, y: m ? +m[2] : 0, w: bb.width, h: bb.height });
    }
    const svg = document.querySelector('.blocklySvg').getBoundingClientRect();
    const tb = Array.from(document.querySelectorAll('div')).filter(d => typeof d.className === 'string' && /toolbox/i.test(d.className)).map(d => d.getBoundingClientRect()).filter(r => r.width > 50 && r.height > 200);
    return { tops, svgLeft: svg.left, svgTop: svg.top, tbRight: tb.length ? Math.max(...tb.map(r => r.right)) : 0 };
  });
  const left = Math.max(info.svgLeft, info.tbRight);
  const setView = (s, tx, ty) => frame.evaluate(([s, x, y]) => { for (const c of document.querySelectorAll('.blocklyBlockCanvas, .blocklyBubbleCanvas')) { if (c.closest('.blocklyFlyout')) continue; c.setAttribute('transform', `translate(${x},${y}) scale(${s})`); } }, [s, tx, ty]);

  // one picture per block at 100% zoom
  const pictures = {};
  const PAD = 8;
  for (const t of info.tops) {
    const key = keys[t.id]; if (!key) continue;
    await setView(1, left - info.svgLeft + PAD - t.x, PAD - t.y);
    await page.waitForTimeout(120);
    const buf = await page.screenshot({ clip: { x: left + 2, y: info.svgTop, width: Math.ceil(t.w + 2 * PAD), height: Math.ceil(t.h + 2 * PAD) } });
    pictures[key] = { data: 'data:image/png;base64,' + buf.toString('base64'), w: Math.ceil(t.w + 2 * PAD), h: Math.ceil(t.h + 2 * PAD) };
    console.log('captured', key.padEnd(34), Math.round(t.w) + 'x' + Math.round(t.h));
  }
  // the whole workspace, for the overview sheet
  const ext = info.tops.reduce((a, t) => [Math.max(a[0], t.x + t.w), Math.max(a[1], t.y + t.h)], [0, 0]);
  const vw = 2200 - left - 40, vh = 3000 - 40;
  const s = Math.min(vw / (ext[0] + 80), vh / (ext[1] + 80));
  await setView(s, left - info.svgLeft + 20, 20);
  await page.waitForTimeout(400);
  const overview = await page.screenshot({ clip: { x: left + 4, y: info.svgTop, width: Math.ceil((ext[0] + 80) * s) + 32, height: Math.ceil((ext[1] + 80) * s) + 40 } });
  // the editor's block colours, for the legend
  const colours = await frame.evaluate(ns => {
    const out = {};
    for (const n of ns) { try { out[n] = pxt.toolbox.getNamespaceColor(n) || ''; } catch (e) { out[n] = ''; } }
    for (const row of document.querySelectorAll('.blocklyTreeRow')) {   // the toolbox knows the target's own categories
      const m = /--block-meta-color:\s*(#[0-9a-f]{6})/i.exec(row.getAttribute('style') || ''); const name = row.textContent.replace(/[^a-z]/gi, '').toLowerCase();
      if (m && ns.includes(name) && !out[name]) out[name] = m[1];
    }
    return out;
  }, ['basic', 'input', 'music', 'led', 'bluetooth', 'loops', 'logic', 'variables', 'math', 'functions', 'arrays', 'text', 'pins', 'serial', 'control']);
  await browser.close();
  const result = { pictures, overview: 'data:image/png;base64,' + overview.toString('base64'), colours };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}

// ---------- the sheets ----------
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function figureHtml(key, pic, labels) {
  const lab = labels[key] || {}; const ev = spec.eventLabels[key];
  const name = ev ? ev.name : lab.name || key;
  let kind;
  if (ev) kind = ev.kind;
  else {
    kind = lab.returns === 'boolean' ? 'A yes-or-no question the program asks' : lab.returns === 'string' ? 'Works out a piece of text' : lab.returns === 'number' ? 'Works out a number' : 'A step of the program';
    if (lab.params) kind += ` · needs: ${lab.params.replace(/: [\w\[\]]+/g, '').replace(/,\s*/g, ', ')}`;
  }
  const plain = (spec.plain || {})[key] || lab.comment || '';
  const meta = [];
  if (lab.calledFrom && lab.calledFrom.length) meta.push(`<b>Used by:</b> ${esc(lab.calledFrom.map(k => (spec.eventLabels[k] || {}).name || k.replace(/^fn /, '')).join(', '))}`);
  if (lab.calls && lab.calls.length) meta.push(`<b>Uses:</b> ${esc(lab.calls.join(', '))}`);
  const imgW = Math.round(pic.w * ZOOM), imgH = Math.round(pic.h * ZOOM);
  const textLen = plain.length + meta.join('').length;
  const width = Math.max(imgW, Math.round((textLen > 220 ? 330 : textLen > 120 ? 260 : 210) * TEXT));
  return `<figure style="width:${width}px" data-key="${esc(key)}"><img src="${pic.data}" width="${imgW}" height="${imgH}" alt="${esc(name)}">
    <figcaption><span class="nm">${esc(name)}</span> <span class="kd">${esc(kind)}</span><p>${esc(plain)}</p>${meta.length ? `<p class="meta">${meta.join(' · ')}</p>` : ''}</figcaption></figure>`;
}

function composeHtml(caps, labels) {
  const flowchart = path.join(ROOT, 'docs', 'sunburn-flowchart.png');
  const flowchartData = fs.existsSync(flowchart) ? 'data:image/png;base64,' + fs.readFileSync(flowchart).toString('base64') : '';
  const missing = [];
  const sections = spec.sections.map(sec => {
    const figs = sec.blocks.map(key => { const pic = caps.pictures[key]; if (!pic) { missing.push(key); return ''; } return figureHtml(key, pic, labels); }).join('\n');
    return `<div class="section" data-num="${sec.num}" data-title="${esc(sec.title)}" data-count="${sec.blocks.length}"><div class="text">${esc(sec.text)}</div>${figs}</div>`;
  }).join('\n');
  if (missing.length) console.warn('no picture for:', missing.join(', '));
  const unplaced = Object.keys(caps.pictures).filter(k => !spec.sections.some(sec => sec.blocks.includes(k)));
  if (unplaced.length) console.warn('blocks not in any section of sections.json (add them):', unplaced.join(', '));
  const index = spec.sections.map(sec => `<li><span class="n">${sec.num}</span><div><b>${esc(sec.title)}</b> <span class="muted">· ${sec.blocks.length} block${sec.blocks.length === 1 ? '' : 's'} · <span class="sheetref" data-num="${sec.num}">sheet ?</span></span><br>${esc(sec.text)}</div></li>`).join('');
  const LEGEND = [['variables', 'Variables: remember a value'], ['functions', 'Functions: a step with a name'], ['basic', 'Basic: the lights, pauses'], ['input', 'Input: buttons and time'], ['loops', 'Loops: repeat'], ['logic', 'Logic: if, compare'], ['math', 'Maths'], ['text', 'Text'], ['arrays', 'Arrays: lists'], ['music', 'Music: beeps'], ['pins', 'Pins: sensor, motor, screen'], ['bluetooth', 'Bluetooth: the phone'], ['serial', 'Serial: the USB cable'], ['control', 'Control: timing']];
  const colours = Object.assign({ basic: '#1E90FF', input: '#D400D4', music: '#E63022', led: '#5C2D91', bluetooth: '#007EF4', pins: '#A80000', serial: '#002050', control: '#333333' }, Object.fromEntries(Object.entries(caps.colours || {}).filter(([, v]) => v)));
  const legend = LEGEND.filter(([ns]) => colours[ns]).map(([ns, what]) => `<li><i style="background:${colours[ns]}"></i>${esc(what)}</li>`).join('');
  const glossary = (spec.glossary || []).map(([term, what]) => `<li><b>${esc(term)}</b> ${esc(what)}</li>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  const coverZoom = SHEET_H / 420;   // the cover is laid out as an A3 landscape sheet and scaled up to the chosen size
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.title)} poster</title><style>
    @page { size: ${SHEET_W}mm ${SHEET_H}mm; margin: 0; }
    @page land { size: ${SHEET_H}mm ${SHEET_W}mm; margin: 0; }
    * { box-sizing: border-box; }
    :root { --t: ${TEXT}; }
    html, body { margin: 0; background: #fff; color: #1c1917; font: calc(11pt * var(--t))/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .page { position: relative; width: ${SHEET_W}mm; height: ${SHEET_H}mm; padding: 10mm; overflow: hidden; break-after: page; page-break-after: always; background: #fff; }
    .page.landscape { width: ${SHEET_H}mm; height: ${SHEET_W}mm; page: land; padding: 0; }
    .page:last-child { break-after: auto; page-break-after: auto; }
    .coverin { width: 420mm; height: 297mm; padding: 10mm; zoom: ${coverZoom}; font-size: 11pt; display: grid; grid-template-columns: 1fr 300px; grid-template-rows: auto auto 1fr auto auto; gap: 0 10mm; position: relative; }
    .coverin .side { grid-row: 1 / 6; grid-column: 2; }
    .coverin h1 { font-size: 34pt; margin: 0 0 2mm; letter-spacing: -0.01em; line-height: 1.1; }
    .coverin .sub { font-size: 14pt; color: #57534e; margin: 0 0 3mm; }
    .coverin .story { font-size: 10.5pt; margin: 0 0 2mm; max-width: 95%; }
    .coverin .howto { font-size: 9.5pt; color: #57534e; margin: 0 0 3mm; }
    .coverin .ovwrap { min-height: 0; display: flex; align-items: flex-start; gap: 4mm; }
    .coverin .ov { max-height: 100%; max-width: 100%; border: 1px solid #ece5d6; border-radius: 3mm; }
    .coverin ol.index { list-style: none; padding: 0; margin: 3mm 0 0; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2mm 6mm; font-size: 8.5pt; line-height: 1.3; }
    .coverin ol.index li { display: flex; gap: 2.5mm; }
    .coverin ul.glossary { list-style: none; padding: 3mm 0 0; margin: 3mm 0 0; border-top: 1px solid #ece5d6; columns: 4; column-gap: 6mm; font-size: 8pt; line-height: 1.3; color: #57534e; }
    .coverin ul.glossary li { break-inside: avoid; margin-bottom: 1.5mm; }
    .coverin ul.glossary b { color: #1c1917; }
    .coverin .side img { width: 100%; border: 1px solid #ece5d6; border-radius: 3mm; }
    .coverin .side p { font-size: 9pt; color: #57534e; margin: 2mm 0 4mm; }
    .coverin .side h3 { font-size: 10pt; margin: 4mm 0 2mm; }
    .coverin ul.legend { list-style: none; padding: 0; margin: 0; font-size: 8.5pt; columns: 2; column-gap: 4mm; }
    .coverin ul.legend li { display: flex; align-items: center; gap: 2mm; margin-bottom: 1.2mm; break-inside: avoid; }
    .coverin ul.legend i { display: inline-block; width: 5mm; height: 3.6mm; border-radius: 1mm; flex: none; }
    .coverin footer { bottom: 4mm; right: 10mm; font-size: 8pt; }
    .n { display: inline-flex; align-items: center; justify-content: center; width: calc(7.5mm * var(--t)); height: calc(7.5mm * var(--t)); border-radius: 50%; background: #e8401c; color: #fff; font-weight: 700; font-size: calc(10.5pt * var(--t)); flex: none; }
    .coverin .n { width: 7.5mm; height: 7.5mm; font-size: 10.5pt; }
    .bar { display: flex; align-items: flex-start; gap: calc(5mm * var(--t)); background: #fff6e6; border: 1px solid #f3dcb8; border-radius: 3mm; padding: calc(3.5mm * var(--t)) calc(5mm * var(--t)); position: absolute; }
    #stage .bar { position: relative; visibility: hidden; }
    .bar h2 { margin: 0 0 1mm; font-size: calc(17pt * var(--t)); line-height: 1.15; }
    .bar h2 small { font-weight: 400; color: #8a857d; font-size: calc(11pt * var(--t)); }
    .bar p { margin: 0; font-size: calc(9.5pt * var(--t)); color: #57534e; }
    .bar .tag { margin-left: auto; font-size: calc(9pt * var(--t)); color: #8a857d; white-space: nowrap; }
    .area { position: relative; }
    figure { margin: 0; position: absolute; }
    #stage figure { position: relative; visibility: hidden; }
    figure img { display: block; border: 1px solid #ece5d6; border-radius: 2mm; }
    figcaption { margin-top: 1.5mm; font-size: calc(8.5pt * var(--t)); line-height: 1.3; }
    figcaption .nm { font-weight: 700; font-size: calc(10pt * var(--t)); }
    figcaption .kd { color: #8a857d; }
    figcaption p { margin: 0.8mm 0 0; }
    figcaption p.meta { color: #57534e; font-size: calc(8pt * var(--t)); }
    footer { position: absolute; bottom: 4mm; right: 10mm; font-size: calc(8pt * var(--t)); color: #8a857d; }
    .muted { color: #8a857d; }
    .section .text { display: none; }
  </style></head><body>
  <div class="page landscape cover"><div class="coverin">
    <div>
      <h1>${esc(spec.title)}: the whole program</h1>
      <p class="sub">${esc(spec.subtitle)} · printed ${today}</p>
    </div>
    <div>
      <p class="story">${esc(spec.story || '')}</p>
      <p class="howto">${esc(spec.howto || '')}</p>
    </div>
    <div class="ovwrap"><img class="ov" src="${caps.overview}" alt="The whole Blocks workspace"></div>
    <ol class="index">${index}</ol>
    ${glossary ? `<ul class="glossary">${glossary}</ul>` : ''}
    <div class="side">${flowchartData ? `<img src="${flowchartData}" alt="The Sunburn flowchart"><p>The Sunburn Flowchart the device follows. Every box on it is a block in section 2 with the same name.</p>` : ''}
      ${legend ? `<h3>What the block colours mean</h3><ul class="legend">${legend}</ul>` : ''}
      <h3>Reading the other sheets</h3><p>Every picture is one block from the editor${ZOOM === 1 ? '' : ` at ${Math.round(ZOOM * 100)}% of its size on screen`}. Under it: the block's name, what kind of block it is, what it does, which blocks use it (Used by) and which blocks it calls on (Uses).</p>
    </div>
    <footer></footer>
  </div></div>
  <div id="stage">${sections}</div>
  <script>
    // Lays the figures out on as many sheets as they need, in section order, packing each sheet full.
    const PX = 96 / 25.4, GAP = Math.round(16 * ${TEXT});
    const CW = (${SHEET_W} - 20) * PX, CH = (${SHEET_H} - 20) * PX;
    const findPos = (sky, w, h, H) => { let best = null; for (const s of sky) { const x = s.x; if (x + w > CW + 0.5) continue; let y = 0; for (const t of sky) { if (t.x < x + w && t.x + t.w > x) y = Math.max(y, t.y); } if (y + h > H + 0.5) continue; if (!best || y < best.y - 0.5 || (Math.abs(y - best.y) <= 0.5 && x < best.x)) best = { x, y }; } return best; };
    const addLevel = (sky, x, w, top) => { const out = []; for (const s of sky) { if (s.x + s.w <= x || s.x >= x + w) { out.push(s); continue; } if (s.x < x) out.push({ x: s.x, w: x - s.x, y: s.y }); if (s.x + s.w > x + w) out.push({ x: x + w, w: s.x + s.w - (x + w), y: s.y }); } out.push({ x, w, y: top }); out.sort((a, b) => a.x - b.x); const m = []; for (const s of out) { const l = m[m.length - 1]; if (l && Math.abs(l.y - s.y) < 0.01 && Math.abs(l.x + l.w - s.x) < 0.01) l.w += s.w; else m.push({ ...s }); } return m; };
    const pages = [document.querySelector('.cover')];
    const firstSheet = {}, onPage = [[]];
    let page = null, area = null, sky = null, H = 0;
    const FOOT = 6 * PX * ${TEXT};
    const newPage = () => { page = document.createElement('div'); page.className = 'page'; page.innerHTML = '<div class="area"></div><footer></footer>';
      document.body.appendChild(page); pages.push(page); onPage.push([]);
      area = page.querySelector('.area'); H = CH - FOOT; area.style.height = H + 'px'; sky = [{ x: 0, w: CW, y: 0 }]; };
    const makeBar = (sec, cont) => { const el = document.createElement('div'); el.className = 'bar'; el.style.width = CW + 'px';
      el.innerHTML = '<span class="n">' + sec.num + '</span><div><h2>' + sec.title + (cont ? ' <small>(continued)</small>' : '') + '</h2><p>' + sec.text + '</p></div><span class="tag">' + sec.count + ' block' + (sec.count == 1 ? '' : 's') + '</span>';
      document.getElementById('stage').appendChild(el); return { el, w: CW - GAP, h: el.offsetHeight, bar: true, sec }; };
    const fit = (f, HF) => {   // a block bigger than the space under a section bar is shown smaller (the caption grows as the figure narrows, so measure again)
      const img = f.el.querySelector('img');
      for (let i = 0; i < 4; i++) {
        const cap = f.el.offsetHeight - img.offsetHeight;
        const shrink = Math.min(1, (CW - GAP - 4) / img.offsetWidth, (HF - cap - 4) / img.offsetHeight);
        if (shrink >= 1) break;
        img.width = Math.floor(img.width * shrink); img.height = Math.floor(img.height * shrink); f.el.style.width = Math.max(img.width, 260 * ${TEXT}) + 'px';
      }
      f.h = f.el.offsetHeight; f.w = f.el.offsetWidth;
    };
    // Places items in order on the given skyline; when the next item does not fit, a later block that fills the gap goes first.
    // A section bar is never skipped. Returns what was placed and what is left over.
    const packInto = (skyIn, items) => {
      let s = skyIn; const placed = [], queue = items.slice();
      while (queue.length) {
        let chosen = -1, pos = null;
        for (let i = 0; i < queue.length; i++) { const f = queue[i]; pos = findPos(s, f.w + GAP, f.h + GAP, H + GAP); if (pos) { chosen = i; break; } if (f.bar) break; }
        if (chosen < 0) break;
        const f = queue.splice(chosen, 1)[0]; s = addLevel(s, pos.x, f.w + GAP, pos.y + f.h + GAP); placed.push({ f, x: pos.x, y: pos.y });
      }
      return { placed, rest: queue, sky: s };
    };
    const commit = r => { for (const { f, x, y } of r.placed) { f.el.style.left = x + 'px'; f.el.style.top = y + 'px'; f.el.style.visibility = 'visible'; area.appendChild(f.el); if (f.bar) { if (!(f.sec.num in firstSheet)) firstSheet[f.sec.num] = pages.length; onPage[pages.length - 1].push(f.sec.num); } } sky = r.sky; };
    for (const secEl of document.querySelectorAll('#stage .section')) {
      const sec = { num: secEl.dataset.num, title: secEl.dataset.title, count: secEl.dataset.count, text: secEl.querySelector('.text').textContent };
      const figs = Array.from(secEl.querySelectorAll('figure')).map(f => ({ el: f, w: f.offsetWidth, h: f.offsetHeight }));
      const bar = makeBar(sec, false);
      figs.forEach(f => fit(f, CH - FOOT - bar.h - GAP));
      let items = figs, first = true;
      if (page) {   // a section starts in the space left on the current sheet when all of it, or at least three of its blocks, fit there
        const trial = packInto(sky, [bar, ...figs]);
        if (!trial.rest.length) { commit(trial); continue; }
        if (trial.placed.length > 3) { commit(trial); items = trial.rest; first = false; }
      }
      while (true) { newPage(); const r = packInto(sky, [first ? bar : makeBar(sec, true), ...items]); if (r.placed.length < 2) throw new Error('cannot place ' + sec.title + ': ' + (r.rest[1] || {}).el); commit(r); if (!r.rest.length) break; items = r.rest; first = false; }
    }
    document.getElementById('stage').remove();
    pages.forEach((p, i) => { const secs = onPage[i]; p.querySelector('footer').innerHTML = '${esc(spec.title)} · <span class="sheetno">sheet ' + (i + 1) + ' of ' + pages.length + '</span>' + (secs.length ? ' · section' + (secs.length > 1 ? 's ' : ' ') + secs.join(', ') + ' of ${spec.sections.length}' : '') + ' · ${SIZE}'; });
    for (const r of document.querySelectorAll('.sheetref')) r.textContent = 'sheet ' + firstSheet[r.dataset.num];
    window.__layout = { pages: pages.length, firstSheet };
  </script>
  </body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const labels = parseLabels(mainTs);
  if (args.includes('--dump-labels')) { console.log(JSON.stringify(labels, null, 1)); return; }   // to write the plain-language texts in sections.json
  const caps = await capture();
  const html = composeHtml(caps, labels);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, `poster-${SIZE}.html`), html);
  const pdfName = `sunburn-code-poster-${SIZE}.pdf`;

  // lay out and print
  const { chromium } = require('playwright');
  const b2 = await chromium.launch(); const p2 = await b2.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: SIZE === 'A3' ? 1.5 : 0.75 });
  await p2.setContent(html, { waitUntil: 'load', timeout: 180000 });
  const layout = await p2.evaluate(() => window.__layout);
  if (!layout) throw new Error('layout script did not run');
  await p2.pdf({ path: path.join(OUT, pdfName), preferCSSPageSize: true, printBackground: true });
  // the A3 overview sheet as a picture too (for the README and screens), and the bare workspace
  if (SIZE === 'A3') {
    await (await p2.$('.cover')).screenshot({ path: path.join(OUT, 'sheet-1-overview.png') });
    fs.writeFileSync(path.join(OUT, 'workspace-overview.png'), Buffer.from(caps.overview.split(',')[1], 'base64'));
  }
  if (WANT_SHEETS) { const ps = await p2.$$('.page'); for (let i = 0; i < ps.length; i++) await ps[i].screenshot({ path: path.join(CACHE, `sheet-${SIZE}-${String(i + 1).padStart(2, '0')}.png`) }); }
  await b2.close();
  const size = fs.statSync(path.join(OUT, pdfName)).size;
  const where = Object.entries(layout.firstSheet).map(([n, s]) => `${n}→${s}`).join(' ');
  console.log(`wrote ${path.relative(ROOT, OUT)}/${pdfName} (${(size / 1e6).toFixed(1)} MB, ${layout.pages} ${SIZE} sheets at zoom ${ZOOM} text ${TEXT}, sections start on sheets ${where}); ${Object.keys(caps.pictures).length} blocks`);
}

module.exports = { spec, labels: () => parseLabels(mainTs), capture, esc, ROOT, OUT, CACHE, HARNESS, SHEETS };
if (require.main === module) main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
