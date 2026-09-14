'use strict';
/* ===================================================================
   Sunburn device companion app.  Three files (index.html, app.css, app.js), no build step.
   Sections: protocol · transports (Bluetooth, USB, demo) · live UV ·
   state & storage · rendering · charts · wiring up
   =================================================================== */

const APP_VERSION = '2.0';
const TIMER_MS = 2 * 3600000;   // the reapply timer of the flowchart

// ---------- protocol ----------
const NUS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',   // app -> device
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',   // device -> app
};
// title, description, icon, tone
const STEPS = {
  on:        ['Device turns on', 'Starting up', 'power', ''],
  reading:   ['Read UV sensor', 'Taking a reading from the sensor', 'scan', ''],
  error:     ['CHECK SENSOR', 'The sensor reading is out of range. It retries every 5 seconds.', 'alert', 'error'],
  safe:      ['Low UV', 'Happy face: no sunscreen needed right now', 'smile', 'good'],
  alert:     ['Alert', 'Flashing, beeping or tapping until A is pressed', 'bell', 'alert'],
  protected: ['Sunscreen on', 'Waiting for the 2 hour reapply timer', 'drop', 'good'],
  wait:      ['Wait 5 minutes', 'Checking the UV again soon', 'clock', ''],
  standby:   ['Standby', 'Press a button on the device to check again', 'moon', ''],
  off:       ['Off', 'Press A+B on the device, or Turn on below', 'off', ''],
};
const EVENT_LABELS = {
  on: ['Device turned on', ''], off: ['Device turned off', ''],
  sunscreen: ['Sunscreen applied', 'Reminder in 2 hours'], reapply: ['Reapply sunscreen', 'The 2 hour timer ran out'],
  inside: ['Went inside', 'Extreme UV'], standby: ['Standby', 'Nobody answered, or extreme UV'],
  error: ['Sensor problem', ''],
};
// WHO Global Solar UV Index bands and their official colours (status colours, always with a label)
const BANDS = [
  { max: 2, name: 'Low', color: '#3ea72d', ink: '#ffffff' },
  { max: 5, name: 'Moderate', color: '#fff300', ink: '#1c1917' },
  { max: 7, name: 'High', color: '#f18b00', ink: '#1c1917' },
  { max: 10, name: 'Very high', color: '#e53210', ink: '#ffffff' },
  { max: Infinity, name: 'Extreme', color: '#b567a4', ink: '#ffffff' },
];
const bandFor = uv => BANDS.find(b => Math.round(uv) <= b.max);
const BAND_CODES = { low: 'Low', modhigh: 'Moderate / high', vhigh: 'Very high', extreme: 'Extreme' };

function parseKv(line) {
  const o = {};
  for (const part of line.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) o[part] = true; else o[part.slice(0, i)] = part.slice(i + 1);
  }
  return o;
}

// ---------- transports ----------
// Every transport: connect() -> resolves when ready; send(text); close(); fields kind, name; callbacks onLine, onClose.
class LineBuffer {
  constructor(onLine) { this.buf = ''; this.onLine = onLine; }
  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r/g, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }
}

class BleLink {
  constructor() { this.kind = 'Bluetooth'; this.name = ''; this.onLine = () => {}; this.onClose = () => {}; this.onStatus = () => {}; this.wantConnected = false; this.retryTimer = null; }
  async connect() {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'BBC micro:bit' }], optionalServices: [NUS.service] });
    this.device = device; this.name = device.name || 'micro:bit'; this.wantConnected = true;
    device.addEventListener('gattserverdisconnected', () => this.dropped());
    await this.open();
  }
  async open() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS.service);
    this.rx = await service.getCharacteristic(NUS.rx);
    this.tx = await service.getCharacteristic(NUS.tx);
    const decoder = new TextDecoder();
    const lines = new LineBuffer(l => this.onLine(l));
    this.tx.addEventListener('characteristicvaluechanged', e => lines.push(decoder.decode(e.target.value)));
    await this.tx.startNotifications();
  }
  // The micro:bit went out of range or restarted: keep trying to get it back for about two minutes.
  dropped() {
    if (!this.wantConnected) { this.onClose(); return; }
    this.onStatus('reconnecting');
    this.retry(0);
  }
  retry(attempt) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      if (!this.wantConnected) return;
      try { await this.open(); this.onStatus('reconnected'); }
      catch (e) { if (attempt >= 7) { this.wantConnected = false; this.onClose(); } else this.retry(attempt + 1); }
    }, Math.min(30000, 1500 * 2 ** attempt));
  }
  async send(text) {
    if (!this.device || !this.device.gatt.connected) throw new Error('the micro:bit is not connected right now');
    const bytes = new TextEncoder().encode(text + '\n');
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (this.rx.properties.write) await (this.rx.writeValueWithResponse ? this.rx.writeValueWithResponse(chunk) : this.rx.writeValue(chunk));
      else await this.rx.writeValueWithoutResponse(chunk);
    }
  }
  async reopen() { if (!this.device) throw new Error('no device to reconnect to'); this.wantConnected = true; await this.open(); }
  close() { this.wantConnected = false; clearTimeout(this.retryTimer); try { this.device && this.device.gatt.disconnect(); } catch (e) { /* already gone */ } }
}

class SerialLink {
  constructor() { this.kind = 'USB'; this.name = 'micro:bit (USB)'; this.onLine = () => {}; this.onClose = () => {}; }
  async connect() {
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x0d28 }] });
    await port.open({ baudRate: 115200 });
    this.port = port;
    port.addEventListener('disconnect', () => this.onClose());
    const lines = new LineBuffer(l => this.onLine(l));
    this.decoder = new TextDecoderStream();
    this.readClosed = port.readable.pipeTo(this.decoder.writable).catch(() => {});
    this.reader = this.decoder.readable.getReader();
    (async () => {
      try {
        for (;;) { const { value, done } = await this.reader.read(); if (done) break; lines.push(value); }
      } catch (e) { /* port closed */ }
      this.onClose();
    })();
    this.encoder = new TextEncoderStream();
    this.writeClosed = this.encoder.readable.pipeTo(port.writable).catch(() => {});
    this.writer = this.encoder.writable.getWriter();
  }
  async send(text) { await this.writer.write(text + '\n'); }
  async close() {
    try { await this.reader.cancel(); } catch (e) {}
    try { await this.writer.close(); } catch (e) {}
    try { await this.port.close(); } catch (e) {}
  }
}

