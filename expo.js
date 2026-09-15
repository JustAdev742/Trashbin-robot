'use strict';
/* ===================================================================
   Expo mode: the page runs itself. It tours every card, drives the
   wearable (real or demo) through the whole flowchart in show mode,
   and shows the flowchart, the wiring and the code between the cards.
   Start it with the "Expo mode" button or by opening the page with
   ?expo on the end. Esc or Exit stops it. Touching the page pauses it.
   =================================================================== */
const expo = {
  on: false, step: -1, timer: null, pausedUntil: 0, tickTimer: null, hadLink: false,
  // what the device is doing, for the live caption on the wearable step
  states: {
    on: 'Switching on: a tick on the lights, then the flowchart starts.',
    reading: 'Reading the UV sensor: 15 quick readings, the middle one counts.',
    safe: 'UV 0 to 2: happy face. No sunscreen needed.',
    alert: 'Alert! It flashes and beeps (or taps the arm) until A is pressed. In show mode it presses A itself after 6 seconds.',
    protected: 'Sunscreen is on: a tick, and the 2 hour timer runs (1 minute in demo timings).',
    wait: 'Waiting 5 minutes before the next check (10 seconds in demo timings).',
    standby: 'Nobody answered, so it sleeps until a button is pressed.',
    error: 'CHECK SENSOR: the reading makes no sense, so it retries every 5 seconds and never pretends to be safe.',
    off: 'Off. A and B together turn it on again.',
  },
  steps: [
    { kind: 'slide', secs: 9, title: 'The Sunburn device', text: 'A wearable on a BBC micro:bit. It measures the sun\'s UV, checks the online UV index for where you are through a phone, and flashes, beeps or taps your arm until you put sunscreen on. Two hours later it reminds you to reapply.', big: true },
    { kind: 'spot', secs: 11, card: 'hUv', title: 'Live UV for where you are', text: 'The phone asks Open-Meteo for the UV index here, right now, plus today\'s curve, the sun protection times and the next 7 days. It sends the number to the wearable every 10 minutes.' },
    { kind: 'slide', secs: 11, title: 'The flowchart the wearable follows', text: 'Read the sensor. Check the reading makes sense. Ask the phone. Decide how strong the sun is. Then a happy face, or an alert until A is pressed. Wait 5 minutes and go round again.', image: 'docs/sunburn-flowchart.png' },
    { kind: 'spot', secs: 40, card: 'hDev', title: 'On the wrist, live', live: true },
    { kind: 'spot', secs: 9, card: 'hTimer', title: 'The sunscreen timer', text: 'Two hours after sunscreen goes on, the wearable and this page both say: time to reapply. The page can run the timer on its own too.' },
    { kind: 'spot', secs: 9, card: 'hMeasured', title: 'What the wearable measured today', text: 'One reading a minute from the wearable, drawn against the forecast for here.' },
    { kind: 'spot', secs: 10, card: 'hHist', title: 'Sunscreen history', text: 'How much time in the sun today by UV level, and sunscreen applications per day. Everything is kept on this phone only.' },
    { kind: 'spot', secs: 8, card: 'hEv', title: 'Every event, as it happens', text: 'Sunscreen applied, reminders, going inside, sleeping, sensor problems: the wearable reports each one.' },
    { kind: 'slide', secs: 10, title: 'How it is wired', text: 'A UV sensor on P1, a small motor on P2 to tap the wrist, the micro:bit\'s own speaker, and an optional screen. Three wires each.', image: 'docs/wiring.png' },
    { kind: 'slide', secs: 12, title: 'The code: 78 blocks, 9 sections', text: 'The whole program is built from coloured blocks in MakeCode. This is the flowchart built from the real blocks; every block is on the poster and in the booklet.', image: 'docs/poster/wall-poster.png' },
    { kind: 'slide', secs: 8, title: 'Ask us anything', text: 'Try the buttons, connect your own micro:bit, or take the address home: joviangame.me/Trashbin-robot', big: true },
  ],
};

function expoEl() {
  let el = $('expo');
  if (el) return el;
  el = document.createElement('div'); el.id = 'expo'; el.hidden = true;
  el.innerHTML = `
    <div class="expo-slide" id="expoSlide" hidden><div class="expo-slide-in"><h2 id="expoSlideTitle"></h2><img id="expoSlideImg" alt="" hidden><p id="expoSlideText"></p></div></div>
    <div class="expo-bar" role="status" aria-live="polite">
      <div class="expo-cap"><b id="expoTitle"></b><span id="expoText"></span></div>
      <div class="expo-ctl">
        <span class="expo-dots" id="expoDots"></span>
        <button class="btn small" id="expoPrev" aria-label="Previous">‹</button>
        <button class="btn small" id="expoPause" aria-label="Pause">Pause</button>
        <button class="btn small" id="expoNext" aria-label="Next">›</button>
        <button class="btn small ghost" id="expoExit">Exit</button>
      </div>
    </div>`;
  document.body.append(el);
  $('expoNext').addEventListener('click', e => { e.stopPropagation(); expoGo(expo.step + 1); });
  $('expoPrev').addEventListener('click', e => { e.stopPropagation(); expoGo(expo.step - 1); });
  $('expoPause').addEventListener('click', e => { e.stopPropagation(); expoPause(expo.pausedUntil ? 0 : Infinity); });
  $('expoExit').addEventListener('click', e => { e.stopPropagation(); expoStop(); });
  return el;
}

