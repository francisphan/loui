// The search engine that words typed in the address bar go to. Brave Search
// unless the user picks another, or an address of their own with %s where the
// words go. Kept in settings.json in the profile.
const ENGINES = {
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=%s' },
  kagi: { label: 'Kagi', url: 'https://kagi.com/search?q=%s' },
};

let template = ENGINES.brave.url;
let name = ENGINES.brave.label; // the engine as menus name it ("Search Kagi for …")

// A custom address must be a web page and say where the words go.
const valid = (url) => typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url.trim()) && url.includes('%s');

function apply(settings) {
  template = settings.search === 'custom' && valid(settings.searchUrl) ? settings.searchUrl.trim()
    : (ENGINES[settings.search] || ENGINES.brave).url;
  name = ENGINES[settings.search]?.label || ENGINES.brave.label;
  if (settings.search === 'custom' && valid(settings.searchUrl)) {
    try { name = new URL(template).hostname.replace(/^www\./, ''); } catch {}
  }
}

// The address that searches for these words.
const searchFor = (text) => template.split('%s').join(encodeURIComponent(text));
const searchName = () => name;

// settings: the object kept in settings.json; save writes it.
function createSearch({ settings, save, changed }) {
  apply(settings);
  return {
    // engine: one of ENGINES, or 'custom' with url. An invalid custom address is ignored.
    set({ engine, url } = {}) {
      if (engine === 'custom' ? !valid(url) : !ENGINES[engine]) return;
      settings.search = engine;
      if (engine === 'custom') settings.searchUrl = url.trim();
      apply(settings);
      save();
      changed();
    },
    state: () => ({
      search: {
        engine: settings.search === 'custom' && valid(settings.searchUrl) ? 'custom'
          : ENGINES[settings.search] ? settings.search : 'brave',
        custom: settings.searchUrl || '',
        engines: Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label })),
      },
    }),
  };
}

module.exports = { searchFor, searchName, createSearch, ENGINES };
