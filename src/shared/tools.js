// The one list of browser tools. The app runs them (src/main/actions.js); the
// MCP shim and the in-browser chat both advertise them from here.
// `acts` marks tools that change the page: those are refused while the user
// has paused Claude.
const { z } = require('zod');

const ref = z.string().describe('Element ref from the latest snapshot, like "e12"');

module.exports = [
  {
    name: 'navigate',
    acts: true,
    description:
      'Load a URL in the active tab (or a new tab) and return an outline of the page.',
    shape: {
      url: z.string().describe('http(s) URL. Bare hosts like "localhost:5173" work.'),
      new_tab: z.boolean().optional(),
    },
  },
  {
    name: 'history',
    acts: true,
    description: 'Go back, go forward, or reload the active tab.',
    shape: { action: z.enum(['back', 'forward', 'reload']) },
  },
  {
    name: 'snapshot',
    description:
      'Read the active page as an outline of headings, text and interactive elements. ' +
      'Elements carry refs like [e12] that the other tools accept. Refs stay valid until ' +
      'the element leaves the page. Pass ref to read one region of a long page.',
    shape: { ref: ref.optional() },
  },
  {
    name: 'click',
    acts: true,
    description:
      'Click an element by ref, or a point by x,y (pixel coordinates in the latest ' +
      'viewport screenshot). Returns the page outline afterwards.',
    shape: {
      ref: ref.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      double: z.boolean().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
    },
  },
  {
    name: 'type',
    acts: true,
    description: 'Click a text field and type into it.',
    shape: {
      ref,
      text: z.string(),
      clear: z.boolean().optional().describe('Replace what is there instead of adding to it'),
      submit: z.boolean().optional().describe('Press Enter afterwards'),
    },
  },
  {
    name: 'press_key',
    acts: true,
    description: 'Press a key or chord in the active page.',
    shape: {
      key: z.string().describe('"Enter", "Escape", "Tab", "ArrowDown", "Control+A", "a"'),
    },
  },
  {
    name: 'hover',
    acts: true,
    description: 'Move the pointer over an element, for menus and tooltips that open on hover.',
    shape: { ref },
  },
  {
    name: 'select_option',
    acts: true,
    description: 'Choose an option in a <select> by its value or visible label.',
    shape: { ref, value: z.string() },
  },
  {
    name: 'scroll',
    acts: true,
    description:
      'Scroll the page, or the scrollable region containing ref. Returns the outline afterwards.',
    shape: {
      direction: z.enum(['up', 'down', 'top', 'bottom']),
      ref: ref.optional(),
      amount: z.number().optional().describe('Pixels. Default is most of one screen.'),
    },
  },
  {
    name: 'wait_for',
    description:
      'Wait until text appears on the page, until text disappears, or for a number of seconds.',
    shape: {
      text: z.string().optional(),
      text_gone: z.string().optional(),
      seconds: z.number().optional().describe('Timeout, or the time to wait. Default 10, max 30.'),
    },
  },
  {
    name: 'screenshot',
    description:
      'Capture the visible page, one element (ref), or the whole scrollable page (full_page).',
    shape: { ref: ref.optional(), full_page: z.boolean().optional() },
  },
  {
    name: 'tabs',
    description:
      'List the tabs in your tab group, open a new one, switch to one, or close one. Your tools ' +
      'act on the tab you last switched to or opened.',
    shape: {
      action: z.enum(['list', 'new', 'select', 'close']),
      id: z.number().optional().describe('Tab id, for select and close'),
      url: z.string().optional().describe('For new'),
    },
  },
  {
    name: 'evaluate',
    acts: true,
    description:
      'Run JavaScript in the active page and return the result. Takes an expression or a ' +
      'function body using return and await.',
    shape: { code: z.string() },
  },
  {
    name: 'console_logs',
    description: 'Console messages and uncaught errors from the active tab, oldest first.',
    shape: {
      level: z.enum(['all', 'warning', 'error']).optional(),
      contains: z.string().optional(),
      limit: z.number().optional().describe('Default 50'),
    },
  },
  {
    name: 'network_requests',
    description: 'Requests made by the active tab: method, status, type, duration, URL.',
    shape: {
      failed_only: z.boolean().optional().describe('Only failed requests and status >= 400'),
      contains: z.string().optional().describe('Substring of the URL'),
      limit: z.number().optional().describe('Default 50'),
    },
  },
  {
    name: 'set_viewport',
    acts: true,
    description:
      'Emulate a device size in the active tab, or go back to the full window with preset "desktop".',
    shape: {
      preset: z.enum(['desktop', 'iphone', 'ipad', 'ipad-landscape', 'android']).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      mobile: z.boolean().optional().describe('Mobile user agent and viewport behaviour'),
    },
  },
  {
    name: 'request_tab',
    description:
      'Ask the user to hand you the tab they are looking at, so you can work in it. Use this ' +
      'when they refer to a page they have open. Waits its turn behind other questions to the ' +
      'user, then up to a minute for their answer.',
    shape: {},
  },
  {
    name: 'picks',
    description:
      'Elements the user pointed at with the Point tool, newest first, each with its ' +
      'selector, text, HTML, a ref, and a cropped screenshot.',
    shape: {},
  },
  {
    name: 'ask_user_to_pick',
    description:
      'Ask the user to click an element in the page to show which one they mean. Waits its ' +
      'turn behind other questions to the user, then for their click (up to two minutes), and ' +
      'returns that element.',
    shape: { message: z.string().describe('What to click, shown to the user') },
  },
];
