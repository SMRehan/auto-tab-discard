const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../v3/worker/plugins/dummy/core.mjs'), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/^export default \{[\s\S]*\};\s*$/m, 'this.plugin = {enable, disable, placeholder, asleep, area};');
const PAGE = 'moz-extension://uuid/worker/plugins/dummy/page.html';

const page = (o = {}) => ({frameId: 0, result: {prompts: false, width: 1000, height: 3000, y: 600, vh: 800, ...o}});

function fixture({captureTab = true, granted = true, activateOnCapture = false, frames = [page()], failRect = false,
  scrollTop = 0} = {}) {
  const tabs = new Map();
  const native = [];
  const captured = [];
  const captures = [];
  const scrolls = [];
  const stored = [];
  const updated = [];
  const listeners = {updated: new Set(), activated: new Set(), message: new Set()};
  const timers = [];
  const event = set => ({addListener: c => set.add(c), removeListener: c => set.delete(c)});
  const chrome = {
    runtime: {getURL: p => 'moz-extension://uuid' + p, onMessage: event(listeners.message)},
    permissions: {contains: async () => granted},
    scripting: {executeScript: async ({target, args}) => {
      if (args) { // scroll position fallback
        scrolls.push({tabId: target.tabId, y: args[0]});
        return [{frameId: 0, result: scrollTop < 10}];
      }
      if (frames instanceof Error) {
        throw frames;
      }
      return frames;
    }},
    tabs: {
      get: async id => ({...tabs.get(id)}),
      update: async (id, props) => {
        updated.push({id, ...props});
        Object.assign(tabs.get(id), {url: props.url, status: 'loading'});
        // the placeholder page finishes loading
        setImmediate(() => {
          const tab = Object.assign(tabs.get(id), {status: 'complete'});
          listeners.updated.forEach(c => c(id, {status: 'complete'}, {...tab}));
        });
      },
      onUpdated: event(listeners.updated),
      onActivated: event(listeners.activated)
    }
  };
  if (captureTab) {
    chrome.tabs.captureTab = async (id, options) => {
      if (failRect && options.rect) {
        throw new Error('canvas too large');
      }
      captured.push(id);
      captures.push(options);
      if (activateOnCapture) {
        tabs.get(id).active = true;
      }
      return 'data:image/jpeg;base64,AAAA';
    };
  }
  const discard = {method: tab => {
    native.push(tab.id);
    tabs.get(tab.id).discarded = true;
    return Promise.resolve();
  }};
  const ctx = vm.createContext({
    chrome, discard, console, URL, URLSearchParams, Date, Promise, Set, Map,
    setTimeout: (c, ms) => {
      timers.push(c);
      return timers.length;
    },
    clearTimeout: () => {},
    log: () => {},
    query: async filter => [...tabs.values()].filter(t => Object.entries(filter).every(([k, v]) => t[k] === v))
      .map(t => ({...t})),
    previews: {
      set: async (href, image, meta = {}) => stored.push({...meta, href, image}),
      get: async href => stored.find(p => p.href === href),
      remove: async href => {
        const i = stored.findIndex(p => p.href === href);
        if (i !== -1) stored.splice(i, 1);
      },
      keep: async () => {}
    }
  });
  vm.runInContext(source, ctx);
  const add = tab => {
    const t = {active: false, discarded: false, status: 'complete', title: 'Title', favIconUrl: '', ...tab};
    tabs.set(t.id, t);
    return t;
  };
  return {ctx, add, tabs, native, captured, captures, scrolls, stored, updated, listeners, timers, plugin: ctx.plugin, discard};
}

test('a web page is captured, replaced by the placeholder, and the placeholder gets discarded', async () => {
  const f = fixture();
  f.add({id: 1, url: 'https://example.com/a?x=1', title: '💤 Example'});
  await f.plugin.placeholder({id: 1});
  assert.deepEqual(f.captured, [1]);
  assert.deepEqual(f.stored.map(s => s.href), ['https://example.com/a?x=1']);
  assert.equal(f.updated.length, 1);
  const url = new URL(f.updated[0].url);
  assert.ok(f.updated[0].url.startsWith(PAGE + '?'));
  assert.equal(url.searchParams.get('href'), 'https://example.com/a?x=1');
  assert.equal(url.searchParams.get('title'), '💤 Example');
  assert.deepEqual(f.native, [1]);
  assert.equal(f.listeners.updated.size, 1, 'only the permanent scroll fallback listener is left');
});

test('non web pages are discarded natively', async () => {
  const f = fixture();
  f.add({id: 1, url: 'about:preferences'});
  f.add({id: 2, url: 'file:///tmp/a.html'});
  await f.plugin.placeholder({id: 1});
  await f.plugin.placeholder({id: 2});
  assert.deepEqual(f.updated, []);
  assert.deepEqual(f.native, [1, 2]);
});

test('active and discarded tabs are left alone', async () => {
  const f = fixture();
  f.add({id: 1, url: 'https://example.com/', active: true});
  f.add({id: 2, url: 'https://example.com/', discarded: true});
  await f.plugin.placeholder({id: 1});
  await f.plugin.placeholder({id: 2});
  assert.deepEqual(f.updated, []);
  assert.deepEqual(f.native, []);
  assert.deepEqual(f.captured, []);
});

test('a tab that gets selected while capturing is not replaced', async () => {
  const f = fixture({activateOnCapture: true});
  f.add({id: 1, url: 'https://example.com/'});
  await f.plugin.placeholder({id: 1});
  assert.deepEqual(f.updated, []);
  assert.deepEqual(f.native, []);
});