async function expoStart() {
  if (expo.on) return;
  expo.on = true; expo.hadLink = !!state.link;
  document.body.classList.add('expo');
  expoEl().hidden = false;
  if (!location.search.includes('expo')) history.replaceState(null, '', location.pathname + '?expo');
  // a wearable to show: the real one in show mode, or the demo device
  if (!state.link) await connectWith(new DemoLink());
  if (state.link) send('demo=2');
  // live UV: the saved place, or Sydney so the cards are not empty
  if (!state.online) updateUv(-33.87, 151.21, 'Sydney, New South Wales');
  document.addEventListener('keydown', expoKeys);
  document.addEventListener('pointerdown', expoTouched, true);
  expo.tickTimer = setInterval(expoTick, 500);
  expoGo(0);
}
function expoStop() {
  if (!expo.on) return;
  expo.on = false; clearTimeout(expo.timer); clearInterval(expo.tickTimer); expo.pausedUntil = 0;
  document.body.classList.remove('expo');
  for (const c of document.querySelectorAll('.card.spot')) c.classList.remove('spot');
  expoEl().hidden = true; $('expoSlide').hidden = true;
  document.removeEventListener('keydown', expoKeys);
  document.removeEventListener('pointerdown', expoTouched, true);
  if (location.search.includes('expo')) history.replaceState(null, '', location.pathname);
  if (state.link) { send('demo=0'); if (!expo.hadLink && state.link.kind === 'Demo') disconnect(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function expoKeys(e) {
  if (e.key === 'Escape') expoStop();
  else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); expoGo(expo.step + 1); }
  else if (e.key === 'ArrowLeft') expoGo(expo.step - 1);
}
// a visitor touched the page: hold the tour for a while so they can look and press things
function expoTouched(e) {
  if (e.target.closest('#expo')) return;
  expoPause(Date.now() + 45000);
}
function expoPause(until) {
  expo.pausedUntil = until;
  clearTimeout(expo.timer);
  $('expoPause').textContent = until ? 'Play' : 'Pause';
  if (!until) expoArm();
}
function expoArm() {
  clearTimeout(expo.timer);
  const s = expo.steps[expo.step];
  expo.timer = setTimeout(() => expoGo(expo.step + 1), s.secs * 1000);
}
function expoGo(i) {
  if (!expo.on) return;
  const n = expo.steps.length; expo.step = ((i % n) + n) % n;
  const s = expo.steps[expo.step];
  for (const c of document.querySelectorAll('.card.spot')) c.classList.remove('spot');
  const slide = $('expoSlide');
  if (s.kind === 'slide') {
    slide.hidden = false; slide.classList.toggle('big', !!s.big);
    $('expoSlideTitle').textContent = s.title; $('expoSlideText').textContent = s.text;
    const img = $('expoSlideImg'); if (s.image) { img.src = s.image; img.alt = s.title; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  } else {
    slide.hidden = true;
    const card = $(s.card).closest('.card'); card.classList.add('spot');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  $('expoTitle').textContent = s.title;
  $('expoText').textContent = s.live ? expoLiveText() : s.text;
  $('expoDots').replaceChildren(...expo.steps.map((_, k) => el('i', { class: k === expo.step ? 'on' : '' })));
  if (!expo.pausedUntil) expoArm();
}
function expoLiveText() {
  const st = state.device.status;
  if (!state.link) return 'Connecting a wearable…';
  if (!st) return 'Waiting for the wearable to report…';
  return (expo.states[st.st] || '') + (st.st === 'alert' || st.st === 'protected' ? '' : '') ;
}
function expoTick() {
  if (!expo.on) return;
  // resume after a touch pause
  if (expo.pausedUntil && expo.pausedUntil !== Infinity && Date.now() >= expo.pausedUntil) expoPause(0);
  const s = expo.steps[expo.step];
  if (s && s.live) $('expoText').textContent = expoLiveText();
  if (expo.pausedUntil && expo.pausedUntil !== Infinity) $('expoPause').textContent = `Resumes in ${Math.ceil((expo.pausedUntil - Date.now()) / 1000)} s`;
}
window.addEventListener('load', () => {
  $('btnExpo').addEventListener('click', expoStart);
  if (/[?&]expo/.test(location.search)) setTimeout(expoStart, 600);
});
