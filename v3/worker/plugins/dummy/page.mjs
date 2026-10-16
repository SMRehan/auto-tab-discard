const args = new URLSearchParams(location.search);
const href = args.get('href') || '';
const title = args.get('title') || href;
const restorable = /^https?:/.test(href);

// localization
[...document.querySelectorAll('[data-i18n]')].forEach(e => {
  e.textContent = chrome.i18n.getMessage(e.dataset.i18n);
});

document.title = title;
document.getElementById('title').textContent = title;
{
  const a = document.getElementById('href');
  a.textContent = href;
  if (restorable) {
    a.href = href; // middle-click opens the original page in a new tab
  }
}
{
  const favicon = args.get('favicon');
  if (favicon) {
    document.head.appendChild(Object.assign(document.createElement('link'), {
      rel: 'icon',
      href: favicon
    }));
    document.getElementById('favicon').src = favicon;
  }
}
{
  const time = Number(args.get('time'));
  if (time) {
    const minutes = Math.round((Date.now() - time) / 60000);
    const format = new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'});
    const [value, unit] = minutes < 60 ? [minutes, 'minute'] :
      (minutes < 60 * 24 ? [Math.round(minutes / 60), 'hour'] : [Math.round(minutes / 60 / 24), 'day']);
    document.getElementById('time').textContent = chrome.i18n.getMessage('dummy_time') + ' ' +
      format.format(-value, unit);
  }
}

// previews are served by the background. Firefox partitions the storage of extension pages that are loaded in a
// container tab, so this page cannot read the background's IndexedDB directly
chrome.runtime.sendMessage({
  method: 'dummy.preview',
  href
}).then(r => {
  // older previews are a plain image of the visible part
  const {image, top, y, width} = typeof r === 'string' ? {image: r} : (r || {});
  if (image) {
    const img = document.getElementById('preview');
    img.onload = () => {
      // full page preview: open it where the user left the page (the title bar is sticky, so the preview
      // starts right below it at this scroll position)
      if (width > 0 && typeof top === 'number' && typeof y === 'number') {
        const ratio = img.clientWidth / width;
        document.scrollingElement.scrollTop = Math.max(0, (y - top) * ratio);
      }
    };
    img.src = image;
  }
}).catch(e => console.warn('cannot read the preview', e));

/* load the original page */
let loading = false;

// remove the preview unless another placeholder tab still needs it
const cleanup = async () => {
  const self = await chrome.tabs.getCurrent();
  const tabs = await chrome.tabs.query({});
  const used = tabs.some(t => t.id !== self.id && t.url && t.url.startsWith(location.origin + location.pathname) &&
    new URL(t.url).searchParams.get('href') === href);
  if (used === false) {
    await chrome.runtime.sendMessage({
      method: 'dummy.forget',
      href
    });
  }
};

const load = () => {
  if (loading || restorable === false) {
    return;
  }
  loading = true;
  document.body.classList.add('loading');

  // the background scrolls pages that do not restore their own scroll position (single page apps). The
  // message must be delivered before this page unloads, so wait for the answer
  const y = Number(args.get('y'));
  const restore = y > 0 ? chrome.runtime.sendMessage({
    method: 'dummy.restore',
    href,
    y
  }) : Promise.resolve();

  Promise.race([
    Promise.all([
      cleanup().catch(e => console.warn('cannot remove the preview', e)),
      restore.catch(e => console.warn('cannot ask for the scroll position fallback', e)),
      chrome.runtime.sendMessage({
        method: 'dummy.stat',
        type: 'restore',
        href
      }).catch(() => {})
    ]),
    new Promise(resolve => setTimeout(resolve, 500))
  ]).then(() => {
    // the original page is one step back in the session history. Going back restores its scroll
    // position and form data. If there is no history (e.g. the history got cleared), load the URL
    if (history.length > 1) {
      const id = setTimeout(() => location.replace(href), 1000);
      addEventListener('beforeunload', () => clearTimeout(id));
      history.back();
    }
    else {
      location.replace(href);
    }
  });
};

document.addEventListener('click', e => {
  if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    load();
  }
});
document.addEventListener('keydown', e => {
  // Space, arrows, and Page Up/Down scroll the preview
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    load();
  }
});

/* the background discards this placeholder right after it is created. Discard it whenever it gets hidden too
   (e.g. after it was selected but not loaded, or when it is restored in the background after a browser
   restart), so only a lightweight local page gets loaded when the tab is selected next time */
// a placeholder that is shown instead of the page is a reload avoided (logged once per showing)
const viewed = () => {
  if (document.hidden === false && loading === false && viewed.shown !== true) {
    viewed.shown = true;
    chrome.runtime.sendMessage({
      method: 'dummy.stat',
      type: 'view',
      href
    }).catch(() => {});
  }
  if (document.hidden) {
    viewed.shown = false;
  }
};
document.addEventListener('visibilitychange', viewed);
viewed();

const sleep = () => {
  clearTimeout(sleep.id);
  if (document.hidden && loading === false) {
    sleep.id = setTimeout(() => chrome.tabs.getCurrent().then(tab => {
      if (tab && tab.active === false && tab.discarded === false) {
        return chrome.tabs.discard(tab.id);
      }
    }).catch(e => console.warn('cannot discard the placeholder', e)), 1000);
  }
};
document.addEventListener('visibilitychange', sleep);
sleep();
