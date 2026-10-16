import {overwrite, release} from '../loader.mjs';
import {log, query} from '../../core/utils.mjs';
import {storage} from '../../core/prefs.mjs';

/* "blank.newtab": instead of the temporary blank page, open the browser's new tab page next to the tab that
   gets discarded. It stays if it is used; it is closed when the user leaves it unused. Tracked tabs are kept
   in the session storage so that a restarted background still knows them */
const NEWTABS = 'blank.newtabs';
const newtabs = () => chrome.storage.session.get({[NEWTABS]: []}).then(ps => ps[NEWTABS]);

const track = async id => {
  const tabs = await newtabs();
  tabs.push({id, created: Date.now()});
  await chrome.storage.session.set({[NEWTABS]: tabs});
};
// any navigation after the new tab page loaded means the tab is in use (URLs of internal pages are not
// visible to the extension, so loading events are used instead)
const used = async (tabId, info) => {
  if (info.status !== 'loading') {
    return;
  }
  const tabs = await newtabs();
  const t = tabs.find(t => t.id === tabId);
  if (t && Date.now() - t.created > 1000) {
    log('blank', 'new tab is in use', tabId);
    await chrome.storage.session.set({[NEWTABS]: tabs.filter(t => t.id !== tabId)});
  }
};
// close tracked new tabs that are left unused
const cleanup = async () => {
  const tabs = await newtabs();
  if (tabs.length === 0) {
    return;
  }
  const keep = [];
  for (const t of tabs) {
    const tab = await chrome.tabs.get(t.id).catch(() => null);
    if (!tab || /^(https?|file):/.test(tab.url || '')) {
      continue;
    }
    if (tab.active) {
      keep.push(t);
      continue;
    }
    log('blank', 'closing the unused new tab', t.id);
    chrome.tabs.remove(t.id).catch(() => {});
  }
  await chrome.storage.session.set({[NEWTABS]: keep});
};

function enable() {
  log('blank.enable is called');
  overwrite('before-menu-click', function({menuItemId}, tab) {
    log('menu command:', menuItemId);
    if (menuItemId === 'release-tabs' || menuItemId === 'release-other-windows') {
      return query({
        active: true,
        currentWindow: false
      }).then(tbs => {
        for (const tb of tbs) {
          chrome.tabs.sendMessage(tb.id, {
            method: 'tab-is-active'
          });
        }
      });
    }
    else if (menuItemId === 'discard-other-windows' || menuItemId === 'discard-tabs') {
      return query({
        active: true,
        currentWindow: false,
        url: '*://*/*' // only if the active tab is not an internal page
      }).then(tbs => Promise.all(tbs.map(tb => {
        const args = new URLSearchParams();
        args.set('title', tb.title);
        args.set('favicon', tb.favIconUrl);

        return chrome.tabs.create({
          openerTabId: tb.id,
          windowId: tb.windowId,
          url: '/worker/plugins/blank/blank.html?' + args.toString(),
          index: tb.index
        });
      })));
    }
    else if (menuItemId === 'discard-tab' || menuItemId === 'discard-tree') {
      return query({
        active: false,
        highlighted: false,
        windowId: tab.windowId, // the window of the tab, like the discarding itself (menu.mjs)
        discarded: false
      }).then(async tbs => {
        if (tbs.length === 0 && tab.url?.startsWith('http')) {
          const prefs = await storage({
            'blank.newtab': false
          });
          if (prefs['blank.newtab']) {
            const t = await chrome.tabs.create({
              openerTabId: tab.id,
              windowId: tab.windowId,
              index: tab.index + 1,
              active: false
            });
            await track(t.id);
            return t;
          }

          const args = new URLSearchParams();
          args.set('title', tab.title);
          args.set('favicon', tab.favIconUrl);

          return chrome.tabs.create({
            openerTabId: tab.id,
            windowId: tab.windowId,
            url: '/worker/plugins/blank/blank.html?' + args.toString(),
            index: tab.index,
            active: false // so that this tab gets focused
          });
        }
      });
    }
  });
  chrome.tabs.onActivated.addListener(cleanup);
  chrome.tabs.onUpdated.addListener(used);
}
function disable() {
  log('blank.disable is called');
  release('before-menu-click');
  chrome.tabs.onActivated.removeListener(cleanup);
  chrome.tabs.onUpdated.removeListener(used);
}

export default {
  enable,
  disable
};
