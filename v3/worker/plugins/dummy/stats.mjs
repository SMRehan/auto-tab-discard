/* event log of the placeholder plug-in, so that tools outside the extension can relate memory measurements to
   what happened (e.g. a memory report). Kept local in the IndexedDB "dummy-stats" for 30 days; one record per
   event, stored as a JSON string so readers do not need to decode structured objects:
     {"t": 1792160000000, "type": "placeholder" | "native" | "view" | "restore", "host": "example.com"}
   placeholder: a tab was replaced by the placeholder; native: a tab was discarded natively instead;
   view: a placeholder was shown without loading the page (a reload avoided); restore: the page was loaded */

const KEEP = 30 * 24 * 60 * 60 * 1000;

const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('dummy-stats', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('events', {
    autoIncrement: true
  });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const host = href => {
  try {
    return new URL(href).hostname;
  }
  catch (e) {
    return '';
  }
};

// remove events older than 30 days (at most once per day)
const prune = db => {
  if (Date.now() - prune.time < 24 * 60 * 60 * 1000) {
    return;
  }
  prune.time = Date.now();
  const store = db.transaction('events', 'readwrite').objectStore('events');
  store.openCursor().onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) {
      if (JSON.parse(cursor.value).t < Date.now() - KEEP) {
        cursor.delete();
        cursor.continue();
      }
    }
  };
};
prune.time = 0;

const stats = {
  record(type, href) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').add(JSON.stringify({
        t: Date.now(),
        type,
        host: host(href)
      }));
      tx.oncomplete = () => {
        prune(db);
        db.close(); // pending transactions (prune) still complete
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    })).catch(e => console.warn('cannot record the event', e));
  }
};

export {stats};
