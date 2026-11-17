// Loui's notes in front of the page, drawn in a view of their own (see
// src/main/hints.js): how to leave full screen, and the card under a tab. The
// main process says what to show; this page draws it and reports nothing.
// Text from pages (a title, a site's name) is set with textContent, never as HTML.
const box = document.getElementById('hint');

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

loui.on('hint', (h) => {
  document.body.classList.toggle('private', !!h.private);
  box.className = h.kind;
  if (h.kind === 'full') {
    const how = el('span', 'how', '');
    how.append(el('kbd', '', h.key), ' to leave full screen');
    box.replaceChildren(...(h.host ? [el('strong', 'site', h.host)] : []), how);
  } else {
    box.replaceChildren(
      el('span', 'title', h.title),
      ...(h.host ? [el('span', 'site', h.host)] : []),
      ...(h.who ? [el('span', 'who', h.who)] : []),
      ...h.more.map((line) => el('span', 'more', line)),
    );
  }
});