test('without "<all_urls>" or tabs.captureTab the placeholder has no preview', async () => {
  for (const options of [{granted: false}, {captureTab: false}]) {
    const f = fixture(options);
    f.add({id: 1, url: 'https://example.com/'});
    await f.plugin.placeholder({id: 1});
    assert.deepEqual(f.captured, []);
    assert.deepEqual(f.stored, []);
    assert.equal(f.updated.length, 1);
    assert.deepEqual(f.native, [1]);
  }
});

test('enable and disable swap the discard method; the tab listener is registered at start-up', () => {
  const f = fixture();
  const method = f.discard.method;
  // registered at start-up so it wakes an idle background
  assert.equal(f.listeners.activated.size, 1);
  f.plugin.enable();
  assert.equal(f.discard.method, f.plugin.placeholder);
  f.plugin.disable();
  assert.equal(f.discard.method, method);
  assert.equal(f.listeners.activated.size, 1);
});

test('switching tabs discards placeholders that were selected but not loaded', async () => {
  const f = fixture();
  f.add({id: 1, url: PAGE + '?href=https%3A%2F%2Fexample.com%2F'});
  f.add({id: 2, url: 'https://example.com/b'});
  f.add({id: 3, url: PAGE + '?href=https%3A%2F%2Fexample.com%2Fc', active: true});
  f.plugin.asleep();
  await f.timers.pop()();
  assert.deepEqual(f.native, [1]);
});

test('pages that ask before leaving are discarded natively', async () => {
  for (const frames of [[page(), {frameId: 3, result: {prompts: true}}], new Error('Missing host permission')]) {
    const f = fixture({frames});
    f.add({id: 1, url: 'https://example.com/editor'});
    await f.plugin.placeholder({id: 1});
    assert.deepEqual(f.updated, []);
    assert.deepEqual(f.captured, []);
    assert.deepEqual(f.native, [1]);
  }
});

test('placeholder pages get and forget previews through messages (container tabs cannot read the IndexedDB)', async () => {
  const f = fixture();
  f.add({id: 1, url: 'https://example.com/a'});
  await f.plugin.placeholder({id: 1});
  const [listener] = f.listeners.message;
  const ask = request => new Promise(resolve => {
    const async = listener(request, {}, resolve);
    if (async !== true) resolve(undefined);
  });
  assert.deepEqual({...await ask({method: 'dummy.preview', href: 'https://example.com/a'})},
    {image: 'data:image/jpeg;base64,AAAA', top: 0, y: 600, width: 1000});
  assert.equal(await ask({method: 'dummy.preview', href: 'https://example.com/unknown'}), '');
  assert.equal(await ask({method: 'dummy.forget', href: 'https://example.com/a'}), true);
  assert.equal(await ask({method: 'dummy.preview', href: 'https://example.com/a'}), '');
  assert.equal(await ask({method: 'storage'}), undefined, 'other messages are left to other listeners');
});

test('short pages are captured completely; the placeholder URL keeps the scroll position', async () => {
  const f = fixture();
  f.add({id: 1, url: 'https://example.com/'});
  await f.plugin.placeholder({id: 1});
  assert.deepEqual({...f.captures[0].rect}, {x: 0, y: 0, width: 1000, height: 3000});
  assert.deepEqual({...f.stored[0], image: undefined}, {href: 'https://example.com/', image: undefined, top: 0, y: 600, width: 1000});
  assert.equal(new URL(f.updated[0].url).searchParams.get('y'), '600');
});

test('long pages are captured around the position the user left them at', () => {
  const {area} = fixture().plugin;
  const vh = 800; // 10 screens = 8000px
  assert.deepEqual({...area({width: 1000, height: 50000, y: 20000, vh})}, {x: 0, y: 17600, width: 1000, height: 8000});
  assert.deepEqual({...area({width: 1000, height: 50000, y: 1000, vh})}, {x: 0, y: 0, width: 1000, height: 8000});
  assert.deepEqual({...area({width: 1000, height: 50000, y: 49200, vh})}, {x: 0, y: 42000, width: 1000, height: 8000});
  // tall windows are capped at 16000px
  assert.equal(area({width: 1000, height: 90000, y: 0, vh: 2000}).height, 16000);
});

test('if the full page cannot be captured, the visible part is used', async () => {
  const f = fixture({failRect: true});
  f.add({id: 1, url: 'https://example.com/'});
  await f.plugin.placeholder({id: 1});
  assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0].rect, undefined);
  assert.deepEqual({...f.stored[0], image: undefined}, {href: 'https://example.com/', image: undefined});
});

test('scroll position fallback scrolls a restored page that came back at the top', async () => {
  const f = fixture();
  const [listener] = f.listeners.message;
  listener({method: 'dummy.restore', href: 'https://app.example.com/feed', y: 2400}, {tab: {id: 7}}, () => {});
  const [onUpdated] = f.listeners.updated;
  // other tabs and other URLs are ignored
  onUpdated(8, {status: 'complete'}, {url: 'https://app.example.com/feed'});
  onUpdated(7, {status: 'complete'}, {url: 'https://app.example.com/other'});
  assert.equal(f.timers.length, 0);
  onUpdated(7, {status: 'complete'}, {url: 'https://app.example.com/feed'});
  await f.timers.pop()();
  assert.deepEqual(f.scrolls, [{tabId: 7, y: 2400}]);
  // only once per restore
  onUpdated(7, {status: 'complete'}, {url: 'https://app.example.com/feed'});
  assert.equal(f.timers.length, 0);
});

test('no scroll fallback for positions near the top', async () => {
  const f = fixture();
  const [listener] = f.listeners.message;
  const [onUpdated] = f.listeners.updated;
  listener({method: 'dummy.restore', href: 'https://example.com/', y: 50}, {tab: {id: 7}}, () => {});
  onUpdated(7, {status: 'complete'}, {url: 'https://example.com/'});
  assert.equal(f.timers.length, 0);
});
