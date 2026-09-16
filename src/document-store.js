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
  // Pick one durable backend for the lifetime of this page. Falling back from
  // a healthy IndexedDB session for one failed write creates two divergent
  // histories, and a later reload would silently prefer the older IndexedDB
  // copy. A transient IndexedDB failure is therefore reported as a failure;
  // fallback storage is selected only when IndexedDB cannot start a session.
  let sessionBackend = "";

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
  // Project documents expose one reader-facing name in the library, title,
  // running header, and footer. Library-level rename/duplicate operations must
  // preserve that invariant just like an in-canvas title edit does.
  function documentWithName(document, name) {
    const next = clone(document || {});
    const nextName = String(name || "").trim();
    next.metadata = Object.assign({}, next.metadata, { name: nextName });
    if (next.metadata.documentType === "Project") {
      const blocks = Array.isArray(next.blocks) ? next.blocks : [];
      const title = blocks.find((block) => block && block.type === "title");
      if (title) title.content = nextName;
      const header = next.metadata.runningHeader && typeof next.metadata.runningHeader === "object" && !Array.isArray(next.metadata.runningHeader)
        ? next.metadata.runningHeader : {};
      const hasRight = Object.prototype.hasOwnProperty.call(header, "right");
      next.metadata.runningHeader = {
        left: nextName,
        right: hasRight ? String(header.right || "") : "Project"
      };
    }
    return next;
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

  async function useStorageSession(indexedOperation, fallbackOperation, failedValue) {
    if (sessionBackend === "localStorage") return fallbackOperation();
    try {
      const result = await indexedOperation();
      sessionBackend = "indexeddb";
      return result;
    } catch (_) {
      // Once IndexedDB has successfully served this session, never write a
      // one-off fallback copy. That would be a false successful save.
      if (sessionBackend === "indexeddb") return typeof failedValue === "function" ? failedValue() : failedValue;
      sessionBackend = "localStorage";
      return fallbackOperation();
    }
  }

  const store = {
    // The only entry point that establishes a local document identity. It
    // migrates v1's one current document on first use without changing the
    // document's portable payload.
    async initialiseDocumentLibrary(seedDocument) {
      return useStorageSession(async () => {
        const record = await initialiseIndexedLibrary(seedDocument);
        return { record: record && clone(record), backend: "indexeddb" };
      }, () => {
        const library = fallbackLibrary(seedDocument);
        const saved = library.migrated || library.hasLegacy ? persistFallbackLibrary(library, false) : true;
        return { record: library.current && clone(library.current), backend: saved ? "localStorage" : "failed" };
      }, () => ({ record: null, backend: "failed" }));
    },
    async listDocuments() {
      return useStorageSession(
        async () => ordered((await readIndexedLibrary()).records).map(clone),
        () => ordered(fallbackLibrary(null).records).map(clone),
        () => []
      );
    },
    async createDocument(document) {
      const record = recordFor(document);
      return useStorageSession(async () => {
        await writeIndexedLibrary({ put: [record], currentId: record.id });
        return { record: clone(record), backend: "indexeddb" };
      }, () => {
        const library = fallbackLibrary(null);
        library.records.push(record); library.current = record; library.currentId = record.id;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => ({ record: null, backend: "failed" }));
    },
    async openDocument(id) {
      return useStorageSession(async () => {
        const library = await readIndexedLibrary();
        const found = library.records.find((record) => record.id === id);
        if (!found) return null;
        const record = Object.assign({}, found, { lastOpenedAt: timestamp() });
        await writeIndexedLibrary({ put: [record], currentId: record.id });
        return { record: clone(record), backend: "indexeddb" };
      }, () => {
        const library = fallbackLibrary(null);
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return null;
        const record = Object.assign({}, library.records[index], { lastOpenedAt: timestamp() });
        library.records[index] = record; library.current = record; library.currentId = record.id;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => null);
    },
    async saveDocument(id, document) {
      return useStorageSession(async () => {
        const library = await readIndexedLibrary();
        const existing = library.records.find((record) => record.id === id);
        const record = recordFor(document, existing || { id: id || newDocumentId() });
        record.id = id || record.id;
        record.lastOpenedAt = existing && existing.lastOpenedAt || record.lastOpenedAt;
        // Saving a background record must not silently switch the current
        // document. The open/create operations own current-document changes.
        await writeIndexedLibrary({ put: [record], currentId: library.currentId || record.id });
        return "indexeddb";
      }, () => {
        const library = fallbackLibrary(document);
        const index = library.records.findIndex((record) => record.id === id);
        const record = recordFor(document, index >= 0 ? library.records[index] : { id: id || newDocumentId() });
        record.id = id || record.id;
        if (index >= 0) library.records[index] = record;
        else library.records.push(record);
        if (library.currentId === record.id) library.current = record;
        return persistFallbackLibrary(library) ? "localStorage" : "failed";
      }, "failed");
    },
    async renameDocument(id, name) {
      const nextName = String(name || "").trim();
      if (!nextName) return null;
      const apply = (record) => {
        const updatedAt = timestamp();
        const document = documentWithName(record.document, nextName);
        document.metadata = Object.assign({}, document.metadata, { updatedAt });
        return Object.assign({}, record, { document, updatedAt });
      };
      return useStorageSession(async () => {
        const library = await readIndexedLibrary();
        const found = library.records.find((record) => record.id === id);
        if (!found) return null;
        const record = apply(found);
        await writeIndexedLibrary({ put: [record] });
        return { record: clone(record), backend: "indexeddb" };
      }, () => {
        const library = fallbackLibrary(null);
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return null;
        const record = apply(library.records[index]);
        library.records[index] = record;
        if (library.currentId === record.id) library.current = record;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => null);
    },
    async duplicateDocument(id, name) {
      return useStorageSession(async () => {
        const library = await readIndexedLibrary();
        const source = library.records.find((record) => record.id === id);
        if (!source) return null;
        const nextName = String(name || source.document.metadata && source.document.metadata.name || "Untitled document");
        const document = documentWithName(source.document, nextName);
        document.metadata = Object.assign({}, document.metadata, { updatedAt: timestamp() });
        const record = recordFor(document);
        await writeIndexedLibrary({ put: [record], currentId: record.id });
        return { record: clone(record), backend: "indexeddb" };
      }, () => {
        const library = fallbackLibrary(null);
        const source = library.records.find((record) => record.id === id);
        if (!source) return null;
        const nextName = String(name || source.document.metadata && source.document.metadata.name || "Untitled document");
        const document = documentWithName(source.document, nextName);
        document.metadata = Object.assign({}, document.metadata, { updatedAt: timestamp() });
        const record = recordFor(document);
        library.records.push(record); library.current = record; library.currentId = record.id;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => null);
    },
    async deleteDocument(id) {
      return useStorageSession(async () => {
        const library = await readIndexedLibrary();
        const wasCurrent = library.currentId === id;
        await writeIndexedLibrary({ remove: wasCurrent ? [id, CURRENT_KEY] : [id], currentId: wasCurrent ? "" : library.currentId });
        return "indexeddb";
      }, () => {
        const library = fallbackLibrary(null);
        library.records = library.records.filter((record) => record.id !== id);
        if (library.currentId === id) { library.currentId = ""; library.current = null; }
        return persistFallbackLibrary(library) ? "localStorage" : "failed";
      }, "failed");
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
      return useStorageSession(async () => {
        const db = await openDatabase();
        const tx = db.transaction("templates", "readonly");
        const value = await requestValue(tx.objectStore("templates").getAll());
        await transactionDone(tx); db.close();
        return Array.isArray(value) ? value.map(clone) : [];
      }, () => fallbackRead(FALLBACK_TEMPLATES, []), () => []);
    },
    async saveTemplate(template) {
      const payload = clone(template);
      return useStorageSession(async () => {
        await transaction("templates", "readwrite", (objectStore) => objectStore.put(payload));
        return "indexeddb";
      }, () => {
        const templates = fallbackRead(FALLBACK_TEMPLATES, []).filter((item) => item && item.template && item.template.id !== payload.template.id);
        templates.push(payload);
        return fallbackWrite(FALLBACK_TEMPLATES, templates) ? "localStorage" : "failed";
      }, "failed");
    },
    async deleteTemplate(templateId) {
      return useStorageSession(async () => {
        await transaction("templates", "readwrite", (objectStore) => objectStore.delete(templateId));
        return "indexeddb";
      }, () => {
        return fallbackWrite(FALLBACK_TEMPLATES, fallbackRead(FALLBACK_TEMPLATES, []).filter((item) => item && item.template && item.template.id !== templateId)) ? "localStorage" : "failed";
      }, "failed");
    }
  };
  root.ProofnoteStore = store;
})(window);

// This application has no build step, so the model and store are loaded as
// adjacent classic scripts before the editor. Keep a compact defence-in-depth
// layer here to make the untrusted JSON boundary and the local persistence
// boundary agree on limits and coercions without changing the public 1.0
// interchange shape.
(function hardenProofnoteDocumentBoundary(root) {
  "use strict";
  const Model = root.ProofnoteDocument;
  if (!Model || Model.__boundaryHardened) return;

  const MAX_ID_LENGTH = 256;
  const RESERVED_BLOCK_IDS = new Set(["__proofnote_header__"]);
  const limits = Model.LIMITS || {};
  const maxStringLength = limits.maxStringLength || 200000;
  const maxImageDataUrlLength = limits.maxImageDataUrlLength || 14 * 1024 * 1024;
  const originalNormalizeBlock = Model.normalizeBlock;
  const originalNormalizeDocument = Model.normalizeDocument;
  const originalValidateDocumentRaw = Model.validateDocumentRaw;
  const originalValidateTemplateRaw = Model.validateTemplateRaw;
  const originalMakeTemplate = Model.makeTemplate;
  const originalNormalizeTemplate = Model.normalizeTemplate;

  function isObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  function generatedId(prefix) { return (prefix || "item") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9); }
  function idIsUnsafe(value) {
    return typeof value === "string" && (value.length > MAX_ID_LENGTH || RESERVED_BLOCK_IDS.has(value));
  }
  function sanitizeBlock(raw) {
    if (!isObject(raw)) return raw;
    const next = Object.assign({}, raw);
    if (idIsUnsafe(next.id)) next.id = "";
    if (next.type === "list") next.ordered = next.ordered === true;
    return next;
  }
  function sanitizeDocument(raw) {
    if (!isObject(raw)) return raw;
    const next = Object.assign({}, raw);
    if (Array.isArray(raw.blocks)) next.blocks = raw.blocks.map(sanitizeBlock);
    return next;
  }
  function uniquePush(target, issue) {
    const key = String(issue && issue.path || "") + "\u0000" + String(issue && issue.message || "");
    if (!target.some((current) => String(current && current.path || "") + "\u0000" + String(current && current.message || "") === key)) target.push(issue);
  }
  function allowedLargeImagePaths(document) {
    const allowed = new Set();
    if (!document || !Array.isArray(document.blocks)) return allowed;
    document.blocks.forEach((block, index) => {
      const source = block && typeof block.src === "string" ? block.src : "";
      if (block && block.type === "image"
        && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(source)
        && source.length > maxStringLength
        && source.length <= maxImageDataUrlLength) {
        allowed.add("blocks[" + index + "].src");
      }
    });
    return allowed;
  }
  function filterImageLengthFalsePositives(errors, document) {
    const allowed = allowedLargeImagePaths(document);
    return (errors || []).filter((issue) => !(allowed.has(issue.path) && issue.message === "Text exceeds the maximum supported length."));
  }
  function hardenDocumentValidation(raw, baseResult) {
    const result = baseResult || { errors: [], warnings: [] };
    const errors = filterImageLengthFalsePositives(result.errors, raw);
    const warnings = (result.warnings || []).slice();
    const addError = (path, message) => uniquePush(errors, { path, message });
    const addWarning = (path, message) => uniquePush(warnings, { path, message });
    const checkLength = (path, value) => {
      if (typeof value === "string" && value.length > maxStringLength) addError(path, "Text exceeds the maximum supported length.");
    };

    if (isObject(raw && raw.metadata)) {
      ["name", "templateName", "documentType", "language", "noteNumber", "author", "date", "status", "source", "createdAt", "updatedAt"].forEach((key) => checkLength("metadata." + key, raw.metadata[key]));
      if (isObject(raw.metadata.runningHeader)) {
        checkLength("metadata.runningHeader.left", raw.metadata.runningHeader.left);
        checkLength("metadata.runningHeader.right", raw.metadata.runningHeader.right);
      }
    }

    if (raw && Array.isArray(raw.blocks)) {
      raw.blocks.slice(0, limits.maxBlocks || 2000).forEach((block, index) => {
        if (!isObject(block)) return;
        const path = "blocks[" + index + "]";
        if (typeof block.id === "string") {
          if (block.id.length > MAX_ID_LENGTH) addWarning(path + ".id", "Block ID is too long and will be regenerated.");
          if (RESERVED_BLOCK_IDS.has(block.id)) addWarning(path + ".id", "Reserved block ID will be regenerated.");
        }
        if (!Model.BLOCK_TYPES.includes(block.type)) {
          if (block.content !== undefined && typeof block.content !== "string") addWarning(path + ".content", "Expected a string; it will be treated as empty text.");
          checkLength(path + ".content", block.content);
        }
        if (block.type === "table" && (!Array.isArray(block.columns) || block.columns.length === 0) && Array.isArray(block.rows)) {
          const expected = 2;
          block.rows.slice(0, limits.maxTableRows || 500).forEach((row, rowIndex) => {
            if (!Array.isArray(row)) return;
            const rowPath = path + ".rows[" + rowIndex + "]";
            if (row.length < expected) addWarning(rowPath, "Expected 2 cells, found " + row.length + "; missing cells will be filled with empty text.");
            else if (row.length > expected && row.length <= (limits.maxTableColumns || 50)) addError(rowPath, "Expected 2 cells, found " + row.length + "; importing would discard " + (row.length - expected) + " cell(s).");
          });
        }
      });
    }
    return { errors, warnings };
  }

  Model.normalizeBlock = function (raw, options) {
    return originalNormalizeBlock.call(Model, sanitizeBlock(raw), options);
  };
  Model.normalizeDocument = function (raw, options) {
    const document = originalNormalizeDocument.call(Model, sanitizeDocument(raw), options);
    const seen = new Set();
    (document.blocks || []).forEach((block) => {
      if (!block) return;
      while (!block.id || block.id.length > MAX_ID_LENGTH || RESERVED_BLOCK_IDS.has(block.id) || seen.has(block.id)) block.id = generatedId("block");
      seen.add(block.id);
      if (block.type === "list") block.ordered = block.ordered === true;
    });
    return document;
  };
  Model.validateDocumentRaw = function (raw) {
    return hardenDocumentValidation(raw, originalValidateDocumentRaw.call(Model, raw));
  };
  Model.validateTemplateRaw = function (raw) {
    const base = originalValidateTemplateRaw.call(Model, raw);
    const errors = filterImageLengthFalsePositives(base.errors, raw && raw.document);
    const warnings = (base.warnings || []).slice();
    if (raw && raw.document) {
      const oldDocument = originalValidateDocumentRaw.call(Model, raw.document);
      const hardenedDocument = Model.validateDocumentRaw(raw.document);
      const oldErrorKeys = new Set(filterImageLengthFalsePositives(oldDocument.errors, raw.document).map((issue) => issue.path + "\u0000" + issue.message));
      const oldWarningKeys = new Set((oldDocument.warnings || []).map((issue) => issue.path + "\u0000" + issue.message));
      hardenedDocument.errors.forEach((issue) => { if (!oldErrorKeys.has(issue.path + "\u0000" + issue.message)) uniquePush(errors, issue); });
      hardenedDocument.warnings.forEach((issue) => { if (!oldWarningKeys.has(issue.path + "\u0000" + issue.message)) uniquePush(warnings, issue); });
    }
    if (raw && isObject(raw.template)) {
      if (typeof raw.template.id === "string" && raw.template.id.length > MAX_ID_LENGTH) uniquePush(warnings, { path: "template.id", message: "Template ID is too long and will be regenerated." });
      if (typeof raw.template.name === "string" && raw.template.name.length > maxStringLength) uniquePush(errors, { path: "template.name", message: "Text exceeds the maximum supported length." });
      if (typeof raw.template.description === "string" && raw.template.description.length > maxStringLength) uniquePush(errors, { path: "template.description", message: "Text exceeds the maximum supported length." });
    }
    return { errors, warnings };
  };
  Model.makeTemplate = function (rawDocument, template) {
    const info = Object.assign({}, template || {});
    if (typeof info.id === "string" && info.id.length > MAX_ID_LENGTH) info.id = "";
    const result = originalMakeTemplate.call(Model, sanitizeDocument(rawDocument), info);
    result.document = Model.normalizeDocument(result.document);
    return result;
  };
  Model.normalizeTemplate = function (raw) {
    const result = originalNormalizeTemplate.call(Model, raw);
    if (result && result.template && (typeof result.template.id !== "string" || !result.template.id || result.template.id.length > MAX_ID_LENGTH)) result.template.id = generatedId("template");
    if (result && result.document) result.document = Model.normalizeDocument(result.document);
    return result;
  };
  Object.defineProperty(Model, "__boundaryHardened", { value: true, enumerable: false });
})(window);
