// Louis's walk: the game on Loui's error page. Louis, the husky from the app
// icon, wanders the lawn and now and then leaves something behind; the player
// picks it up. Too many on the lawn ends the round.
//
// src/main/errorpage.js puts this together with errorpage.js into one script,
// so it shares that scope: it defines createLouis and nothing global. Plain
// DOM and inline SVG, no network and no storage (the best score is handed in
// and reported back out).

// Louis, side on, facing right. Diagonal legs (a, b) swing together.
const LOUIS_FUR = '#1E2029';
const LOUIS_CREAM = '#F7F3EC';
function louisLeg(x, hip, cls, fur, cream) {
  const len = 95.5 - hip;
  return `<g class="leg ${cls}" style="transform-origin:${x}px ${hip}px">` +
    `<rect x="${x - 5}" y="${hip - 4}" width="10" height="${len}" rx="5" fill="${fur}"/>` +
    `<rect x="${x - 5}" y="${hip + len - 18}" width="10" height="14" rx="5" fill="${cream}"/>` +
    `<ellipse cx="${x + 2}" cy="${hip + len - 4}" rx="6.5" ry="3.5" fill="${cream}"/></g>`;
}
const LOUIS_SVG = `<svg viewBox="0 0 144 100" aria-hidden="true">
  <ellipse class="shadow" cx="74" cy="95" rx="46" ry="4"/>
  <g class="flip">
    <g class="body">
      ${louisLeg(96, 62, 'front a far', '#3A3E4C', '#D8D1C3')}
      <g class="rear" style="transform-origin:94px 54px">
        <g class="tail" style="transform-origin:36px 44px">
          <path d="M37,45 C24,41 18,29 24,20 C29,13 40,15 38,23" fill="none" stroke="${LOUIS_FUR}" stroke-width="11" stroke-linecap="round"/>
          <path d="M28,15.5 C34,13.5 39,17 38,23" fill="none" stroke="${LOUIS_CREAM}" stroke-width="5" stroke-linecap="round"/>
        </g>
        ${louisLeg(50, 62, 'back b far', '#3A3E4C', '#D8D1C3')}
        <path d="M30,48 C30,36 42,31 58,31 L90,31 C100,31 106,40 104,52 C102,64 94,69 84,69 L46,69 C36,69 30,60 30,48 Z" fill="${LOUIS_FUR}"/>
        <path d="M42,68 C48,61 80,60 92,64 C90,68 87,69 84,69 L46,69 C44,69 43,69 42,68 Z" fill="${LOUIS_CREAM}"/>
        <path d="M31,52 C32,61 37,67 45,69 C40,63 37,57 31,52 Z" fill="${LOUIS_CREAM}"/>
        ${louisLeg(44, 64, 'back a', LOUIS_FUR, LOUIS_CREAM)}
      </g>
      <path d="M94,36 C104,40 106,54 100,66 L92,66 C98,56 98,46 94,36 Z" fill="${LOUIS_CREAM}"/>
      ${louisLeg(90, 64, 'front b', LOUIS_FUR, LOUIS_CREAM)}
      <path d="M88,34 Q97,44 108,42 L106,49 Q95,51 86,41 Z" fill="#D62830"/>
      <path d="M92,44 L107,46 L97,58 Z" fill="#D62830" stroke="#D62830" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="88" cy="37.5" r="3.5" fill="#B01E26"/>
      <g class="head" style="transform-origin:100px 40px">
        <path d="M100,24 L102,5 L113,19 Z" fill="${LOUIS_FUR}" stroke="${LOUIS_FUR}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M96,32 C95,20 104,15 115,16 C125,17 130,23 130,30 L137,33 C142,35 142,42 136,44 L120,47 C108,49 97,44 96,32 Z" fill="${LOUIS_FUR}"/>
        <path d="M108,20 L115,2 L123,19 Z" fill="${LOUIS_FUR}" stroke="${LOUIS_FUR}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M111.5,17 L115,8.5 L119,17 Z" fill="${LOUIS_CREAM}"/>
        <path d="M103,34 C104,29 110,27 116,29 C121,31 124,33 130,34 L136,36 C140,38 139,43 135,44 L120,47 C110,48 103,42 103,34 Z" fill="${LOUIS_CREAM}"/>
        <ellipse cx="117" cy="24" rx="2.6" ry="1.8" fill="${LOUIS_CREAM}"/>
        <g class="eye"><circle cx="117" cy="30.5" r="2.7" fill="${LOUIS_FUR}"/><circle cx="118" cy="29.6" r="0.9" fill="#fff"/></g>
        <path class="closed" d="M114.5,30.5 Q117,33 119.5,30.5" fill="none" stroke="${LOUIS_FUR}" stroke-width="1.6" stroke-linecap="round"/>
        <ellipse class="nose" cx="138" cy="37.5" rx="3.2" ry="2.6" fill="${LOUIS_FUR}"/>
        <path class="tongue" d="M127,44.5 Q127,51 131,50.5 Q134,49.5 132,44.5 Z" fill="#E46F82"/>
        <path d="M136,43 Q130,46 124,44" fill="none" stroke="${LOUIS_FUR}" stroke-width="1.4" stroke-linecap="round"/>
      </g>
    </g>
  </g>
</svg>`;

