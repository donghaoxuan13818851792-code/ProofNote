// Persistence must never claim success if both IndexedDB and the fallback
// storage reject a write (for example, a full quota with an embedded image).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { IDBFactory } = require("fake-indexeddb");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "document-store.js"), "utf8");
const window = {
  localStorage: {
    getItem() { return null; },
    setItem() { throw new Error("Quota exceeded"); }
  }
};
vm.runInNewContext(source, { window, JSON, Promise, Date, Error });

const results = [];
function check(name, condition) { results.push({ name, pass: Boolean(condition) }); }
function memoryStorage(values) {
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}
function openDatabase(indexedDB, name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function main() {
  const Store = window.ProofnoteStore;
  check("store-exposes-persistence-api", Boolean(Store));
  check("store-save-current-reports-total-failure", await Store.saveCurrent({ metadata: { name: "Quota" } }) === "failed");
  check("store-save-template-reports-total-failure", await Store.saveTemplate({ template: { id: "quota" }, document: {} }) === "failed");
  check("store-delete-template-reports-total-failure", await Store.deleteTemplate("quota") === "failed");

  const values = new Map();
  const libraryWindow = {
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); }
    }
  };
  vm.runInNewContext(source, { window: libraryWindow, JSON, Promise, Date, Error, Math, Map, String, Object, Array });
  const Library = libraryWindow.ProofnoteStore;
  const legacy = { format: "proofnote-document", metadata: { name: "Migrated note" }, blocks: [] };
  libraryWindow.localStorage.setItem("proofnote-document:current:v1", JSON.stringify(legacy));
  const initial = await Library.initialiseDocumentLibrary({ metadata: { name: "Seed" } });
  check("store-migrates-legacy-current-into-a-local-record", Boolean(initial.record && initial.record.id && initial.record.document.metadata.name === "Migrated note"));
  check("store-migration-clears-the-legacy-single-document-cache", libraryWindow.localStorage.getItem("proofnote-document:current:v1") === "null");
  check("store-local-id-is-not-written-into-portable-document", initial.record && !Object.prototype.hasOwnProperty.call(initial.record.document, "id"));
  let unusedSeedCalls = 0;
  const existingLibrary = await Library.initialiseDocumentLibrary(() => {
    unusedSeedCalls += 1;
    return { metadata: { name: "This seed must stay lazy" }, blocks: [] };
  });
  check(
    "store-seed-factory-is-never-evaluated-when-a-modern-library-already-exists",
    unusedSeedCalls === 0 && existingLibrary.record && existingLibrary.record.id === initial.record.id,
    JSON.stringify({ unusedSeedCalls, existingLibrary })
  );
  const created = await Library.createDocument({ metadata: { name: "Second note" }, blocks: [] });
  check("store-creates-separate-document-records", Boolean(created && created.record && created.record.id && created.record.id !== initial.record.id));
  const fallbackEnvelope = JSON.parse(libraryWindow.localStorage.getItem("proofnote-document:library:v2") || "null");
  check(
    "store-fallback-library-writes-records-and-current-id-as-one-envelope",
    Boolean(fallbackEnvelope && fallbackEnvelope.version === 3
      && Array.isArray(fallbackEnvelope.records)
      && Array.isArray(fallbackEnvelope.projects)
      && fallbackEnvelope.records.some((record) => record.id === created.record.id)
      && typeof fallbackEnvelope.currentId === "string"),
    JSON.stringify(fallbackEnvelope)
  );
  const fallbackProject = await Library.createProject("Fallback research");
  const fallbackAssigned = await Library.assignDocumentToProject(created.record.id, {
    projectId: fallbackProject.project && fallbackProject.project.id,
    projectGroup: "Research",
    projectPinned: true
  }, created.record.revision);
  const fallbackProjects = await Library.listProjects();
  check(
    "store-keeps-project-membership-local-and-preserves-portable-document-payloads",
    Boolean(fallbackProject && fallbackProject.project && fallbackAssigned && fallbackAssigned.record)
      && fallbackAssigned.record.projectId === fallbackProject.project.id
      && fallbackAssigned.record.projectGroup === "Research"
      && fallbackAssigned.record.projectPinned === true
      && !Object.prototype.hasOwnProperty.call(fallbackAssigned.record.document, "projectId")
      && fallbackProjects.projects.some((project) => project.id === fallbackProject.project.id),
    JSON.stringify({ fallbackProject, fallbackAssigned, fallbackProjects })
  );
  const fallbackUnpinned = await Library.assignDocumentToProject(created.record.id, { projectPinned: false }, fallbackAssigned.record && fallbackAssigned.record.revision);
  const fallbackSibling = await Library.createDocument({ metadata: { name: "Contained sibling" }, blocks: [] }, {
    makeCurrent: false,
    projectId: fallbackProject.project && fallbackProject.project.id,
    projectGroup: "Research"
  });
  const fallbackReordered = await Library.reorderProjectDocument(fallbackSibling.record && fallbackSibling.record.id, "up", fallbackSibling.record && fallbackSibling.record.revision);
  const fallbackOrderedRecords = (await Library.listDocuments()).filter((record) => record.projectId === fallbackProject.project.id && record.projectGroup === "Research");
  check(
    "store-project-membership-supports-stable-local-pinning-and-reordering",
    Boolean(fallbackUnpinned && fallbackUnpinned.record)
      && Boolean(fallbackSibling && fallbackSibling.record)
      && fallbackSibling.record.projectPosition > fallbackUnpinned.record.projectPosition
      && fallbackReordered.backend === "localStorage"
      && fallbackOrderedRecords.some((record) => record.id === fallbackSibling.record.id && record.projectPosition === fallbackUnpinned.record.projectPosition),
    JSON.stringify({ fallbackUnpinned, fallbackSibling, fallbackReordered, fallbackOrderedRecords })
  );
  // Keep the following legacy-library lifecycle assertions independent from
  // this extra Project fixture record.
  await Library.deleteDocument(fallbackSibling.record.id);
  const opened = await Library.openDocument(initial.record.id);
  check("store-opens-a-document-by-local-id", Boolean(opened && opened.record && opened.record.id === initial.record.id));
  const renamed = await Library.renameDocument(initial.record.id, "Renamed note");
  check("store-renames-the-local-document-and-portable-name", Boolean(renamed && renamed.record && renamed.record.document.metadata.name === "Renamed note"));
  const duplicate = await Library.duplicateDocument(initial.record.id, "Renamed note copy");
  const beforeDelete = await Library.listDocuments();
  check("store-duplicates-with-a-fresh-local-id", Boolean(duplicate && duplicate.record && duplicate.record.id !== initial.record.id && beforeDelete.length === 3));
  check(
    "store-duplicate-refreshes-portable-document-timestamps",
    Boolean(duplicate && duplicate.record
      && duplicate.record.document.metadata.createdAt
      && duplicate.record.document.metadata.updatedAt
      && duplicate.record.document.metadata.createdAt === duplicate.record.document.metadata.updatedAt),
    JSON.stringify(duplicate && duplicate.record && duplicate.record.document && duplicate.record.document.metadata)
  );
  await Library.deleteDocument(created.record.id);
  const afterDelete = await Library.listDocuments();
  check("store-deletes-only-the-requested-document", afterDelete.length === 2 && !afterDelete.some((record) => record.id === created.record.id));
  await Library.deleteDocument(duplicate.record.id);
  const recoveredCurrent = await Library.initialiseDocumentLibrary({ metadata: { name: "Seed" } });
  check("store-deleting-current-selects-an-existing-document-not-a-legacy-ghost", Boolean(recoveredCurrent.record && recoveredCurrent.record.id === initial.record.id));
  await Library.deleteDocument(initial.record.id);
  const afterLastDelete = await Library.initialiseDocumentLibrary({ metadata: { name: "Fresh seed" } });
  check("store-deleting-last-document-does-not-resurrect-the-legacy-record", Boolean(afterLastDelete.record && afterLastDelete.record.document.metadata.name === "Fresh seed"));
  libraryWindow.localStorage.setItem("proofnote-document:library:v2", JSON.stringify({
    version: 2,
    currentId: "opened-later",
    records: [
      { id: "opened-later", document: { metadata: { name: "Opened later" }, blocks: [] }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", lastOpenedAt: "2026-01-04T00:00:00.000Z" },
      { id: "edited-later", document: { metadata: { name: "Edited later" }, blocks: [] }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", lastOpenedAt: "2026-01-01T12:00:00.000Z" }
    ]
  }));
  const modifiedFirst = await Library.listDocuments();
  check("store-lists-documents-by-most-recent-modification", modifiedFirst[0] && modifiedFirst[0].id === "edited-later");
  const openedWithoutEditing = await Library.openDocument("opened-later");
  const modifiedAfterOpen = await Library.listDocuments();
  const reopenedRecord = modifiedAfterOpen.find((record) => record.id === "opened-later");
  check(
    "store-opening-does-not-promote-document-over-a-later-edit",
    Boolean(openedWithoutEditing && reopenedRecord)
      && modifiedAfterOpen[0].id === "edited-later"
      && reopenedRecord.updatedAt === "2026-01-02T00:00:00.000Z"
      && reopenedRecord.lastOpenedAt !== "2026-01-04T00:00:00.000Z",
    JSON.stringify(modifiedAfterOpen)
  );

  // A damaged fallback library must remain recoverable. It is not an empty
  // library, so startup and listing must fail explicitly without replacing
  // the original bytes with a seed document.
  const corruptFallbackValues = new Map([["proofnote-document:library:v2", "{ damaged fallback JSON"]]);
  const corruptFallbackWindow = { localStorage: memoryStorage(corruptFallbackValues) };
  vm.runInNewContext(source, { window: corruptFallbackWindow, JSON, Promise, Date, Error, Math, Map, String, Object, Array, WeakSet });
  const CorruptFallback = corruptFallbackWindow.ProofnoteStore;
  const corruptFallbackInitial = await CorruptFallback.initialiseDocumentLibrary({ metadata: { name: "Do not overwrite" }, blocks: [] });
  const corruptFallbackList = await CorruptFallback.listDocumentLibrary();
  check(
    "store-corrupt-fallback-library-is-not-treated-as-empty-or-overwritten",
    corruptFallbackInitial.backend === "failed"
      && corruptFallbackList.backend === "failed"
      && corruptFallbackValues.get("proofnote-document:library:v2") === "{ damaged fallback JSON",
    JSON.stringify({ initial: corruptFallbackInitial, list: corruptFallbackList, stored: corruptFallbackValues.get("proofnote-document:library:v2") })
  );

  // Protocol-specific local identity changes must be applied during the
  // duplicate transaction on both persistence backends. This is how the
  // editor ensures a copied/recovery document cannot later look like the
  // source document to Editable HTML replacement.
  const lineageFallbackValues = new Map();
  const lineageFallbackWindow = { localStorage: memoryStorage(lineageFallbackValues) };
  vm.runInNewContext(source, { window: lineageFallbackWindow, JSON, Promise, Date, Error, Math, Map, String, Object, Array, WeakSet });
  const LineageFallback = lineageFallbackWindow.ProofnoteStore;
  const fallbackLineageSource = await LineageFallback.createDocument({
    metadata: { name: "Fallback lineage source" }, blocks: [],
    compatibility: { proofnoteEditable: { documentId: "pn_doc_fallbacksource123456" } }
  });
  const forkLineage = (document) => {
    const next = JSON.parse(JSON.stringify(document));
    next.compatibility = Object.assign({}, next.compatibility, { proofnoteEditable: { documentId: "pn_doc_fallbackforked123456" } });
    return next;
  };
  const fallbackLineageCopy = await LineageFallback.duplicateDocument(fallbackLineageSource.record.id, "Fallback lineage copy", {
    makeCurrent: false,
    transformDocument: forkLineage
  });

  // Exercise the real IndexedDB upgrade and transaction path. The legacy v1
  // record intentionally has no local id in its value; it lived under the
  // `current-document` key in the old object store.
  const indexedDB = new IDBFactory();
  const idbValues = new Map();
  const v1 = await openDatabase(indexedDB, "proofnote-document-store", 1, (db) => db.createObjectStore("documents"));
  const legacyTx = v1.transaction("documents", "readwrite");
  legacyTx.objectStore("documents").put({ document: { metadata: { name: "IDB legacy" }, blocks: [] } }, "current-document");
  await transactionComplete(legacyTx);
  v1.close();
  const indexedWindow = { indexedDB, localStorage: memoryStorage(idbValues) };
  vm.runInNewContext(source, { window: indexedWindow, JSON, Promise, Date, Error, Math, Map, String, Object, Array });
  const IndexedLibrary = indexedWindow.ProofnoteStore;
  const idbInitial = await IndexedLibrary.initialiseDocumentLibrary({ metadata: { name: "IDB seed" }, blocks: [] });
  check("store-indexeddb-migrates-v1-current-record", Boolean(idbInitial.record && idbInitial.backend === "indexeddb" && idbInitial.record.document.metadata.name === "IDB legacy"));
  const idbCreated = await IndexedLibrary.createDocument({ metadata: { name: "IDB second" }, blocks: [] });
  const idbSaved = await IndexedLibrary.saveDocument(idbInitial.record && idbInitial.record.id, { metadata: { name: "IDB saved" }, blocks: [] });
  const idbOpened = await IndexedLibrary.openDocument(idbInitial.record && idbInitial.record.id);
  const idbRenamed = await IndexedLibrary.renameDocument(idbInitial.record && idbInitial.record.id, "IDB renamed");
  const idbDuplicate = await IndexedLibrary.duplicateDocument(idbInitial.record && idbInitial.record.id, "IDB copy");
  const idbDeleted = await IndexedLibrary.deleteDocument(idbCreated.record && idbCreated.record.id);
  const idbRecords = await IndexedLibrary.listDocuments();
  check(
    "store-indexeddb-create-save-open-rename-duplicate-delete",
    idbSaved === "indexeddb"
      && Boolean(idbOpened && idbOpened.record && idbOpened.record.document.metadata.name === "IDB saved")
      && Boolean(idbRenamed && idbRenamed.record && idbRenamed.record.document.metadata.name === "IDB renamed")
      && Boolean(idbDuplicate && idbDuplicate.record && idbDuplicate.record.id !== idbInitial.record.id)
      && idbDeleted === "indexeddb"
      && idbRecords.length === 2
      && !idbRecords.some((record) => record.id === "current-document"),
    JSON.stringify(idbRecords)
  );
  const indexedProject = await IndexedLibrary.createProject("Indexed research");
  const indexedCurrentRecord = (await IndexedLibrary.listDocuments()).find((record) => record.id === idbInitial.record.id);
  const indexedAssigned = await IndexedLibrary.assignDocumentToProject(idbInitial.record.id, {
    projectId: indexedProject.project && indexedProject.project.id,
    projectGroup: "Main"
  }, indexedCurrentRecord && indexedCurrentRecord.revision);
  const indexedProjectRecords = await IndexedLibrary.listProjects();
  check(
    "store-indexeddb-persists-projects-and-document-membership-in-local-records",
    Boolean(indexedProject && indexedProject.project && indexedAssigned && indexedAssigned.record)
      && indexedAssigned.record.projectId === indexedProject.project.id
      && indexedAssigned.record.projectGroup === "Main"
      && !Object.prototype.hasOwnProperty.call(indexedAssigned.record.document, "projectId")
      && indexedProjectRecords.projects.some((project) => project.id === indexedProject.project.id),
    JSON.stringify({ indexedProject, indexedAssigned, indexedProjectRecords })
  );

  const indexedLineageSource = await IndexedLibrary.createDocument({
    metadata: { name: "Indexed lineage source" }, blocks: [],
    compatibility: { proofnoteEditable: { documentId: "pn_doc_indexedsource123456" } }
  }, { makeCurrent: false });
  const indexedLineageCopy = await IndexedLibrary.duplicateDocument(indexedLineageSource.record.id, "Indexed lineage copy", {
    makeCurrent: false,
    transformDocument: (document) => {
      const next = JSON.parse(JSON.stringify(document));
      next.compatibility = Object.assign({}, next.compatibility, { proofnoteEditable: { documentId: "pn_doc_indexedforked123456" } });
      return next;
    }
  });
  check(
    "store-duplicate-applies-a-document-transform-in-both-fallback-and-indexeddb-transactions",
    fallbackLineageSource && fallbackLineageCopy
      && fallbackLineageSource.record.document.compatibility.proofnoteEditable.documentId === "pn_doc_fallbacksource123456"
      && fallbackLineageCopy.record.document.compatibility.proofnoteEditable.documentId === "pn_doc_fallbackforked123456"
      && indexedLineageSource && indexedLineageCopy
      && indexedLineageSource.record.document.compatibility.proofnoteEditable.documentId === "pn_doc_indexedsource123456"
      && indexedLineageCopy.record.document.compatibility.proofnoteEditable.documentId === "pn_doc_indexedforked123456",
    JSON.stringify({ fallbackLineageSource, fallbackLineageCopy, indexedLineageSource, indexedLineageCopy })
  );
  const importedTemplate = {
    format: "proofnote-template", version: "1.0",
    template: { id: "atomic-import", name: "First imported template" },
    document: { format: "proofnote-document", version: "1.0", metadata: { name: "Template" }, blocks: [] }
  };
  const duplicateImportedTemplate = Object.assign({}, importedTemplate, {
    template: { id: "atomic-import", name: "Must not overwrite" }
  });
  const firstTemplateImport = await IndexedLibrary.importTemplateIfAbsent(importedTemplate);
  const secondTemplateImport = await IndexedLibrary.importTemplateIfAbsent(duplicateImportedTemplate);
  const storedTemplates = await IndexedLibrary.listTemplates();
  check(
    "store-template-import-adds-atomically-without-upserting-a-collision",
    firstTemplateImport === "added"
      && secondTemplateImport === "exists"
      && storedTemplates.find((template) => template.template && template.template.id === "atomic-import")?.template?.name === "First imported template",
    JSON.stringify({ firstTemplateImport, secondTemplateImport, storedTemplates })
  );
  const malformedStoredTemplate = {
    format: "proofnote-template", version: "1.0",
    template: { id: "", name: "Historic template" },
    document: { format: "proofnote-document", version: "1.0", metadata: { name: "Historic" }, blocks: [] }
  };
  const repairedStoredTemplate = Object.assign({}, malformedStoredTemplate, {
    template: { id: "repaired-template-id", name: "Historic template" }
  });
  const savedMalformedTemplate = await IndexedLibrary.saveTemplate(malformedStoredTemplate);
  const repairTemplateResult = await IndexedLibrary.repairTemplate("", repairedStoredTemplate);
  const templatesAfterRepair = await IndexedLibrary.listTemplates();
  check(
    "store-repairs-a-malformed-template-id-once-and-removes-old-identity",
    savedMalformedTemplate === "indexeddb"
      && repairTemplateResult === "indexeddb"
      && templatesAfterRepair.some((template) => template.template && template.template.id === "repaired-template-id")
      && !templatesAfterRepair.some((template) => template.template && template.template.id === ""),
    JSON.stringify({ savedMalformedTemplate, repairTemplateResult, templatesAfterRepair })
  );

  // Two store instances model two browser tabs sharing one IndexedDB library.
  // A stale revision must be rejected rather than silently overwriting the
  // document the other tab has already saved.
  const concurrentIndexedDB = new IDBFactory();
  const firstTabWindow = { indexedDB: concurrentIndexedDB, localStorage: memoryStorage(new Map()) };
  const secondTabWindow = { indexedDB: concurrentIndexedDB, localStorage: memoryStorage(new Map()) };
  vm.runInNewContext(source, { window: firstTabWindow, JSON, Promise, Date, Error, Math, Map, String, Object, Array });
  vm.runInNewContext(source, { window: secondTabWindow, JSON, Promise, Date, Error, Math, Map, String, Object, Array });
  const FirstTab = firstTabWindow.ProofnoteStore;
  const SecondTab = secondTabWindow.ProofnoteStore;
  const concurrentCreated = await FirstTab.createDocument({ metadata: { name: "Concurrent original" }, blocks: [] });
  const openedRevision = concurrentCreated.record.revision;
  const newerSave = await SecondTab.saveDocument(concurrentCreated.record.id, { metadata: { name: "Saved by second tab" }, blocks: [] }, openedRevision);
  const staleSave = await FirstTab.saveDocument(concurrentCreated.record.id, { metadata: { name: "Stale first tab write" }, blocks: [] }, openedRevision);
  const concurrentRecord = (await FirstTab.listDocuments()).find((record) => record.id === concurrentCreated.record.id);
  check(
    "store-rejects-stale-cross-tab-revisions-without-losing-newer-content",
    newerSave === "indexeddb"
      && staleSave === "conflict"
      && concurrentRecord && concurrentRecord.document.metadata.name === "Saved by second tab",
    JSON.stringify({ newerSave, staleSave, concurrentRecord })
  );
  const otherCurrent = await SecondTab.createDocument({ metadata: { name: "Other selected document" }, blocks: [] }, { makeCurrent: false });
  await SecondTab.setCurrentDocument(otherCurrent.record.id);
  // Editable-HTML replacement must use the same compare-and-swap boundary as
  // autosave: it keeps the local record ID, commits one new revision, and
  // cannot overwrite a concurrent replacement with an old revision token.
  // Its successful transaction also owns the current-document pointer, so a
  // reload does not reopen a different tab's previously selected document.
  const replacement = await SecondTab.replaceDocument(concurrentCreated.record.id, { metadata: { name: "Replaced from editable HTML" }, blocks: [] }, openedRevision + 1, { makeCurrent: true });
  const staleReplacement = await FirstTab.replaceDocument(concurrentCreated.record.id, { metadata: { name: "Stale replacement must not win" }, blocks: [] }, openedRevision + 1);
  const replacedRecord = (await FirstTab.listDocuments()).find((record) => record.id === concurrentCreated.record.id);
  const currentAfterReplacement = await FirstTab.initialiseDocumentLibrary(() => ({ metadata: { name: "Unexpected seed" }, blocks: [] }));
  check(
    "store-editable-html-replacement-preserves-record-identity-current-selection-and-rejects-a-stale-revision",
    replacement && replacement.backend === "indexeddb"
      && replacement.record && replacement.record.id === concurrentCreated.record.id
      && staleReplacement && staleReplacement.backend === "conflict"
      && replacedRecord && replacedRecord.id === concurrentCreated.record.id
      && replacedRecord.document.metadata.name === "Replaced from editable HTML"
      && currentAfterReplacement && currentAfterReplacement.record && currentAfterReplacement.record.id === concurrentCreated.record.id,
    JSON.stringify({ replacement, staleReplacement, replacedRecord, currentAfterReplacement })
  );
  const deletedConcurrent = await FirstTab.deleteDocument(concurrentCreated.record.id);
  const staleAfterDelete = await SecondTab.saveDocument(concurrentCreated.record.id, { metadata: { name: "Must not revive" }, blocks: [] }, openedRevision + 1);
  check(
    "store-indexeddb-save-cannot-revive-a-record-deleted-by-another-tab",
    deletedConcurrent === "indexeddb"
      && staleAfterDelete === "failed"
      && !(await FirstTab.listDocuments()).some((record) => record.id === concurrentCreated.record.id)
  );

  // A malformed row elsewhere in the old object store is not the v1 current
  // document. Migration must only trust the historical `current-document`
  // key, otherwise unrelated corruption can be resurrected as user content.
  const corruptIndexedDB = new IDBFactory();
  const corruptV1 = await openDatabase(corruptIndexedDB, "proofnote-document-store", 1, (db) => db.createObjectStore("documents"));
  const corruptTx = corruptV1.transaction("documents", "readwrite");
  corruptTx.objectStore("documents").put({ document: { metadata: { name: "Unrelated corrupt row" }, blocks: [] } }, "not-current-document");
  corruptTx.objectStore("documents").put({ id: "   ", document: { metadata: { name: "Whitespace id row" }, blocks: [] } }, "space-id");
  await transactionComplete(corruptTx);
  corruptV1.close();
  const corruptWindow = { indexedDB: corruptIndexedDB, localStorage: memoryStorage(new Map()) };
  vm.runInNewContext(source, { window: corruptWindow, JSON, Promise, Date, Error, Math, Map, String, Object, Array });
  const CorruptLibrary = corruptWindow.ProofnoteStore;
  const corruptInitial = await CorruptLibrary.initialiseDocumentLibrary({ metadata: { name: "Clean seed" }, blocks: [] });
  check(
    "store-indexeddb-migration-only-trusts-the-v1-current-key",
    Boolean(corruptInitial.record && corruptInitial.record.document.metadata.name === "Clean seed")
      && (await CorruptLibrary.listDocuments()).every((record) => record.id.trim())
  );

  const healthyIndexedDB = indexedWindow.indexedDB;
  indexedWindow.indexedDB = { open() { throw new Error("temporary IndexedDB failure"); } };
  const failedStickySave = await IndexedLibrary.saveDocument(idbInitial.record && idbInitial.record.id, { metadata: { name: "Must not split backend" }, blocks: [] });
  check(
    "store-indexeddb-session-failure-does-not-create-a-fallback-copy",
    failedStickySave === "failed" && !idbValues.has("proofnote-document:documents:v1"),
    JSON.stringify(Array.from(idbValues.entries()))
  );
  indexedWindow.indexedDB = healthyIndexedDB;
  check("store-indexeddb-session-recovers-on-a-later-write", await IndexedLibrary.saveDocument(idbInitial.record && idbInitial.record.id, { metadata: { name: "IDB recovered" }, blocks: [] }) === "indexeddb");
  const pass = results.filter((result) => result.pass).length;
  results.forEach((result) => console.log((result.pass ? "PASS" : "FAIL") + "  " + result.name));
  console.log("\n" + pass + " / " + results.length + " passed");
  process.exitCode = pass === results.length ? 0 : 1;
}

main();