// A pretend micro:bit that speaks the same protocol, so the page can be tried without hardware.
class DemoLink {
  constructor() {
    this.kind = 'Demo'; this.name = 'Demo micro:bit'; this.onLine = () => {}; this.onClose = () => {};
    this.d = { on: true, st: 'on', sensor: 1.4, online: -1, onlineAt: 0, protection: 0, timer: 0, spfn: 0, demo: true, ack: false, any: false, band: 'low' };
    this.timers = [];
  }
  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  emit(line) { this.later(0, () => this.onLine(line)); }
  async connect() {
    this.emit('hello;fw=3.1');
    this.statusTimer = setInterval(() => this.emit(this.statusLine()), 2000);
    this.later(1500, () => this.cycle());
  }
  uvNow() { const d = this.d; const fresh = d.onlineAt && Date.now() - d.onlineAt < 30 * 60000; return Math.max(d.sensor, fresh ? d.online : 0); }
  bandOf(uv) { const r = Math.round(uv); return r <= 2 ? 'low' : r <= 7 ? 'modhigh' : r <= 10 ? 'vhigh' : 'extreme'; }
  statusLine() {
    const d = this.d; const uv = this.uvNow();
    const fresh = d.onlineAt && Date.now() - d.onlineAt < 30 * 60000;
    const spf = d.timer ? Math.max(0, Math.floor((d.timer - Date.now()) / 1000)) : -1;
    return `st=${d.st};uv=${uv.toFixed(1)};sen=${d.sensor.toFixed(1)};onl=${fresh ? d.online.toFixed(1) : '-1'};band=${this.bandOf(uv)};spf=${spf};spfn=${d.spfn};fw=3.1;demo=${d.demo ? 1 : 0}`;
  }
  // the flowchart, sped up: a "5 minute" wait is 10 s, the reapply timer 60 s, alerts give up after 20 s
  cycle() {
    const d = this.d; if (!d.on) return;
    d.st = 'reading';
    this.later(800, () => {
      const uv = this.uvNow(); const band = this.bandOf(uv); d.band = band;
      const next = (ms) => this.later(ms, () => this.cycle());
      const waitThenTimer = () => {
        d.st = 'wait';
        this.later(10000, () => {
          if (d.timer && Date.now() >= d.timer) { d.timer = 0; d.protection = 0; d.st = 'alert'; this.emit('ev=reapply'); }
          this.cycle();
        });
      };
      if (band === 'low') { d.st = 'safe'; waitThenTimer(); return; }
      if (band === 'extreme') {
        d.st = 'alert'; d.ack = false;
        this.waitForAck(20000, acked => { if (acked) this.emit('ev=inside'); this.standby(() => this.cycle()); });
        return;
      }
      const level = band === 'vhigh' ? 2 : 1;
      if (d.protection >= level) { d.st = 'protected'; waitThenTimer(); return; }
      d.st = 'alert'; d.ack = false;
      this.waitForAck(20000, acked => {
        if (acked) { d.protection = level; d.spfn++; d.timer = Date.now() + 60000; this.emit('ev=sunscreen'); waitThenTimer(); }
        else this.standby(() => this.cycle());
      });
    });
  }
  waitForAck(limit, done) {
    const t0 = Date.now(); const d = this.d;
    const poll = () => { if (!d.on) return; if (d.ack) { d.ack = false; done(true); } else if (Date.now() - t0 > limit) done(false); else this.later(200, poll); };
    poll();
  }
  standby(done) {
    const d = this.d; d.st = 'standby'; d.any = false; this.emit('ev=standby');
    const poll = () => { if (!d.on) return; if (d.any) { d.any = false; done(); } else this.later(200, poll); };
    poll();
  }
  async send(text) {
    const d = this.d; const [key, value = ''] = text.trim().split('=');
    switch (key) {
      case 'uv': { const v = parseFloat(value); if (v >= 0 && v <= 20) { d.online = v; d.onlineAt = Date.now(); this.emit('ok=uv'); } else this.emit('err=uv'); break; }
      case 'ack': d.ack = true; d.any = true; this.emit('ok=ack'); break;
      case 'read': this.emit(this.statusLine()); break;
      case 'ping': this.emit('pong;fw=3.1;oled=0'); break;
      case 'demo': d.demo = value === '1'; this.emit('ok=demo'); break;
      case 'debug': this.emit('ok=debug'); break;
      case 'zero': this.emit('ok=zero;v=0.0'); break;
      case 'cal': this.emit(parseFloat(value) > 0 ? 'ok=cal' : 'err=cal'); break;
      case 'power':
        if (value === '0' && d.on) { d.on = false; d.st = 'off'; this.emit('ev=off'); }
        else if (value === '1' && !d.on) { d.on = true; d.st = 'on'; this.emit('ev=on'); this.later(1500, () => this.cycle()); }
        break;
      default: if (key) this.emit('err=unknown');
    }
  }
  close() { clearInterval(this.statusTimer); this.timers.forEach(clearTimeout); }
}

// ---------- state & storage ----------
const store = {
  load(k, fb) { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch (e) { return fb; } },
  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};
const state = {
  link: null, linkStatus: 'off',
  device: { fw: '', status: null, statusAt: 0, debug: false },
  demoEvents: [],                                 // events from the demo device: shown, never stored
  bands: store.load('sunburn.bands', {}),         // { day: { low, modhigh, vhigh, extreme } } seconds while connected
  demoBands: {}, bandsDirty: false,
  samples: store.load('sunburn.samples', {}),     // { day: [{ m: minute of day, uv, sen }] } one reading a minute while connected
  demoSamples: {}, samplesDirty: false,
  appTimer: store.load('sunburn.appTimer', null), // this page's own sunscreen timer { startedAt, due, notified }
  lastBle: null,                                  // the last Bluetooth link, kept so it can be reopened without the chooser
  online: store.load('sunburn.online', null),   // { uv, at, lat, lon, place, tz, peak, peakAt, hourly:[{t, uv}] }
  settings: Object.assign({ autoSend: true, intervalMin: 10, location: null, notify: false, keepAwake: false, rangeDays: 14, theme: 'system', gotStarted: false }, store.load('sunburn.settings', {})),
  events: store.load('sunburn.events', []),      // [{ t, ev, msg }]
  lastSentAt: store.load('sunburn.lastSent', 0),
  consoleLines: [],
  showAllEvents: false, showTable: false,
};
const saveSettings = () => store.save('sunburn.settings', state.settings);

// ---------- helpers ----------
const $ = id => document.getElementById(id);
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const c of children) if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
function svgEl(tag, attrs, ...children) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
// Line icons, 24-unit grid, drawn with the current text colour. Emoji looked different on every platform.
const ICONS = {
  watch: 'M6 12a6 6 0 1 0 12 0 6 6 0 1 0-12 0M12 10v2l1 1M16.1 7.7l-.8-4.1a2 2 0 0 0-2-1.6h-2.6a2 2 0 0 0-2 1.6l-.8 4.1M7.9 16.4l.8 4a2 2 0 0 0 2 1.6h2.7a2 2 0 0 0 2-1.6l.8-4',
  radio: 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M10 12a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.1 19.1 19',
  hourglass: 'M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4A2 2 0 0 0 7 17.8V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4A2 2 0 0 0 17 6.2V2',
  power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0',
  scan: 'M3 11a8 8 0 1 0 16 0 8 8 0 1 0-16 0M21 21l-4.3-4.3',
  alert: 'M21.7 18l-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3M12 9v4M12 17h.01',
  smile: 'M2 12a10 10 0 1 0 20 0 10 10 0 1 0-20 0M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  drop: 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z',
  clock: 'M2 12a10 10 0 1 0 20 0 10 10 0 1 0-20 0M12 6v6l4 2',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z',
  off: 'M18.4 6.6A9 9 0 0 1 20.8 15M6.2 6.2a9 9 0 1 0 12.7 12.7M12 2v4M2 2l20 20',
};
function icon(name) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'i' });
  svg.append(svgEl('path', { d: ICONS[name] || ICONS.clock }));
  return svg;
}
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
// New content settling in: a short fade through a little blur reads as one thing changing, not two things swapping.
function settle(node) {
  if (reduced.matches || !node.animate) return;
  node.animate([{ opacity: 0.35, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0px)' }], { duration: 260, easing: EASE_OUT });
}
// A button that is waiting on something shows a spinner and cannot be pressed twice.
function busy(id, on) {
  const b = $(id); b.classList.toggle('is-busy', on); b.disabled = on; b.setAttribute('aria-busy', on ? 'true' : 'false');
}
// Charts and lists are rebuilt only when what they show has changed (status lines arrive every 2 seconds, and a rebuild would pull a tooltip out from under the pointer).
const sigs = {};
function changed(key, sig) { if (sigs[key] === sig) return false; sigs[key] = sig; return true; }
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); };
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now'; if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
function fmtCountdown(sec) {
  if (sec < 0) return null;
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
}
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
function pushConsole(line) {
  state.consoleLines.push(`${fmtTime(Date.now())}  ${line}`);
  if (state.consoleLines.length > 200) state.consoleLines.shift();
  const c = $('console'); c.textContent = state.consoleLines.join('\n'); c.scrollTop = c.scrollHeight;
}

