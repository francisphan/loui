// Reader view's page side. Runs in an isolated world of its own (see
// src/main/reader.js), after Mozilla's Readability and isProbablyReaderable
// (node_modules/@mozilla/readability), which the main process puts in front
// of this file. The page's own JavaScript can neither see nor change it.
//
// Readability works on a clone of the document, which has no browsing
// context: nothing in it runs or loads. What it finds is then copied, element
// by element, through an allow-list into another inert document: only
// structural and text tags, links and images to http(s) addresses, and a few
// harmless attributes. No scripts, no event handlers, no styles, no iframes,
// no forms, no SVG or MathML. The reader page is served with a policy that
// runs no scripts either, so either layer alone keeps the page inert.
(() => {
  if (globalThis.__louiReader) return;

  // Tags kept as they are. Anything else is either dropped with what it holds
  // (DROP) or unwrapped, its children kept (a custom element around a paragraph).
  const KEEP = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark',
    'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'div', 'span', 'section', 'article', 'header', 'footer', 'abbr', 'cite', 'q', 'time', 'del', 'ins',
    'kbd', 'samp', 'var', 'details', 'summary', 'aside',
  ]);
  const DROP = new Set([
    'script', 'style', 'link', 'meta', 'base', 'noscript', 'template', 'iframe', 'frame', 'frameset',
    'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'option', 'textarea', 'label',
    'fieldset', 'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'picture', 'map', 'area',
    'dialog', 'slot', 'portal', 'head', 'title',
  ]);
  // Attributes kept, per tag; URLs are checked separately.
  const ATTRS = {
    a: ['title'], img: ['alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'], ol: ['start', 'reversed', 'type'], abbr: ['title'],
    time: ['datetime'], q: ['cite'], blockquote: [], details: ['open'],
  };

  // An absolute http(s) address, or null.
  const web = (raw, base) => {
    try {
      const u = new URL(raw, base);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  };

  function clean(from, out, base) {
    const copy = (node, into) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { into.append(out.createTextNode(child.data)); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        // Elements in other namespaces (SVG, MathML) are never kept.
        if (child.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
        const tag = child.localName;
        if (DROP.has(tag)) continue;
        if (!KEEP.has(tag)) { copy(child, into); continue; }
        const el = out.createElement(tag);
        for (const name of ATTRS[tag] || []) {
          const v = child.getAttribute(name);
          if (v != null) el.setAttribute(name, v);
        }
        if (tag === 'a') {
          const href = web(child.getAttribute('href') || '', base);
          if (href) el.setAttribute('href', href);
        }
        if (tag === 'img') {
          const src = web(child.getAttribute('src') || '', base);
          const set = (child.getAttribute('srcset') || '').split(',').map((part) => {
            const [u, ...size] = part.trim().split(/\s+/);
            const ok = u && web(u, base);
            return ok ? [ok, ...size].join(' ') : null;
          }).filter(Boolean).join(', ');
          if (!src && !set) continue; // an image with nowhere safe to load from
          if (src) el.setAttribute('src', src);
          if (set) el.setAttribute('srcset', set);
          el.setAttribute('loading', 'lazy');
          el.setAttribute('referrerpolicy', 'no-referrer');
        }
        into.append(el);
        copy(child, el);
      }
    };
    const root = out.createElement('div');
    copy(from, root);
    return root;
  }

  // The article as plain text for Claude: markdown-ish headings, lists,
  // quotes and code, links as "text (url)", images as [Image: alt].
  function plain(root) {
    const lines = [];
    let line = '';
    const flush = () => { if (line.trim()) lines.push(line.replace(/[ \t]+/g, ' ').trim()); line = ''; };
    const gap = () => { flush(); if (lines.length && lines[lines.length - 1] !== '') lines.push(''); };
    const BLOCK = /^(p|div|section|article|header|footer|figure|figcaption|table|tr|dl|dt|dd|details|summary|aside|caption)$/;
    const walk = (node, ctx) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { line += child.data.replace(/\s+/g, ' '); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.localName;
        if (/^h[1-6]$/.test(tag)) {
          gap();
          line = '#'.repeat(+tag[1]) + ' ';
          walk(child, ctx);
          gap();
        } else if (tag === 'ul' || tag === 'ol') {
          if (!ctx.depth) gap(); else flush();
          let n = Number(child.getAttribute('start')) || 1;
          for (const li of child.children) {
            if (li.localName !== 'li') continue;
            flush();
            line = '  '.repeat(ctx.depth) + (tag === 'ol' ? `${n++}. ` : '- ');
            walk(li, { ...ctx, depth: ctx.depth + 1 });
            flush();
          }
          if (!ctx.depth) gap();
        } else if (tag === 'blockquote') {
          gap();
          const inner = plain(child).split('\n').map((l) => (l ? '> ' + l : '>'));
          lines.push(...inner);
          gap();
        } else if (tag === 'pre') {
          gap();
          lines.push('```', ...child.textContent.replace(/\n$/, '').split('\n'), '```');
          gap();
        } else if (tag === 'br') {
          flush();
        } else if (tag === 'hr') {
          gap(); lines.push('---'); gap();
        } else if (tag === 'a') {
          const before = line.length;
          walk(child, ctx);
          const label = line.slice(before).trim();
          const href = child.getAttribute('href');
          if (href && label && label !== href) line += ` (${href})`;
          else if (href && !label) line += href;
        } else if (tag === 'img') {
          const alt = (child.getAttribute('alt') || '').trim();
          if (alt) line += ` [Image: ${alt}] `;
        } else if (tag === 'td' || tag === 'th') {
          walk(child, ctx);
          line += ' | ';
        } else if (BLOCK.test(tag)) {
          gap();
          walk(child, ctx);
          gap();
        } else {
          walk(child, ctx);
        }
      }
    };
    walk(root, { depth: 0 });
    flush();
    while (lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  globalThis.__louiReader = {
    // The cheap check after a page loads: does it look like an article?
    readable: () => {
      try { return isProbablyReaderable(document); } catch { return false; }
    },

    // The article: { title, byline, siteName, lang, dir, html, text, length }
    // with html already cleaned (see clean()), or null if there is none.
    extract({ html = true, text = false } = {}) {
      const base = document.baseURI;
      let found;
      try {
        found = new Readability(document.cloneNode(true), { serializer: (el) => el }).parse();
      } catch {
        return null;
      }
      if (!found?.content) return null;
      const out = document.implementation.createHTMLDocument('');
      const root = clean(found.content, out, base);
      const words = text ? plain(root) : '';
      return {
        title: (found.title || document.title || '').trim(),
        byline: (found.byline || '').trim(),
        siteName: (found.siteName || '').trim(),
        lang: found.lang || document.documentElement.lang || '',
        dir: found.dir === 'rtl' ? 'rtl' : 'ltr',
        html: html ? root.innerHTML : '',
        text: words,
        length: words.length,
        readable: globalThis.__louiReader.readable(),
      };
    },
  };
})();