const POOP_SVG = `<svg viewBox="0 0 40 36" aria-hidden="true">
  <ellipse cx="20" cy="33" rx="15" ry="2.5" fill="rgba(0,0,0,0.15)"/>
  <path class="stink" d="M13,8 q-2.5,-2 0,-4 q2.5,-2 0,-4" fill="none" stroke="#9BAA8C" stroke-width="1.6" stroke-linecap="round"/>
  <path class="stink" d="M28,9 q-2.5,-2 0,-4 q2.5,-2 0,-4" fill="none" stroke="#9BAA8C" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M7,32 C2,32 2,25 8,24 L32,24 C38,25 38,32 33,32 Z" fill="#7A4A2A"/>
  <path d="M10,25 C6,25 7,18 12,17.5 L28,17.5 C33,18 34,25 30,25 Z" fill="#8E5B34"/>
  <path d="M14,18.5 C11,18.5 12,12 17,11.5 C18,6 23,4.5 24,8.5 C27,10 28,18 25,18.5 Z" fill="#A36A3E"/>
  <ellipse cx="14" cy="21" rx="3" ry="1.1" fill="#fff" opacity="0.35"/>
  <ellipse cx="11" cy="28" rx="3.5" ry="1.2" fill="#fff" opacity="0.3"/>
</svg>`;

