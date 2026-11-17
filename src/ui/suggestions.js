// The suggestions list under the address bar, drawn in a view of its own in
// front of the page (see src/main/suggest.js). The window chrome decides what
// it shows; this page draws it and reports a click. Page titles are set with
// textContent, never as HTML.
const list = document.getElementById('suggestions');

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
// The address as people read it: no scheme, no "www.".
const plain = (url) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

loui.on('suggest', ({ items, chosen }) => {
  list.replaceChildren(...items.map((s, i) => {
    const row = el('div', 'suggestion' + (i === chosen ? ' chosen' : '') + (s.source === 'bookmark' ? ' bookmarked' : ''), '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === chosen);
    row.dataset.url = s.url;
    row.append(el('span', 'title', s.title || plain(s.url)), el('span', 'url', plain(s.url)));
    // On press, not on click: the press moves focus out of the address bar,
    // which closes the list before a click would arrive.
    row.onmousedown = (e) => { if (e.button === 0) loui.send('suggest:pick', s.url); };
    return row;
  }));
});
