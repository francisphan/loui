// Reader view's button in the address bar: shown when the page on screen
// reads as an article (src/main/reader.js decides), and lit while the tab
// shows reader view, which is the address bar's mark that the address it
// shows is the article's, drawn by Loui. Uses $, svg, ICON and setIcon from ui.js.
(() => {
  ICON.book = svg('<path d="M8 4.2C6.6 3 4.4 2.6 1.75 2.75v9.5c2.65-.15 4.85.25 6.25 1.45 1.4-1.2 3.6-1.6 6.25-1.45v-9.5C11.6 2.6 9.4 3 8 4.2zM8 4.2v9.5"/>');
  const button = $('reader');
  setIcon(button, 'book');
  button.onclick = () => loui.send('reader:toggle');
  loui.on('state', (next) => {
    const r = next.reader || {};
    button.hidden = !r.can;
    button.classList.toggle('on', !!r.on);
    button.setAttribute('aria-pressed', String(!!r.on));
    const what = r.on ? 'Leave reader view (F9)' : 'Reader view (F9)';
    button.title = what;
    button.setAttribute('aria-label', r.on ? 'Leave reader view' : 'Reader view');
  });
})();
