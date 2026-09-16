const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { IDBFactory } = require("fake-indexeddb");

const Model = require("../src/document-model.js");
const storeSource = fs.readFileSync(path.join(__dirname, "..", "src", "document-store.js"), "utf8");
const projectAiSource = fs.readFileSync(path.join(__dirname, "..", "src", "project-ai-instructions.js"), "utf8");
const results = [];

function check(name, condition, details) {
  results.push({ name, pass: Boolean(condition), details: details || "" });
}
function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}
function loadStore(options) {
  const opts = options || {};
  const window = {
    ProofnoteDocument: Model,
    localStorage: opts.localStorage || memoryStorage()
  };
  if (opts.indexedDB) window.indexedDB = opts.indexedDB;
  vm.runInNewContext(storeSource, { window, JSON, Promise, Date, Error, Math, Map, Set, WeakSet, String, Object, Array, Boolean, RegExp });
  return window.ProofnoteStore;
}
function loadLegacyBoundary(legacySurface) {
  const window = { ProofnoteDocument: Model, __snTest: legacySurface };
  vm.runInNewContext(projectAiSource, { window, JSON, Date, Error, Math, Map, Set, WeakSet, String, Object, Array, Boolean, RegExp });
  return window;
}
function documentWith(blocks, metadata) {
  return {
    format: Model.FORMAT,
    version: Model.VERSION,
    metadata: Object.assign({ name: "Boundary test" }, metadata || {}),
    blocks: blocks || []
  };
}
function legacyNote(overrides) {
  const base = {
    format: "solution-note",
    version: "1.0",
    meta: { title: "Legacy", status: "Solved" },
    core: {
      problem: "",
      result: { type: "Theorem", statement: "", explanation: "" },
      whyItWorks: [],
      evidence: [],
      reproduce: { sourceCode: "", data: "", verificationScript: "", certificate: "", discussion: "" }
    },
    optional: {}
  };
  return Object.assign(base, overrides || {});
}

