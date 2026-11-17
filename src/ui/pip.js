// The small window that watches a session (see src/main/pip.js). The main
// process sends pictures of the session's tab and what the session is doing;
// this page shows them. Text is set with textContent, never as HTML.
const $ = (id) => document.getElementById(id);
const frame = $('pip-frame');

let state = null;
// As in the helm, the status lingers briefly after a step so that it does
// not flicker between one tool call and the next.
let lingerUntil = 0;
let lingerTimer = 0;

function draw() {
  if (!state) return;
  const s = state;
  $('pip-label').textContent = s.label;
  document.title = s.label ? `Watching ${s.label}` : 'Watching a Claude session';
  $('pip-ended').hidden = !s.ended;
  $('pip-view').title = s.title ? `Show this tab in Loui: ${s.title}` : 'Show this tab in Loui';
  $('pip-empty').hidden = s.picture && frame.hasAttribute('src');
  if (s.busy) lingerUntil = Date.now() + 1400;
  const moving = !s.ended && !s.paused && (s.busy || lingerUntil > Date.now());
  if (moving && !s.busy) {
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(draw, 1450);
  }
  const status = $('pip-status');
  status.textContent = s.ended ? 'Session ended'
    : s.paused ? "Paused. You're driving."
      : moving && s.status ? s.status[0].toUpperCase() + s.status.slice(1)
        : 'Not acting right now';
  status.title = status.textContent;
  status.classList.toggle('moving', moving);
  const pause = $('pip-pause');
  pause.hidden = s.ended;
  pause.textContent = s.paused ? 'Let Claude continue' : 'Take over';
}

loui.onUpdate((next) => {
  if (!next.picture) frame.removeAttribute('src');
  state = next;
  draw();
});
loui.onFrame((url) => {
  frame.src = url;
  draw();
});

$('pip-close').onclick = () => loui.act('close');
$('pip-ended-close').onclick = () => loui.act('close');
$('pip-view').onclick = () => loui.act('show');
$('pip-pause').onclick = () => loui.act(state?.paused ? 'continue' : 'take-over');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') loui.act('close');
});

// Pictures are made to fit the picture area, in device pixels.
let sizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    const r = $('pip-view').getBoundingClientRect();
    loui.size(r.width * devicePixelRatio, r.height * devicePixelRatio);
  }, 100);
}).observe($('pip-view'));
