// Proofnote Editable HTML protocol regression tests.
//
// This suite is deliberately independent from the workspace editor. It tests
// the portable protocol boundary directly so a green UI smoke test cannot hide
// a lossy semantic round trip behind editor state or DOM implementation
// details. The browser editor loads this module after document-model and the
// shared reader renderer; this harness mirrors that order in JSDOM.
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const modelSource = fs.readFileSync(path.join(root, "src", "document-model.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "src", "document-renderer.js"), "utf8");
const protocolSource = fs.readFileSync(path.join(root, "src", "editable-html-protocol.js"), "utf8");

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail: detail || "" });
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function serializedDocument(dom) {
  return "<!doctype html>" + dom.window.document.documentElement.outerHTML;
}
function findBlock(document, type) {
  return document.querySelector('[data-pn-block-id][data-pn-type="' + type + '"]');
}
function textToken(field) {
  return field && (field.querySelector('[data-pn-token="text"]') || field);
}
function blockById(document, id) {
  return (document.blocks || []).find((block) => block && block.id === id);
}
async function revisionIdFor(Protocol, document) {
  return await Protocol.revisionIdForDocument(document);
}

function protocolFixture(Model) {
  return Model.normalizeDocument({
    format: Model.FORMAT,
    version: Model.VERSION,
    metadata: {
      name: "Editable protocol fixture",
      language: "en",
      documentType: "Project",
      author: "Ada",
      status: "Draft",
      runningHeader: { left: "Editable protocol fixture", right: "Project" },
      proofMetadata: { fields: ["author", "status"] },
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z"
    },
    blocks: [
      { id: "title_fixture", type: "title", content: "Editable protocol fixture" },
      { id: "subtitle_fixture", type: "subtitle", content: "A **portable** reader document." },
      { id: "heading_fixture", type: "heading", level: 2, content: "Method" },
      { id: "paragraph_fixture", type: "paragraph", content: "A [safe link](https://example.test), `literal **code**`, and \\(G_n\\)." },
      { id: "equation_fixture", type: "equation", content: "\\frac{x}{2}" },
      { id: "code_fixture", type: "code", language: "python", content: "def solve(x):\n    return x + 1" },
      { id: "image_fixture", type: "image", src: "https://images.example.test/proofnote.png", alt: "Protocol fixture", caption: "A remote image remains unapproved on import." },
      { id: "table_fixture", type: "table", header: false, columns: ["Name", "Value"], rows: [["alpha", "1"], ["beta", "2"]] },
      { id: "quote_fixture", type: "quote", content: "A quotation", citation: "Source" },
      { id: "divider_fixture", type: "divider" },
      { id: "page_break_fixture", type: "page-break" },
      { id: "callout_fixture", type: "callout", kind: "warning", title: "Caveat", content: "Keep the semantic kind." },
      { id: "semantic_fixture", type: "semantic", kind: "result", appearance: "editorial", bodyVisible: false, label: "Claim", title: "Main result", content: "The result is \\(x=2\\).", summary: "A short note." },
      { id: "list_fixture", type: "list", ordered: true, items: ["First", "Second"] },
      { id: "key_value_fixture", type: "key-value", items: [{ label: "Runtime", value: "3.2 s" }] },
      { id: "stats_fixture", type: "stats", items: [{ kicker: "Verified", value: "1", body: "claim" }] }
    ]
  });
}