const BAG_SVG = `<svg viewBox="0 0 34 38" width="34" height="38" aria-hidden="true">
  <path d="M14,9 L10,2 M20,9 L24,2" stroke="#2F6FA0" stroke-width="3" stroke-linecap="round"/>
  <path d="M12,8 L22,8 L20,13 L14,13 Z" fill="#2F6FA0"/>
  <path d="M14,12 C4,14 3,34 10,36 L24,36 C31,34 30,14 20,12 Z" fill="#3E86BE"/>
  <path d="M11,19 C9,25 9,30 11,33" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const SPARK_SVG = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5,0 L6,4 L10,5 L6,6 L5,10 L4,6 L0,5 L4,4 Z" fill="#F2C14E"/></svg>';

const LAWN_LIMIT = 7; // this many on the lawn ends the round
const LOUIS_W = 172, LOUIS_H = 120; // his box in the yard, as in errorpage.css
const ENDINGS = [
  'Louis has claimed the lawn.',
  'Louis regrets nothing.',
  'The lawn has lost. Louis has not.',
  'Louis would like to thank the little bags.',
  'That is the whole lawn, then.',
  'Louis says it was like that when he got here.',
];
const CHEERS = { 10: 'Good human!', 25: 'Best human ever!', 50: 'Okay, show-off.', 100: 'Is this your job now?' };

// section: the game's <section>. best: the best score so far.
// onBest(n): a round ended with a new best score.
function createLouis(section, { best, onBest }) {
  const $ = (id) => document.getElementById(id);
  const yard = $('yard'), card = $('card');
  const scoreEl = $('score'), bestEl = $('best'), floorEl = $('floor'), dotsEl = $('dots');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motion.matches;

  const louis = document.createElement('div');
  louis.className = 'louis idle';
  louis.setAttribute('aria-label', 'Louis');
  louis.innerHTML = LOUIS_SVG + '<div class="bubble" hidden></div>';
  yard.append(louis);
  const bubble = louis.querySelector('.bubble');
  dotsEl.innerHTML = '<i></i>'.repeat(LAWN_LIMIT);

  let mode = 'idle'; // idle (Louis wanders, waiting for a player), play, over
  let score = 0, dropped = 0, played = false, t = 0, nextPoop = Infinity;
  let poops = [];
  let size = { w: 0, h: 0 };
  // act: what Louis is doing until `until` (game seconds); trot and zoom head for (tx, ty).
  const dog = { x: 0, y: 0, dir: 1, act: 'stand', until: 0, tx: 0, ty: 0, dropAt: Infinity, asked: false };

  const rand = (a, b) => a + Math.random() * (b - a);
  const lawn = () => ({ top: size.h * 0.36, bottom: size.h - 10, left: LOUIS_W / 2, right: size.w - LOUIS_W / 2 });
  // Further back is smaller, so the lawn reads as ground seen from above.
  const depth = (y) => { const l = lawn(); return 0.74 + 0.3 * Math.min(1, Math.max(0, (y - l.top) / (l.bottom - l.top))); };

  function measure() {
    const r = yard.getBoundingClientRect();
    const first = !size.w;
    size = { w: r.width, h: r.height };
    const l = lawn();
    if (first || reduced) Object.assign(dog, { x: size.w * 0.5, y: l.top + (l.bottom - l.top) * 0.85 });
    dog.x = Math.min(l.right, Math.max(l.left, dog.x));
    dog.y = Math.min(l.bottom, Math.max(l.top, dog.y));
    draw();
  }
  new ResizeObserver(measure).observe(yard);

  function draw() {
    const s = depth(dog.y);
    louis.style.transform = `translate(${dog.x - LOUIS_W / 2}px, ${dog.y - LOUIS_H}px) scale(${s})`;
    louis.style.zIndex = Math.round(dog.y);
    louis.classList.toggle('left', dog.dir < 0);
  }

  function pose(act) {
    for (const a of ['stand', 'trot', 'zoom', 'sniff', 'squat', 'kick', 'sit']) louis.classList.toggle(a, a === act);
  }

  function say(words, ms = 1600) {
    bubble.textContent = words;
    bubble.hidden = false;
    clearTimeout(say.timer);
    say.timer = setTimeout(() => { bubble.hidden = true; }, ms);
  }

  // ── what Louis does next ──────────────────────────────────────────────
  function start(act, seconds, extra = {}) {
    Object.assign(dog, { act, until: t + seconds }, extra);
    pose(act);
  }

  function somewhere(far) {
    const l = lawn();
    let x = rand(l.left, l.right), y = rand(l.top, l.bottom);
    if (far) x = dog.x < size.w / 2 ? rand(size.w * 0.65, l.right) : rand(l.left, size.w * 0.35);
    return { tx: x, ty: y };
  }

  function choose() {
    if (reduced) return start('sit', 3600);
    if (mode === 'play' && t >= nextPoop - 0.3) {
      // Dogs check the spot first, about half the time.
      if (dog.act !== 'sniff' && Math.random() < 0.5) return start('sniff', 0.6);
      const squat = Math.max(0.45, 0.9 - dropped * 0.02);
      return start('squat', squat, { dropAt: t + squat * 0.65 });
    }
    if (dog.act === 'squat') return start('kick', 0.45);
    if (dog.act === 'kick') return start('trot', 30, somewhere(true)); // off, proudly
    const r = Math.random();
    const zoomies = mode === 'play' ? 0.1 : 0.05;
    if (r < zoomies) return start('zoom', 30, somewhere(true));
    if (r < 0.6) return start('trot', 30, somewhere(false));
    if (r < 0.78) return start('sniff', rand(0.8, 1.8));
    return start('stand', rand(0.5, 1.4));
  }

  function step(dt) {
    t += dt;
    if (dog.act === 'trot' || dog.act === 'zoom') {
      const speed = (mode === 'play' ? 85 + Math.min(dropped, 30) * 3 : 70) * (dog.act === 'zoom' ? 2.4 : 1) * depth(dog.y);
      const dx = dog.tx - dog.x, dy = dog.ty - dog.y, dist = Math.hypot(dx, dy);
      if (Math.abs(dx) > 2) dog.dir = Math.sign(dx);
      if (dist <= speed * dt || (mode === 'play' && t >= nextPoop && dog.act === 'trot')) {
        if (dist <= speed * dt) Object.assign(dog, { x: dog.tx, y: dog.ty });
        choose();
      } else {
        dog.x += (dx / dist) * speed * dt;
        dog.y += (dy / dist) * speed * dt;
      }
      draw();
    } else if (t >= dog.until) {
      choose();
    }
    if (dog.act === 'squat' && t >= dog.dropAt) {
      dog.dropAt = Infinity;
      drop();
    }
    if (reduced && mode === 'play' && t >= nextPoop) drop();
    if (mode === 'idle' && !dog.asked && t > 4) { dog.asked = true; say('Walk?'); }
  }

  // ── poops ─────────────────────────────────────────────────────────────
  function drop() {
    const l = lawn();
    let x, y;
    if (reduced) {
      // Louis sits still; what he leaves turns up around the lawn anyway.
      ({ tx: x, ty: y } = somewhere(false));
      if (Math.abs(x - dog.x) < 80 && Math.abs(y - dog.y) < 50) x = x < dog.x ? x - 90 : x + 90;
    } else {
      x = dog.x - dog.dir * 0.33 * LOUIS_W * depth(dog.y);
      y = dog.y + 2;
    }
    // Not on top of another one, and on the lawn.
    for (const p of poops) {
      if (Math.abs(p.x - x) < 36 && Math.abs(p.y - y) < 24) { x += x < p.x ? -30 : 30; y += 14; }
    }
    x = Math.min(size.w - 26, Math.max(26, x));
    y = Math.min(l.bottom, Math.max(l.top, y));
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'poop';
    el.setAttribute('aria-label', 'Pick up the poop');
    el.innerHTML = POOP_SVG;
    el.style.transform = `translate(${x - 24}px, ${y - 40}px) scale(${depth(y)})`;
    el.style.zIndex = Math.round(y);
    const p = { el, x, y };
    // Pointer down, not click: quicker on touch. Click covers the keyboard.
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); pick(p); });
    el.addEventListener('click', () => pick(p));
    yard.append(el);
    poops.push(p);
    dropped++;
    nextPoop = t + Math.max(0.6, 2.4 * 0.95 ** dropped) + rand(0, 0.6);
    tally();
    if (poops.length >= LAWN_LIMIT) over();
  }

  function pick(p) {
    if (mode !== 'play' || p.taken) return;
    p.taken = true;
    poops = poops.filter((q) => q !== p);
    score++;
    tally();
    scoreEl.classList.remove('bump');
    void scoreEl.offsetWidth; // restart the bump
    scoreEl.classList.add('bump');
    if (CHEERS[score]) say(CHEERS[score]);
    celebrate(p);
  }

  // The little moment: a bag swoops over it, a few sparkles, the bag flies
  // off to the counter, and a +1 floats up.
  function celebrate(p) {
    const el = p.el;
    el.disabled = true;
    const at = (node, x, y) => {
      node.style.transform = `translate(${x}px, ${y}px)`;
      yard.append(node);
      return node;
    };
    if (reduced) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(() => el.remove());
      return;
    }
    const bag = at(Object.assign(document.createElement('div'), { className: 'bag', innerHTML: BAG_SVG }), p.x - 17, p.y - 40);
    const yardBox = yard.getBoundingClientRect(), target = scoreEl.getBoundingClientRect();
    const to = { x: target.left + target.width / 2 - yardBox.left - 17, y: target.top + target.height / 2 - yardBox.top - 19 };
    const from = `translate(${p.x - 17}px, ${p.y - 40}px)`;
    bag.animate([
      { transform: `${from} scale(0.2)`, opacity: 0 },
      { transform: `${from} scale(1.2)`, opacity: 1, offset: 0.25 },
      { transform: `${from} scale(1)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${to.x}px, ${to.y}px) scale(0.4) rotate(-20deg)`, opacity: 0.2 },
    ], { duration: 700, easing: 'ease-in' }).finished.then(() => bag.remove());
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: 120, fill: 'forwards' }).finished.then(() => el.remove());
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + rand(-0.3, 0.3), reach = rand(22, 38);
      const spark = at(Object.assign(document.createElement('div'), { className: 'spark', innerHTML: SPARK_SVG }), p.x - 5, p.y - 22);
      spark.animate([
        { transform: `translate(${p.x - 5}px, ${p.y - 22}px) scale(0.4)`, opacity: 1 },
        { transform: `translate(${p.x - 5 + Math.cos(angle) * reach}px, ${p.y - 22 + Math.sin(angle) * reach}px) scale(1) rotate(90deg)`, opacity: 0 },
      ], { duration: 420, easing: 'ease-out' }).finished.then(() => spark.remove());
    }
    const plus = at(Object.assign(document.createElement('div'), { className: 'plus', textContent: '+1' }), p.x - 8, p.y - 52);
    plus.animate([
      { transform: `translate(${p.x - 8}px, ${p.y - 52}px)`, opacity: 1 },
      { transform: `translate(${p.x - 8}px, ${p.y - 80}px)`, opacity: 0 },
    ], { duration: 650, easing: 'ease-out' }).finished.then(() => plus.remove());
  }

  function tally() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
    floorEl.textContent = `${poops.length} of ${LAWN_LIMIT}`;
    [...dotsEl.children].forEach((d, i) => d.classList.toggle('on', i < poops.length));
    floorEl.closest('.lawn-count').classList.toggle('warn', poops.length >= LAWN_LIMIT - 2);
  }

  // ── rounds ────────────────────────────────────────────────────────────
  function play() {
    for (const p of poops) p.el.remove();
    poops = [];
    Object.assign(dog, { asked: true });
    mode = 'play';
    played = true;
    score = 0;
    dropped = 0;
    nextPoop = t + 1.4;
    louis.classList.remove('idle');
    card.hidden = true;
    tally();
    choose();
    run();
  }

  function over() {
    mode = 'over';
    const newBest = score > best;
    if (newBest) { best = score; onBest(best); }
    for (const p of poops) { p.el.classList.add('left'); p.el.disabled = true; }
    start('sit', Infinity);
    $('card-title').textContent = newBest ? `New best: ${score}` : score ? `${score} picked up` : 'Louis wins this one';
    $('card-line').textContent = ENDINGS[Math.floor(Math.random() * ENDINGS.length)];
    $('play').textContent = 'Walk him again';
    // Where it doesn't hide Louis sitting proudly.
    card.classList.toggle('low', dog.y < (lawn().top + lawn().bottom) / 2 + 20);
    card.hidden = false;
    tally();
    run();
  }

  $('play').addEventListener('click', play);
  louis.addEventListener('click', () => { if (mode === 'idle') play(); });

  // ── running only while someone can see it ─────────────────────────────
  let running = false, raf = 0, last = 0;
  function frame(now) {
    step(Math.min(0.05, (now - last) / 1000));
    last = now;
    raf = requestAnimationFrame(frame);
  }
  // Nothing to animate once a round is over, or while Louis sits still and nobody plays.
  function run() {
    const needed = running && (mode === 'play' || (mode === 'idle' && !reduced));
    section.classList.toggle('still', !running || mode === 'over');
    if (needed && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!needed && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }
  motion.addEventListener('change', () => {
    reduced = motion.matches;
    measure();
    choose();
    run();
  });

  section.hidden = false;
  tally();
  measure();
  choose();

  return {
    setRunning(on) { running = on; run(); },
    played: () => played,
  };
}
