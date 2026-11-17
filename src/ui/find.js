// The find bar. A strip under the toolbar, so the page moves down to make room
// rather than being covered (pages are native views; nothing can sit on them).
// Whether it is open and how many matches there are come from the main
// process (src/main/find.js); only the text being typed lives here.
// Uses $ and svg from ui.js.
(() => {
  const bar = $('find');
  const input = $('find-text');
  const count = $('find-count');
  $('find-prev').innerHTML = svg('<path d="m4 10 4-4 4 4"/>');
  $('find-next').innerHTML = svg('<path d="m4 6 4 4 4-4"/>');
  $('find-close').innerHTML = svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>', 12);

  let found = { open: false, text: '', matches: 0, active: 0 };
  const step = (forward) => { if (input.value) loui.send('find', { text: input.value, forward, again: true }); };

  input.oninput = () => loui.send('find', { text: input.value });
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      loui.send('find:close');
    }
  };
  $('find-prev').onclick = () => step(false);
  $('find-next').onclick = () => step(true);
  $('find-close').onclick = () => loui.send('find:close');

  // Ctrl+F. Opening again searches for the last text, ready to be typed over.
  loui.on('focus-find', () => {
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value && input.value !== found.text) loui.send('find', { text: input.value });
  });

  loui.on('state', (next) => {
    found = next.find || found;
    bar.hidden = !found.open;
    if (!found.open && document.activeElement === input) input.blur();
    count.textContent = !found.open || !found.text || found.matches == null ? ''
      : found.matches ? `${found.active} of ${found.matches}` : 'No matches';
    count.classList.toggle('none', count.textContent === 'No matches'); // in the danger colour, as browsers do
    $('find-prev').disabled = $('find-next').disabled = !found.matches;
  });
})();
