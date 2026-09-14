/* Device-local persistence for Proofnote documents and templates.
 *
 * IndexedDB is the primary store because documents can contain data-URL image
 * assets. localStorage remains a small, failure-tolerant fallback for browsers
 * where IndexedDB is unavailable (for example, private browsing modes).
 */
(function (root) {
  "use strict";

  const DB_NAME = "proofnote-document-store";
  const DB_VERSION = 1;
  const CURRENT_KEY = "current-document";
  const FALLBACK_CURRENT = "proofnote-document:current:v1";
  const FALLBACK_TEMPLATES = "proofnote-document:templates:v1";

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function openDatabase() {
    if (!root.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("documents")) db.createObjectStore("documents");
        if (!db.objectStoreNames.contains("templates")) db.createObjectStore("templates", { keyPath: "template.id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open IndexedDB"));
    });
  }
  async function transaction(storeName, mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try { result = action(store); } catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : result); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("IndexedDB transaction failed")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("IndexedDB transaction aborted")); };
    });
  }
  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }
  function fallbackRead(key, empty) {
    try { return JSON.parse(root.localStorage.getItem(key) || JSON.stringify(empty)); } catch (_) { return empty; }
  }
  function fallbackWrite(key, value) {
    try { root.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }

  const store = {
    async loadCurrent() {
      try {
        const db = await openDatabase();
        const tx = db.transaction("documents", "readonly");
        const request = tx.objectStore("documents").get(CURRENT_KEY);
        const value = await requestValue(request);
        db.close();
        return value && value.document ? clone(value.document) : null;
      } catch (_) {
        return fallbackRead(FALLBACK_CURRENT, null);
      }
    },
    async saveCurrent(document) {
      const payload = { document: clone(document), savedAt: new Date().toISOString() };
      try {
        await transaction("documents", "readwrite", (objectStore) => objectStore.put(payload, CURRENT_KEY));
        return "indexeddb";
      } catch (_) {
        return fallbackWrite(FALLBACK_CURRENT, payload.document) ? "localStorage" : "failed";
      }
    },
    async listTemplates() {
      try {
        const db = await openDatabase();
        const tx = db.transaction("templates", "readonly");
        const request = tx.objectStore("templates").getAll();
        const value = await requestValue(request);
        db.close();
        return Array.isArray(value) ? value.map(clone) : [];
      } catch (_) {
        return fallbackRead(FALLBACK_TEMPLATES, []);
      }
    },
    async saveTemplate(template) {
      const payload = clone(template);
      try {
        await transaction("templates", "readwrite", (objectStore) => objectStore.put(payload));
        return "indexeddb";
      } catch (_) {
        const templates = fallbackRead(FALLBACK_TEMPLATES, []).filter((item) => item && item.template && item.template.id !== payload.template.id);
        templates.push(payload);
        return fallbackWrite(FALLBACK_TEMPLATES, templates) ? "localStorage" : "failed";
      }
    },
    async deleteTemplate(templateId) {
      try {
        await transaction("templates", "readwrite", (objectStore) => objectStore.delete(templateId));
        return "indexeddb";
      } catch (_) {
        return fallbackWrite(FALLBACK_TEMPLATES, fallbackRead(FALLBACK_TEMPLATES, []).filter((item) => item && item.template && item.template.id !== templateId)) ? "localStorage" : "failed";
      }
    }
  };
  root.ProofnoteStore = store;
})(window);