// ---------- device link ----------
async function connectWith(link) {
  if (state.link) await disconnect();
  link.onLine = handleLine;
  link.onClose = () => { if (state.link === link) { state.link = null; state.linkStatus = 'off'; state.device.status = null; if (link.kind === 'Bluetooth') state.lastBle = link; pushConsole('-- disconnected'); toast(`${link.kind} link closed`); updateWakeLock(); render(); } };
  link.onStatus = status => {
    if (state.link !== link) return;
    if (status === 'reconnecting') { state.linkStatus = 'wait'; state.device.status = null; pushConsole('-- link dropped, reconnecting'); toast('Lost the micro:bit, trying to reconnect'); }
    if (status === 'reconnected') { state.linkStatus = 'on'; pushConsole('-- reconnected'); toast('Reconnected'); send('ping'); }
    render();
  };
  try {
    await link.connect();
  } catch (e) {
    if (e && e.name === 'NotFoundError') return;   // the chooser was cancelled
    toast(`Could not connect: ${e.message || e}`); return;
  }
  state.link = link; state.linkStatus = 'on'; state.device.status = null; state.device.fw = ''; state.lastBle = null;
  if (!state.settings.gotStarted) { state.settings.gotStarted = true; saveSettings(); }
  pushConsole(`-- connected via ${link.kind} (${link.name}), app ${APP_VERSION}`);
  updateWakeLock(); render();
  setTimeout(() => { if (state.link === link && !state.device.fw) send('ping'); }, 2500);
}
async function disconnect() {
  const link = state.link; if (!link) return;
  state.link = null; state.linkStatus = 'off'; state.device.status = null; if (link.kind === 'Bluetooth') state.lastBle = link;
  try { await link.close(); } catch (e) {}
  pushConsole('-- disconnected'); updateWakeLock(); render();
}
async function send(text) {
  if (!state.link) { toast('Not connected'); return false; }
  pushConsole('> ' + text);
  try { await state.link.send(text); return true; }
  catch (e) { toast(`Send failed: ${e.message || e}`); return false; }
}
// Reopens the last Bluetooth link without the chooser (the micro:bit must be on and nearby).
async function reconnectLast() {
  const link = state.lastBle; if (!link) return;
  $('btnReconnect').disabled = true; toast(`Reconnecting to ${link.name}`);
  try { await link.reopen(); }
  catch (e) { toast(`Could not reconnect: ${e.message || e}. Is the micro:bit on and nearby?`); $('btnReconnect').disabled = false; return; }
  state.link = link; state.linkStatus = 'on'; state.device.status = null; state.lastBle = null;
  pushConsole(`-- reconnected via Bluetooth (${link.name})`); updateWakeLock(); render(); send('ping');
  $('btnReconnect').disabled = false;
}
function handleLine(line) {
  pushConsole('< ' + line);
  if (line.startsWith('st=')) {
    const status = parseKv(line);
    countBandTime(status); recordSample(status);
    state.device.status = status; state.device.statusAt = Date.now();
    // the device lost its online value (it restarted, or 30 minutes passed): give it ours again
    if (status.onl === '-1' && onlineIsFresh() && Date.now() - state.lastSentAt > 60000) sendUvIfFresh('device has none');
  } else if (line.startsWith('ev=')) {
    const kv = parseKv(line); addEvent(kv.ev, kv.msg || '');
  } else if (line.startsWith('hello') || line.startsWith('pong')) {
    const kv = parseKv(line); state.device.fw = kv.fw || state.device.fw;
    sendUvIfFresh(line.startsWith('hello') ? 'connected' : 'ping');
  } else if (line.startsWith('ok=') || line.startsWith('err=')) {
    const [k, v] = line.split('=');
    if (k === 'err') toast(`Device replied: ${line}`);
    else if (v === 'cal') toast('Sensor calibrated to the live UV index');
    else if (v === 'zero') toast('Sensor zero point set');
  }
  render();
}
function addEvent(ev, msg) {
  const e = { t: Date.now(), ev, msg };
  if (state.link && state.link.kind === 'Demo') { e.demo = true; state.demoEvents.push(e); }
  else {
    state.events.push(e);
    if (state.events.length > 3000) state.events.splice(0, state.events.length - 3000);
    store.save('sunburn.events', state.events);
  }
  notify(ev);
}
const allEvents = () => (state.demoEvents.length ? state.events.concat(state.demoEvents) : state.events);
const MEASURING = new Set(['reading', 'safe', 'alert', 'protected', 'wait']);
// Adds the seconds since the last status line to today's total for the band the device reports.
function countBandTime(status) {
  if (!state.link || !status.band || !MEASURING.has(status.st) || !state.device.statusAt) return;
  const seconds = Math.min(10, (Date.now() - state.device.statusAt) / 1000);
  const store_ = state.link.kind === 'Demo' ? state.demoBands : state.bands;
  const k = dayKey(Date.now()); const d = store_[k] || (store_[k] = { low: 0, modhigh: 0, vhigh: 0, extreme: 0 });
  if (d[status.band] !== undefined) { d[status.band] += seconds; if (store_ === state.bands) state.bandsDirty = true; }
}
function saveBands() {
  if (state.bandsDirty) { store.save('sunburn.bands', state.bands); state.bandsDirty = false; }
  if (state.samplesDirty) { store.save('sunburn.samples', state.samples); state.samplesDirty = false; }
}
// One reading a minute of the UV value the device is using (and its raw sensor), for the "Measured today" chart.
function recordSample(status) {
  if (!state.link || !MEASURING.has(status.st)) return;
  const uv = parseFloat(status.uv), sen = parseFloat(status.sen); if (!isFinite(uv)) return;
  const now = new Date(); const m = now.getHours() * 60 + now.getMinutes();
  const src = state.link.kind === 'Demo' ? state.demoSamples : state.samples;
  const k = dayKey(now.getTime()); const arr = src[k] || (src[k] = []);
  const last = arr[arr.length - 1];
  if (last && last.m === m) { last.uv = uv; last.sen = isFinite(sen) ? sen : last.sen; } else arr.push({ m, uv, sen: isFinite(sen) ? sen : 0 });
  if (src === state.samples) { state.samplesDirty = true; const keys = Object.keys(state.samples).sort(); while (keys.length > 7) delete state.samples[keys.shift()]; }
}
// ---------- this page's own sunscreen timer ----------
function startAppTimer() {
  const now = Date.now(); state.appTimer = { startedAt: now, due: now + TIMER_MS, notified: false };
  store.save('sunburn.appTimer', state.appTimer); addEvent('sunscreen', 'from this page'); render();
}
function stopAppTimer() { state.appTimer = null; store.save('sunburn.appTimer', null); render(); }
function checkAppTimer() {
  const t = state.appTimer;
  if (t && t.due <= Date.now() && !t.notified) { t.notified = true; store.save('sunburn.appTimer', t); addEvent('reapply', 'from this page'); toast('Reapply sunscreen: the 2 hours are up'); renderEvents(); renderHistory(); }
}
// ---------- appearance ----------
function applyTheme() {
  const t = state.settings.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  for (const b of $('themeSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.theme === t));
  placeSegment($('themeSeg'));
}
// Keeps the screen on while connected, if the wearer asked for it (a phone that sleeps stops sending UV updates).
let wakeLock = null;
async function updateWakeLock() {
  const want = state.settings.keepAwake && state.link && !document.hidden && 'wakeLock' in navigator;
  if (want && !wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) { wakeLock = null; } }
  else if (!want && wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
}

// ---------- live UV ----------
const FRESH_MS = 60 * 60000;
// One quiet retry: mobile networks drop the odd request, and a 12 s hang followed by a second try beats an error.
async function fetchTwice(url, ms) {
  try { return await fetch(url, { signal: AbortSignal.timeout(ms) }); }
  catch (e) { return fetch(url, { signal: AbortSignal.timeout(ms) }); }
}
async function fetchUv(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=uv_index&hourly=uv_index&daily=uv_index_max&forecast_days=7&timezone=auto`;
  const r = await fetchTwice(url, 12000); if (!r.ok) throw new Error(`Open-Meteo replied ${r.status}`);
  const j = await r.json();
  const today = j.current.time.slice(0, 10);
  const hourly = j.hourly.time.map((t, i) => ({ t, uv: j.hourly.uv_index[i] })).filter(h => h.t.startsWith(today) && h.uv !== null);
  const daily = ((j.daily && j.daily.time) || []).map((d, i) => ({ date: d, max: j.daily.uv_index_max[i] })).filter(d => d.max !== null);
  const peak = hourly.reduce((a, h) => (h.uv > a.uv ? h : a), { uv: -1, t: '' });
  return { uv: j.current.uv_index, at: Date.now(), lat, lon, tz: j.timezone, peak: peak.uv, peakAt: peak.t, hourly, daily, currentTime: j.current.time };
}
async function placeName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return [j.city || j.locality, j.principalSubdivision || j.countryName].filter(Boolean).join(', ');
  } catch (e) { return ''; }
}
async function updateUv(lat, lon, name) {
  const card = $('uvNum'); card.classList.add('loading'); busy('btnRefresh', true);
  try {
    const data = await fetchUv(lat, lon);
    data.place = name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    state.online = data; store.save('sunburn.online', data);
    state.settings.location = { lat, lon, name: data.place }; saveSettings();
    $('uvError').hidden = true;
    render();
    if (state.link) sendUvIfFresh('refreshed');
    if (!name) {
      // the place name is decoration: show the UV first, fill the name in when it arrives
      const found = await placeName(lat, lon);
      if (found && state.online === data) {
        data.place = found; store.save('sunburn.online', data);
        state.settings.location = { lat, lon, name: found }; saveSettings();
        render();
      }
    }
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'The UV service did not answer. Check the connection and press Refresh.' : `Could not get the UV index: ${e.message || e}`;
    $('uvError').textContent = msg; $('uvError').hidden = false; toast(msg);
  } finally { card.classList.remove('loading'); busy('btnRefresh', false); }
}
function useMyLocation() {
  if (!navigator.geolocation) { toast('This browser has no location service. Search for a town instead.'); return; }
  busy('btnLocate', true);
  navigator.geolocation.getCurrentPosition(
    async pos => { await updateUv(pos.coords.latitude, pos.coords.longitude, ''); busy('btnLocate', false); },
    err => { busy('btnLocate', false); toast(err.code === 1 ? 'Location permission was refused. Search for a town instead.' : 'Could not get your location. Search for a town instead.'); },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60000 });
}
async function searchPlace() {
  const q = $('placeInput').value.trim(); const list = $('searchResults'); list.replaceChildren();
  if (!q) return;
  busy('btnSearch', true);
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const results = j.results || [];
    if (!results.length) { toast('No place found with that name'); return; }
    for (const p of results) {
      const label = [p.name, p.admin1, p.country].filter(Boolean).join(', ');
      list.append(el('li', {}, el('button', { class: 'btn small', onclick: () => { list.replaceChildren(); $('placeInput').value = ''; updateUv(p.latitude, p.longitude, [p.name, p.admin1].filter(Boolean).join(', ')); } }, label)));
    }
  } catch (e) { toast('Place search failed'); }
  finally { busy('btnSearch', false); }
}
function refreshUv() {
  const loc = state.settings.location;
  if (loc) updateUv(loc.lat, loc.lon, loc.name); else useMyLocation();
}
function onlineIsFresh() { return state.online && Date.now() - state.online.at < FRESH_MS; }
// SunSmart-style protection times: the first and last hour of the day with a UV index of 3 or more
function protectionTimes(hourly) {
  const hours = hourly.filter(h => h.uv >= 3).map(h => parseInt(h.t.slice(11, 13), 10));
  if (!hours.length) return null;
  return { from: Math.min(...hours), to: Math.max(...hours) + 1 };
}
const hh = h => `${String(h).padStart(2, '0')}:00`;
// Where the UV is heading for the rest of the day
function trendText(o) {
  const nowH = o.currentTime ? parseInt(o.currentTime.slice(11, 13), 10) : new Date().getHours();
  const later = (o.hourly || []).filter(h => parseInt(h.t.slice(11, 13), 10) > nowH);
  if (!later.length) return 'The day is done: UV stays low overnight.';
  const peakH = o.peakAt ? parseInt(o.peakAt.slice(11, 13), 10) : -1;
  if (peakH > nowH && o.peak > o.uv + 0.4) return `Rising to about ${o.peak.toFixed(1)} (${bandFor(o.peak).name}) by ${o.peakAt.slice(11, 16)}.`;
  const drop = later.find(h => h.uv < 3);
  if (o.uv >= 3 && drop) return `Falling below 3 after ${drop.t.slice(11, 16)}.`;
  if (o.uv >= 3) return 'Staying at 3 or more for the rest of the day.';
  return 'Staying low for the rest of the day.';
}
async function sendUvIfFresh(reason) {
  if (!state.link || !onlineIsFresh()) return false;
  const ok = await send(`uv=${state.online.uv.toFixed(1)}`);
  if (ok) { state.lastSentAt = Date.now(); store.save('sunburn.lastSent', state.lastSentAt); render(); }
  return ok;
}
function autoTick() {
  const due = Date.now() - state.lastSentAt > state.settings.intervalMin * 60000;
  if (state.settings.autoSend && state.link && due) sendUvIfFresh('interval');
  // keep the online value itself fresh while the page is open (every 20 minutes)
  if (state.settings.location && state.online && Date.now() - state.online.at > 20 * 60000 && !document.hidden) refreshUv();
  renderAges(); saveBands();
}

// ---------- notifications ----------
async function setNotify(on) {
  if (on && 'Notification' in window && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { toast('Notifications were not allowed'); $('notifyTog').checked = false; return; }
  }
  state.settings.notify = on && 'Notification' in window; saveSettings();
}
function notify(ev) {
  if (!state.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const text = { reapply: 'Reapply sunscreen: the 2 hours are up.', sunscreen: 'Sunscreen on. Reminder in 2 hours.', inside: 'Extreme UV: go inside now.', error: 'The UV sensor needs checking.' }[ev];
  if (text) try { new Notification('Sunburn device', { body: text }); } catch (e) {}
}

// ---------- history ----------
function dayStats() {
  const days = {};
  for (const e of allEvents()) {
    const k = dayKey(e.t); const d = days[k] || (days[k] = { sunscreen: 0, reapply: 0, inside: 0, error: 0, standby: 0 });
    if (d[e.ev] !== undefined) d[e.ev]++;
  }
  return days;
}
function lastNDays(n) {
  const out = []; const now = new Date();
  for (let i = n - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); out.push(dayKey(d.getTime())); }
  return out;
}

// ---------- rendering ----------
function render() {
  renderLink(); renderUv(); renderDevice(); renderTimer(); renderMeasured(); renderHistory(); renderEvents(); renderStart(); renderAges();
  $('appVersion').textContent = `App ${APP_VERSION}`;
}
function renderLink() {
  const link = state.link; const waiting = state.linkStatus === 'wait';
  $('linkPill').classList.toggle('is-on', !!link && !waiting);
  $('linkPill').classList.toggle('is-wait', waiting);
  $('linkText').textContent = !link ? 'Not connected' : waiting ? `Reconnecting to ${link.name}` : `${link.kind}: ${link.name}${state.device.fw ? ` · firmware ${state.device.fw}` : ''}`;
  $('btnDisconnect').hidden = !link;
  $('btnReconnect').hidden = !!link || !state.lastBle; if (state.lastBle) $('btnReconnect').textContent = `Reconnect to ${state.lastBle.name}`;
  $('btnBle').hidden = !!link; $('btnSerial').hidden = !!link; $('btnDemo').hidden = !!link;
  for (const id of ['btnAck', 'btnRead', 'btnDemoTimings', 'btnPower', 'btnZero', 'btnPing', 'btnCmd', 'cmdInput', 'debugTog']) $(id).disabled = !link;
  $('btnCal').disabled = !link || !onlineIsFresh();
}
function renderUv() {
  const o = state.online;
  const num = $('uvNum'), band = $('uvBand');
  if (!o) {
    num.textContent = '–'; num.classList.add('empty');
    band.replaceChildren(el('span', { class: 'sw' }), el('span', {}, 'No data yet'));
    $('uvPlace').textContent = 'Use your location or search for a town to get the live UV index.';
    $('uvPeak').textContent = ''; $('uvProtect').textContent = ''; $('uvTrend').textContent = ''; $('uvSource').textContent = '';
    $('curveChart').replaceChildren(); $('weekChart').replaceChildren(); $('weekText').textContent = ''; sigs.curve = sigs.week = '';
    band.style.background = '';
  } else {
    const b = bandFor(o.uv);
    const text = o.uv.toFixed(1);
    if (num.textContent !== text) { num.textContent = text; settle(num); }
    num.classList.remove('empty');
    band.replaceChildren(el('span', { class: 'sw', style: `background:${b.color}` }), el('span', {}, b.name));
    band.style.background = `color-mix(in srgb, ${b.color} 14%, var(--surface-2))`;
    band.setAttribute('title', `WHO band: ${b.name}`);
    const stale = !onlineIsFresh();
    $('uvPlace').replaceChildren(el('b', {}, o.place), ` · updated ${ago(o.at)}`, stale ? ' · out of date, refresh it' : '');
    $('uvPlace').classList.toggle('muted', stale);
    if (o.peak >= 0) {
      const peakB = bandFor(o.peak);
      $('uvPeak').replaceChildren('Peak today ', el('b', {}, o.peak.toFixed(1)), ` (${peakB.name}) around ${o.peakAt.slice(11, 16)}`);
    } else $('uvPeak').textContent = '';
    const pt = protectionTimes(o.hourly || []);
    $('uvProtect').replaceChildren(pt ? el('b', {}, `Sun protection needed ${hh(pt.from)} to ${hh(pt.to)}`) : el('b', {}, 'No sun protection needed today'), pt ? ' (UV 3 or more)' : ' (UV stays below 3)');
    $('uvTrend').textContent = trendText(o);
    $('uvSource').textContent = 'Open-Meteo';
    renderCurve(o); renderWeek(o);
  }
  $('btnLocate').classList.toggle('primary', !state.settings.location);   // the first thing to do, until it is done
  $('autoSend').checked = !!state.settings.autoSend;
  $('sendEvery').value = String(state.settings.intervalMin);
  $('btnSendNow').disabled = !state.link || !onlineIsFresh();
  $('lastSent').textContent = state.lastSentAt ? `Last sent ${ago(state.lastSentAt)}` : (state.link ? 'Nothing sent yet' : '');
}
// What the device is doing right now: title, description, a line icon and a tone (alert / error / good). A change settles in.
function showState(title, desc, iconName, tone) {
  const box = $('devState');
  $('devStateT').textContent = title; $('devStateD').textContent = desc;
  if (changed('state', `${title}|${iconName}|${tone}`)) {
    box.querySelector('.icon').replaceChildren(icon(iconName));
    box.classList.remove('alert', 'error', 'good'); if (tone) box.classList.add(tone);
    settle(box);
  }
}
function renderDevice() {
  const s = state.device.status; const link = state.link;
  const stats = $('devStats');
  $('spfMeter').hidden = true;
  if (!link) {
    showState('Not connected', 'Connect the micro:bit to see what it is doing.', 'watch', '');
    stats.replaceChildren(); $('devAge').textContent = ''; return;
  }
  if (!s) {
    if (state.linkStatus === 'wait') showState('Reconnecting', 'The micro:bit went out of range or restarted. Bring it closer; this keeps trying for about two minutes.', 'radio', '');
    else showState('Waiting for the device', 'It sends its status every 2 seconds.', 'hourglass', '');
    stats.replaceChildren(); return;
  }
  const step = STEPS[s.st] || [s.st, '', 'clock', ''];
  showState(step[0], step[1], step[2], step[3]);
  const uv = parseFloat(s.uv), sen = parseFloat(s.sen), onl = parseFloat(s.onl), spf = parseInt(s.spf, 10);
  const b = isFinite(uv) ? bandFor(uv) : null;
  const tile = (l, v, sub) => el('div', { class: 'stat' }, el('div', { class: 'l' }, l), el('div', { class: 'v' }, v, sub ? el('small', {}, ' ' + sub) : null));
  stats.replaceChildren(
    tile('UV the device is using', isFinite(uv) ? uv.toFixed(1) : '–', b ? b.name : ''),
    tile('Its own sensor', isFinite(sen) ? sen.toFixed(1) : '–'),
    tile('From this app', onl >= 0 ? onl.toFixed(1) : 'none in the last 30 min'),
    tile('Sunscreen due in', spf >= 0 ? fmtCountdown(spf) : 'no timer', spf >= 0 ? `at ${fmtTime(Date.now() + spf * 1000)}` : ''),
    tile('Sunscreen applications', s.spfn || '0', 'since power-on'),
    tile('Timings', s.demo === '1' ? 'demo (fast)' : 'normal'),
  );
  $('btnDemoTimings').textContent = `Demo timings: ${s.demo === '1' ? 'on' : 'off'}`;
  $('btnPower').textContent = s.st === 'off' ? 'Turn on' : 'Turn off';
  if (spf >= 0) {   // how much of the 2 hours (1 minute in demo) is left
    const total = s.demo === '1' ? 60 : 7200;
    setMeter($('spfMeter'), $('spfFill'), 100 * spf / total, `${fmtCountdown(spf)} until sunscreen is due`);
  }
}
// A countdown bar: a progressbar with a spoken value, red under 10%
function setMeter(meter, fill, pct, text) {
  pct = Math.max(2, Math.min(100, pct));
  meter.hidden = false; meter.classList.toggle('low', pct < 10);
  meter.setAttribute('aria-valuenow', String(Math.round(pct))); meter.setAttribute('aria-valuetext', text);
  fill.style.width = `${pct}%`;
}
function renderStart() { $('startCard').hidden = !!state.settings.gotStarted; }
// The sunscreen timer card: the wearable's own timer while it is connected, otherwise this page's
function renderTimer() {
  const s = state.device.status; const spf = s ? parseInt(s.spf, 10) : -1; const now = Date.now();
  const num = $('timerNum'), band = $('timerBand'), meter = $('timerMeter'), fill = $('timerFill'), text = $('timerText'), btn = $('btnSunscreenNow'), stop = $('btnTimerStop');
  const setBand = (label, color) => band.replaceChildren(el('span', { class: 'sw', style: color ? `background:${color}` : '' }), el('span', {}, label));
  if (state.link && s && spf >= 0) {
    const total = s.demo === '1' ? 60 : 7200;
    num.textContent = fmtCountdown(spf); num.classList.remove('empty'); setBand('Wearable timer running', '#0ca30c'); $('timerSource').textContent = 'from the wearable';
    setMeter(meter, fill, 100 * spf / total, `${fmtCountdown(spf)} until sunscreen is due`);
    text.replaceChildren('Reapply at ', el('b', {}, fmtTime(now + spf * 1000)), '. Press A on the wearable when you have.');
    btn.hidden = true; stop.hidden = true; return;
  }
  $('timerSource').textContent = '';
  const t = state.appTimer;
  if (t && t.due > now) {
    num.textContent = fmtCountdown(Math.round((t.due - now) / 1000)); num.classList.remove('empty'); setBand('Sunscreen on', '#0ca30c');
    setMeter(meter, fill, 100 * (t.due - now) / (t.due - t.startedAt), `${fmtCountdown(Math.round((t.due - now) / 1000))} until sunscreen is due`);
    text.replaceChildren('Reapply at ', el('b', {}, fmtTime(t.due)), '.');
    btn.hidden = true; stop.hidden = false; stop.textContent = 'Stop the timer';
  } else if (t && t.due) {
    num.textContent = 'Now'; num.classList.remove('empty'); setBand('Reapply sunscreen', '#e53210'); meter.hidden = true;
    text.textContent = 'The 2 hours are up. Put sunscreen on again, then press the button.';
    btn.hidden = false; btn.textContent = 'Sunscreen on again'; stop.hidden = false; stop.textContent = 'Dismiss';
  } else {
    num.textContent = '–'; num.classList.add('empty'); setBand('No timer running', ''); meter.hidden = true;
    text.textContent = 'Put sunscreen on, press the button, and this page reminds you in 2 hours, with or without the wearable.';
    btn.hidden = false; btn.textContent = 'Sunscreen on now'; stop.hidden = true;
  }
}
const weekday = date => new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
const longDay = date => new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
// Peak UV for the next 7 days: one series, so no legend; labels on today and the highest, the rest in the tooltip and the text line
function renderWeek(o) {
  const c = $('weekChart');
  const days = (o.daily || []).slice(0, 7); if (!days.length) { c.replaceChildren(); $('weekText').textContent = ''; sigs.week = ''; return; }
  const W = Math.max(300, c.clientWidth || 600), H = 100, padL = 6, padR = 6, padT = 18, padB = 18; const plotW = W - padL - padR, plotH = H - padT - padB;
  if (!changed('week', `${o.at}|${W}`)) return;
  const animate = changed('weekData', o.at) && !reduced.matches;
  c.replaceChildren();
  const maxV = Math.max(11, ...days.map(d => d.max)); const slot = plotW / days.length, barW = Math.min(24, slot - 4);
  const y = v => padT + plotH - (v / maxV) * plotH;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Peak UV index for the next 7 days' });
  svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y(0), y2: y(0), class: 'base' }));
  const tip = attachTooltip(c); const maxI = days.map(d => d.max).indexOf(Math.max(...days.map(d => d.max)));
  days.forEach((d, i) => {
    const cx = padL + slot * i + slot / 2, x = cx - barW / 2, top = y(d.max), h = y(0) - top, r = Math.min(4, h);
    const name = i === 0 ? 'Today' : weekday(d.date);
    const g = svgEl('g');
    const hit = svgEl('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH, class: 'bar-hit', tabindex: '0', role: 'img', 'aria-label': `${name}: peak UV ${d.max.toFixed(1)}` });
    const bar = h > 0 ? svgEl('path', { class: 'bar', d: `M${x},${y(0)} V${top + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${y(0)} Z` }) : svgEl('rect', { class: 'bar', x, y: y(0) - 1, width: barW, height: 1, opacity: 0.35 });
    g.append(hit, bar);
    if (h > 0 && animate && bar.animate) bar.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 420, delay: i * 28, easing: EASE_OUT, fill: 'backwards' });
    if (i === 0 || i === maxI) g.append(svgEl('text', { x: cx, y: top - 4, 'text-anchor': 'middle', class: 'lab' }, d.max.toFixed(1)));
    svg.append(svgEl('text', { x: cx, y: H - 4, 'text-anchor': 'middle', class: 'tick' }, name));
    const show = () => { const sx = c.getBoundingClientRect().width / W; tip.show(cx * sx, top * sx, `Peak UV ${d.max.toFixed(1)} · ${bandFor(d.max).name}`, i === 0 ? 'Today' : longDay(d.date)); };
    hit.addEventListener('pointerenter', show); hit.addEventListener('focus', show); hit.addEventListener('pointerleave', tip.hide); hit.addEventListener('blur', tip.hide);
    svg.append(g);
  });
  c.append(svg);
  $('weekText').textContent = days.map((d, i) => `${i === 0 ? 'Today' : weekday(d.date)} ${d.max.toFixed(1)}`).join(' · ');
}
// The wearable's UV value through the day against the forecast curve: two series, so a legend, one crosshair tooltip with both
function renderMeasured() {
  const demo = state.link && state.link.kind === 'Demo';
  const pts = (demo ? state.demoSamples : state.samples)[dayKey(Date.now())] || [];
  const o = state.online; const c = $('measuredChart'), legend = $('measuredLegend');
  $('measuredSub').textContent = demo ? 'demo device' : pts.length ? `${pts.length} minute${pts.length === 1 ? '' : 's'} recorded` : '';
  $('measuredHint').hidden = pts.length > 0;
  if (!pts.length) { c.replaceChildren(); legend.replaceChildren(); sigs.measured = ''; return; }
  const forecast = o && o.hourly && o.hourly.length ? o.hourly : null;
  const W = Math.max(320, c.clientWidth || 600), H = 150, padL = 26, padR = 12, padT = 12, padB = 22; const plotW = W - padL - padR, plotH = H - padT - padB;
  if (!changed('measured', `${demo}|${pts.length}|${pts[pts.length - 1].m}|${forecast ? o.at : 0}|${W}`)) return;
  c.replaceChildren(); legend.replaceChildren();
  legend.append(el('span', {}, el('i', { class: 'ln', style: 'color:var(--brand)' }), 'Wearable'));
  if (forecast) legend.append(el('span', {}, el('i', { class: 'ln', style: 'color:var(--series-2)' }), 'Forecast for here'));
  const maxV = Math.max(11, Math.ceil(Math.max(...pts.map(p => p.uv), forecast ? o.peak : 0) + 1));
  const x = m => padL + (m / 1439) * plotW, y = v => padT + plotH - (v / maxV) * plotH;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'UV measured by the wearable today, with the forecast' });
  svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y(0), y2: y(0), class: 'base' }));
  for (const v of [3, 8, 11]) if (v <= maxV) { svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y(v), y2: y(v), class: 'grid-line' })); svg.append(svgEl('text', { x: padL - 5, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, v)); }
  for (const h of [0, 6, 12, 18]) svg.append(svgEl('text', { x: x(h * 60), y: H - 6, 'text-anchor': 'middle', class: 'tick' }, `${String(h).padStart(2, '0')}:00`));
  if (forecast) svg.append(svgEl('path', { class: 'line line2', d: forecast.map((h, i) => `${i ? 'L' : 'M'}${x(parseInt(h.t.slice(11, 13), 10) * 60).toFixed(1)},${y(h.uv).toFixed(1)}`).join(' ') }));
  svg.append(svgEl('path', { class: 'line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.m).toFixed(1)},${y(p.uv).toFixed(1)}`).join(' ') }));
  const last = pts[pts.length - 1]; svg.append(svgEl('circle', { cx: x(last.m), cy: y(last.uv), r: 5, class: 'marker' }));
  const xhair = svgEl('line', { class: 'xhair', y1: padT, y2: padT + plotH, x1: -10, x2: -10 }); svg.append(xhair);
  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' }); svg.append(hit);
  c.append(svg); const tip = attachTooltip(c);
  const mm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  hit.addEventListener('pointermove', ev => {
    const rect = svg.getBoundingClientRect(); const sx = rect.width / W;
    const m = Math.max(0, Math.min(1439, Math.round(((ev.clientX - rect.left) / sx - padL) / plotW * 1439)));
    let best = pts[0]; for (const p of pts) if (Math.abs(p.m - m) < Math.abs(best.m - m)) best = p;
    const fc = forecast ? forecast.find(h => parseInt(h.t.slice(11, 13), 10) === Math.floor(m / 60)) : null;
    xhair.setAttribute('x1', x(m)); xhair.setAttribute('x2', x(m));
    tip.show(x(m) * sx, y(best.uv) * sx, `Wearable ${best.uv.toFixed(1)}${fc ? ` · Forecast ${fc.uv.toFixed(1)}` : ''}`, `${mm(m)} (reading at ${mm(best.m)})`);
  });
  hit.addEventListener('pointerleave', () => { tip.hide(); xhair.setAttribute('x1', -10); xhair.setAttribute('x2', -10); });
}
function renderAges() {
  checkAppTimer(); renderTimer();
  if (state.online) { const stale = !onlineIsFresh(); $('uvPlace').replaceChildren(el('b', {}, state.online.place), ` · updated ${ago(state.online.at)}`, stale ? ' · out of date, refresh it' : ''); }
  $('lastSent').textContent = state.lastSentAt ? `Last sent ${ago(state.lastSentAt)}` : (state.link ? 'Nothing sent yet' : '');
  if (state.link && state.device.statusAt) {
    const age = Date.now() - state.device.statusAt;
    $('devAge').textContent = age > 8000 ? `no status for ${Math.round(age / 1000)} s` : `updated ${ago(state.device.statusAt)}`;
  }
}
const EVENTS_SHOWN = 12;
let eventsSeenT = Date.now();   // anything that arrives after the page opened is news
function renderEvents() {
  const list = $('eventList');
  const evs = allEvents().slice().sort((a, b) => b.t - a.t);
  if (changed('events', `${evs.length}|${evs.length ? evs[0].t : 0}|${state.showAllEvents}`)) {
    list.replaceChildren();
    const shown = state.showAllEvents ? evs : evs.slice(0, EVENTS_SHOWN);
    for (const e of shown) {
      const lab = EVENT_LABELS[e.ev] || [e.ev, ''];
      const when = dayKey(e.t) === dayKey(Date.now()) ? fmtTime(e.t) : new Date(e.t).toLocaleDateString([], { day: 'numeric', month: 'short' });
      list.append(el('li', { class: e.t > eventsSeenT ? 'new' : '' }, el('time', {}, when), el('div', {}, el('div', { class: 'e' }, lab[0], e.demo ? el('span', { class: 'tag' }, 'demo') : null), el('div', { class: 'm' }, e.msg || lab[1]))));
    }
    eventsSeenT = Date.now();   // whatever arrives after this paint is news
  }
  $('evHint').hidden = evs.length > 0;
  $('btnMoreEv').hidden = evs.length <= EVENTS_SHOWN || state.showAllEvents;
}