async function main() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost/proofnote/"
  });
  const window = dom.window;
  Object.defineProperty(window.crypto, "subtle", { configurable: true, value: nodeCrypto.webcrypto.subtle });
  try {
    window.eval(modelSource);
    window.eval(rendererSource);
    window.eval(protocolSource);
    const Model = window.ProofnoteDocument;
    const Protocol = window.ProofnoteEditableHtml;
    const fixture = protocolFixture(Model);
    const built = await Protocol.build(fixture, {});

    check(
      "editable-html-protocol-v2-builds-a-semantic-carrier",
      Boolean(Protocol)
        && Protocol && Protocol.constants && Protocol.constants.VERSION === "2"
        && Boolean(built && built.html && built.document && built.envelope)
        && /<meta name="proofnote-format" content="editable-html">/i.test(built && built.html || "")
        && /<meta name="proofnote-version" content="2">/i.test(built && built.html || "")
        && /data-pn-block-id=/i.test(built && built.html || "")
        && /data-pn-type=/i.test(built && built.html || "")
        && /data-pn-field=/i.test(built && built.html || "")
        && /proofnote-editable-source/i.test(built && built.html || ""),
      (built && built.html || "").slice(0, 1000)
    );

    const exact = await Protocol.inspect(built.html);
    const exactTable = blockById(exact.document || {}, "table_fixture");
    const exactSemantic = blockById(exact.document || {}, "semantic_fixture");
    const exactRevision = exact.document ? await revisionIdFor(Protocol, exact.document) : "";
    const builtRevision = built.document ? await revisionIdFor(Protocol, built.document) : "";
    check(
      "editable-html-protocol-exact-roundtrips-canonical-semantic-fields",
      exact.status === "EXACT"
        && exact.document && exact.document.blocks.length === built.document.blocks.length
        && exactRevision === builtRevision
        && exactTable && exactTable.header === false
        && JSON.stringify(exactTable.columns) === JSON.stringify(["Name", "Value"])
        && JSON.stringify(exactTable.rows) === JSON.stringify([["alpha", "1"], ["beta", "2"]])
        && exactSemantic && exactSemantic.kind === "result" && exactSemantic.appearance === "editorial"
        && exactSemantic.bodyVisible === false && exactSemantic.summary === "A short note.",
      JSON.stringify({ status: exact.status, changes: exact.changes, diagnostic: exact.diagnostic, table: exactTable, semantic: exactSemantic })
    );

    // Being an exact export does not authorize replacing an unrelated open
    // document. Replacement is allowed only for the same portable lineage at
    // the exported baseline; unrelated documents remain a new-import path.
    const unrelatedLine = Protocol.ensureLineage(Model.blankDocument({
      name: "Unrelated current document",
      blocks: [Model.createBlock("title", { content: "Unrelated current document" })]
    })).document;
    const unrelatedCurrent = await Protocol.inspect(built.html, { currentDocument: unrelatedLine });
    check(
      "editable-html-protocol-keeps-an-exact-unrelated-lineage-import-non-replaceable",
      unrelatedCurrent.status === "EXACT" && unrelatedCurrent.replacementEligible === false,
      JSON.stringify({ status: unrelatedCurrent.status, replacementEligible: unrelatedCurrent.replacementEligible, diagnostic: unrelatedCurrent.diagnostic, warnings: unrelatedCurrent.warnings })
    );
    const sameCurrent = await Protocol.inspect(built.html, { currentDocument: built.document });
    check(
      "editable-html-protocol-allows-replacement-only-for-the-same-current-lineage-and-revision",
      sameCurrent.status === "EXACT" && sameCurrent.replacementEligible === true,
      JSON.stringify({ status: sameCurrent.status, replacementEligible: sameCurrent.replacementEligible, diagnostic: sameCurrent.diagnostic, warnings: sameCurrent.warnings })
    );

    // Remote-image approval is local browser-session trust, not portable
    // document meaning. Opening an image in the editor after export must not
    // make an otherwise untouched same-lineage file look stale.
    const sessionTrustedCurrent = clone(built.document);
    const sessionTrustedImage = (sessionTrustedCurrent.blocks || []).find((block) => block && block.type === "image");
    if (sessionTrustedImage) sessionTrustedImage.remoteApproved = true;
    const sessionTrusted = await Protocol.inspect(built.html, { currentDocument: sessionTrustedCurrent });
    check(
      "editable-html-protocol-excludes-session-only-image-approval-from-replacement-revision",
      Boolean(sessionTrustedImage)
        && sessionTrusted.status === "EXACT"
        && sessionTrusted.replacementEligible === true,
      JSON.stringify({ status: sessionTrusted.status, replacementEligible: sessionTrusted.replacementEligible, image: sessionTrustedImage, diagnostic: sessionTrusted.diagnostic, warnings: sessionTrusted.warnings })
    );

    // An author may add arbitrary visual styling or a presentation wrapper.
    // Neither is a canonical Proofnote field, so it becomes RECOVERED rather
    // than a rejection or a semantic change.
    const visualDom = new JSDOM(built.html);
    const visualField = findBlock(visualDom.window.document, "paragraph")?.querySelector('[data-pn-field="content"]');
    const wrapper = visualDom.window.document.createElement("div");
    wrapper.className = "external-editorial-wrapper";
    if (visualField && visualField.parentNode) {
      visualField.parentNode.insertBefore(wrapper, visualField);
      wrapper.appendChild(visualField);
    }
    const extraStyle = visualDom.window.document.createElement("style");
    extraStyle.textContent = ".external-editorial-wrapper { color: rebeccapurple; }";
    visualDom.window.document.head.appendChild(extraStyle);
    const visualOnly = await Protocol.inspect(serializedDocument(visualDom));
    const visualRevision = visualOnly.document ? await revisionIdFor(Protocol, visualOnly.document) : "";
    check(
      "editable-html-protocol-recovers-through-css-class-and-transparent-wrapper-changes",
      visualOnly.status === "RECOVERED"
        && visualOnly.changes && visualOnly.changes.visualOnly === true
        && visualRevision === builtRevision,
      JSON.stringify({ status: visualOnly.status, changes: visualOnly.changes, diagnostic: visualOnly.diagnostic })
    );

    // KaTeX is derived output. Altering only its rendered preview must never
    // override the explicit inline TeX source or turn into a protocol error.
    const previewDom = new JSDOM(built.html);
    const derivedPreview = previewDom.window.document.querySelector("[data-pn-rendered]");
    if (derivedPreview) derivedPreview.innerHTML = "<strong>externally changed preview</strong>";
    const previewOnly = await Protocol.inspect(serializedDocument(previewDom));
    const previewParagraph = blockById(previewOnly.document || {}, "paragraph_fixture");
    check(
      "editable-html-protocol-ignores-derived-katex-preview-edits",
      previewOnly.status === "RECOVERED"
        && previewOnly.changes && previewOnly.changes.visualOnly === true
        && previewParagraph && previewParagraph.content === blockById(built.document, "paragraph_fixture").content,
      JSON.stringify({ status: previewOnly.status, changes: previewOnly.changes, paragraph: previewParagraph, diagnostic: previewOnly.diagnostic })
    );

    // KaTeX's htmlAndMathml output legitimately contains MathML and can
    // include SVG. Those elements are safe only inside an explicit derived
    // preview; a visual-only rewrite forces reconciliation through that path.
    const originalKatex = window.katex;
    window.katex = {
      renderToString() {
        return '<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow></semantics></math></span><span class="katex-html"><svg><path d="M0 0"></path></svg></span></span>';
      }
    };
    const katexBuilt = await Protocol.build(fixture, {});
    window.katex = originalKatex;
    const katexDom = new JSDOM(katexBuilt.html);
    const katexStyle = katexDom.window.document.createElement("style");
    katexStyle.textContent = ".external-preview-only{opacity:.99}";
    katexDom.window.document.head.appendChild(katexStyle);
    const katexPreview = await Protocol.inspect(serializedDocument(katexDom));
    check(
      "editable-html-protocol-accepts-derived-katex-mathml-and-svg-only-inside-previews",
      katexPreview.status === "RECOVERED"
        && katexPreview.changes && katexPreview.changes.visualOnly === true,
      JSON.stringify({ status: katexPreview.status, changes: katexPreview.changes, diagnostic: katexPreview.diagnostic })
    );

    // A direct edit to the explicit semantic field is intentionally accepted
    // and becomes the recovered source of truth, independent of class/CSS.
    const editedDom = new JSDOM(built.html);
    const editedField = findBlock(editedDom.window.document, "paragraph")?.querySelector('[data-pn-field="content"]');
    // Paragraph fields deliberately keep their paragraph boundary. Replacing
    // the visible paragraph contents is the closest browser/AI edit to a
    // normal prose rewrite and proves the importer does not rely on source
    // token markup surviving exactly.
    const editedParagraphNode = editedField && editedField.querySelector("[data-pn-paragraph]");
    if (editedParagraphNode) editedParagraphNode.textContent = "Externally revised semantic content.";
    const editedHtml = serializedDocument(editedDom);
    const edited = await Protocol.inspect(editedHtml);
    const editedParagraph = blockById(edited.document || {}, "paragraph_fixture");
    check(
      "editable-html-protocol-recovers-an-explicit-visible-content-edit",
      edited.status === "RECOVERED"
        && edited.changes && Number(edited.changes.edited || 0) >= 1
        && editedParagraph && editedParagraph.content === "Externally revised semantic content.",
      JSON.stringify({ status: edited.status, changes: edited.changes, paragraph: editedParagraph, diagnostic: edited.diagnostic })
    );

    // The rich paragraph boundaries are semantic, not decorative. Text added
    // beside a marked paragraph would previously be skipped during recovery;
    // reject it instead of silently dropping an external edit.
    const orphanParagraphTextDom = new JSDOM(built.html);
    const orphanParagraphTextField = findBlock(orphanParagraphTextDom.window.document, "paragraph")?.querySelector('[data-pn-field="content"]');
    if (orphanParagraphTextField) orphanParagraphTextField.appendChild(orphanParagraphTextDom.window.document.createTextNode(" unmarked external text"));
    const orphanParagraphText = await Protocol.inspect(serializedDocument(orphanParagraphTextDom));
    check(
      "editable-html-protocol-rejects-unmarked-raw-text-outside-rich-paragraph-boundaries",
      orphanParagraphText.status === "INVALID"
        && orphanParagraphText.diagnostic && orphanParagraphText.diagnostic.code === "orphan-paragraph-content",
      JSON.stringify({ status: orphanParagraphText.status, diagnostic: orphanParagraphText.diagnostic })
    );

    // The same rule applies to a protocol token: it must be within an
    // explicit paragraph carrier, rather than sitting in a field where the
    // content parser would never consume it.
    const orphanParagraphTokenDom = new JSDOM(built.html);
    const orphanParagraphTokenField = findBlock(orphanParagraphTokenDom.window.document, "paragraph")?.querySelector('[data-pn-field="content"]');
    const sourceToken = orphanParagraphTokenField?.querySelector("[data-pn-token]");
    if (orphanParagraphTokenField) {
      const token = sourceToken
        ? sourceToken.cloneNode(true)
        : (() => {
          const node = orphanParagraphTokenDom.window.document.createElement("span");
          node.setAttribute("data-pn-token", "text");
          node.textContent = "orphan token";
          return node;
        })();
      orphanParagraphTokenField.appendChild(token);
    }
    const orphanParagraphToken = await Protocol.inspect(serializedDocument(orphanParagraphTokenDom));
    check(
      "editable-html-protocol-rejects-protocol-tokens-outside-rich-paragraph-boundaries",
      orphanParagraphToken.status === "INVALID"
        && orphanParagraphToken.diagnostic && orphanParagraphToken.diagnostic.code === "orphan-paragraph-content",
      JSON.stringify({ status: orphanParagraphToken.status, diagnostic: orphanParagraphToken.diagnostic })
    );

    // Visible metadata is a separate semantic payload, intentionally not part
    // of the immutable baseline carrier. Its protocol edit must survive
    // reconciliation just like a block field.
    const metadataDom = new JSDOM(built.html);
    const visibleAuthor = metadataDom.window.document.querySelector('[data-pn-meta-field="author"]');
    const authorToken = textToken(visibleAuthor);
    if (authorToken) authorToken.textContent = "Grace";
    const metadataEdit = await Protocol.inspect(serializedDocument(metadataDom));
    check(
      "editable-html-protocol-recovers-the-explicit-visible-metadata-payload",
      metadataEdit.status === "RECOVERED"
        && metadataEdit.document && metadataEdit.document.metadata.author === "Grace"
        && metadataEdit.changes && metadataEdit.changes.visualOnly === false,
      JSON.stringify({ status: metadataEdit.status, changes: metadataEdit.changes, metadata: metadataEdit.document && metadataEdit.document.metadata, diagnostic: metadataEdit.diagnostic })
    );

    const duplicateMetadataDom = new JSDOM(built.html);
    const metadataHost = duplicateMetadataDom.window.document.querySelector("[data-pn-metadata-fields]");
    const authorField = metadataHost && metadataHost.querySelector('[data-pn-meta-field="author"]');
    if (metadataHost && authorField) metadataHost.appendChild(authorField.cloneNode(true));
    const duplicateMetadata = await Protocol.inspect(serializedDocument(duplicateMetadataDom));
    check(
      "editable-html-protocol-rejects-duplicated-visible-metadata-fields",
      duplicateMetadata.status === "INVALID"
        && duplicateMetadata.diagnostic && duplicateMetadata.diagnostic.code === "ambiguous-metadata-field",
      JSON.stringify({ status: duplicateMetadata.status, diagnostic: duplicateMetadata.diagnostic })
    );

    // The hidden structured metadata template remains semantic input too. A
    // duplicate JSON key is ambiguous across parsers, so it is never resolved
    // by choosing either occurrence.
    const duplicateMetadataKeyDom = new JSDOM(built.html);
    const metadataTemplate = duplicateMetadataKeyDom.window.document.querySelector("template[data-pn-metadata]");
    if (metadataTemplate) metadataTemplate.innerHTML = '{"name":"First","name":"Second"}';
    const duplicateMetadataKey = await Protocol.inspect(serializedDocument(duplicateMetadataKeyDom));
    check(
      "editable-html-protocol-rejects-duplicated-structured-metadata-json-keys",
      duplicateMetadataKey.status === "INVALID"
        && duplicateMetadataKey.diagnostic && duplicateMetadataKey.diagnostic.code === "duplicate-metadata-key",
      JSON.stringify({ status: duplicateMetadataKey.status, diagnostic: duplicateMetadataKey.diagnostic })
    );

    // The protocol is a document loop rather than an edit-in-place text
    // transport: an external tool can omit an old block, reorder retained
    // ones, and add a new `ext_` block. The latter must receive a normal
    // Proofnote ID after validation rather than preserving transport-only
    // identity in the canonical document.
    const structuralDom = new JSDOM(built.html);
    const structuralBlocks = structuralDom.window.document.querySelector("[data-pn-blocks]");
    const removedHeading = findBlock(structuralDom.window.document, "heading");
    const movedParagraph = findBlock(structuralDom.window.document, "paragraph");
    if (removedHeading) removedHeading.remove();
    if (structuralBlocks && movedParagraph) structuralBlocks.appendChild(movedParagraph);
    const externalBlock = movedParagraph && movedParagraph.cloneNode(true);
    if (externalBlock && structuralBlocks) {
      externalBlock.setAttribute("data-pn-block-id", "ext_ai_added_paragraph");
      const externalParagraph = externalBlock.querySelector("[data-pn-paragraph]");
      if (externalParagraph) externalParagraph.textContent = "A protocol-compliant external block.";
      structuralBlocks.appendChild(externalBlock);
    }
    const structural = await Protocol.inspect(serializedDocument(structuralDom));
    const addedBlock = (structural.document && structural.document.blocks || []).find((block) => block && block.content === "A protocol-compliant external block.");
    check(
      "editable-html-protocol-recovers-delete-reorder-and-ext-block-insertion-without-transport-id-leakage",
      structural.status === "RECOVERED"
        && structural.changes && Number(structural.changes.deleted || 0) >= 1
        && Number(structural.changes.inserted || 0) >= 1
        && Number(structural.changes.moved || 0) >= 1
        && !(structural.document && structural.document.blocks || []).some((block) => block && block.id === "heading_fixture")
        && addedBlock && !String(addedBlock.id || "").startsWith("ext_"),
      JSON.stringify({ status: structural.status, changes: structural.changes, addedBlock, diagnostic: structural.diagnostic })
    );

    // This is the complete external-editor loop rather than merely a parser
    // assertion: a recovered document with a deleted block, a moved retained
    // block, and an ext_ insertion must export as a fresh v2 baseline and
    // then import exactly. The transport-only ext_ ID must never reappear.
    const structuralReexport = structural.document ? await Protocol.build(structural.document, {}) : null;
    const structuralExact = structuralReexport ? await Protocol.inspect(structuralReexport.html) : null;
    const structuralAddedAfterExport = structuralExact && (structuralExact.document.blocks || []).find((block) => block && block.content === "A protocol-compliant external block.");
    check(
      "editable-html-protocol-reexports-a-recovered-regrouped-document-as-the-next-exact-baseline",
      structuralExact && structuralExact.status === "EXACT"
        && structuralAddedAfterExport
        && structuralAddedAfterExport.id === addedBlock.id
        && !String(structuralAddedAfterExport.id || "").startsWith("ext_")
        && !(structuralExact.document.blocks || []).some((block) => block && block.id === "heading_fixture"),
      JSON.stringify({ status: structuralExact && structuralExact.status, addedBlock, structuralAddedAfterExport, diagnostic: structuralExact && structuralExact.diagnostic })
    );

    // Heading content and heading level are schema-owned fields, not a
    // presentation class. A direct semantic edit must therefore survive
    // reconciliation and preserve the explicit level.
    const headingEditDom = new JSDOM(built.html);
    const headingField = findBlock(headingEditDom.window.document, "heading")?.querySelector('[data-pn-field="content"]');
    if (headingField) headingField.textContent = "Reframed method";
    const headingEdit = await Protocol.inspect(serializedDocument(headingEditDom));
    const editedHeading = blockById(headingEdit.document || {}, "heading_fixture");
    check(
      "editable-html-protocol-recovers-a-heading-field-with-its-schema-level",
      headingEdit.status === "RECOVERED"
        && editedHeading && editedHeading.content === "Reframed method" && editedHeading.level === 2,
      JSON.stringify({ status: headingEdit.status, heading: editedHeading, diagnostic: headingEdit.diagnostic })
    );

    // A large deletion remains recoverable, but it needs an explicit warning
    // so an external HTML tool silently dropping much of a document cannot
    // look like a routine content change.
    const highDeletionDom = new JSDOM(built.html);
    const highDeletionHost = highDeletionDom.window.document.querySelector("[data-pn-blocks]");
    const highDeletionBlocks = highDeletionHost
      ? Array.from(highDeletionHost.children).filter((node) => node.hasAttribute("data-pn-block-id"))
      : [];
    highDeletionBlocks.slice(0, Math.ceil(highDeletionBlocks.length / 2)).forEach((node) => node.remove());
    const highDeletion = await Protocol.inspect(serializedDocument(highDeletionDom));
    check(
      "editable-html-protocol-flags-large-recovered-block-deletions-for-confirmation",
      highDeletion.status === "RECOVERED"
        && highDeletion.changes && highDeletion.changes.highDeletion === true
        && Number(highDeletion.changes.deletionRatio || 0) >= 0.5
        && Array.isArray(highDeletion.warnings)
        && highDeletion.warnings.some((warning) => /removes/i.test(String(warning))),
      JSON.stringify({ status: highDeletion.status, changes: highDeletion.changes, warnings: highDeletion.warnings, diagnostic: highDeletion.diagnostic })
    );

    // A same-lineage file cannot silently replace a document that advanced
    // locally after its exported baseline. The caller may still import it as
    // a new branch, but replacement eligibility must be false.
    const locallyAdvanced = clone(built.document);
    blockById(locallyAdvanced, "paragraph_fixture").content = "Local revision after export.";
    const stale = await Protocol.inspect(editedHtml, { currentDocument: locallyAdvanced });
    check(
      "editable-html-protocol-classifies-same-lineage-divergence-as-stale-not-replaceable",
      stale.status === "STALE" && stale.replacementEligible === false,
      JSON.stringify({ status: stale.status, replacementEligible: stale.replacementEligible, changes: stale.changes, diagnostic: stale.diagnostic })
    );

    // Duplicating a semantic field makes ownership ambiguous. The importer
    // must reject it rather than choose the first field or silently lose text.
    const malformedDom = new JSDOM(built.html);
    const malformedBlock = findBlock(malformedDom.window.document, "paragraph");
    const originalField = malformedBlock?.querySelector('[data-pn-field="content"]');
    if (malformedBlock && originalField) malformedBlock.appendChild(originalField.cloneNode(true));
    const malformed = await Protocol.inspect(serializedDocument(malformedDom));
    check(
      "editable-html-protocol-rejects-duplicated-or-ambiguous-semantic-fields",
      malformed.status === "INVALID"
        && malformed.diagnostic && malformed.diagnostic.code === "ambiguous-field",
      JSON.stringify({ status: malformed.status, diagnostic: malformed.diagnostic })
    );

    // A copied block that retains its original transport ID is just as
    // ambiguous as a duplicated field. The importer must reject it instead
    // of treating one copy as an insertion or picking a document position.
    const duplicateBlockDom = new JSDOM(built.html);
    const duplicateBlockHost = duplicateBlockDom.window.document.querySelector("[data-pn-blocks]");
    const duplicateBlock = findBlock(duplicateBlockDom.window.document, "paragraph");
    if (duplicateBlockHost && duplicateBlock) duplicateBlockHost.appendChild(duplicateBlock.cloneNode(true));
    const duplicateBlockResult = await Protocol.inspect(serializedDocument(duplicateBlockDom));
    check(
      "editable-html-protocol-rejects-duplicated-block-identity-instead-of-guessing",
      duplicateBlockResult.status === "INVALID"
        && duplicateBlockResult.diagnostic && duplicateBlockResult.diagnostic.code === "duplicate-block-id",
      JSON.stringify({ status: duplicateBlockResult.status, diagnostic: duplicateBlockResult.diagnostic })
    );

    // The baseline is the reconciliation anchor. A one-character mutation in
    // its inert source must fail integrity verification before visible HTML is
    // ever interpreted as document content.
    const carrierStart = built.html.indexOf('<script id="proofnote-editable-source"');
    const corruptedBaselineHtml = carrierStart >= 0
      ? built.html.slice(0, carrierStart) + built.html.slice(carrierStart).replace("Editable protocol fixture", "Corrupted baseline fixture")
      : built.html;
    const corruptedBaseline = await Protocol.inspect(corruptedBaselineHtml);
    check(
      "editable-html-protocol-rejects-a-corrupted-baseline-before-reconciliation",
      corruptedBaseline.status === "INVALID"
        && corruptedBaseline.diagnostic
        && ["invalid-source-integrity", "source-integrity-failed"].includes(corruptedBaseline.diagnostic.code),
      JSON.stringify({ status: corruptedBaseline.status, diagnostic: corruptedBaseline.diagnostic })
    );

    const presentationOnly = await Protocol.inspect("<!doctype html><html><head><title>Proofnote</title></head><body><article class=\"pn-document\"><h1>Presentation only</h1></article></body></html>");
    check(
      "editable-html-protocol-rejects-legacy-presentation-html-instead-of-guessing-blocks",
      presentationOnly.status === "INVALID"
        && presentationOnly.diagnostic && presentationOnly.diagnostic.code === "presentation-only",
      JSON.stringify({ status: presentationOnly.status, diagnostic: presentationOnly.diagnostic })
    );

    // Old standalone Proofnote exports often contain KaTeX's MathML. They
    // are still presentation-only when the dedicated v2 carrier is absent;
    // carrier recognition must happen before unrelated visual markup is
    // evaluated. A fake carrier remains an invalid protocol file, not a
    // presentation import that could bypass validation.
    const legacyMathPresentation = await Protocol.inspect('<!doctype html><html><body><article class="pn-document"><span class="katex"><math><mrow><mi>x</mi></mrow></math></span></article></body></html>');
    const hostileCarrier = await Protocol.inspect('<!doctype html><html><body><article class="pn-document"></article><script id="proofnote-editable-source" type="text/javascript">alert(1)</script></body></html>');
    check(
      "editable-html-protocol-classifies-legacy-katex-presentation-before-visual-validation-without-accepting-a-fake-carrier",
      legacyMathPresentation.status === "INVALID"
        && legacyMathPresentation.diagnostic && legacyMathPresentation.diagnostic.code === "presentation-only"
        && hostileCarrier.status === "INVALID"
        && hostileCarrier.diagnostic && hostileCarrier.diagnostic.code === "invalid-source-carrier",
      JSON.stringify({ legacyMath: legacyMathPresentation.diagnostic, hostileCarrier: hostileCarrier.diagnostic })
    );
  } catch (error) {
    check("editable-html-protocol-test-harness", false, error && error.stack ? error.stack : String(error));
  } finally {
    dom.window.close();
  }

  const passed = results.filter((result) => result.pass).length;
  results.forEach((result) => {
    console.log((result.pass ? "PASS" : "FAIL") + "  " + result.name);
    if (!result.pass && result.detail) console.log("      " + String(result.detail).slice(0, 1000));
  });
  console.log("\n" + passed + " / " + results.length + " passed");
  process.exitCode = passed === results.length ? 0 : 1;
}

main();
