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
  // A single envelope makes the localStorage fallback's library mutation
  // atomic at the key level. The two v1 keys remain read-only migration
  // sources; never update them independently after this point.
  const FALLBACK_LIBRARY = "proofnote-document:library:v2";
  // Pick one durable backend for the lifetime of this page. Falling back from
  // a healthy IndexedDB session for one failed write creates two divergent
  // histories, and a later reload would silently prefer the older IndexedDB
  // copy. A transient IndexedDB failure is therefore reported as a failure;
  // fallback storage is selected only when IndexedDB cannot start a session.
  let sessionBackend = "";

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function timestamp() { return new Date().toISOString(); }
  function resolveSeed(seedSource) {
    return typeof seedSource === "function" ? seedSource() : seedSource;
  }
  function newDocumentId() { return "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9); }
  // `revision` is local-library metadata, never part of portable document
  // JSON. It lets a tab prove that it is saving the same record it opened,
  // rather than silently replacing a newer write from another tab.
  function revisionOf(record) {
    return Number.isSafeInteger(record && record.revision) && record.revision >= 0 ? record.revision : 0;
  }
  function recordFor(document, existing) {
    const now = timestamp();
    return {
      id: existing && existing.id || newDocumentId(),
      document: clone(document),
      createdAt: existing && existing.createdAt || now,
      updatedAt: now,
      lastOpenedAt: existing && existing.lastOpenedAt || now,
      revision: existing ? revisionOf(existing) + 1 : 1
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
  // A library duplicate normally preserves the portable document payload.
  // A caller may deliberately fork a protocol-specific identity (for example
  // Proofnote Editable HTML's replacement lineage) before the new record is
  // committed.  Keep that transform inside the same storage transaction as
  // the duplicate so no briefly-created copy can expose the source identity.
  function duplicateDocumentPayload(document, name, options) {
    const next = documentWithName(document, name);
    const transform = options && options.transformDocument;
    if (typeof transform !== "function") return next;
    const transformed = transform(clone(next));
    if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)
      || (transformed && typeof transformed.then === "function")) {
      throw new Error("Invalid duplicate document transform");
    }
    return transformed;
  }
  function storedDocumentIsSafe(document) {
    if (!document || typeof document !== "object" || Array.isArray(document)) return false;
    // A stored document is still untrusted input: browser crashes, old
    // versions and interrupted writes can leave malformed values in either
    // backend. Check depth and traversal cost before clone()/normalisation
    // could recurse through it.
    const pending = [{ value: document, depth: 0 }];
    const visited = new WeakSet();
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop();
      const value = item.value;
      if (!value || typeof value !== "object") continue;
      if (visited.has(value)) continue;
      visited.add(value);
      nodes += 1;
      if (nodes > 25000 || item.depth > 32) return false;
      const values = Array.isArray(value) ? value : Object.keys(value).map((key) => value[key]);
      for (const child of values) if (child && typeof child === "object") pending.push({ value: child, depth: item.depth + 1 });
    }
    if (!document.metadata || typeof document.metadata !== "object" || Array.isArray(document.metadata) || !Array.isArray(document.blocks)) return false;
    // Modern Proofnote records must pass the same boundary validation as an
    // import. Keep accepting pre-format library records so a real v1 library
    // can still migrate forward instead of being discarded on startup.
    const model = root.ProofnoteDocument;
    if ((document.format !== undefined || document.version !== undefined) && model && typeof model.validateDocumentRaw === "function") {
      try { return model.validateDocumentRaw(document).errors.length === 0; } catch (_) { return false; }
    }
    return true;
  }
  function validRecord(value) {
    return Boolean(
      value && typeof value === "object"
      && typeof value.id === "string" && value.id.trim()
      && storedDocumentIsSafe(value.document)
    );
  }
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
      // A version upgrade held behind another tab otherwise leaves the
      // promise pending with no user-visible failure path. Rejecting keeps
      // the editor honest about persistence and allows a later retry once
      // that tab is closed.
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another open tab"));
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
  function fallbackReadChecked(key, empty) {
    try {
      const raw = root.localStorage.getItem(key);
      if (!raw) return { value: empty, valid: true };
      return { value: JSON.parse(raw), valid: true };
    } catch (_) { return { value: empty, valid: false }; }
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
    const envelope = fallbackReadChecked(FALLBACK_LIBRARY, null);
    if (!envelope.valid) {
      // Never reinterpret damaged library JSON as an empty library and write
      // a seed document over it. Keep the original value untouched so it can
      // be recovered manually or by a future repair flow.
      return { records: [], current: null, currentId: "", migrated: false, hasLegacy: false, corrupt: true };
    }
    const usingEnvelope = envelope.value !== null;
    const stored = usingEnvelope ? envelope : fallbackReadChecked(FALLBACK_DOCUMENTS, []);
    if (!stored.valid || (usingEnvelope && (!stored.value || typeof stored.value !== "object" || Array.isArray(stored.value) || !Array.isArray(stored.value.records))) || (!usingEnvelope && !Array.isArray(stored.value))) {
      return { records: [], current: null, currentId: "", migrated: false, hasLegacy: false, corrupt: true };
    }
    const raw = usingEnvelope ? stored.value.records : stored.value;
    // A malformed row is evidence of corruption, not permission to silently
    // drop that document during a later write.
    if (raw.some((record) => !validRecord(record))) {
      return { records: [], current: null, currentId: "", migrated: false, hasLegacy: false, corrupt: true };
    }
    const records = raw.slice();
    const legacyStored = usingEnvelope ? { value: null, valid: true } : fallbackReadChecked(FALLBACK_CURRENT, null);
    // The legacy v1 slot can be the only remaining copy of a document. Treat
    // malformed JSON there just like damaged library JSON: do not call the
    // state "empty" and then erase the bytes during a migration write.
    if (!legacyStored.valid) {
      return { records, current: null, currentId: "", migrated: false, hasLegacy: false, corrupt: true };
    }
    const legacy = legacyStored.value;
    const hasLegacy = Boolean(legacy && typeof legacy === "object");
    let currentId = usingEnvelope ? String(stored.value.currentId || "") : fallbackReadString(FALLBACK_CURRENT_DOCUMENT_ID);
    let current = records.find((record) => record.id === currentId) || null;
    if (!current) {
      const remembered = ordered(records)[0] || null;
      if (remembered) return { records, current: remembered, currentId: remembered.id, migrated: true, hasLegacy, corrupt: false };
      const document = legacy && typeof legacy === "object" ? legacy : resolveSeed(seedDocument);
      if (!document || typeof document !== "object") return { records, current: null, currentId, migrated: false, hasLegacy, corrupt: false };
      current = recordFor(document);
      records.push(current);
      currentId = current.id;
      return { records, current, currentId, migrated: true, hasLegacy, corrupt: false };
    }
    return { records, current, currentId, migrated: false, hasLegacy, corrupt: false };
  }
  function persistFallbackLibrary(library, includeLegacy) {
    const saved = fallbackWrite(FALLBACK_LIBRARY, {
      version: 2,
      records: library.records,
      currentId: library.currentId
    });
    if (!saved) return false;
    // The envelope is now the one source of truth. Cleanup is best effort so
    // a failure to remove an obsolete migration key cannot turn a completed
    // atomic library write into a false failure state.
    if (includeLegacy === true && library.current) fallbackWrite(FALLBACK_CURRENT, library.current.document);
    else fallbackRemove(FALLBACK_CURRENT);
    return true;
  }
  async function readIndexedLibrary() {
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readonly");
      const documents = tx.objectStore("documents");
      const documentRequest = documents.getAll();
      // v1 stored exactly one legacy value under the `current-document` key.
      // Read that key directly instead of guessing that any malformed modern
      // row is a migration source; unrelated corruption must never be revived
      // as the active document.
      const legacyRequest = documents.get(CURRENT_KEY);
      const currentRequest = tx.objectStore("settings").get(CURRENT_DOCUMENT_ID_KEY);
      const values = await Promise.all([requestValue(documentRequest), requestValue(legacyRequest), requestValue(currentRequest)]);
      await transactionDone(tx);
      const rows = Array.isArray(values[0]) ? values[0] : [];
      const legacy = values[1] && values[1].document && !validRecord(values[1]) ? values[1] : null;
      return {
        records: rows.filter(validRecord),
        legacy,
        currentId: values[2] && typeof values[2].value === "string" ? values[2].value : ""
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
  // Keep the read, decision, and write for one record in the same IndexedDB
  // transaction. A read in one transaction followed by a later write permits
  // a second tab to delete or update the record in between, which can revive
  // deleted content or overwrite a newer document snapshot.
  async function mutateIndexedRecord(id, options, apply) {
    const opts = options || {};
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readwrite");
      const documents = tx.objectStore("documents");
      const settings = tx.objectStore("settings");
      const existing = await requestValue(documents.get(id));
      if (!validRecord(existing)) {
        await transactionDone(tx);
        return { status: "missing", record: null };
      }
      if (opts.expectedRevision !== undefined && revisionOf(existing) !== opts.expectedRevision) {
        await transactionDone(tx);
        return { status: "conflict", record: clone(existing) };
      }
      const record = apply(clone(existing));
      if (!validRecord(record)) throw new Error("Invalid document record mutation");
      documents.put(clone(record), record.id);
      if (opts.currentId !== undefined) settings.put({ key: CURRENT_DOCUMENT_ID_KEY, value: opts.currentId });
      await transactionDone(tx);
      return { status: "ok", record: clone(record) };
    } finally { db.close(); }
  }
  async function createIndexedRecord(record, options) {
    const opts = options || {};
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readwrite");
      tx.objectStore("documents").put(clone(record), record.id);
      if (opts.currentId !== undefined) tx.objectStore("settings").put({ key: CURRENT_DOCUMENT_ID_KEY, value: opts.currentId });
      await transactionDone(tx);
    } finally { db.close(); }
  }
  async function selectIndexedDocument(id) {
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readwrite");
      const existing = await requestValue(tx.objectStore("documents").get(id));
      if (!validRecord(existing)) {
        await transactionDone(tx);
        return null;
      }
      tx.objectStore("settings").put({ key: CURRENT_DOCUMENT_ID_KEY, value: id });
      await transactionDone(tx);
      return clone(existing);
    } finally { db.close(); }
  }
  async function duplicateIndexedRecord(id, name, options) {
    const opts = options || {};
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readwrite");
      const documents = tx.objectStore("documents");
      const source = await requestValue(documents.get(id));
      if (!validRecord(source)) {
        await transactionDone(tx);
        return null;
      }
      const nextName = String(name || source.document.metadata && source.document.metadata.name || "Untitled document");
      const document = duplicateDocumentPayload(source.document, nextName, opts);
      const now = timestamp();
      document.metadata = Object.assign({}, document.metadata, { createdAt: now, updatedAt: now });
      const record = recordFor(document);
      documents.put(clone(record), record.id);
      if (opts.makeCurrent === true) tx.objectStore("settings").put({ key: CURRENT_DOCUMENT_ID_KEY, value: record.id });
      await transactionDone(tx);
      return clone(record);
    } finally { db.close(); }
  }
  async function deleteIndexedRecord(id) {
    const db = await openDatabase();
    try {
      const tx = db.transaction(["documents", "settings"], "readwrite");
      const documents = tx.objectStore("documents");
      const settings = tx.objectStore("settings");
      const values = await Promise.all([
        requestValue(documents.get(id)),
        requestValue(settings.get(CURRENT_DOCUMENT_ID_KEY))
      ]);
      if (!validRecord(values[0])) {
        await transactionDone(tx);
        return "missing";
      }
      const wasCurrent = values[1] && values[1].value === id;
      documents.delete(id);
      if (wasCurrent) {
        documents.delete(CURRENT_KEY);
        settings.put({ key: CURRENT_DOCUMENT_ID_KEY, value: "" });
      }
      await transactionDone(tx);
      return "ok";
    } finally { db.close(); }
  }
  // Imported templates must never overwrite an existing local template. This
  // is deliberately an `add`, not a read-then-put sequence, so IndexedDB
  // enforces the identity boundary even when two tabs import concurrently.
  async function addIndexedTemplateIfAbsent(template) {
    const db = await openDatabase();
    try {
      const tx = db.transaction("templates", "readwrite");
      let duplicate = false;
      const request = tx.objectStore("templates").add(clone(template));
      request.onerror = () => { duplicate = Boolean(request.error && request.error.name === "ConstraintError"); };
      try {
        await transactionDone(tx);
        return "added";
      } catch (error) {
        // Some engines surface a duplicate-key abort as AbortError on the
        // transaction even though the request itself correctly reports the
        // ConstraintError. Keep the request-level fact through completion.
        if (duplicate || (error && error.name === "ConstraintError")) return "exists";
        throw error;
      }
    } finally { db.close(); }
  }
  // A malformed historic template can receive a generated safe ID during
  // normalisation. Persist that repair once, atomically replacing the old
  // primary key, so selection and future delete/edit actions do not acquire a
  // fresh identity on every reload.
  async function repairIndexedTemplate(originalId, template) {
    const db = await openDatabase();
    try {
      const tx = db.transaction("templates", "readwrite");
      const store = tx.objectStore("templates");
      const payload = clone(template);
      const nextId = payload && payload.template && String(payload.template.id || "");
      if (!nextId) { tx.abort(); return "failed"; }
      const existing = await requestValue(store.get(originalId));
      if (!existing) { await transactionDone(tx); return "missing"; }
      if (nextId === originalId) store.put(payload);
      else {
        store.add(payload);
        store.delete(originalId);
      }
      await transactionDone(tx);
      return "indexeddb";
    } finally { db.close(); }
  }
  async function initialiseIndexedLibrary(seedDocument) {
    const library = await readIndexedLibrary();
    let current = library.records.find((record) => record.id === library.currentId) || ordered(library.records)[0] || null;
    if (current) {
      // Do not write the snapshot from readIndexedLibrary back wholesale:
      // another tab may have saved newer content while startup was deciding
      // which document to open. Mutate only lastOpenedAt against the record
      // that exists at commit time.
      const opened = await mutateIndexedRecord(current.id, { currentId: current.id }, (record) => Object.assign({}, record, { lastOpenedAt: timestamp() }));
      if (opened.status === "ok") {
        if (library.legacy) await writeIndexedLibrary({ remove: [CURRENT_KEY] });
        return opened.record;
      }
      // A concurrent deletion is not a migration source. Let the caller make
      // a fresh selection on the next normal library operation instead of
      // reviving the record that disappeared during startup.
      return null;
    }
    const legacyDocument = library.legacy && library.legacy.document;
    const document = legacyDocument && typeof legacyDocument === "object" ? legacyDocument : resolveSeed(seedDocument);
    if (!document || typeof document !== "object") return null;
    current = recordFor(document);
    await writeIndexedLibrary({ put: [current], remove: library.legacy ? [CURRENT_KEY] : [], currentId: current.id });
    return current;
  }

  async function useStorageSession(indexedOperation, fallbackOperation, failedValue) {
    if (sessionBackend === "localStorage") return fallbackOperation();
    // Do not create a second history because one IndexedDB request happened
    // to fail. Fallback storage is only safe when IndexedDB is absent before
    // this session begins; otherwise a later recovery would reveal a stale
    // IndexedDB library and split the user's documents across backends.
    if (!root.indexedDB) {
      sessionBackend = "localStorage";
      return fallbackOperation();
    }
    try {
      const result = await indexedOperation();
      sessionBackend = "indexeddb";
      return result;
    } catch (_) {
      // Leave the session retryable: a transient open/transaction failure
      // must neither become a permanent fallback nor a false success.
      return typeof failedValue === "function" ? failedValue() : failedValue;
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
        if (library.corrupt) return { record: null, backend: "failed" };
        const saved = library.migrated || library.hasLegacy ? persistFallbackLibrary(library, false) : true;
        return { record: library.current && clone(library.current), backend: saved ? "localStorage" : "failed" };
      }, () => ({ record: null, backend: "failed" }));
    },
    async listDocumentLibrary() {
      return useStorageSession(
        async () => ({ records: ordered((await readIndexedLibrary()).records).map(clone), backend: "indexeddb" }),
        () => {
          const library = fallbackLibrary(null);
          return library.corrupt
            ? { records: [], backend: "failed" }
            : { records: ordered(library.records).map(clone), backend: "localStorage" };
        },
        () => ({ records: [], backend: "failed" })
      );
    },
    async listDocuments() {
      return (await this.listDocumentLibrary()).records;
    },
    async createDocument(document, options) {
      const opts = options || {};
      const makeCurrent = opts.makeCurrent !== false;
      const record = recordFor(document);
      return useStorageSession(async () => {
        await createIndexedRecord(record, makeCurrent ? { currentId: record.id } : {});
        return { record: clone(record), backend: "indexeddb" };
      }, () => {
        const library = fallbackLibrary(null);
        if (library.corrupt) return { record: null, backend: "failed" };
        library.records.push(record);
        if (makeCurrent) { library.current = record; library.currentId = record.id; }
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => ({ record: null, backend: "failed" }));
    },
    async openDocument(id, options) {
      const opts = options || {};
      const makeCurrent = opts.makeCurrent !== false;
      return useStorageSession(async () => {
        const result = await mutateIndexedRecord(id, makeCurrent ? { currentId: id } : {}, (record) => Object.assign({}, record, { lastOpenedAt: timestamp() }));
        return result.status === "ok" ? { record: clone(result.record), backend: "indexeddb" } : null;
      }, () => {
        const library = fallbackLibrary(null);
        if (library.corrupt) return null;
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return null;
        const record = Object.assign({}, library.records[index], { lastOpenedAt: timestamp() });
        library.records[index] = record;
        if (makeCurrent) { library.current = record; library.currentId = record.id; }
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => null);
    },
    async saveDocument(id, document, expectedRevision) {
      return useStorageSession(async () => {
        if (!id) return "failed";
        const options = expectedRevision === undefined ? {} : { expectedRevision };
        const result = await mutateIndexedRecord(id, options, (existing) => {
          const record = recordFor(document, existing);
          record.id = id;
          record.lastOpenedAt = existing.lastOpenedAt || record.lastOpenedAt;
          return record;
        });
        // saveDocument updates an established local identity. Creation belongs
        // exclusively to createDocument; otherwise a stale tab can recreate a
        // record that was intentionally deleted elsewhere. It also never
        // changes currentId: opening/selecting owns that pointer.
        return result.status === "ok" ? "indexeddb" : result.status === "conflict" ? "conflict" : "failed";
      }, () => {
        if (!id) return "failed";
        const library = fallbackLibrary(null);
        if (library.corrupt) return "failed";
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return "failed";
        if (expectedRevision !== undefined && revisionOf(library.records[index]) !== expectedRevision) return "conflict";
        const record = recordFor(document, library.records[index]);
        record.id = id;
        library.records[index] = record;
        if (library.currentId === record.id) library.current = record;
        return persistFallbackLibrary(library) ? "localStorage" : "failed";
      }, "failed");
    },

    // A destructive import replaces the content of an existing local record
    // but must keep that record's identity and prove that no other tab has
    // changed it since the editor last saw it. Unlike saveDocument(), return
    // the exact record committed by the compare-and-swap transaction so the
    // caller never needs a second read that could observe a newer write.
    async replaceDocument(id, document, expectedRevision, options) {
      if (!id || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { record: null, backend: "failed" };
      const opts = options || {};
      const makeCurrent = opts.makeCurrent === true;
      const apply = (existing) => {
        const record = recordFor(document, existing);
        record.id = id;
        record.lastOpenedAt = existing.lastOpenedAt || record.lastOpenedAt;
        return record;
      };
      return useStorageSession(async () => {
        const result = await mutateIndexedRecord(id, makeCurrent ? { expectedRevision, currentId: id } : { expectedRevision }, apply);
        if (result.status === "ok") return { record: clone(result.record), backend: "indexeddb" };
        return { record: result.record ? clone(result.record) : null, backend: result.status === "conflict" ? "conflict" : "failed" };
      }, () => {
        const library = fallbackLibrary(null);
        if (library.corrupt) return { record: null, backend: "failed" };
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return { record: null, backend: "failed" };
        const existing = library.records[index];
        if (revisionOf(existing) !== expectedRevision) return { record: clone(existing), backend: "conflict" };
        const record = apply(existing);
        library.records[index] = record;
        if (makeCurrent || library.currentId === record.id) {
          library.currentId = record.id;
          library.current = record;
        }
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => ({ record: null, backend: "failed" }));
    },

    async renameDocument(id, name, expectedRevision) {
      const nextName = String(name || "").trim();
      if (!nextName) return null;
      const apply = (record) => {
        const updatedAt = timestamp();
        const document = documentWithName(record.document, nextName);
        document.metadata = Object.assign({}, document.metadata, { updatedAt });
        return Object.assign({}, record, { document, updatedAt, revision: revisionOf(record) + 1 });
      };
      return useStorageSession(async () => {
        const result = await mutateIndexedRecord(id, expectedRevision === undefined ? {} : { expectedRevision }, apply);
        if (result.status === "missing") return null;
        return { record: clone(result.record), backend: result.status === "conflict" ? "conflict" : "indexeddb" };
      }, () => {
        const library = fallbackLibrary(null);
        if (library.corrupt) return null;
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return null;
        if (expectedRevision !== undefined && revisionOf(library.records[index]) !== expectedRevision) return { record: clone(library.records[index]), backend: "conflict" };
        const record = apply(library.records[index]);
        library.records[index] = record;
        if (library.currentId === record.id) library.current = record;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => null);
    },
    async duplicateDocument(id, name, options) {
      const opts = options || {};
      const makeCurrent = opts.makeCurrent !== false;
      return useStorageSession(async () => {
        // Preserve caller-supplied duplicate transforms on both persistence
        // backends.  Dropping it here would make IndexedDB copies retain an
        // identity that localStorage copies correctly fork.
        const record = await duplicateIndexedRecord(id, name, Object.assign({}, opts, { makeCurrent }));
        if (!record) return null;
        return { record: clone(record), backend: "indexeddb" };
      }, () => {
        const library = fallbackLibrary(null);
        if (library.corrupt) return null;
        const source = library.records.find((record) => record.id === id);
        if (!source) return null;
        const nextName = String(name || source.document.metadata && source.document.metadata.name || "Untitled document");
        const document = duplicateDocumentPayload(source.document, nextName, opts);
        const now = timestamp();
        document.metadata = Object.assign({}, document.metadata, { createdAt: now, updatedAt: now });
        const record = recordFor(document);
        library.records.push(record);
        if (makeCurrent) { library.current = record; library.currentId = record.id; }
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => null);
    },
    async deleteDocument(id) {
      return useStorageSession(async () => {
        return (await deleteIndexedRecord(id)) === "ok" ? "indexeddb" : "failed";
      }, () => {
        const library = fallbackLibrary(null);
        if (library.corrupt) return "failed";
        library.records = library.records.filter((record) => record.id !== id);
        if (library.currentId === id) { library.currentId = ""; library.current = null; }
        return persistFallbackLibrary(library) ? "localStorage" : "failed";
      }, "failed");
    },
    async setCurrentDocument(id) {
      return useStorageSession(async () => {
        const record = await selectIndexedDocument(id);
        return record ? { record, backend: "indexeddb" } : null;
      }, () => {
        const library = fallbackLibrary(null);
        if (library.corrupt) return null;
        const record = library.records.find((item) => item.id === id);
        if (!record) return null;
        library.current = record;
        library.currentId = record.id;
        return { record: clone(record), backend: persistFallbackLibrary(library) ? "localStorage" : "failed" };
      }, () => null);
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
    async importTemplateIfAbsent(template) {
      const payload = clone(template);
      const id = payload && payload.template && String(payload.template.id || "");
      if (!id) return "failed";
      return useStorageSession(async () => {
        return await addIndexedTemplateIfAbsent(payload);
      }, () => {
        // localStorage has no compare-and-set primitive. It remains a
        // single-device fallback, while the primary IndexedDB backend gets a
        // genuine add-if-absent transaction above.
        const templates = fallbackRead(FALLBACK_TEMPLATES, []);
        if (templates.some((item) => item && item.template && item.template.id === id)) return "exists";
        templates.push(payload);
        return fallbackWrite(FALLBACK_TEMPLATES, templates) ? "added" : "failed";
      }, "failed");
    },
    async repairTemplate(originalId, template) {
      const hasPreviousId = originalId !== undefined && originalId !== null;
      const previousId = hasPreviousId ? String(originalId) : "";
      const payload = clone(template);
      const nextId = payload && payload.template && String(payload.template.id || "");
      if (!hasPreviousId || !nextId) return "failed";
      return useStorageSession(async () => repairIndexedTemplate(previousId, payload), () => {
        const templates = fallbackReadChecked(FALLBACK_TEMPLATES, []);
        if (!templates.valid || !Array.isArray(templates.value)) return "failed";
        const index = templates.value.findIndex((item) => item && item.template && item.template.id === previousId);
        if (index < 0) return "missing";
        if (previousId !== nextId && templates.value.some((item, itemIndex) => itemIndex !== index && item && item.template && item.template.id === nextId)) return "exists";
        templates.value[index] = payload;
        return fallbackWrite(FALLBACK_TEMPLATES, templates.value) ? "localStorage" : "failed";
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