async function main() {
  const Store = loadStore();
  check("boundary-hardening-is-active-before-editor-use", Model.__boundaryHardened === true);

  const moderateImage = "data:image/png;base64," + "A".repeat(Model.LIMITS.maxStringLength + 1024);
  const imageDocument = documentWith([{ type: "image", src: moderateImage, alt: "image", caption: "" }]);
  const imageValidation = Model.validateDocumentRaw(imageDocument);
  check(
    "embedded-raster-roundtrip-does-not-hit-normal-text-limit",
    !imageValidation.errors.some((issue) => issue.path === "blocks[0].src"),
    JSON.stringify(imageValidation.errors)
  );

  const missingColumnsLongRow = documentWith([{ type: "table", rows: [["a", "b", "extra"]] }]);
  const longRowValidation = Model.validateDocumentRaw(missingColumnsLongRow);
  check(
    "implicit-table-shape-blocks-cell-loss",
    longRowValidation.errors.some((issue) => issue.path === "blocks[0].rows[0]")
  );
  const missingColumnsShortRow = documentWith([{ type: "table", rows: [["a"]] }]);
  const shortRowValidation = Model.validateDocumentRaw(missingColumnsShortRow);
  check(
    "implicit-table-shape-reports-filled-cells",
    shortRowValidation.errors.length === 0 && shortRowValidation.warnings.some((issue) => issue.path === "blocks[0].rows[0]")
  );

  const tooLong = "x".repeat(Model.LIMITS.maxStringLength + 1);
  const unknownValidation = Model.validateDocumentRaw(documentWith([{ type: "future-block", content: tooLong }]));
  check(
    "unknown-block-fallback-still-enforces-text-limits",
    unknownValidation.errors.some((issue) => issue.path === "blocks[0].content")
  );
  const metadataValidation = Model.validateDocumentRaw(documentWith([], { name: tooLong }));
  check(
    "metadata-strings-share-document-text-limits",
    metadataValidation.errors.some((issue) => issue.path === "metadata.name")
  );

  const unordered = Model.normalizeDocument(documentWith([{ type: "list", ordered: "yes", items: ["one"] }]));
  check("invalid-list-ordering-does-not-become-truthy", unordered.blocks[0].ordered === false);

  const reservedId = Model.normalizeDocument(documentWith([{ id: "__proofnote_header__", type: "paragraph", content: "safe" }]));
  const longId = Model.normalizeDocument(documentWith([{ id: "x".repeat(300), type: "paragraph", content: "safe" }]));
  const whitespaceId = Model.normalizeDocument(documentWith([{ id: "   ", type: "paragraph", content: "safe" }]));
  check(
    "editor-invalid-block-ids-are-regenerated",
    reservedId.blocks[0].id !== "__proofnote_header__"
      && longId.blocks[0].id.length <= 256
      && Boolean(whitespaceId.blocks[0].id.trim()),
    [reservedId.blocks[0].id, longId.blocks[0].id, whitespaceId.blocks[0].id].join(" | ")
  );

  const project = documentWith([
    { type: "title", content: "Original project" },
    { type: "paragraph", content: "Body" }
  ], {
    name: "Original project",
    documentType: "Project",
    runningHeader: { left: "Original project", right: "Project" }
  });
  const created = await Store.createDocument(project);
  const renamed = await Store.renameDocument(created.record.id, "Renamed project");
  const renamedTitle = renamed.record.document.blocks.find((block) => block.type === "title");
  check(
    "project-library-rename-keeps-reader-facing-name-in-sync",
    renamed.record.document.metadata.name === "Renamed project"
      && renamedTitle && renamedTitle.content === "Renamed project"
      && renamed.record.document.metadata.runningHeader.left === "Renamed project"
  );
  const duplicated = await Store.duplicateDocument(created.record.id, "Project copy");
  const duplicatedTitle = duplicated.record.document.blocks.find((block) => block.type === "title");
  check(
    "project-duplicate-keeps-reader-facing-name-in-sync",
    duplicated.record.document.metadata.name === "Project copy"
      && duplicatedTitle && duplicatedTitle.content === "Project copy"
      && duplicated.record.document.metadata.runningHeader.left === "Project copy"
  );

  const staleFallbackStore = loadStore({ localStorage: memoryStorage() });
  const staleFallbackCreated = await staleFallbackStore.createDocument(documentWith([], { name: "Disposable fallback" }));
  await staleFallbackStore.deleteDocument(staleFallbackCreated.record.id);
  const staleFallbackSave = await staleFallbackStore.saveDocument(staleFallbackCreated.record.id, documentWith([], { name: "Should stay deleted" }));
  const staleFallbackRecords = await staleFallbackStore.listDocuments();
  check(
    "store-save-cannot-resurrect-deleted-local-identity",
    staleFallbackSave === "failed" && !staleFallbackRecords.some((record) => record.id === staleFallbackCreated.record.id)
  );

  const indexedDB = new IDBFactory();
  const IndexedStore = loadStore({ indexedDB });
  const first = await IndexedStore.createDocument(documentWith([], { name: "First" }));
  const second = await IndexedStore.createDocument(documentWith([], { name: "Second" }));
  await IndexedStore.openDocument(first.record.id);
  const backgroundSave = await IndexedStore.saveDocument(second.record.id, documentWith([], { name: "Second edited" }));
  const stillCurrent = await IndexedStore.initialiseDocumentLibrary(null);
  check(
    "background-save-does-not-switch-current-document",
    backgroundSave === "indexeddb" && stillCurrent.record && stillCurrent.record.id === first.record.id,
    stillCurrent.record && stillCurrent.record.id
  );

  const templateValidation = Model.validateTemplateRaw({
    format: Model.TEMPLATE_FORMAT,
    version: Model.VERSION,
    template: { id: "t".repeat(300), name: tooLong, description: tooLong },
    document: documentWith([])
  });
  check(
    "template-boundary-enforces-identifier-and-text-limits",
    templateValidation.errors.some((issue) => issue.path === "template.name")
      && templateValidation.errors.some((issue) => issue.path === "template.description")
      && templateValidation.warnings.some((issue) => issue.path === "template.id")
  );

  const nestedTemplateValidation = Model.validateTemplateRaw({
    format: Model.TEMPLATE_FORMAT,
    version: Model.VERSION,
    template: { id: "nested-path", name: "Nested path", description: "" },
    document: documentWith([{ type: "future-block", content: tooLong }])
  });
  check(
    "template-validation-prefixes-nested-document-diagnostics",
    nestedTemplateValidation.errors.some((issue) => issue.path === "document.blocks[0].content"),
    JSON.stringify(nestedTemplateValidation.errors)
  );

  const reservedTemplateRaw = {
    format: Model.TEMPLATE_FORMAT,
    version: Model.VERSION,
    template: { id: "proof-note", name: "Imported custom", description: "" },
    document: documentWith([])
  };
  const reservedTemplateValidation = Model.validateTemplateRaw(reservedTemplateRaw);
  const reservedTemplate = Model.normalizeTemplate(reservedTemplateRaw);
  const whitespaceTemplate = Model.normalizeTemplate({
    format: Model.TEMPLATE_FORMAT,
    version: Model.VERSION,
    template: { id: "   ", name: "Whitespace custom", description: "" },
    document: documentWith([])
  });
  check(
    "custom-template-ids-cannot-shadow-builtins-or-stay-blank",
    reservedTemplateValidation.warnings.some((issue) => issue.path === "template.id")
      && reservedTemplate.template.id !== "proof-note"
      && Boolean(reservedTemplate.template.id.trim())
      && Boolean(whitespaceTemplate.template.id.trim()),
    reservedTemplate.template.id + " | " + whitespaceTemplate.template.id
  );

  const legacySurface = {
    validateRaw() { return { errors: [], warnings: [], fieldCount: 1 }; }
  };
  loadLegacyBoundary(legacySurface);
  check("legacy-boundary-hardening-is-active", Model.__legacyBoundaryHardened === true);
  check("portable-object-graph-hardening-is-active", Model.__portableGraphHardened === true);

  const deepCompatibility = documentWith([]);
  deepCompatibility.compatibility = {};
  let compatibilityCursor = deepCompatibility.compatibility;
  for (let depth = 0; depth < Model.LIMITS.maxDepth; depth += 1) {
    compatibilityCursor.next = {};
    compatibilityCursor = compatibilityCursor.next;
  }
  const deepCompatibilityValidation = Model.validateDocumentRaw(deepCompatibility);
  check("portable-extension-payload-obeys-exact-depth-bound", deepCompatibilityValidation.errors.length > 0);

  const wideCompatibility = documentWith([]);
  wideCompatibility.compatibility = { entries: Array.from({ length: Model.LIMITS.maxBlocks + 1 }, () => null) };
  const wideCompatibilityValidation = Model.validateDocumentRaw(wideCompatibility);
  check("portable-extension-arrays-cannot-be-silently-truncated", wideCompatibilityValidation.errors.length > 0);

  const longCompatibility = documentWith([]);
  longCompatibility.compatibility = { note: tooLong };
  const longCompatibilityValidation = Model.validateDocumentRaw(longCompatibility);
  check("portable-extension-text-obeys-normal-string-bound", longCompatibilityValidation.errors.length > 0);

  const deepLegacy = legacyNote();
  let cursor = deepLegacy;
  for (let depth = 0; depth < Model.LIMITS.maxDepth + 3; depth += 1) {
    cursor.extra = {};
    cursor = cursor.extra;
  }
  const deepLegacyValidation = legacySurface.validateRaw(deepLegacy);
  check("legacy-import-rejects-excessive-nesting-before-recursive-code", deepLegacyValidation.errors.length > 0);

  const longLegacy = legacyNote();
  longLegacy.core.problem = tooLong;
  const longLegacyValidation = legacySurface.validateRaw(longLegacy);
  check("legacy-import-enforces-string-bounds", longLegacyValidation.errors.length > 0);

  const oversizedLegacyList = legacyNote();
  oversizedLegacyList.core.evidence = [{ type: "bullets", items: Array.from({ length: Model.LIMITS.maxListItems + 1 }, () => "x") }];
  const oversizedLegacyListValidation = legacySurface.validateRaw(oversizedLegacyList);
  check("legacy-import-blocks-list-truncation", oversizedLegacyListValidation.errors.length > 0);

  const lossyLegacyTable = legacyNote();
  lossyLegacyTable.core.evidence = [{ type: "table", text: "| A | B |\n|---|---|\n| 1 | 2 | EXTRA |" }];
  const lossyLegacyTableValidation = legacySurface.validateRaw(lossyLegacyTable);
  check("legacy-import-blocks-table-cell-loss", lossyLegacyTableValidation.errors.length > 0);

  const aggregateLegacy = legacyNote();
  aggregateLegacy.core.whyItWorks = Array.from({ length: 1995 }, (_, index) => "step " + index);
  aggregateLegacy.optional.proof = Array.from({ length: 20 }, (_, index) => ({ type: "paragraph", text: "extra " + index }));
  const aggregateLegacyValidation = legacySurface.validateRaw(aggregateLegacy);
  check("legacy-import-validates-migrated-block-count-before-storage", aggregateLegacyValidation.errors.length > 0);

  const legacyWithUiPayload = legacyNote({ ui: { sections: { proof: true }, unrelated: { nested: "should not persist" } } });
  const migratedLegacy = Model.migrateSolutionNote(legacyWithUiPayload);
  check(
    "legacy-migration-keeps-only-known-ui-compatibility-state",
    migratedLegacy.compatibility
      && JSON.stringify(migratedLegacy.compatibility.sourceUi) === JSON.stringify({ sections: { proof: true } })
  );

  const pass = results.filter((result) => result.pass).length;
  results.forEach((result) => console.log((result.pass ? "PASS" : "FAIL") + "  " + result.name + (result.pass || !result.details ? "" : " — " + result.details)));
  console.log("\n" + pass + " / " + results.length + " passed");
  process.exitCode = pass === results.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
