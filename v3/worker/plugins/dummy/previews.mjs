/* screenshots of the tabs that are replaced by the placeholder page; keyed by the original URL.
   Shared between the background (writes) and the placeholder page (reads and removes) */

const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('dummy-previews', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('previews', {
    keyPath: 'href'
  });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transaction = (mode, c) => open().then(db => new Promise((resolve, reject) => {
  const tx = db.transaction('previews', mode);
  const result = c(tx.objectStore('previews'));
  tx.oncomplete = () => {
    db.close();
    resolve(result.result);
  };
  tx.onerror = tx.onabort = () => {
    db.close();
    reject(tx.error);
  };
}));

const previews = {
  get(href) {
    return transaction('readonly', store => store.get(href));
  },
  // meta: {top, y, width} of a full page preview, in CSS pixels
  set(href, image, meta = {}) {
    return transaction('readwrite', store => store.put({
      ...meta,
      href,
      image,
      time: Date.now()
    }));
  },
  remove(href) {
    return transaction('readwrite', store => store.delete(href));
  },
  // remove previews that are older than "before" unless they still belong to a placeholder tab
  keep(hrefs, before) {
    return transaction('readwrite', store => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (hrefs.has(cursor.key) === false && cursor.value.time < before) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      return request;
    });
  }
};

export {previews};
