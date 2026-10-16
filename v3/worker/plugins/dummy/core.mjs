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

// Firefox only (tabs.captureTab). It requires "<all_urls>" which Firefox grants on install because of the
// content script matches. Users can revoke it; then the placeholder is shown without a preview
const capture = async tab => {
  if (!chrome.tabs.captureTab) {
    return;
  }
  const granted = await chrome.permissions.contains({
    origins: ['<all_urls>']
  });
  if (granted !== true) {
    return log('dummy', 'preview is skipped', '"<all_urls>" permission is not granted');
  }
  const image = await chrome.tabs.captureTab(tab.id, {
    format: 'jpeg',
    quality: 60,
    scale: 1
  });
  await previews.set(tab.url, image);
  await prune();
};

// does leaving this page show a "Leave page?" prompt (beforeunload)? Such pages cannot be replaced without
// prompting the user. A synthetic and cancelable "beforeunload" event is dispatched to find out; listeners
// that block leaving the page cancel it. This is the same set of pages that native discarding skips
const prompts = tab => chrome.scripting.executeScript({
  target: {
    tabId: tab.id,
    allFrames: true
  },
  world: 'MAIN',
  func: () => {
    if (typeof window.onbeforeunload === 'function') {
      return true;
    }
    const e = new Event('beforeunload', {
      cancelable: true
    });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  }
}).then(r => r.some(o => o.result === true));

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
  if (await prompts(t).catch(() => true)) {
    log('dummy', 'placeholder is skipped', 'page asks before leaving', t.id);
    return method(t);
  }
  await capture(t).catch(e => log('dummy', 'preview capture failed', e.message || e));
  // the user might have switched to this tab while the preview was being captured
  if ((await chrome.tabs.get(t.id)).active) {
    return log('dummy', 'placeholder is skipped', 'tab got activated', t.id);
  }

  const args = new URLSearchParams();
  args.set('href', t.url);
  args.set('title', t.title || '');
  args.set('favicon', t.favIconUrl || '');
  args.set('time', Date.now());

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

function enable() {
  log('dummy.enable is called');
  discard.method = placeholder;
  chrome.tabs.onActivated.addListener(asleep);
}
function disable() {
  log('dummy.disable is called');
  // placeholders that are already open keep working; they do not depend on this module
  discard.method = method;
  chrome.tabs.onActivated.removeListener(asleep);
}

export default {
  enable,
  disable
};
