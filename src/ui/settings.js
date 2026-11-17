// Settings, a panel in the Claude panel's place (File › Settings, Ctrl+,;
// see sidePanel in ui.js): the search
// engine for the address bar, and the sites that open in the user's other
// browser (see src/main/search.js and src/main/brave.js), and whether the
// tabs sit in a sidebar (main.js, tabs:layout). Uses $, el and
// sidePanel from ui.js.
const sheet = $('settings');
const engine = $('search-engine');
const validSearch = (url) => /^https?:\/\/\S+$/i.test(url.trim()) && url.includes('%s');
let settings = null;

function drawSettings(next) {
  settings = next;
  const { search, elsewhere } = next;
  // What the user is choosing is left alone while the sheet is open.
  if (sheet.hidden) {
    engine.replaceChildren(
      ...search.engines.map((e) => Object.assign(el('option', '', e.label), { value: e.id })),
      Object.assign(el('option', '', 'Custom address'), { value: 'custom' }),
    );
    engine.value = search.engine;
    $('search-url').value = search.custom;
    $('search-url-note').textContent = '';
    $('search-custom').hidden = search.engine !== 'custom';
  }
  $('tabs-vertical').checked = !!next.tabStrip?.vertical;
  $('elsewhere-title').textContent = `Sites that open in ${elsewhere.browser}`;
  $('elsewhere-list').replaceChildren(...elsewhere.sites.map((site) => {
    const row = el('li');
    const remove = el('button', 'quiet', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Open ${site} in Loui`);
    remove.onclick = () => loui.send('brave:remove', site);
    row.append(el('span', 'site', site), remove);
    return row;
  }));
  if (!elsewhere.sites.length) $('elsewhere-list').append(el('li', 'none', 'None. Every site opens in Loui.'));
}

engine.onchange = () => {
  const custom = engine.value === 'custom';
  $('search-custom').hidden = !custom;
  if (custom) $('search-url').focus();
  else loui.send('search:set', { engine: engine.value });
};
$('search-custom').onsubmit = (e) => {
  e.preventDefault();
  const url = $('search-url').value;
  if (!validSearch(url)) {
    $('search-url-note').textContent = 'Use an http or https address with %s in it.';
    return;
  }
  $('search-url-note').textContent = 'Saved.';
  loui.send('search:set', { engine: 'custom', url });
};
$('tabs-vertical').onchange = () => loui.send('tabs:layout', { vertical: $('tabs-vertical').checked });
$('elsewhere-add').onsubmit = (e) => {
  e.preventDefault();
  loui.send('brave:add', $('elsewhere-site').value);
  $('elsewhere-site').value = '';
};

const showSettingsPanel = sidePanel('settings', sheet, () => engine.focus());
const showSettings = (show) => {
  if (show && settings) {
    sheet.hidden = true; // so it is drawn afresh
    drawSettings(settings);
  }
  showSettingsPanel(show);
};
loui.on('show-settings', () => showSettings(true));

loui.on('state', (next) => drawSettings(next));
