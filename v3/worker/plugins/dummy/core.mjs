/* replace the page with a local placeholder that shows a preview of the page and only loads the page
   on user request (see page.mjs). The placeholder itself gets discarded natively whenever it is not
   selected, so the memory footprint is close to a natively discarded tab and selecting the tab only
   reloads the local placeholder */

import {log, query} from '../../core/utils.mjs';
import {discard} from '../../core/discard.mjs';
import {previews} from './previews.mjs';

const PAGE = chrome.runtime.getURL('/worker/plugins/dummy/page.html');
const method = discard.method;

// original URL of a tab that is showing the placeholder page
const original = tab => {
  if (tab.url && tab.url.startsWith(PAGE)) {
    try {
      return new URL(tab.url).searchParams.get('href');
    }
    catch (e) {}
  }
};

// remove previews that no longer belong to a placeholder tab (at most once per 10 minutes). Recent previews
// are kept since their tabs might not have navigated to the placeholder yet
const prune = () => {
  if (Date.now() - prune.time < 10 * 60 * 1000) {
    return;
  }
  prune.time = Date.now();
  return query({}).then(tbs => previews.keep(new Set(tbs.map(original).filter(Boolean)), Date.now() - 60 * 1000));
};
prune.time = 0;

// the preview covers the whole page, up to this many screens; on longer pages, the screens around the
// position the user left the page at (SCREENS_ABOVE above it)
const SCREENS = 10;
const SCREENS_ABOVE = 3;
const MAX_HEIGHT = 16000; // CSS pixels

// the part of the page to capture, in CSS pixels relative to the page
const area = m => {
  const cap = Math.min(SCREENS * m.vh, MAX_HEIGHT);
  if (m.height <= cap) {
    return {x: 0, y: 0, width: m.width, height: m.height};
  }
  return {
    x: 0,
    y: Math.round(Math.max(0, Math.min(m.y - SCREENS_ABOVE * m.vh, m.height - cap))),
    width: m.width,
    height: Math.round(cap)
  };
};

// Firefox only (tabs.captureTab). It requires "<all_urls>" which Firefox grants on install because of the
// content script matches. Users can revoke it; then the placeholder is shown without a preview
const capture = async (tab, metrics) => {
  if (!chrome.tabs.captureTab) {
    return;
  }
  const granted = await chrome.permissions.contains({
    origins: ['<all_urls>']
  });
  if (granted !== true) {
    return log('dummy', 'preview is skipped', '"<all_urls>" permission is not granted');
  }
  const options = {
    format: 'jpeg',
    quality: 60,
    scale: 1
  };
  let image;
  let meta = {};
  if (metrics && metrics.width > 0 && metrics.height > 0 && metrics.vh > 0) {
    const rect = area(metrics);
    image = await chrome.tabs.captureTab(tab.id, {...options, rect}).catch(e => {
      log('dummy', 'full page capture failed', e.message || e);
    });
    if (image) {
      meta = {top: rect.y, y: metrics.y, width: rect.width};
    }
  }
  // visible part only
  if (!image) {
    image = await chrome.tabs.captureTab(tab.id, options);
  }
  await previews.set(tab.url, image, meta);
  await prune();
};

// one script for every frame:
// 1. does leaving this page show a "Leave page?" prompt (beforeunload)? Such pages cannot be replaced without
//    prompting the user. A synthetic and cancelable "beforeunload" event is dispatched to find out; listeners
//    that block leaving the page cancel it. This is the same set of pages that native discarding skips
// 2. size and scroll position of the top document (for the preview and to restore the scroll position)
const inspect = tab => chrome.scripting.executeScript({
  target: {
    tabId: tab.id,
    allFrames: true
  },
  world: 'MAIN',
  func: () => {
    let prompts = typeof window.onbeforeunload === 'function';
    if (prompts === false) {
      const e = new Event('beforeunload', {
        cancelable: true
      });
      window.dispatchEvent(e);
      prompts = e.defaultPrevented;
    }
    const root = document.scrollingElement || document.documentElement;
    return {
      prompts,
      width: root.clientWidth,
      height: root.scrollHeight,
      y: window.scrollY,
      vh: window.innerHeight
    };
  }
}).then(r => ({
  prompts: r.some(o => o.result && o.result.prompts),
  metrics: (r.find(o => o.frameId === 0) || {}).result
}));

// resolves when the placeholder page of this tab is loaded (or after 10 seconds)
const complete = id => new Promise(resolve => {
  const done = () => {
    chrome.tabs.onUpdated.removeListener(observe);
    clearTimeout(timer);
    resolve();
  };
  const observe = (tabId, info, tab) => {
    if (tabId === id && info.status === 'complete' && tab.url && tab.url.startsWith(PAGE)) {
      done();
    }
  };
  const timer = setTimeout(done, 10000);
  chrome.tabs.onUpdated.addListener(observe);
});

