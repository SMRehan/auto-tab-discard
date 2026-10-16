const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../v3/worker/plugins/dummy/core.mjs'), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/^export default \{[\s\S]*\};\s*$/m, 'this.plugin = {enable, disable, placeholder, asleep};');
const PAGE = 'moz-extension://uuid/worker/plugins/dummy/page.html';

function fixture({captureTab = true, granted = true, activateOnCapture = false, frames = [{result: false}]} = {}) {
  const tabs = new Map();
  const native = [];
  const captured = [];
  const stored = [];
  const updated = [];
  const listeners = {updated: new Set(), activated: new Set(), message: new Set()};
  const timers = [];
  const event = set => ({addListener: c => set.add(c), removeListener: c => set.delete(c)});
  const chrome = {
    runtime: {getURL: p => 'moz-extension://uuid' + p, onMessage: event(listeners.message)},
    permissions: {contains: async () => granted},
    scripting: {executeScript: async () => {
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
    chrome.tabs.captureTab = async id => {
      captured.push(id);
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
    chrome, discard, console, URL, URLSearchParams, Date, Promise, Set,
    setTimeout: (c, ms) => {
      timers.push(c);
      return timers.length;
    },
    clearTimeout: () => {},
    log: () => {},
    query: async filter => [...tabs.values()].filter(t => Object.entries(filter).every(([k, v]) => t[k] === v))
      .map(t => ({...t})),
    previews: {
      set: async (href, image) => stored.push({href, image}),
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
  return {ctx, add, tabs, native, captured, stored, updated, listeners, timers, plugin: ctx.plugin, discard};
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
  assert.equal(f.listeners.updated.size, 0, 'onUpdated listener is removed');
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

test('enable and disable swap the discard method and the tab listener', () => {
  const f = fixture();
  const method = f.discard.method;
  f.plugin.enable();
  assert.equal(f.discard.method, f.plugin.placeholder);
  assert.equal(f.listeners.activated.size, 1);
  f.plugin.disable();
  assert.equal(f.discard.method, method);
  assert.equal(f.listeners.activated.size, 0);
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
  for (const frames of [[{result: false}, {result: true}], new Error('Missing host permission')]) {
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
  assert.equal(await ask({method: 'dummy.preview', href: 'https://example.com/a'}), 'data:image/jpeg;base64,AAAA');
  assert.equal(await ask({method: 'dummy.preview', href: 'https://example.com/unknown'}), '');
  assert.equal(await ask({method: 'dummy.forget', href: 'https://example.com/a'}), true);
  assert.equal(await ask({method: 'dummy.preview', href: 'https://example.com/a'}), '');
  assert.equal(await ask({method: 'storage'}), undefined, 'other messages are left to other listeners');
});
