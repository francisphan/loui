// The Shields button in the toolbar: how many ads and trackers were blocked
// on the page on screen. Clicking it opens a menu (drawn by the main process,
// since nothing can be drawn over the page) that turns Shields off or on for
// the site. Uses $ and svg from ui.js.
const SHIELD = svg('<path d="M8 1.5 13.5 3.5v4c0 3.3-2.3 5.8-5.5 7-3.2-1.2-5.5-3.7-5.5-7v-4z"/>');
const SHIELD_OFF = svg('<path d="M8 1.5 13.5 3.5v4c0 3.3-2.3 5.8-5.5 7-3.2-1.2-5.5-3.7-5.5-7v-4z"/><path d="m2 2 12 12"/>');

const shieldsButton = $('shields');
shieldsButton.onclick = () => loui.send('shields:menu');

loui.on('state', (next) => {
  const s = next.shields;
  shieldsButton.disabled = !s;
  shieldsButton.classList.toggle('on', !!s?.on);
  shieldsButton.querySelector('.glyph').innerHTML = s && !s.on ? SHIELD_OFF : SHIELD;
  $('shields-count').textContent = s?.on && s.blocked ? String(s.blocked) : '';
  const label = !s ? 'Shields'
    : !s.on ? `Shields are off for ${s.site}`
      : `Shields: ${s.blocked} blocked on this page`;
  shieldsButton.title = label;
  shieldsButton.setAttribute('aria-label', label);
});
