// Proofnote Document Format regression tests. These exercise the DOM-free
// model directly, including the Solution Note adapter and unsafe-key boundary.
const Model = require("../src/document-model.js");

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail: detail || "" });
}

// A blank document is independently named and contains actual movable blocks.
const blank = Model.blankDocument({ name: "Working title" });
check("document-blank-format", blank.format === "proofnote-document" && blank.version === "1.0", JSON.stringify(blank));
check("document-blank-movable-title", blank.metadata.name === "Working title" && blank.blocks[0].type === "title", JSON.stringify(blank));
const configuredMetadata = Model.normalizeDocument({
  format: Model.FORMAT,
  version: Model.VERSION,
  metadata: { name: "Metadata", proofMetadata: { fields: ["status", "author", "author", "unknown"] } },
  blocks: []
});
check(
  "document-proof-metadata-display-is-portable",
  JSON.stringify(configuredMetadata.metadata.proofMetadata) === JSON.stringify({ fields: ["author", "status"] }),
  JSON.stringify(configuredMetadata.metadata)
);
const hiddenMetadata = Model.normalizeDocument({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Hidden", proofMetadata: { fields: [] } }, blocks: [] });
check("document-proof-metadata-allows-complete-hide", hiddenMetadata.metadata.proofMetadata.fields.length === 0, JSON.stringify(hiddenMetadata.metadata));
const preservedUpdatedAt = "2026-01-02T00:00:00.000Z";
const timestampPreservingDocument = Model.normalizeDocument({
  format: Model.FORMAT,
  version: Model.VERSION,
  metadata: { name: "Timestamp", updatedAt: preservedUpdatedAt },
  blocks: []
});
check("document-normalization-preserves-updated-at", timestampPreservingDocument.metadata.updatedAt === preservedUpdatedAt, JSON.stringify(timestampPreservingDocument.metadata));
const malformedMetadataDisplay = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Bad display", proofMetadata: { fields: ["author", "unknown"] } }, blocks: [] });
check("document-proof-metadata-warns-on-unknown-field", malformedMetadataDisplay.warnings.some((warning) => warning.path === "metadata.proofMetadata.fields[1]"), JSON.stringify(malformedMetadataDisplay));
const runningHeader = Model.normalizeDocument({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Project", runningHeader: { left: "Field notes", right: "Project" } }, blocks: [] });
check("document-running-header-is-portable", JSON.stringify(runningHeader.metadata.runningHeader) === JSON.stringify({ left: "Field notes", right: "Project" }), JSON.stringify(runningHeader.metadata));
const malformedRunningHeader = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Bad header", runningHeader: { left: 42 } }, blocks: [] });
check("document-running-header-warns-on-non-string-label", malformedRunningHeader.warnings.some((warning) => warning.path === "metadata.runningHeader.left"), JSON.stringify(malformedRunningHeader));
const localizedDocument = Model.normalizeDocument({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "中文项目", language: "zh-CN" }, blocks: [] });
check("document-language-is-portable", localizedDocument.metadata.language === "zh-CN", JSON.stringify(localizedDocument.metadata));
const malformedLanguage = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Bad language", language: 42 }, blocks: [] });
check("document-language-warns-on-non-string-value", malformedLanguage.warnings.some((warning) => warning.path === "metadata.language"), JSON.stringify(malformedLanguage));
const hiddenHeaderSubtitle = Model.normalizeDocument({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Hidden subtitle", headerSubtitle: { visible: false } }, blocks: [] });
check("document-header-subtitle-display-is-portable", hiddenHeaderSubtitle.metadata.headerSubtitle.visible === false && Model.blankDocument().metadata.headerSubtitle.visible === true, JSON.stringify(hiddenHeaderSubtitle.metadata));
const malformedHeaderSubtitle = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Bad subtitle", headerSubtitle: { visible: "no" } }, blocks: [] });
check("document-header-subtitle-warns-on-non-boolean-display", malformedHeaderSubtitle.warnings.some((warning) => warning.path === "metadata.headerSubtitle.visible"), JSON.stringify(malformedHeaderSubtitle));

// Structural type, semantic kind, and typography preset are distinct concepts.
const heading = Model.createBlock("heading", { level: 3, content: "Details" });
const introduction = Model.createBlock("semantic", { kind: "introduction", title: "Introduction" });
const section = Model.createBlock("semantic", { kind: "section", appearance: "editorial", title: "Untitled section" });
const hiddenSectionBody = Model.createBlock("semantic", { kind: "section", appearance: "editorial", title: "Hidden body", content: "Keep this text", bodyVisible: false });
const theorem = Model.createBlock("semantic", { kind: "theorem", content: "Claim" });
const editorialTheorem = Model.createBlock("semantic", { kind: "theorem", appearance: "editorial", content: "Claim" });
const tableWithNoHeader = Model.createBlock("table", { header: false, columns: ["A"], rows: [["1"]] });
check("document-heading-preset", heading.type === "heading" && heading.level === 3 && heading.preset === "heading-3", JSON.stringify(heading));
check("document-introduction-is-a-semantic-kind", introduction.type === "semantic" && introduction.kind === "introduction" && introduction.preset === "semantic-introduction", JSON.stringify(introduction));
check("document-section-is-a-neutral-semantic-kind", section.type === "semantic" && section.kind === "section" && section.appearance === "editorial" && section.preset === "semantic-section", JSON.stringify(section));
check("document-semantic-body-visibility-is-portable", hiddenSectionBody.bodyVisible === false && hiddenSectionBody.content === "Keep this text", JSON.stringify(hiddenSectionBody));
const malformedSemanticBodyVisibility = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Bad body visibility" }, blocks: [{ id: "section_visibility", type: "semantic", kind: "section", bodyVisible: "no" }] });
check("document-semantic-body-visibility-warns-on-non-boolean", malformedSemanticBodyVisibility.warnings.some((warning) => warning.path === "blocks[0].bodyVisible"), JSON.stringify(malformedSemanticBodyVisibility));
check("document-semantic-preset", theorem.type === "semantic" && theorem.kind === "theorem" && theorem.preset === "semantic-theorem", JSON.stringify(theorem));
check("document-semantic-appearance-is-separate", editorialTheorem.type === "semantic" && editorialTheorem.kind === "theorem" && editorialTheorem.appearance === "editorial" && editorialTheorem.preset === "semantic-theorem", JSON.stringify(editorialTheorem));
check("document-table-header-is-a-portable-display-option", tableWithNoHeader.header === false && Model.createBlock("table").header === true, JSON.stringify(tableWithNoHeader));

// Validation sees malformed raw data before normalisation makes it safe.
const invalid = Model.validateDocumentRaw({ format: "proofnote-document", version: "1.0", metadata: { name: "Test" }, blocks: [{ type: "heading", level: 8 }] });
check("document-raw-validation", invalid.errors.length === 0 && invalid.warnings.length === 1 && invalid.warnings[0].path === "blocks[0].level", JSON.stringify(invalid));

// Imported objects cannot carry prototype-pollution keys across the boundary.
const polluted = JSON.parse('{"format":"proofnote-document","version":"1.0","metadata":{"name":"Safe"},"blocks":[],"__proto__":{"polluted":true},"compatibility":{"constructor":{"prototype":{"polluted2":true}}}}');
Model.normalizeDocument(polluted);
check("document-no-pollution", ({}).polluted !== true && ({}).polluted2 !== true, "prototype intact");

// Legacy Solution Note input maps to editable generic blocks without losing its
// identifying metadata, result type, or established content-block types.
const legacy = {
  format: "solution-note", version: "1.0",
  meta: { noteNumber: "7", title: "A legacy note", summary: "Summary", author: "Ada", status: "Solved" },
  core: {
    problem: "Find x.",
    result: { type: "Theorem", statement: "x = 2", explanation: "By calculation." },
    whyItWorks: [{ title: "Step", body: "Reason" }],
    evidence: [{ type: "math", text: "x=2" }, { type: "bullets", items: ["checked"] }],
    reproduce: { sourceCode: "solve.py", data: "", verificationScript: "", certificate: "", discussion: "" }
  },
  optional: { proof: [{ type: "callout", kicker: "Lemma", text: "Useful fact" }] },
  ui: { sections: { proof: true } }
};
const migrated = Model.migrateSolutionNote(legacy);
check("document-migrates-legacy-format", migrated.format === "proofnote-document" && migrated.metadata.templateName === "Proof Note", JSON.stringify(migrated.metadata));
check("document-migrates-legacy-title", migrated.blocks.some((block) => block.type === "title" && block.content === "A legacy note"), JSON.stringify(migrated.blocks));
check("document-migrates-legacy-content", migrated.blocks.some((block) => block.type === "equation" && block.content === "x=2") && migrated.blocks.some((block) => block.type === "list" && block.items[0] === "checked"), JSON.stringify(migrated.blocks));
check("document-migrates-legacy-metadata", migrated.compatibility.sourceMeta.noteNumber === "7" && migrated.compatibility.sourceMeta.author === "Ada", JSON.stringify(migrated.compatibility));
check("document-migrates-visible-proof-metadata", migrated.metadata.documentType === "Solution Note" && migrated.metadata.noteNumber === "7" && migrated.metadata.author === "Ada" && migrated.blocks.filter((block) => block.type === "semantic").every((block) => block.appearance === "editorial"), JSON.stringify({ metadata: migrated.metadata, blocks: migrated.blocks }));
check("document-migrates-legacy-ui", migrated.compatibility.sourceUi.sections.proof === true, JSON.stringify(migrated.compatibility));

// Compatibility export remains available for the original Proof Note shape.
const legacyExport = Model.documentToSolutionNote(migrated);
check("document-legacy-export", legacyExport.note.format === "solution-note" && legacyExport.note.meta.title === "A legacy note" && legacyExport.note.core.result.statement === "x = 2", JSON.stringify(legacyExport.note));
check("document-legacy-export-ui", legacyExport.note.ui && legacyExport.note.ui.sections.proof === true, JSON.stringify(legacyExport.note.ui));
check(
  "document-legacy-export-preserves-reproduce-and-optional-content",
  legacyExport.note.core.reproduce.sourceCode === "solve.py"
    && Array.isArray(legacyExport.note.optional.proof)
    && legacyExport.note.optional.proof[0].text === "Useful fact",
  JSON.stringify({ reproduce: legacyExport.note.core.reproduce, optional: legacyExport.note.optional })
);
migrated.metadata.author = "Grace";
check("document-legacy-export-prefers-edited-metadata", Model.documentToSolutionNote(migrated).note.meta.author === "Grace", JSON.stringify(Model.documentToSolutionNote(migrated).note.meta));
const draftExport = Model.documentToSolutionNote(Model.builtInTemplates().find((template) => template.template.id === "proof-note").document);
check("document-legacy-export-maps-draft-status", draftExport.note.meta.status === "Partial" && draftExport.warnings.some((warning) => warning.includes("Draft")), JSON.stringify(draftExport));
const genericLegacyExport = Model.documentToSolutionNote(Model.blankDocument({ blocks: [Model.createBlock("heading", { content: "Introduction" }), Model.createBlock("paragraph", { content: "Not a Solution Note section." })] }));
check("document-legacy-export-warns-on-unmappable-content", genericLegacyExport.warnings.length > 0, JSON.stringify(genericLegacyExport.warnings));

// The new format is an untrusted interchange boundary. Shape errors, duplicate
// editor IDs, and resource limits must be detected before normalization.
const duplicateIds = {
  format: Model.FORMAT, version: Model.VERSION, metadata: { name: "IDs" },
  blocks: [
    { id: "same", type: "paragraph", content: "First" },
    { id: "same", type: "paragraph", content: "Second" }
  ]
};
const duplicateValidation = Model.validateDocumentRaw(duplicateIds);
const duplicateNormalized = Model.normalizeDocument(duplicateIds);
check("document-duplicate-id-warning", duplicateValidation.warnings.some((warning) => warning.path === "blocks[1].id"), JSON.stringify(duplicateValidation));
check("document-duplicate-id-normalized", new Set(duplicateNormalized.blocks.map((block) => block.id)).size === 2, JSON.stringify(duplicateNormalized.blocks));
const malformedShapes = Model.validateDocumentRaw({
  format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Shapes" },
  blocks: [{ type: "paragraph", content: 42 }, { type: "table", columns: ["A"], rows: [[1]] }, { type: "key-value", items: [{ label: 5, value: false }] }]
});
check("document-raw-validation-covers-block-shapes", malformedShapes.errors.length === 0 && malformedShapes.warnings.length >= 4, JSON.stringify(malformedShapes));
const malformedTableHeader = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Table" }, blocks: [{ type: "table", header: "yes" }] });
check("document-table-header-validation", malformedTableHeader.warnings.some((warning) => warning.path === "blocks[0].header"), JSON.stringify(malformedTableHeader));
const shortTableRow = { format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Short table row" }, blocks: [{ type: "table", columns: ["Name", "Score", "Status"], rows: [["Alice", "98"]] }] };
const shortTableValidation = Model.validateDocumentRaw(shortTableRow);
const shortTableNormalized = Model.normalizeDocument(shortTableRow);
check("document-table-short-row-warns-and-fills-empty-cells", shortTableValidation.errors.length === 0
  && shortTableValidation.warnings.some((warning) => warning.path === "blocks[0].rows[0]" && /Expected 3 cells, found 2/.test(warning.message))
  && JSON.stringify(shortTableNormalized.blocks[0].rows[0]) === JSON.stringify(["Alice", "98", ""]), JSON.stringify({ validation: shortTableValidation, normalized: shortTableNormalized.blocks[0] }));
const longTableRow = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Long table row" }, blocks: [{ type: "table", columns: ["Name", "Score", "Status"], rows: [["Bob", "91", "Pass", "EXTRA CELL"]] }] });
check("document-table-long-row-blocks-silent-cell-loss", longTableRow.errors.some((error) => error.path === "blocks[0].rows[0]" && /Expected 3 cells, found 4/.test(error.message) && /discard 1 cell/.test(error.message)), JSON.stringify(longTableRow));
const tooManyBlocks = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Large" }, blocks: Array.from({ length: Model.LIMITS.maxBlocks + 1 }, () => ({ type: "paragraph", content: "" })) });
check("document-raw-validation-has-block-limit", tooManyBlocks.errors.some((error) => error.path === "blocks"), JSON.stringify(tooManyBlocks.errors));
let deeplyNestedCompatibility = {};
for (let index = 0; index < Model.LIMITS.maxDepth + 2; index += 1) deeplyNestedCompatibility = { next: deeplyNestedCompatibility };
const deeplyNestedValidation = Model.validateDocumentRaw({ format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Deep" }, blocks: [], compatibility: deeplyNestedCompatibility });
check("document-raw-validation-has-depth-limit", deeplyNestedValidation.errors.some((error) => error.message.includes("nesting")), JSON.stringify(deeplyNestedValidation.errors));
const remoteImageRaw = { format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Image" }, blocks: [{ type: "image", src: "https://example.test/pixel.png", remoteApproved: true }] };
check("document-import-does-not-trust-remote-image-approval", Model.normalizeDocument(remoteImageRaw).blocks[0].remoteApproved !== true && Model.normalizeDocument(remoteImageRaw, { allowRemoteImages: true }).blocks[0].remoteApproved === true, JSON.stringify(Model.normalizeDocument(remoteImageRaw)));

// Templates include the expected shareable envelope and are distinct from the
// document name carried by the template's document metadata.
const customTemplate = Model.makeTemplate(blank, { name: "My layout" });
check("document-template-envelope", customTemplate.format === "proofnote-template" && customTemplate.template.name === "My layout" && customTemplate.document.metadata.name === "Working title", JSON.stringify(customTemplate));
check("document-builtin-proof-template", Model.builtInTemplates().some((template) => template.template.id === "proof-note"), "missing Proof Note template");
const builtIns = Model.builtInTemplates();
const blankTemplate = builtIns.find((template) => template.template.id === "blank-document");
const proofTemplate = builtIns.find((template) => template.template.id === "proof-note");
check("document-template-controls-running-header", Boolean(blankTemplate) && blankTemplate.document.metadata.templateName === "" && Boolean(proofTemplate) && proofTemplate.document.metadata.templateName === "Proof Note", JSON.stringify({ blank: blankTemplate && blankTemplate.document.metadata, proof: proofTemplate && proofTemplate.document.metadata }));
check("document-proof-template-is-editorial", Boolean(proofTemplate) && proofTemplate.document.metadata.documentType === "Solution Note" && proofTemplate.document.metadata.status === "Draft" && proofTemplate.document.blocks.filter((block) => block.type === "semantic").every((block) => block.appearance === "editorial"), JSON.stringify(proofTemplate && proofTemplate.document));
const invalidTemplate = Model.validateTemplateRaw({ format: Model.TEMPLATE_FORMAT, version: Model.VERSION, template: { name: "Bad" }, document: { format: Model.FORMAT, version: Model.VERSION, metadata: { name: "Bad" }, blocks: [{ type: "table", rows: "not rows" }] } });
check("document-template-raw-validation", invalidTemplate.warnings.some((warning) => warning.path === "blocks[0].rows"), JSON.stringify(invalidTemplate));

const pass = results.filter((result) => result.pass).length;
results.forEach((result) => {
  console.log((result.pass ? "PASS" : "FAIL") + "  " + result.name);
  if (!result.pass && result.detail) console.log("      " + result.detail.slice(0, 240));
});
console.log("\n" + pass + " / " + results.length + " passed");
process.exit(pass === results.length ? 0 : 1);
