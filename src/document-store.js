/* Device-local persistence for Proofnote documents and templates.
 *
 * A document's local identity belongs to this library layer, never to the
 * portable Proofnote Document JSON. IndexedDB is the primary store because a
 * document can contain data-URL image assets; localStorage is a deliberately
 * small, failure-tolerant fallback for browsers where IndexedDB is absent.
 */
(function (root) {
  "use strict";

  const DB_NAME = "proofnote-document-store";
  const DB_VERSION = 2;
  const CURRENT_KEY = "current-document"; // v1 record, retained for migration
  const CURRENT_DOCUMENT_ID_KEY = "currentDocumentId";
  const FALLBACK_CURRENT = "proofnote-document:current:v1";
  const FALLBACK_TEMPLATES = "proofnote-document:templates:v1";
  const FALLBACK_DOCUMENTS = "proofnote-document:documents:v1";
  const FALLBACK_CURRENT_DOCUMENT_ID = "proofnote-document:current-id:v1";

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function timestamp() { return new Date().toISOString(); }
  function newDocumentId() { return "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9); }
  function recordFor(document, existing) {
    const now = timestamp();
    return {
      id: existing && existing.id || newDocumentId(),
      document: clone(document),
      createdAt: existing && existing.createdAt || now,
      updatedAt: now,
      lastOpenedAt: existing && existing.lastOpenedAt || now
    };
  }
  function validRecord(value) { return Boolean(value && typeof value === "object" && typeof value.id === "string" && value.id && value.document && typeof value.document === "object"); }
  function ordered(records) {
    return records.filter(validRecord).sort((first, second) => String(second.updatedAt || second.lastOpenedAt || "").localeCompare(String(first.updatedAt || first.lastOpenedAt || "")));
  }
  function openDatabase() {
    if (!root.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("documents")) db.createObjectStore("documents");
        if (!db.objectStoreNames.contains("templates")) db.createObjectStore("templates", { keyPath: "template.id" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open IndexedDB"));
    });
  }
  function transaction(storeName, mode, action) {
    return openDatabase().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const objectStore = tx.objectStore(storeName);
      let result;
      try { result = action(objectStore); } catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : result); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("IndexedDB transaction failed")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("IndexedDB transaction aborted")); };
    }));
  }
  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result == null ? null : request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }
  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }
  function fallbackRead(key, empty) {
    try { return JSON.parse(root.localStorage.getItem(key) || JSON.stringify(empty)); } catch (_) { return empty; }
  }
  function fallbackReadString(key) {
    try { return String(root.localStorage.getItem(key) || ""); } catch (_) { return ""; }
  }
  function fallbackWrite(key, value) {
    try { root.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function fallbackWriteString(key, value) {
    try { root.localStorage.setItem(key, String(value || "")); return true; } catch (_) { return false; }
  }
  function fallbackRemove(key) {
    try {
      if (typeof root.localStorage.removeItem === "function") root.localStorage.removeItem(key);
      // A few embedded WebViews expose only getItem/setItem. `null` is still
      // an unambiguous cleared value for the JSON legacy document slot.
      else root.localStorage.setItem(key, "null");
      return true;
    } catch (_) { return false; }
  }
  function fallbackLibrary(seedDocument) {
    const raw = fallbackRead(FALLBACK_DOCUMENTS, []);
    const records = Array.isArray(raw) ? raw.filter(validRecord) : [];
    const legacy = fallbackRead(FALLBACK_CURRENT, null);
    const hasLegacy = Boolean(legacy && typeof legacy === "object");
    let currentId = fallbackReadString(FALLBACK_CURRENT_DOCUMENT_ID);
    let current = records.find((record) => record.id === currentId) || null;
    if (!current) {
      const remembered = ordered(records)[0] || null;
      if (remembered) return { records, current: remembered, currentId: remembered.id, migrated: true, hasLegacy };
      const document = legacy && typeof legacy === "object" ? legacy : seedDocument;
      if (!document || typeof document !== "object") return { records, current: null, currentId, migrated: false, hasLegacy };
      current = recordFor(document);
      records.push(current);
      currentId = current.id;
      return { records, current, currentId, migrated: true, hasLegacy };
    }
    return { records, current, currentId, migrated: false, hasLegacy };
  }
  function persistFallbackLibrary(library, includeLegacy) {
    const documentsSaved = fallbackWrite(FALLBACK_DOCUMENTS, library.records);
    const currentSaved = fallbackWriteString(FALLBACK_CURRENT_DOCUMENT_ID, library.currentId);
    // `current` was the v1 single-document cache. Once the document library
    // exists, retaining it creates a second migration source that can revive
    // deleted documents or duplicate the active one after a fallback.
    const legacySaved = includeLegacy === true && library.current
      ? fallbackWrite(FALLBACK_CURRENT, library.current.document)
      : fallbackRemove(FALLBACK_CURRENT);
    return documentsSaved && currentSaved && legacySaved;
  }
  async function readIndexedLibrary() {
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readonly");
      const documentRequest = tx.objectStore("documents").getAll();
      const currentRequest = tx.objectStore("settings").get(CURRENT_DOCUMENT_ID_KEY);
      const values = await Promise.all([requestValue(documentRequest), requestValue(currentRequest)]);
      await transactionDone(tx);
      const rows = Array.isArray(values[0]) ? values[0] : [];
      return {
        records: rows.filter(validRecord),
        legacy: rows.find((row) => row && row.document && !validRecord(row)) || null,
        currentId: values[1] && typeof values[1].value === "string" ? values[1].value : ""
      };
    } finally { db.close(); }
  }
  async function writeIndexedLibrary(options) {
    const opts = options || {};
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readwrite");
      const documents = tx.objectStore("documents");
      const settings = tx.objectStore("settings");
      (opts.put || []).forEach((record) => documents.put(clone(record), record.id));
      (opts.remove || []).forEach((id) => documents.delete(id));
      if (opts.currentId !== undefined) settings.put({ key: CURRENT_DOCUMENT_ID_KEY, value: opts.currentId });
      await transactionDone(tx);
    } finally { db.close(); }
  }
  async function initialiseIndexedLibrary(seedDocument) {
    const library = await readIndexedLibrary();
    let current = library.records.find((record) => record.id === library.currentId) || ordered(library.records)[0] || null;
    if (current) {
      current = Object.assign({}, current, { lastOpenedAt: timestamp() });
      await writeIndexedLibrary({ put: [current], remove: library.legacy ? [CURRENT_KEY] : [], currentId: current.id });
      return current;
    }
    const legacyDocument = library.legacy && library.legacy.document;
    const document = legacyDocument && typeof legacyDocument === "object" ? legacyDocument : seedDocument;
    if (!document || typeof document !== "object") return null;
    current = recordFor(document);
    await writeIndexedLibrary({ put: [current], remove: library.legacy ? [CURRENT_KEY] : [], currentId: current.id });
    return current;
  }

  const store = {
    // The only entry point that establishes a local document identity. It
    // migrates v1's one current document on first use without changing the
    // document's portable payload.
    async initialiseDocumentLibrary(seedDocument) {
      try {
        const record = await initialiseIndexedLibrary(seedDocument);
        return { record: record && clone(record), backend: "indexeddb" };
      } catch (_) {
        const library = fallbackLibrary(seedDocument);
        const saved = library.migrated || library.hasLegacy ? persistFallbackLibrary(library, false) : true;
        return { record: library.current && clone(library.current), backend: saved ? "localStorage" : "failed" };
      }
    },
    async listDocuments() {
      try { return ordered((await readIndexedLibrary()).records).map(clone); }
      catch (_) { return ordered(fallbackLibrary(null).records).map(clone); }
    },
    async createDocument(document) {
      const record = recordFor(document);
      try {
        await writeIndexedLibrary({ put: [record], currentId: record.id });
        return { record: clone(record), backend: "indexeddb" };
      } catch (_) {
        const library = fallbackLibrary(null);
        library.records.push(record); library.current = record; library.currentId = record.id;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }
    },
    async openDocument(id) {
      try {
        const library = await readIndexedLibrary();
        const found = library.records.find((record) => record.id === id);
        if (!found) return null;
        const record = Object.assign({}, found, { lastOpenedAt: timestamp() });
        await writeIndexedLibrary({ put: [record], currentId: record.id });
        return { record: clone(record), backend: "indexeddb" };
      } catch (_) {
        const library = fallbackLibrary(null);
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return null;
        const record = Object.assign({}, library.records[index], { lastOpenedAt: timestamp() });
        library.records[index] = record; library.current = record; library.currentId = record.id;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }
    },
    async saveDocument(id, document) {
      try {
        const library = await readIndexedLibrary();
        const existing = library.records.find((record) => record.id === id);
        const record = recordFor(document, existing || { id: id || newDocumentId() });
        record.id = id || record.id;
        record.lastOpenedAt = existing && existing.lastOpenedAt || record.lastOpenedAt;
        await writeIndexedLibrary({ put: [record], currentId: id || library.currentId || record.id });
        return "indexeddb";
      } catch (_) {
        const library = fallbackLibrary(document);
        const index = library.records.findIndex((record) => record.id === id);
        const record = recordFor(document, index >= 0 ? library.records[index] : { id: id || newDocumentId() });
        record.id = id || record.id;
        if (index >= 0) library.records[index] = record;
        else library.records.push(record);
        if (library.currentId === record.id) library.current = record;
        return persistFallbackLibrary(library) ? "localStorage" : "failed";
      }
    },
    async renameDocument(id, name) {
      const nextName = String(name || "").trim();
      if (!nextName) return null;
      const apply = (record) => {
        const next = Object.assign({}, record, { document: clone(record.document), updatedAt: timestamp() });
        next.document.metadata = Object.assign({}, next.document.metadata, { name: nextName, updatedAt: next.updatedAt });
        return next;
      };
      try {
        const library = await readIndexedLibrary();
        const found = library.records.find((record) => record.id === id);
        if (!found) return null;
        const record = apply(found);
        await writeIndexedLibrary({ put: [record] });
        return { record: clone(record), backend: "indexeddb" };
      } catch (_) {
        const library = fallbackLibrary(null);
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return null;
        const record = apply(library.records[index]);
        library.records[index] = record;
        if (library.currentId === record.id) library.current = record;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }
    },
    async duplicateDocument(id, name) {
      try {
        const library = await readIndexedLibrary();
        const source = library.records.find((record) => record.id === id);
        if (!source) return null;
        const document = clone(source.document);
        document.metadata = Object.assign({}, document.metadata, { name: String(name || document.metadata && document.metadata.name || "Untitled document"), updatedAt: timestamp() });
        const record = recordFor(document);
        await writeIndexedLibrary({ put: [record], currentId: record.id });
        return { record: clone(record), backend: "indexeddb" };
      } catch (_) {
        const library = fallbackLibrary(null);
        const source = library.records.find((record) => record.id === id);
        if (!source) return null;
        const document = clone(source.document);
        document.metadata = Object.assign({}, document.metadata, { name: String(name || document.metadata && document.metadata.name || "Untitled document"), updatedAt: timestamp() });
        const record = recordFor(document);
        library.records.push(record); library.current = record; library.currentId = record.id;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }
    },
    async deleteDocument(id) {
      try {
        const library = await readIndexedLibrary();
        const wasCurrent = library.currentId === id;
        await writeIndexedLibrary({ remove: wasCurrent ? [id, CURRENT_KEY] : [id], currentId: wasCurrent ? "" : library.currentId });
        return "indexeddb";
      } catch (_) {
        const library = fallbackLibrary(null);
        library.records = library.records.filter((record) => record.id !== id);
        if (library.currentId === id) { library.currentId = ""; library.current = null; }
        return persistFallbackLibrary(library) ? "localStorage" : "failed";
      }
    },

    // Compatibility aliases used by older callers. New editor code always
    // names a document record explicitly.
    async loadCurrent() {
      const loaded = await this.initialiseDocumentLibrary(null);
      return loaded.record ? clone(loaded.record.document) : null;
    },
    async saveCurrent(document) {
      const loaded = await this.initialiseDocumentLibrary(document);
      if (!loaded.record) return "failed";
      return this.saveDocument(loaded.record.id, document);
    },
    async listTemplates() {
      try {
        const db = await openDatabase();
        const tx = db.transaction("templates", "readonly");
        const value = await requestValue(tx.objectStore("templates").getAll());
        await transactionDone(tx); db.close();
        return Array.isArray(value) ? value.map(clone) : [];
      } catch (_) { return fallbackRead(FALLBACK_TEMPLATES, []); }
    },
    async saveTemplate(template) {
      const payload = clone(template);
      try { await transaction("templates", "readwrite", (objectStore) => objectStore.put(payload)); return "indexeddb"; }
      catch (_) {
        const templates = fallbackRead(FALLBACK_TEMPLATES, []).filter((item) => item && item.template && item.template.id !== payload.template.id);
        templates.push(payload);
        return fallbackWrite(FALLBACK_TEMPLATES, templates) ? "localStorage" : "failed";
      }
    },
    async deleteTemplate(templateId) {
      try { await transaction("templates", "readwrite", (objectStore) => objectStore.delete(templateId)); return "indexeddb"; }
      catch (_) {
        return fallbackWrite(FALLBACK_TEMPLATES, fallbackRead(FALLBACK_TEMPLATES, []).filter((item) => item && item.template && item.template.id !== templateId)) ? "localStorage" : "failed";
      }
    }
  };
  root.ProofnoteStore = store;
})(window);