const placeholder = async tab => {
  // title, favicon, and URL might have been changed (e.g. 💤 prefix or plugins/youtube)
  const t = await chrome.tabs.get(tab.id);
  if (t.active || t.discarded) {
    return log('dummy', 'placeholder is skipped', 'tab is either active or discarded', t.id);
  }
  // only web pages can be restored from the placeholder
  if (/^https?:/.test(t.url) === false) {
    return method(t);
  }
  const {prompts, metrics} = await inspect(t).catch(() => ({prompts: true}));
  if (prompts) {
    log('dummy', 'placeholder is skipped', 'page asks before leaving', t.id);
    return method(t);
  }
  await capture(t, metrics).catch(e => log('dummy', 'preview capture failed', e.message || e));
  // the user might have switched to this tab while the preview was being captured
  if ((await chrome.tabs.get(t.id)).active) {
    return log('dummy', 'placeholder is skipped', 'tab got activated', t.id);
  }

  const args = new URLSearchParams();
  args.set('href', t.url);
  args.set('title', t.title || '');
  args.set('favicon', t.favIconUrl || '');
  args.set('time', Date.now());
  if (metrics && metrics.y > 0) {
    args.set('y', Math.round(metrics.y));
  }

  log('dummy', 'replacing with placeholder', t.id, t.url);
  const loaded = complete(t.id);
  // a regular navigation; the original page stays one step back in the session history
  await chrome.tabs.update(t.id, {
    url: PAGE + '?' + args.toString()
  });
  await loaded;
  // discard the placeholder natively. This is done here and not by the placeholder page since timers of
  // background tabs are throttled
  const pt = await chrome.tabs.get(t.id);
  if (pt.active === false && pt.discarded === false && pt.url.startsWith(PAGE)) {
    return method(pt);
  }
};

/* scroll position fallback. Going back in the history restores the scroll position of most pages; pages that
   rebuild themselves on load (single page apps) come back at the top. Those are scrolled to where the user
   left them */
const restoring = new Map(); // tab id → {href, y, time}
const scroll = (tabId, y) => chrome.scripting.executeScript({
  target: {
    tabId
  },
  args: [y],
  func: y => {
    if (window.scrollY < 10 && document.documentElement.scrollHeight > y) {
      window.scrollTo(0, y);
      return true;
    }
    return false;
  }
}).then(r => r[0] && r[0].result).catch(() => false);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const r = restoring.get(tabId);
  if (!r || info.status !== 'complete' || tab.url !== r.href) {
    return;
  }
  restoring.delete(tabId);
  if (Date.now() - r.time > 60 * 1000 || !(r.y > 100)) {
    return;
  }
  // once after load and once more for content that renders late
  setTimeout(() => scroll(tabId, r.y).then(done => {
    log('dummy', 'scroll position fallback', tabId, done);
    if (done === false) {
      setTimeout(() => scroll(tabId, r.y), 1500);
    }
  }), 300);
});

// serve previews to placeholder pages. They cannot read this IndexedDB themselves when they are loaded in a
// container tab (Firefox partitions the storage of extension pages by container). Registered at start-up so
// that a placeholder restored after a browser restart gets its preview even before the plug-in is enabled
chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === 'dummy.preview') {
    previews.get(request.href).then(r => response(r ? {
      image: r.image,
      top: r.top,
      y: r.y,
      width: r.width
    } : ''), () => response(''));
    return true;
  }
  if (request.method === 'dummy.restore' && sender.tab) {
    restoring.set(sender.tab.id, {
      href: request.href,
      y: request.y,
      time: Date.now()
    });
    response(true);
    return;
  }
  if (request.method === 'dummy.forget') {
    previews.remove(request.href).then(() => response(true), () => response(false));
    return true;
  }
});

// when the user leaves a placeholder that was selected (but not loaded), discard it again
const asleep = () => {
  clearTimeout(asleep.id);
  asleep.id = setTimeout(() => query({
    active: false,
    discarded: false
  }).then(tbs => tbs.filter(original).forEach(tb => {
    log('dummy', 'discarding a placeholder', tb.id);
    method(tb).catch(e => log('dummy', 'discarding a placeholder failed', e.message || e));
  })), 1000);
};

// registered at start-up so that it also wakes an idle background (event page). It only acts on placeholder
// tabs, which keep working when the plug-in gets disabled
chrome.tabs.onActivated.addListener(asleep);

function enable() {
  log('dummy.enable is called');
  discard.method = placeholder;
}
function disable() {
  log('dummy.disable is called');
  // placeholders that are already open keep working; they do not depend on this module
  discard.method = method;
}

export default {
  enable,
  disable
};
