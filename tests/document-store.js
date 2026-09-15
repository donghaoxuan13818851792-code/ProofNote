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
  const created = await Library.createDocument({ metadata: { name: "Second note" }, blocks: [] });
  check("store-creates-separate-document-records", Boolean(created && created.record && created.record.id && created.record.id !== initial.record.id));
  const opened = await Library.openDocument(initial.record.id);
  check("store-opens-a-document-by-local-id", Boolean(opened && opened.record && opened.record.id === initial.record.id));
  const renamed = await Library.renameDocument(initial.record.id, "Renamed note");
  check("store-renames-the-local-document-and-portable-name", Boolean(renamed && renamed.record && renamed.record.document.metadata.name === "Renamed note"));
  const duplicate = await Library.duplicateDocument(initial.record.id, "Renamed note copy");
  const beforeDelete = await Library.listDocuments();
  check("store-duplicates-with-a-fresh-local-id", Boolean(duplicate && duplicate.record && duplicate.record.id !== initial.record.id && beforeDelete.length === 3));
  await Library.deleteDocument(created.record.id);
  const afterDelete = await Library.listDocuments();
  check("store-deletes-only-the-requested-document", afterDelete.length === 2 && !afterDelete.some((record) => record.id === created.record.id));
  await Library.deleteDocument(duplicate.record.id);
  const recoveredCurrent = await Library.initialiseDocumentLibrary({ metadata: { name: "Seed" } });
  check("store-deleting-current-selects-an-existing-document-not-a-legacy-ghost", Boolean(recoveredCurrent.record && recoveredCurrent.record.id === initial.record.id));
  await Library.deleteDocument(initial.record.id);
  const afterLastDelete = await Library.initialiseDocumentLibrary({ metadata: { name: "Fresh seed" } });
  check("store-deleting-last-document-does-not-resurrect-the-legacy-record", Boolean(afterLastDelete.record && afterLastDelete.record.document.metadata.name === "Fresh seed"));
  libraryWindow.localStorage.setItem("proofnote-document:documents:v1", JSON.stringify([
    { id: "opened-later", document: { metadata: { name: "Opened later" }, blocks: [] }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", lastOpenedAt: "2026-01-04T00:00:00.000Z" },
    { id: "edited-later", document: { metadata: { name: "Edited later" }, blocks: [] }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", lastOpenedAt: "2026-01-01T12:00:00.000Z" }
  ]));
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