// ---------- charts ----------
function attachTooltip(container) {
  let tip = container.querySelector('.tooltip');
  if (!tip) { tip = el('div', { class: 'tooltip' }); container.append(tip); }
  return {
    show(x, y, strong, rest) {
      tip.replaceChildren(el('b', {}, strong), el('br'), rest);
      const half = tip.offsetWidth / 2, w = container.clientWidth;   // keep the tooltip inside the chart
      tip.style.left = Math.max(half, Math.min(w - half, x)) + 'px'; tip.style.top = y + 'px';
      tip.classList.add('on');
    },
    hide() { tip.classList.remove('on'); },
  };
}
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.round(sec)} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function renderBandTime() {
  const src = state.link && state.link.kind === 'Demo' ? state.demoBands : state.bands;
  const d = src[dayKey(Date.now())] || {};
  const order = [['low', 'Low', BANDS[0].color], ['modhigh', 'Moderate / high', BANDS[2].color], ['vhigh', 'Very high', BANDS[3].color], ['extreme', 'Extreme', BANDS[4].color]];
  const bar = $('bandBar'), legend = $('bandLegend'); bar.replaceChildren(); legend.replaceChildren();
  const total = order.reduce((a, [k]) => a + (d[k] || 0), 0);
  if (total < 20) { bar.hidden = true; legend.append(el('span', { class: 'muted' }, 'Nothing counted yet today.')); return; }
  bar.hidden = false;
  for (const [k, name, color] of order) {
    const sec = d[k] || 0;
    if (sec > 0) bar.append(el('span', { style: `flex:${sec};background:${color}`, title: `${name}: ${fmtDur(sec)}` }));
    legend.append(el('span', {}, el('i', { class: 'sw', style: `background:${color}` }), `${name} `, el('b', {}, fmtDur(sec))));
  }
}
// The segmented controls are one pill sliding between the options
function placeSegment(seg) {
  const ind = seg.querySelector('.ind'), on = seg.querySelector('[aria-pressed="true"]');
  if (!ind || !on) return;
  ind.style.setProperty('--x', on.offsetLeft + 'px'); ind.style.setProperty('--w', on.offsetWidth + 'px');
  if (!seg.classList.contains('ready')) requestAnimationFrame(() => seg.classList.add('ready'));   // no slide on the first paint
}
function renderHistory() {
  const n = state.settings.rangeDays || 14;
  for (const b of $('rangeSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(parseInt(b.dataset.days, 10) === n));
  placeSegment($('rangeSeg'));
  $('histRange').textContent = `· last ${n} days · from the device's events while connected`;
  renderBandTime();
  const days = dayStats(); const keys = lastNDays(n); const today = keys[keys.length - 1];
  const t = days[today] || { sunscreen: 0, reapply: 0, inside: 0, error: 0 };
  const tile = (l, v) => el('div', { class: 'stat' }, el('div', { class: 'l' }, l), el('div', { class: 'v' }, String(v)));
  const month = Object.entries(days).filter(([k]) => k.slice(0, 7) === today.slice(0, 7)).reduce((a, [, d]) => a + d.sunscreen, 0);
  $('todayStats').replaceChildren(tile('Sunscreen today', t.sunscreen), tile('Reapply reminders today', t.reapply), tile('Went inside today', t.inside), tile('Sunscreen this month', month));

  // bar chart: one series, so no legend; <= 24px bars, rounded data end, 2px surface gap, hairline grid, tooltip + table twin
  const W = Math.max(320, $('histChart').clientWidth || 700), H = 200, padL = 28, padR = 8, padT = 14, padB = 26;   // 1 unit = 1 px, so text stays readable
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const values = keys.map(k => (days[k] ? days[k].sunscreen : 0));
  const maxV = Math.max(3, ...values);
  if (changed('hist', `${n}|${W}|${values.join(',')}`)) {
  const animate = changed('histData', `${n}|${values.join(',')}`) && !reduced.matches;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Sunscreen applications per day, last ${n} days` });
  const y = v => padT + plotH - (v / maxV) * plotH;
  const ticks = maxV <= 5 ? [...Array(maxV + 1).keys()] : [0, Math.round(maxV / 2), maxV];
  for (const tv of ticks) {
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y(tv), y2: y(tv), class: tv === 0 ? 'base' : 'grid-line' }));
    svg.append(svgEl('text', { x: padL - 6, y: y(tv) + 4, 'text-anchor': 'end', class: 'tick' }, tv));
  }
  const slot = plotW / keys.length, barW = Math.min(24, slot - 2);
  const container = $('histChart'); container.replaceChildren(svg);
  const tip = attachTooltip(container);
  const maxIdx = values.indexOf(Math.max(...values));
  keys.forEach((k, i) => {
    const v = values[i], cx = padL + slot * i + slot / 2, x = cx - barW / 2, top = y(v), h = padT + plotH - top;
    const label = `${v} application${v === 1 ? '' : 's'}`;
    const g = svgEl('g');
    const hit = svgEl('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH, class: 'bar-hit', tabindex: '0', role: 'img', 'aria-label': `${fmtDay(k)}: ${label}` });
    let bar;
    if (v > 0) {
      const r = Math.min(4, h);
      bar = svgEl('path', { class: 'bar', d: `M${x},${padT + plotH} V${top + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${padT + plotH} Z` });
    } else bar = svgEl('rect', { class: 'bar', x, y: padT + plotH - 1, width: barW, height: 1, opacity: 0.35 });
    g.append(hit, bar);
    if (v > 0 && (i === maxIdx || k === today)) g.append(svgEl('text', { x: cx, y: top - 5, 'text-anchor': 'middle', class: 'lab' }, v));
    const d = new Date(k + 'T00:00:00');
    const every = slot >= 52 ? 1 : slot >= 26 ? 2 : 4;
    if ((keys.length - 1 - i) % every === 0) svg.append(svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, d.toLocaleDateString([], { day: 'numeric', month: 'short' })));
    const showTip = () => { const rect = container.getBoundingClientRect(); const sx = rect.width / W; tip.show(cx * sx, top * sx, label, fmtDay(k)); };
    hit.addEventListener('pointerenter', showTip); hit.addEventListener('focus', showTip);
    hit.addEventListener('pointerleave', tip.hide); hit.addEventListener('blur', tip.hide);
    svg.append(g);
    // the bars grow out of the baseline, left to right, the first time and whenever the numbers change
    if (v > 0 && animate && bar.animate) bar.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 420, delay: i * 28, easing: EASE_OUT, fill: 'backwards' });
  });
  if (animate) for (const t of svg.querySelectorAll('.lab')) t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 320, fill: 'backwards' });
  }
  // table twin
  const tbl = $('histTable'); tbl.replaceChildren();
  const table = el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, el('th', {}, 'Day'), el('th', { class: 'n' }, 'Sunscreen'), el('th', { class: 'n' }, 'Reapply reminders'), el('th', { class: 'n' }, 'Went inside'), el('th', { class: 'n' }, 'Sensor problems'))));
  const body = el('tbody');
  for (const k of keys.slice().reverse()) { const d = days[k] || { sunscreen: 0, reapply: 0, inside: 0, error: 0 }; body.append(el('tr', {}, el('td', {}, fmtDay(k)), el('td', { class: 'n' }, d.sunscreen), el('td', { class: 'n' }, d.reapply), el('td', { class: 'n' }, d.inside), el('td', { class: 'n' }, d.error))); }
  table.append(body); tbl.append(table); tbl.hidden = !state.showTable;
  $('btnTable').textContent = state.showTable ? 'Hide table' : 'Show table';
}
function renderCurve(o) {
  // today's UV by hour: one line, area wash, marker on the current hour, band thresholds as hairlines, crosshair tooltip
  const W = Math.max(320, $('curveChart').clientWidth || 700), H = 150, padL = 26, padR = 64, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const pts = o.hourly.map(h => ({ hour: parseInt(h.t.slice(11, 13), 10), uv: h.uv }));
  if (!pts.length) { $('curveChart').replaceChildren(); sigs.curve = ''; return; }
  if (!changed('curve', `${o.at}|${W}`)) return;   // same data at the same width: leave the chart (and any tooltip) alone
  const animate = changed('curveData', o.at) && !reduced.matches;   // draws itself in once per forecast, not again on a resize
  const maxV = Math.max(11, Math.ceil(o.peak + 1));
  const x = h => padL + (h / 23) * plotW, y = v => padT + plotH - (v / maxV) * plotH;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Today's UV index by hour, peak ${o.peak.toFixed(1)} around ${o.peakAt.slice(11, 16)}` });
  svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y(0), y2: y(0), class: 'base' }));
  for (const [v, name] of [[3, 'Moderate'], [8, 'Very high'], [11, 'Extreme']]) {
    if (v > maxV) continue;
    svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y(v), y2: y(v), class: 'grid-line' }));
    svg.append(svgEl('text', { x: padL + plotW + 6, y: y(v) + 4, class: 'tick' }, `${v} ${name}`));
  }
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.hour).toFixed(1)},${y(p.uv).toFixed(1)}`).join(' ');
  const area = svgEl('path', { class: 'area', d: `${path} L${x(pts[pts.length - 1].hour)},${y(0)} L${x(pts[0].hour)},${y(0)} Z` });
  const line = svgEl('path', { class: 'line', d: path });
  svg.append(area, line);
  for (const h of [0, 6, 12, 18]) svg.append(svgEl('text', { x: x(h), y: H - 6, 'text-anchor': 'middle', class: 'tick' }, `${String(h).padStart(2, '0')}:00`));
  const nowHour = o.currentTime ? parseInt(o.currentTime.slice(11, 13), 10) : new Date().getHours();
  const cur = pts.find(p => p.hour === nowHour);
  const marker = cur ? svgEl('circle', { cx: x(cur.hour), cy: y(cur.uv), r: 5, class: 'marker' }) : null;
  if (marker) svg.append(marker);
  const xhair = svgEl('line', { class: 'xhair', y1: padT, y2: padT + plotH, x1: -10, x2: -10 });
  svg.append(xhair);
  const container = $('curveChart'); container.replaceChildren(svg);
  // the day's curve draws itself from dawn to dusk, then the wash and the "now" marker arrive
  if (animate && line.animate) {
    const len = line.getTotalLength();
    line.style.strokeDasharray = `${len}`;
    line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 700, easing: EASE_OUT }).finished.then(() => { line.style.strokeDasharray = ''; }).catch(() => {});
    area.animate([{ opacity: 0 }, { opacity: 0.10 }], { duration: 500, delay: 250, fill: 'backwards' });
    if (marker) marker.animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 320, delay: 550, easing: EASE_OUT, fill: 'backwards' });
  }
  const tip = attachTooltip(container);
  const hitArea = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  svg.append(hitArea);
  hitArea.addEventListener('pointermove', ev => {
    const rect = svg.getBoundingClientRect(); const sx = rect.width / W;
    const hour = Math.max(0, Math.min(23, Math.round(((ev.clientX - rect.left) / sx - padL) / plotW * 23)));
    const p = pts.find(q => q.hour === hour); if (!p) return;
    xhair.setAttribute('x1', x(hour)); xhair.setAttribute('x2', x(hour));
    tip.show(x(hour) * sx, y(p.uv) * sx, `UV ${p.uv.toFixed(1)} · ${bandFor(p.uv).name}`, `${String(hour).padStart(2, '0')}:00`);
  });
  hitArea.addEventListener('pointerleave', () => { tip.hide(); xhair.setAttribute('x1', -10); xhair.setAttribute('x2', -10); });
}

// ---------- CSV export ----------
function exportCsv() {
  const rows = [['time', 'event', 'note'], ...state.events.map(e => [new Date(e.t).toISOString(), e.ev, e.msg || ''])];   // stored events only, never demo ones
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `sunburn-events-${dayKey(Date.now())}.csv` });
  document.body.append(a); a.click(); a.remove();
}

// ---------- wiring up ----------
function init() {
  if (!window.isSecureContext) $('secureHint').hidden = false;
  const hints = [];
  if (!navigator.bluetooth) { $('btnBle').disabled = true; hints.push('Web Bluetooth is not available in this browser: use Chrome or Edge (Bluefy on iPhone).'); }
  if (!navigator.serial) { $('btnSerial').disabled = true; hints.push('USB needs Chrome or Edge on a computer.'); }
  if (hints.length) { $('supportHint').textContent = hints.join(' '); $('supportHint').hidden = false; }

  $('btnBle').addEventListener('click', () => connectWith(new BleLink()));
  $('btnSerial').addEventListener('click', () => connectWith(new SerialLink()));
  $('btnDemo').addEventListener('click', () => connectWith(new DemoLink()));
  $('btnDisconnect').addEventListener('click', disconnect);
  $('btnLocate').addEventListener('click', useMyLocation);
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); searchPlace(); });
  $('btnRefresh').addEventListener('click', refreshUv);
  $('autoSend').addEventListener('change', e => { state.settings.autoSend = e.target.checked; saveSettings(); if (e.target.checked) autoTick(); });
  $('sendEvery').addEventListener('change', e => { state.settings.intervalMin = parseInt(e.target.value, 10); saveSettings(); });
  $('btnSendNow').addEventListener('click', () => sendUvIfFresh('manual'));
  $('btnAck').addEventListener('click', () => send('ack'));
  $('btnRead').addEventListener('click', () => send('read'));
  $('btnDemoTimings').addEventListener('click', () => { const s = state.device.status; send(`demo=${s && s.demo === '1' ? 0 : 1}`); });
  $('btnPower').addEventListener('click', () => { const s = state.device.status; send(`power=${s && s.st === 'off' ? 1 : 0}`); });
  $('btnZero').addEventListener('click', () => { if (confirm('Cover the sensor completely (dark), then press OK.')) send('zero'); });
  $('btnCal').addEventListener('click', () => { if (state.online && confirm(`Hold the sensor in full sun, then press OK to set its scale so it reads ${state.online.uv.toFixed(1)} (the live UV index here).`)) send(`cal=${state.online.uv.toFixed(1)}`); });
  $('btnPing').addEventListener('click', () => send('ping'));
  $('debugTog').addEventListener('change', e => send(`debug=${e.target.checked ? 1 : 0}`));
  $('notifyTog').addEventListener('change', e => setNotify(e.target.checked));
  $('notifyTog').checked = !!state.settings.notify && 'Notification' in window && Notification.permission === 'granted';
  $('btnCmd').addEventListener('click', () => { const v = $('cmdInput').value.trim(); if (v) { send(v); $('cmdInput').value = ''; } });
  $('cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnCmd').click(); });
  $('btnTable').addEventListener('click', () => { state.showTable = !state.showTable; renderHistory(); });
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnClear').addEventListener('click', () => { if (confirm('Delete all stored events and history on this browser?')) { state.events = []; state.demoEvents = []; state.bands = {}; state.demoBands = {}; state.samples = {}; state.demoSamples = {}; state.appTimer = null; store.save('sunburn.events', []); store.save('sunburn.bands', {}); store.save('sunburn.samples', {}); store.save('sunburn.appTimer', null); render(); } });
  $('btnMoreEv').addEventListener('click', () => { state.showAllEvents = true; renderEvents(); });
  for (const b of $('rangeSeg').querySelectorAll('button')) b.addEventListener('click', () => { state.settings.rangeDays = parseInt(b.dataset.days, 10); saveSettings(); renderHistory(); });
  $('awakeTog').checked = !!state.settings.keepAwake;
  if (!('wakeLock' in navigator)) { $('awakeTog').disabled = true; $('awakeTog').parentElement.title = 'Not available in this browser'; }
  $('awakeTog').addEventListener('change', e => { state.settings.keepAwake = e.target.checked; saveSettings(); updateWakeLock(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoTick(); updateWakeLock(); saveBands(); });
  window.addEventListener('pagehide', saveBands);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  for (const b of $('themeSeg').querySelectorAll('button')) b.addEventListener('click', () => { state.settings.theme = b.dataset.theme; saveSettings(); applyTheme(); });
  applyTheme();
  $('btnHideStart').addEventListener('click', () => { state.settings.gotStarted = true; saveSettings(); renderStart(); });
  $('btnShowStart').addEventListener('click', () => { state.settings.gotStarted = false; saveSettings(); renderStart(); $('startCard').scrollIntoView({ behavior: 'smooth' }); });
  $('btnSunscreenNow').addEventListener('click', startAppTimer);
  $('btnTimerStop').addEventListener('click', stopAppTimer);
  $('btnReconnect').addEventListener('click', reconnectLast);
  window.addEventListener('error', e => { pushConsole('!! ' + e.message); toast('Something went wrong on this page: ' + e.message); });
  window.addEventListener('unhandledrejection', e => { const m = e.reason && e.reason.message ? e.reason.message : String(e.reason); pushConsole('!! ' + m); });

  render();
  if (state.settings.location && (!state.online || !onlineIsFresh())) refreshUv();
  setInterval(autoTick, 15000);
  setInterval(renderAges, 1000);
  window.addEventListener('resize', () => { document.querySelectorAll('.tooltip').forEach(t => t.classList.remove('on')); renderHistory(); renderMeasured(); if (state.online) { renderCurve(state.online); renderWeek(state.online); } placeSegment($('rangeSeg')); placeSegment($('themeSeg')); });
}
init();
