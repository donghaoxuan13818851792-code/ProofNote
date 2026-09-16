// Workspace editor smoke tests. Unlike the legacy regression suite, this
// explicitly evaluates the three external document scripts: JSDOM does not
// fetch <script src> files when it is given index.html as a string.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const modelSource = fs.readFileSync(path.join(root, "src", "document-model.js"), "utf8");
const storeSource = fs.readFileSync(path.join(root, "src", "document-store.js"), "utf8");
const projectAiInstructionsSource = fs.readFileSync(path.join(root, "src", "project-ai-instructions.js"), "utf8");
const jsoncParserSource = fs.readFileSync(path.join(root, "vendor", "jsonc-parser", "jsonc-parser.js"), "utf8");
const prismSource = fs.readFileSync(path.join(root, "vendor", "prism", "prism.js"), "utf8");
const prismLanguageSources = [
  "prism-typescript.min.js", "prism-c.min.js", "prism-cpp.min.js", "prism-java.min.js",
  "prism-bash.min.js", "prism-sql.min.js", "prism-json.min.js", "prism-python.min.js"
].map((name) => fs.readFileSync(path.join(root, "vendor", "prism", name), "utf8"));
const editorSource = fs.readFileSync(path.join(root, "src", "document-editor.js"), "utf8");
const editorCss = fs.readFileSync(path.join(root, "src", "document-editor.css"), "utf8");
const docPageSource = fs.readFileSync(path.join(root, "src", "doc-page.js"), "utf8");

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail: detail || "" });
}
function nextTurn(window) {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
async function settle(window, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1000);
  do {
    if (!predicate || predicate()) return true;
    await nextTurn(window);
  } while (Date.now() < deadline);
  return Boolean(predicate && predicate());
}
function blockHasControlValue(block, value) {
  return Array.from(block.querySelectorAll("input, textarea")).some((control) => control.value === value);
}
function canvasBlockNodes(document) {
  return Array.from(document.querySelectorAll("#pnCanvas .pn-canvas-block")).filter((block) => Boolean(block.dataset.blockId));
}
function proofHeaderBlockCount(document) {
  const header = document.querySelector("#pnCanvas .pn-canvas-proof-header");
  if (!header) return 0;
  return 1 + (header.querySelector(".pn-document-subtitle") ? 1 : 0);
}

async function main() {
  const runtimeErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => runtimeErrors.push(error && error.message ? error.message : String(error)));
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost/proofnote/",
    virtualConsole
  });
  const window = dom.window;
  const document = window.document;
  const originalConsoleError = window.console.error;
  window.console.error = function () {
    runtimeErrors.push(Array.from(arguments).map(String).join(" "));
    // Do not write expected implementation failures into a successful test log.
    // The assertion below reports them in a compact, actionable form.
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};

  try {
    // Seed a deterministic document before the editor's async initialisation.
    // This also proves the external model/store/editor scripts cooperate rather
    // than relying on the old inline Solution Note editor.
    window.eval(modelSource);
    window.eval(storeSource);
    window.eval(projectAiInstructionsSource);
    const jsoncScript = document.createElement("script");
    jsoncScript.text = jsoncParserSource;
    document.head.appendChild(jsoncScript);
    window.Prism = { manual: true };
    window.eval(prismSource);
    prismLanguageSources.forEach((source) => window.eval(source));
    const projectAiInstructions = window.PROOFNOTE_PROJECT_AI_INSTRUCTIONS;
    const Model = window.ProofnoteDocument;
    const fixture = Model.blankDocument({
      name: "Canvas QA",
      templateName: "Proof Note",
      blocks: [
        Model.createBlock("title", { content: "Canvas QA" }),
        Model.createBlock("subtitle", { content: "A concise statement of the result." }),
        Model.createBlock("semantic", { kind: "problem", title: "Canvas problem", content: "Direct editing should keep focus." }),
        Model.createBlock("semantic", { kind: "result", title: "Canvas result", content: "The active outline item must follow the selected block." }),
        Model.createBlock("heading", { level: 1, content: "Method" }),
        Model.createBlock("heading", { level: 2, content: "Procedure" }),
        Model.createBlock("paragraph", { content: "Procedure content" }),
        Model.createBlock("table", { columns: ["Input"], rows: [["Observed"]] }),
        Model.createBlock("list", { items: ["First item"] }),
        Model.createBlock("equation", { content: "x^2 = 4" }),
        Model.createBlock("code", { language: "js", content: "const answer = 42;" }),
        Model.createBlock("image", { src: "data:image/png;base64,AA==", alt: "A test image", caption: "Figure 1" }),
        Model.createBlock("heading", { level: 2, content: "Equipment" }),
        Model.createBlock("heading", { level: 3, content: "Details" }),
        Model.createBlock("paragraph", { content: "A closing paragraph." }),
        Model.createBlock("paragraph", { content: "For \\(G_n\\), the bound is \\(k(n) \\le n\\)." }),
        Model.createBlock("heading", { level: 1, content: "" })
      ]
    });
    window.localStorage.setItem("proofnote-document:current:v1", JSON.stringify(fixture));
    window.eval(editorSource);
    const canvasReady = await settle(window, () => {
      return canvasBlockNodes(document).length + proofHeaderBlockCount(document) === fixture.blocks.length;
    });

    const app = document.querySelector("#proofnoteDocumentApp");
    const canvas = document.querySelector("#pnCanvas");
    const detail = document.querySelector("#pnDetail");
    const inspector = document.querySelector("#pnInspector");
    const actionMenu = document.querySelector("#pnActionMenu");
    const templateLibrary = document.querySelector("#pnTemplates");
    const templateMenu = document.querySelector("#pnTemplateMenu");
    const confirmModal = document.querySelector("#pnConfirmModal");
    const utilityToggle = document.querySelector("#pnUtilityToggle");
    const sidebarResize = document.querySelector("#pnSidebarResize");
    const outline = document.querySelector("#pnOutline");
    let canvasBlocks = canvasBlockNodes(document);
    const initialCanvasBlockIds = new Set(canvasBlocks.map((block) => block.dataset.blockId));
    const globalActionIds = ["pnImport", "pnExportHtml", "pnExportMore", "pnExport", "pnCopyAi"];

    check("editor-external-scripts-boot", Boolean(document.querySelector("#proofnoteDocumentApp")) && Boolean(window.ProofnoteDocument) && Boolean(window.ProofnoteStore) && Boolean(window.ProofnoteJsoncParser?.parse) && Boolean(window.Prism)
      && Boolean(window.Prism.languages.python)
      && html.includes('window.Prism = { manual: true }')
      && html.includes('./vendor/prism/prism-python.min.js?v=1.30.0')
      && html.includes('./vendor/jsonc-parser/jsonc-parser.js?v=3.3.1')
      && html.indexOf('./vendor/jsonc-parser/jsonc-parser.js?v=3.3.1') < html.indexOf('./src/document-editor.js?v=workspace-20260916-52'), "document-model.js, document-store.js, JSON diagnostics, Prism, and document-editor.js did not all boot in browser load order");
    check(
      "editor-document-typography-is-shared",
      [
        "--pn-doc-body-size", "--pn-doc-body-leading", "--pn-doc-title-size",
        "--pn-doc-summary-size", "--pn-doc-section-1-size", "--pn-doc-label-size", "--pn-doc-meta-size"
      ].every((token) => editorCss.includes(token) && editorSource.includes(token))
        && editorCss.includes("--pn-doc-page-width: 8.5in")
        && editorSource.includes("max-width:712px"),
      "canvas and standalone HTML must share the original Proofnote document type scale and reading measure"
    );
    if (utilityToggle) utilityToggle.click();
    await settle(window, () => sidebarResize && sidebarResize.hidden === false);
    check(
      "editor-sidebar-is-resizable",
      Boolean(sidebarResize)
        && sidebarResize.getAttribute("role") === "separator"
        && sidebarResize.getAttribute("aria-orientation") === "vertical"
        && sidebarResize.getAttribute("aria-valuemin") === "180"
        && sidebarResize.getAttribute("aria-valuemax") === "360"
        && sidebarResize.hidden === false
        && editorSource.includes("const SIDEBAR_DEFAULT_WIDTH = 360")
        && !editorSource.includes("SIDEBAR_WIDTH_KEY")
        && editorSource.includes("bindSidebarResize")
        && editorCss.includes("cursor: col-resize"),
      "the open navigation sidebar needs a keyboard-accessible session resize separator that resets to its wide default on reload"
    );
    check(
      "editor-outline-is-a-document-structure-tree",
      editorCss.includes(".pn-utility { background: color-mix(in srgb, var(--color-bg) 94%, var(--color-surface)); font-family: var(--pn-doc-body); }")
        && editorCss.includes(".pn-outline-disclosure.is-expanded")
        && editorCss.includes(".pn-outline-children::before")
        && editorCss.includes("left: calc((var(--pn-outline-level) * 13px) + 11px)")
        && editorCss.includes(".pn-outline-number")
        && editorCss.includes(".pn-outline-item.is-active")
        && editorCss.includes(".pn-sidebar-tabs { display: grid; grid-template-columns: 1fr 1fr;")
        && editorSource.includes("buildOutlineTree")
        && editorSource.includes("function outlineEditorialNumber")
        && Array.from(outline.children).map((node) => node.firstElementChild?.querySelector(".pn-outline-number")?.textContent || "").join(",") === "01,02,03,04"
        && editorSource.includes("setOutlineCollapsed")
        && editorSource.includes("updateViewportOutlineActive")
        && document.querySelectorAll("#pnOutlinePanel .pn-sidebar-heading").length === 1
        && Boolean(outline)
        && outline.querySelectorAll(".pn-outline-item").length === 7
        && outline.textContent.includes("Canvas problem")
        && outline.textContent.includes("Canvas result")
        && outline.textContent.includes("Method")
        && outline.textContent.includes("Details")
        && /Untitled section|未命名章节/.test(outline.textContent)
        && !outline.textContent.includes("Canvas QA")
        && !outline.querySelector(".pn-outline-kind")
        && /Document navigation|文档导航/.test(document.querySelector("#pnUtilityToggle").textContent),
      "navigation should show a collapsible document structure without schema labels or the document title"
    );
    check(
      "editor-canvas-scales-with-sidebar",
      editorSource.includes("syncCanvasScale")
        && editorSource.includes("--doc-page-screen-scale")
        && editorCss.includes("--doc-page-screen-w: var(--pn-doc-page-width)")
        && docPageSource.includes("zoom: var(--doc-page-screen-scale, 1)")
        && docPageSource.includes("width: auto; margin: 0; zoom: 1;"),
      "a narrower desktop workspace must scale the whole screen sheet while print remains true size"
    );
    check(
      "editor-single-canvas",
      canvasReady
        && document.querySelectorAll("#pnCanvas").length === 1
        && Boolean(document.querySelector("#pnCanvas .pn-canvas-proof-header"))
        && canvasBlocks.length + proofHeaderBlockCount(document) === fixture.blocks.length,
      "expected one populated #pnCanvas; the Proof Note masthead intentionally groups title and subtitle into one document-header surface"
    );
    check("editor-no-duplicate-surface", !document.querySelector(".pn-editor") && !document.querySelector("#pnPreviewRoot"), "legacy editor/preview surface is still present");
    check(
      "editor-proof-template-restores-editorial-structure",
      canvas.classList.contains("pn-proofnote-document")
        && document.querySelector("#pnPageHeader").textContent.includes("Proofnote")
        && document.querySelector("#pnPageHeader").textContent.includes("Solution Note")
        && Boolean(document.querySelector("#pnCanvas .pn-proof-metadata"))
        && Boolean(document.querySelector("#pnCanvas .pn-editorial-section"))
        && !document.querySelector("#pnCanvas .pn-semantic"),
      "Proof Note should use the original running header, metadata, and continuous numbered sections instead of default semantic cards"
    );
    const proofMetadata = document.querySelector("#pnCanvas .pn-proof-metadata");
    const proofHeader = document.querySelector("#pnCanvas .pn-canvas-proof-header");
    if (proofMetadata) proofMetadata.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await settle(window, () => inspector && inspector.querySelectorAll(".pn-inspector-toggle-control").length === 4);
    check(
      "editor-proof-metadata-has-contextual-display-controls",
      Boolean(proofMetadata)
        && Boolean(proofHeader)
        && proofHeader.classList.contains("pn-canvas-block")
        && Boolean(proofHeader.querySelector(".pn-canvas-grip"))
        && Boolean(proofHeader.querySelector(".pn-canvas-overflow"))
        && Boolean(inspector)
        && inspector.querySelectorAll(".pn-inspector-toggle-control").length === 4
        && /Document|文档/.test(document.querySelector("#pnInspectorTopLabel").textContent),
      inspector ? inspector.textContent : "missing metadata inspector"
    );
    const findDisplayToggle = (pattern) => Array.from(inspector.querySelectorAll(".pn-inspector-toggle")).find((row) => pattern.test(row.textContent))?.querySelector("input");
    let subtitleToggle = findDisplayToggle(/Show subtitle|显示副标题/);
    if (subtitleToggle) subtitleToggle.click();
    await settle(window, () => !document.querySelector("#pnCanvas .pn-document-subtitle"));
    check(
      "editor-proof-header-subtitle-can-be-hidden-and-restored",
      Boolean(subtitleToggle)
        && !document.querySelector("#pnCanvas .pn-document-subtitle")
        && editorSource.includes("setHeaderSubtitleVisible")
        && editorSource.includes("headerSubtitle: { visible: true }"),
      inspector ? inspector.textContent : "missing subtitle display control"
    );
    subtitleToggle = findDisplayToggle(/Show subtitle|显示副标题/);
    if (subtitleToggle) subtitleToggle.click();
    await settle(window, () => Boolean(document.querySelector("#pnCanvas .pn-document-subtitle")));
    const disableMetadataField = async () => {
      const control = Array.from(inspector.querySelectorAll(".pn-inspector-toggle"))
        .filter((row) => /Author|作者|Date|日期|Status|状态/.test(row.textContent))
        .map((row) => row.querySelector("input"))
        .find((node) => node && node.checked);
      if (control) control.click();
      await settle(window);
    };
    await disableMetadataField();
    await disableMetadataField();
    await disableMetadataField();
    check(
      "editor-proof-metadata-hides-entire-group-when-no-fields-selected",
      !document.querySelector("#pnCanvas .pn-proof-metadata")
        && inspector.querySelectorAll(".pn-inspector-toggle-control").length === 4
        && /hidden from the page|已从纸面隐藏/.test(inspector.textContent)
        && editorSource.includes('if (!fields.length) return "";'),
      inspector ? inspector.textContent : "missing hidden-metadata inspector"
    );
    const titleCanvasBlock = document.querySelector("#pnCanvas .pn-canvas-proof-header");
    if (titleCanvasBlock) titleCanvasBlock.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle(window, () => inspector && inspector.querySelectorAll(".pn-inspector-toggle-control").length === 4);
    const restoreMetadata = findDisplayToggle(/Author|作者|Date|日期|Status|状态/);
    if (restoreMetadata) restoreMetadata.click();
    await settle(window);
    check(
      "editor-proof-header-inspector-can-restore-complete-hide",
      Boolean(document.querySelector("#pnCanvas .pn-proof-metadata"))
        && document.querySelectorAll("#pnCanvas .pn-proof-metadata-item").length === 1,
      document.querySelector("#pnCanvas").textContent
    );
    const closeMetadataInspector = document.querySelector("#pnCloseInspector");
    if (closeMetadataInspector) closeMetadataInspector.click();
    await settle(window, () => detail && detail.hidden === true);
    canvasBlocks = canvasBlockNodes(document);
    check(
      "editor-editorial-export-is-shared",
      editorSource.includes("EXPORT_PROOFNOTE_EDITORIAL_CSS")
        && editorSource.includes("renderStandaloneDocument")
        && editorCss.includes(".pn-editorial-section-head")
        && editorCss.includes(".pn-proofnote-running"),
      "the standalone export and direct canvas must share Proof Note's editorial rendering language"
    );
    check("editor-inline-insert-points", document.querySelectorAll("#pnCanvas .pn-insert-point").length > 0, "expected inline insertion affordances inside #pnCanvas");
    check(
      "editor-paragraphs-keep-the-editorial-canvas-gutter",
      editorSource.includes('body.className = "pn-canvas-paragraph-content"')
        && editorCss.includes(".pn-canvas-block.pn-canvas-paragraph { margin: 0 -10px 11pt; }")
        && editorCss.includes(".pn-canvas-paragraph-content { margin: 0; }"),
      "a standalone paragraph must share the section body's left edge rather than override the canvas gutter"
    );
    check(
      "editor-bottom-add-block-is-curated",
      ["section", "paragraph", "equation", "code", "table", "quote", "divider", "page-break", "callout", "semantic", "list"].every((type) => editorSource.includes('"' + type + '"'))
        && editorSource.includes('kind: "section"')
        && editorSource.includes('appearance: "editorial"')
        && !/INSERTABLE_BLOCK_TYPES[^;]*"heading"/.test(editorSource)
        && !/INSERTABLE_BLOCK_TYPES[^;]*"title"/.test(editorSource)
        && !/INSERTABLE_BLOCK_TYPES[^;]*"subtitle"/.test(editorSource)
        && !/INSERTABLE_BLOCK_TYPES[^;]*"image"/.test(editorSource)
        && !/INSERTABLE_BLOCK_TYPES[^;]*"key-value"/.test(editorSource)
        && !/INSERTABLE_BLOCK_TYPES[^;]*"stats"/.test(editorSource)
        && /\["equation", "Standalone equation", "独立公式"\]/.test(editorSource)
        && /\["quote", "Citation", "引文"\]/.test(editorSource)
        && /\["callout", "Callout", "注释框"\]/.test(editorSource),
      "the canvas picker must stay narrower than the document type registry"
    );
    check("editor-inspector-anchor", Boolean(inspector) && Boolean(detail), "missing contextual #pnInspector or #pnDetail");
    check(
      "editor-global-actions-live-in-top-menu",
      Boolean(actionMenu)
        && Boolean(actionMenu.closest(".pn-workspace-toolbar"))
        && globalActionIds.every((id) => {
          const control = document.getElementById(id);
          return Boolean(control) && actionMenu.contains(control) && !(detail && detail.contains(control));
        }),
      "Import/export/AI controls must live in #pnActionMenu, not inside the contextual Inspector"
    );
    const actionToggle = document.querySelector("#pnActionsToggle");
    const exportMore = document.querySelector("#pnExportMore");
    const exportMoreMenu = document.querySelector("#pnExportMoreMenu");
    if (actionToggle && actionMenu && actionMenu.hidden) actionToggle.click();
    if (exportMore) exportMore.click();
    await settle(window, () => exportMoreMenu && exportMoreMenu.hidden === false);
    check(
      "editor-export-menu-prioritizes-html-and-keeps-a-project-backup",
      Boolean(exportMore)
        && Boolean(exportMoreMenu)
        && exportMoreMenu.hidden === false
        && Boolean(exportMoreMenu.querySelector("#pnExport"))
        && !document.querySelector("#pnExportLegacy")
        && editorSource.includes('download(slug() + ".proofnote.json"')
        && editorCss.includes(".pn-action-menu-submenu-wrap")
        && editorCss.includes("right: calc(100% - 1px)"),
      exportMoreMenu ? exportMoreMenu.textContent : "missing backup submenu"
    );
    if (actionToggle && actionMenu && !actionMenu.hidden) actionToggle.click();
    check(
      "editor-images-require-explicit-remote-approval",
      editorSource.includes("block.remoteApproved === true")
        && editorSource.includes("/^https:\\/\\//i.test(source)")
        && !editorSource.includes("https?:\\/\\/")
        && editorSource.includes("referrerpolicy=\\\"no-referrer\\\"")
        && editorSource.includes("MAX_LOCAL_IMAGE_BYTES"),
      "remote images must require a deliberate Load action, reject HTTP, and omit the referrer"
    );
    check(
      "editor-template-and-document-library-are-separate",
      Boolean(templateLibrary)
        && templateLibrary.getAttribute("role") === "list"
        && !templateLibrary.matches("select")
        && templateLibrary.querySelectorAll(".pn-template-item").length === 1
        && templateLibrary.textContent.includes("Proof Note")
        && !templateLibrary.textContent.includes("Blank Document")
        && Boolean(document.querySelector("#pnDocuments"))
        && Boolean(document.querySelector("#pnNew"))
        && Boolean(templateMenu)
        && ["pnSaveTemplate", "pnImportTemplate", "pnExportTemplate"].every((id) => templateMenu.contains(document.getElementById(id))),
      "the library should show mature templates separately from locally stored documents, without exposing Blank Document as a template"
    );
    check(
      "editor-action-menu-is-file-only",
      !document.querySelector(".pn-wordmark .pn-badge")
        && document.querySelector(".pn-wordmark .pn-app-version")?.textContent === "v1.23"
        && editorSource.includes('const APP_VERSION = "v1.23";')
        && !document.querySelector("#pnEditMetadata")
        && !document.querySelector("#pnExportLegacy")
        && !/Document info|文档信息|Proofnote Document Format/.test(actionMenu.textContent),
      "the global menu should contain only file actions; document properties live on the paper"
    );
    check(
      "editor-inspector-is-absent-without-selection",
      Boolean(detail)
        && detail.hidden === true
        && detail.getAttribute("aria-hidden") === "true"
        && app && app.style.getPropertyValue("--pn-right").trim() === "0px",
      "without a selected block #pnDetail must be hidden, aria-hidden=true, and reserve no right-side rail"
    );

    // Form controls do not expose their value through textContent. Inspect the
    // actual editing controls so this remains valid for both input and textarea
    // based canvas blocks.
    const problem = canvasBlocks.find((block) => blockHasControlValue(block, "Canvas problem"));
    check("editor-canvas-semantic-block", Boolean(problem), "fixture semantic block was not rendered as .pn-canvas-block");

    const readingParagraph = canvasBlocks.find((block) => blockHasControlValue(block, "For \\(G_n\\), the bound is \\(k(n) \\le n\\)."));
    const readingPreview = readingParagraph && readingParagraph.querySelector(".pn-canvas-paragraph-preview");
    check(
      "editor-canvas-rich-text-reads-like-export-until-selected",
      Boolean(readingPreview)
        // JSDOM intentionally does not load KaTeX, where the shared inline
        // renderer emits `.math-error`; a browser has the same rendered span
        // with KaTeX's typeset markup instead.
        && /(math-error|katex)/.test(readingPreview.innerHTML)
        && !readingParagraph.classList.contains("is-selected")
        && editorSource.includes("function canvasRichTextField")
        && editorCss.includes(".pn-canvas-rich-field > .pn-field { display: none; }")
        && editorCss.includes(".pn-canvas-block.is-selected .pn-canvas-rich-preview"),
      readingPreview ? readingPreview.innerHTML : "paragraph reading preview missing"
    );
    if (readingPreview) {
      readingPreview.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(window, () => readingParagraph.classList.contains("is-selected") && document.activeElement === readingParagraph.querySelector(".pn-canvas-paragraph-input"));
      check(
        "editor-canvas-rich-text-reveals-native-editor-on-intent",
        readingParagraph.classList.contains("is-selected") && document.activeElement === readingParagraph.querySelector(".pn-canvas-paragraph-input"),
        "clicking a reading preview must reveal and focus the native textarea"
      );
      const readingInput = readingParagraph.querySelector(".pn-canvas-paragraph-input");
      if (readingInput) {
        readingInput.value = "For \\(G_n\\), the revised bound is \\(k(n) \\le n+1\\).";
        readingInput.dispatchEvent(new window.Event("input", { bubbles: true }));
        readingInput.dispatchEvent(new window.Event("blur"));
      }
      check(
        "editor-rich-preview-refreshes-after-edit-and-blur",
        Boolean(readingInput)
          && /n\+1/.test(readingPreview.textContent || "")
          && editorSource.includes('control.addEventListener("blur", refreshPreview)'),
        readingPreview.textContent || "rich preview did not refresh after the editor lost focus"
      );
    }

    if (problem) {
      const beforeInspector = inspector ? inspector.textContent.trim() : "";
      problem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(window, () => detail && !detail.hidden && detail.getAttribute("aria-hidden") === "false" && inspector && inspector.textContent.trim() !== beforeInspector);
      const afterInspector = inspector ? inspector.textContent.trim() : "";
      check(
        "editor-selection-opens-contextual-inspector",
        Boolean(detail)
          && detail.hidden === false
          && detail.getAttribute("aria-hidden") === "false"
          && app.style.getPropertyValue("--pn-right").trim() !== "0px"
          && afterInspector.length > 0
          && afterInspector !== beforeInspector,
        "selecting a canvas block must reveal and populate #pnDetail without a permanently reserved right rail"
      );
      const semanticStructure = inspector && inspector.querySelector(".pn-inspector-group");
      const semanticAdvanced = inspector && inspector.querySelector(".pn-inspector-advanced");
      const semanticDirectFields = semanticStructure
        ? Array.from(semanticStructure.children).filter((child) => child.classList.contains("pn-field"))
        : [];
      check(
        "editor-semantic-inspector-is-property-only",
        Boolean(semanticStructure)
          && Boolean(semanticAdvanced)
          && semanticAdvanced.open === false
          && semanticAdvanced.querySelectorAll(".pn-field").length === 2
          && semanticAdvanced.querySelector(".pn-inspector-toggle")
          && semanticAdvanced.previousElementSibling === semanticStructure
          && semanticDirectFields.length === 1
          && /Semantic type|语义类型/.test(semanticDirectFields[0].textContent)
          && !/Block type|内容块类型/.test(semanticDirectFields.map((field) => field.textContent).join(" "))
          && !inspector.querySelector(".pn-inspector-page")
          && !inspector.querySelector(".pn-inspector-actions")
          && !/Duplicate|复制|Delete block|删除内容块|删除章节与内容/.test(inspector.textContent),
        inspector ? inspector.textContent : "semantic Inspector missing"
      );

      const editable = problem.querySelector("textarea, input");
      check("editor-canvas-has-editable-input", Boolean(editable), "selected canvas block needs an input or textarea for direct editing");
      if (editable) {
        const beforeInput = editable;
        editable.focus();
        editable.value = "Direct edit stays mounted.";
        editable.dispatchEvent(new window.Event("input", { bubbles: true }));
        await settle(window);
        check(
          "editor-input-does-not-replace-canvas-control",
          beforeInput.isConnected && document.activeElement === beforeInput,
          "input was replaced or lost focus after input; avoid rerendering the canvas while typing"
        );
      }

      const resultBlock = canvasBlocks.find((block) => blockHasControlValue(block, "Canvas result"));
      if (resultBlock) {
        resultBlock.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await settle(window, () => {
          const activeOutlineItem = document.querySelector("#pnOutline .pn-outline-item.is-active");
          return activeOutlineItem && activeOutlineItem.dataset.blockId === resultBlock.dataset.blockId;
        });
        const activeOutlineItem = document.querySelector("#pnOutline .pn-outline-item.is-active");
        check(
          "editor-outline-follows-selected-block",
          Boolean(activeOutlineItem) && activeOutlineItem.dataset.blockId === resultBlock.dataset.blockId,
          "a selected canvas block must stay active in the Outline even when the viewport heuristic runs"
        );
        canvas.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        await settle(window, () => detail && detail.hidden === true);
        check(
          "editor-paper-whitespace-clears-selection",
          detail.hidden === true
            && app.style.getPropertyValue("--pn-right").trim() === "0px"
            && !resultBlock.classList.contains("is-selected")
            && !document.querySelector("#pnOutline .pn-outline-item.is-active"),
          "clicking unoccupied paper should clear the selected block and close its contextual Inspector"
        );
      }
    }

    const compactResultBlock = Array.from(canvasBlockNodes(document)).find((block) => blockHasControlValue(block, "Canvas result"));
    if (compactResultBlock) compactResultBlock.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(window, () => inspector && inspector.querySelector(".pn-inspector-advanced select"));
    const semanticPresentation = inspector && inspector.querySelector(".pn-inspector-advanced select");
    if (semanticPresentation) {
      semanticPresentation.value = "card";
      semanticPresentation.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    await settle(window, () => document.querySelector("#pnCanvas .pn-canvas-semantic .pn-component-add-summary"));
    const addSemanticNote = document.querySelector("#pnCanvas .pn-canvas-semantic .pn-component-add-summary");
    const summaryBeforeAdd = document.querySelector("#pnCanvas .pn-canvas-semantic .pn-canvas-component-summary-input");
    if (addSemanticNote) addSemanticNote.click();
    await settle(window, () => Boolean(document.querySelector("#pnCanvas .pn-canvas-semantic .pn-canvas-component-summary-input")));
    check(
      "editor-semantic-card-hides-empty-notes-until-requested",
      Boolean(compactResultBlock)
        && Boolean(semanticPresentation)
        && !summaryBeforeAdd
        && Boolean(addSemanticNote)
        && Boolean(document.querySelector("#pnCanvas .pn-canvas-semantic .pn-canvas-component-summary-input"))
        && editorSource.includes("function semanticSummaryVisible")
        && editorSource.includes("pn-component-add-summary")
        && editorCss.includes(".pn-canvas-component-body-input { display: block; min-height: 1.6em")
        && editorCss.includes(".pn-component-add-summary"),
      document.querySelector("#pnCanvas .pn-canvas-semantic")?.textContent || "missing semantic card"
    );

    // Existing blocks should be authorable, not just renderable. These checks
    // exercise the in-canvas controls that stay quiet until a block is used.
    let tableBlock = document.querySelector("#pnCanvas .pn-canvas-table");
    const tableRowCountBefore = tableBlock ? tableBlock.querySelectorAll("tbody tr").length : 0;
    const addTableRow = tableBlock && Array.from(tableBlock.querySelectorAll("button")).find((control) => /Add row|添加行/.test(control.textContent));
    if (addTableRow) addTableRow.click();
    await settle(window, () => {
      const nextTable = document.querySelector("#pnCanvas .pn-canvas-table");
      return nextTable && nextTable.querySelectorAll("tbody tr").length === tableRowCountBefore + 1;
    });
    tableBlock = document.querySelector("#pnCanvas .pn-canvas-table");
    const addTableColumn = tableBlock && Array.from(tableBlock.querySelectorAll("button")).find((control) => /Add column|添加列/.test(control.textContent));
    if (addTableColumn) addTableColumn.click();
    await settle(window, () => {
      const nextTable = document.querySelector("#pnCanvas .pn-canvas-table");
      return nextTable && nextTable.querySelectorAll("thead th").length === 2;
    });
    tableBlock = document.querySelector("#pnCanvas .pn-canvas-table");
    if (tableBlock) tableBlock.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(window, () => inspector && inspector.querySelector(".pn-inspector-toggle-control"));
    const tableHeaderToggle = inspector && inspector.querySelector(".pn-inspector-toggle-control");
    if (tableHeaderToggle) tableHeaderToggle.click();
    await settle(window, () => {
      const nextTable = document.querySelector("#pnCanvas .pn-canvas-table");
      return nextTable && !nextTable.querySelector("thead");
    });
    tableBlock = document.querySelector("#pnCanvas .pn-canvas-table");
    check(
      "editor-table-has-real-row-column-and-header-controls",
      tableRowCountBefore === 1
        && Boolean(addTableRow)
        && Boolean(addTableColumn)
        && Boolean(tableHeaderToggle)
        && Boolean(tableBlock)
        && !tableBlock.querySelector("thead")
        && tableBlock.querySelectorAll("tbody tr").length === 3
        && tableBlock.querySelectorAll(".pn-table-row-remove").length === 3,
      tableBlock ? tableBlock.textContent : "missing table"
    );

    let listBlock = document.querySelector("#pnCanvas .pn-canvas-list");
    const firstListInput = listBlock && listBlock.querySelector(".pn-canvas-list-input");
    if (firstListInput) {
      firstListInput.focus();
      firstListInput.setSelectionRange(firstListInput.value.length, firstListInput.value.length);
      firstListInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
    await settle(window, () => {
      const nextList = document.querySelector("#pnCanvas .pn-canvas-list");
      return nextList && nextList.querySelectorAll(".pn-canvas-list-input").length === 2;
    });
    listBlock = document.querySelector("#pnCanvas .pn-canvas-list");
    const addListItem = listBlock && Array.from(listBlock.parentElement.querySelectorAll("button")).find((control) => /Add item|添加项目/.test(control.textContent));
    if (addListItem) addListItem.click();
    await settle(window, () => {
      const nextList = document.querySelector("#pnCanvas .pn-canvas-list");
      return nextList && nextList.querySelectorAll(".pn-canvas-list-input").length === 3;
    });
    listBlock = document.querySelector("#pnCanvas .pn-canvas-list");
    check(
      "editor-list-supports-enter-add-and-remove-controls",
      Boolean(firstListInput)
        && Boolean(addListItem)
        && Boolean(listBlock)
        && listBlock.querySelectorAll(".pn-canvas-list-input").length === 3
        && listBlock.querySelectorAll(".pn-collection-remove").length === 3
        && Boolean(listBlock.querySelector(".pn-canvas-list-row > .pn-collection-remove"))
        && editorCss.includes(".pn-canvas-list-row > .pn-collection-remove { position: absolute")
        && editorCss.includes(".pn-canvas-block:hover .pn-canvas-list-row:hover > .pn-collection-remove"),
      listBlock ? listBlock.textContent : "missing list"
    );

    const codeCanvasBlock = document.querySelector("#pnCanvas .pn-canvas-code")?.closest(".pn-canvas-block");
    if (codeCanvasBlock) codeCanvasBlock.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(window, () => inspector && Array.from(inspector.querySelectorAll(".pn-field")).some((field) => /Language|语言/.test(field.textContent) && field.querySelector("select")));
    const codeLanguageSelect = Array.from(inspector ? inspector.querySelectorAll(".pn-field") : []).find((field) => /Language|语言/.test(field.textContent))?.querySelector("select");
    const codeLanguageInitiallyNormalised = codeLanguageSelect && codeLanguageSelect.value === "javascript"
      && /JavaScript/.test(document.querySelector("#pnCanvas .pn-canvas-code .pn-code-language")?.textContent || "");
    if (codeLanguageSelect) {
      codeLanguageSelect.value = "python";
      codeLanguageSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    await settle(window, () => /Python/.test(document.querySelector("#pnCanvas .pn-canvas-code .pn-code-language")?.textContent || ""));
    check(
      "editor-code-language-uses-a-small-known-dropdown",
      Boolean(codeLanguageSelect)
        && codeLanguageInitiallyNormalised
        && Array.from(codeLanguageSelect.options).map((option) => option.value).join(",") === "text,python,javascript,typescript,c,cpp,java,bash,sql,json,html,css"
        && /Python/.test(document.querySelector("#pnCanvas .pn-canvas-code .pn-code-language")?.textContent || "")
        && editorSource.includes("const CODE_LANGUAGE_OPTIONS")
        && editorSource.includes("function highlightedCodeHtml"),
      inspector ? inspector.textContent : "missing code language selector"
    );
    const equationPreview = document.querySelector("#pnCanvas .pn-equation-preview");
    const codeCopy = document.querySelector("#pnCanvas .pn-code-copy");
    const imageBlock = document.querySelector("#pnCanvas .pn-canvas-image");
    check(
      "editor-equation-code-and-image-have-authoring-affordances",
      Boolean(equationPreview)
        && equationPreview.hidden === false
        && Boolean(codeCopy)
        && Boolean(codeCopy && codeCopy.querySelector("svg.pn-code-copy-icon"))
        && /Copy code|复制代码/.test(codeCopy ? codeCopy.getAttribute("aria-label") || "" : "")
        && Boolean(imageBlock)
        && Boolean(imageBlock.querySelector("img"))
        && Boolean(imageBlock.querySelector(".pn-canvas-image-caption-input"))
        && editorSource.includes("copyBlockText")
        && editorSource.includes("imageFilePicker"),
      document.querySelector("#pnCanvas").textContent
    );
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    const originalExecCommand = document.execCommand;
    let legacyCopyCalls = 0;
    const closeInspector = document.querySelector("#pnCloseInspector");
    if (closeInspector) closeInspector.click();
    if (codeCopy) codeCopy.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await settle(window, () => detail && detail.hidden === true);
    check(
      "editor-code-copy-does-not-open-inspector",
      Boolean(codeCopy) && Boolean(detail) && detail.hidden === true,
      detail ? String(detail.hidden) : "missing inspector"
    );
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("Clipboard permission denied"); } }
    });
    document.execCommand = (command) => { legacyCopyCalls += 1; return command === "copy"; };
    if (codeCopy) codeCopy.click();
    await settle(window, () => legacyCopyCalls === 1 && /Code copied|已复制代码/.test(document.querySelector("#pnStatus").textContent));
    check(
      "editor-code-copy-falls-back-when-clipboard-permission-is-denied",
      legacyCopyCalls === 1
        && /Code copied|已复制代码/.test(document.querySelector("#pnStatus").textContent)
        && Boolean(codeCopy && codeCopy.classList.contains("is-copied"))
        && Boolean(codeCopy && codeCopy.querySelector("svg.pn-code-copy-icon"))
        && /Code copied|代码已复制/.test(codeCopy ? codeCopy.getAttribute("aria-label") || "" : ""),
      document.querySelector("#pnStatus").textContent
    );
    if (clipboardDescriptor) Object.defineProperty(window.navigator, "clipboard", clipboardDescriptor);
    else delete window.navigator.clipboard;
    if (originalExecCommand === undefined) delete document.execCommand;
    else document.execCommand = originalExecCommand;
    check(
      "editor-hover-only-controls-are-not-keyboard-focusable-while-hidden",
      ["pn-code-copy", "pn-table-column-remove", "pn-collection-tools", "pn-collection-remove", "pn-insert-trigger"].every((className) => {
        const ruleStart = className === "pn-collection-remove"
          ? editorCss.indexOf(".pn-collection-remove { display: grid")
          : className === "pn-collection-tools"
            ? editorCss.indexOf(".pn-collection-tools { display: flex")
            : editorCss.indexOf("." + className);
        const rule = editorCss.slice(ruleStart, editorCss.indexOf("}", ruleStart) + 1);
        return rule.includes("visibility: hidden");
      }),
      "hidden controls must use visibility:hidden, not opacity alone"
    );

    // Structural editing is deliberately derived from the flat block list.
    // Exercise the real Outline menu so sibling/child boundaries cannot regress
    // into a simple index + 1 insertion.
    const findOutlineItem = (title, occurrence) => Array.from(document.querySelectorAll("#pnOutline .pn-outline-item"))
      .filter((item) => item.querySelector(".pn-outline-label")?.textContent.trim() === title)[occurrence || 0] || null;
    const outlineMenu = document.querySelector("#pnOutlineMenu");
    const methodItem = findOutlineItem("Method");
    if (methodItem) methodItem.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 120 }));
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    check(
      "editor-outline-right-click-opens-structural-menu",
      Boolean(outlineMenu)
        && outlineMenu.hidden === false
        && Boolean(outlineMenu.querySelector('[data-command="add-section-after"]'))
        && Boolean(outlineMenu.querySelector('[data-command="add-subsection"]'))
        && Boolean(outlineMenu.querySelector('[data-command="add-content-paragraph"]'))
        && Boolean(outlineMenu.querySelector('[data-command="add-content-table"]'))
        && Boolean(outlineMenu.querySelector('[data-command="add-content-code"]'))
        && !outlineMenu.querySelector('[data-command="add-content-semantic"]')
        && !outlineMenu.querySelector('[data-command="rename"]')
        && !outlineMenu.querySelector('[data-command="remove-heading"]')
        && editorSource.includes('tr("添加同级章节", "Add sibling section")')
        && editorSource.includes('tr("添加子章节", "Add child section")'),
      outlineMenu ? outlineMenu.textContent : "missing outline menu"
    );
    // Some browsers emit a follow-up click after contextmenu. That click must
    // not dismiss the menu which was just opened by the secondary click.
    if (methodItem) methodItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle(window);
    check(
      "editor-outline-right-click-menu-survives-follow-up-click",
      Boolean(outlineMenu) && outlineMenu.hidden === false,
      "a click following contextmenu closed the Outline menu"
    );
    const contentMenuTrigger = outlineMenu && outlineMenu.querySelector(".pn-outline-menu-submenu-trigger");
    if (contentMenuTrigger) contentMenuTrigger.click();
    await settle(window, () => outlineMenu && outlineMenu.querySelector(".pn-outline-menu-submenu-wrap.is-open"));
    const contentMenu = outlineMenu && outlineMenu.querySelector(".pn-outline-menu-submenu");
    const paragraphsBeforeOutlineInsert = document.querySelectorAll("#pnCanvas > .pn-canvas-block.pn-canvas-paragraph").length;
    const addParagraphFromOutline = contentMenu && contentMenu.querySelector('[data-command="add-content-paragraph"]');
    if (addParagraphFromOutline) addParagraphFromOutline.click();
    await settle(window, () => document.querySelectorAll("#pnCanvas > .pn-canvas-block.pn-canvas-paragraph").length === paragraphsBeforeOutlineInsert + 1);
    check(
      "editor-outline-add-content-menu-keeps-focus-until-a-choice-is-made",
      Boolean(contentMenuTrigger)
        && Boolean(addParagraphFromOutline)
        && contentMenuTrigger.getAttribute("aria-expanded") === "true"
        && document.querySelectorAll("#pnCanvas > .pn-canvas-block.pn-canvas-paragraph").length === paragraphsBeforeOutlineInsert + 1
        && editorSource.includes("setSubmenuOpen")
        && editorCss.includes(".pn-outline-menu-submenu-wrap.is-open .pn-outline-menu-submenu"),
      "the Add content chooser should stay open long enough to select a content type"
    );

    const detailItem = findOutlineItem("Details");
    const detailMore = detailItem && detailItem.closest(".pn-outline-row").querySelector(".pn-outline-more");
    if (detailMore) detailMore.click();
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    check(
      "editor-outline-h3-remains-navigation-only",
      Boolean(outlineMenu)
        && !outlineMenu.querySelector('[data-command="add-section-after"]')
        && !outlineMenu.querySelector('[data-command="add-subsection-after"]'),
      outlineMenu ? outlineMenu.textContent : "missing H3 menu"
    );
    if (app) app.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const procedureItem = findOutlineItem("Procedure");
    const procedureMore = procedureItem && procedureItem.closest(".pn-outline-row").querySelector(".pn-outline-more");
    if (procedureMore) procedureMore.click();
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    const addSubsectionAfter = outlineMenu && outlineMenu.querySelector('[data-command="add-subsection-after"]');
    if (addSubsectionAfter) addSubsectionAfter.click();
    await settle(window, () => canvasBlockNodes(document).some((block) => !initialCanvasBlockIds.has(block.dataset.blockId) && block.classList.contains("pn-canvas-heading")));
    const postSiblingBlocks = canvasBlockNodes(document);
    const procedureContentIndex = postSiblingBlocks.findIndex((block) => blockHasControlValue(block, "Procedure content"));
    const newSubsectionIndex = postSiblingBlocks.findIndex((block) => !initialCanvasBlockIds.has(block.dataset.blockId) && block.classList.contains("pn-canvas-heading"));
    const equipmentIndex = postSiblingBlocks.findIndex((block) => blockHasControlValue(block, "Equipment"));
    check(
      "editor-outline-sibling-inserts-after-complete-subtree",
      procedureContentIndex >= 0 && procedureContentIndex < newSubsectionIndex && newSubsectionIndex < equipmentIndex,
      JSON.stringify({ procedureContentIndex, newSubsectionIndex, equipmentIndex })
    );

    const duplicateProcedureItem = findOutlineItem("Procedure");
    const duplicateProcedureMore = duplicateProcedureItem && duplicateProcedureItem.closest(".pn-outline-row").querySelector(".pn-outline-more");
    if (duplicateProcedureMore) duplicateProcedureMore.click();
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    const duplicateProcedure = outlineMenu && outlineMenu.querySelector('[data-command="duplicate-subsection"]');
    if (duplicateProcedure) duplicateProcedure.click();
    await settle(window, () => canvasBlockNodes(document).filter((block) => blockHasControlValue(block, "Procedure")).length === 2);
    const duplicatedBlocks = canvasBlockNodes(document);
    check(
      "editor-outline-duplicates-complete-subtree-with-new-ids",
      duplicatedBlocks.filter((block) => blockHasControlValue(block, "Procedure content")).length === 2
        && new Set(duplicatedBlocks.map((block) => block.dataset.blockId)).size === duplicatedBlocks.length,
      duplicatedBlocks.map((block) => block.dataset.blockId).join(",")
    );

    const primaryMethodItem = findOutlineItem("Method");
    const primaryMethodMore = primaryMethodItem && primaryMethodItem.closest(".pn-outline-row").querySelector(".pn-outline-more");
    const codesBeforePrimaryInsert = document.querySelectorAll("#pnCanvas > .pn-canvas-block.pn-canvas-code").length;
    if (primaryMethodMore) primaryMethodMore.click();
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    const primaryAddCode = outlineMenu && outlineMenu.querySelector('[data-command="add-content-code"]');
    if (primaryAddCode) primaryAddCode.click();
    await settle(window, () => document.querySelectorAll("#pnCanvas > .pn-canvas-block.pn-canvas-code").length === codesBeforePrimaryInsert + 1);
    check(
      "editor-outline-primary-section-adds-content-blocks",
      document.querySelectorAll("#pnCanvas > .pn-canvas-block.pn-canvas-code").length === codesBeforePrimaryInsert + 1
        && (() => {
          const blocks = canvasBlockNodes(document);
          const insertedCode = blocks.findIndex((block) => !initialCanvasBlockIds.has(block.dataset.blockId) && block.classList.contains("pn-canvas-code"));
          const procedure = blocks.findIndex((block) => blockHasControlValue(block, "Procedure"));
          return insertedCode >= 0 && procedure >= 0 && insertedCode < procedure;
        })(),
      JSON.stringify({
        before: codesBeforePrimaryInsert,
        after: document.querySelectorAll("#pnCanvas > .pn-canvas-block.pn-canvas-code").length,
        hasButton: Boolean(primaryAddCode)
      })
    );

    // Direct content belongs before the first child section, whereas a newly
    // created subsection belongs at the end of the existing child sequence.
    const newHeadingIdsBeforeChildInsert = new Set(canvasBlockNodes(document).map((block) => block.dataset.blockId));
    const methodForChildInsert = findOutlineItem("Method");
    const methodMoreForChildInsert = methodForChildInsert && methodForChildInsert.closest(".pn-outline-row").querySelector(".pn-outline-more");
    if (methodMoreForChildInsert) methodMoreForChildInsert.click();
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    const addChildSubsection = outlineMenu && outlineMenu.querySelector('[data-command="add-subsection"]');
    if (addChildSubsection) addChildSubsection.click();
    await settle(window, () => canvasBlockNodes(document).some((block) => !newHeadingIdsBeforeChildInsert.has(block.dataset.blockId) && block.classList.contains("pn-canvas-heading")));
    const childSubsection = canvasBlockNodes(document).find((block) => !newHeadingIdsBeforeChildInsert.has(block.dataset.blockId) && block.classList.contains("pn-canvas-heading"));
    const blocksAfterChildInsert = canvasBlockNodes(document);
    const childSubsectionIndex = childSubsection ? blocksAfterChildInsert.indexOf(childSubsection) : -1;
    const finalEquipmentContent = blocksAfterChildInsert.findIndex((block) => blockHasControlValue(block, "A closing paragraph."));
    check(
      "editor-outline-child-subsection-appends-after-existing-children",
      Boolean(addChildSubsection)
        && Boolean(childSubsection)
        && childSubsectionIndex > finalEquipmentContent
        && editorSource.includes("getDirectContentInsertionIndex")
        && editorSource.includes("getChildSectionInsertionIndex"),
      JSON.stringify({ childSubsectionIndex, finalEquipmentContent })
    );

    const methodAfterContent = findOutlineItem("Method");
    const methodAfterContentMore = methodAfterContent && methodAfterContent.closest(".pn-outline-row").querySelector(".pn-outline-more");
    if (methodAfterContentMore) methodAfterContentMore.click();
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    const addEditorialSection = outlineMenu && outlineMenu.querySelector('[data-command="add-section-after"]');
    if (addEditorialSection) addEditorialSection.click();
    const untitledSectionPattern = /^(Untitled section|未命名章节)$/;
    await settle(window, () => canvasBlockNodes(document).some((block) => block.classList.contains("pn-canvas-semantic") && Array.from(block.querySelectorAll("input, textarea")).some((control) => untitledSectionPattern.test(control.value))));
    const editorialSection = canvasBlockNodes(document).find((block) => block.classList.contains("pn-canvas-semantic") && Array.from(block.querySelectorAll("input, textarea")).some((control) => untitledSectionPattern.test(control.value)));
    check(
      "editor-outline-section-uses-editorial-semantic-treatment",
      Boolean(addEditorialSection)
        && Boolean(editorialSection)
        && Boolean(editorialSection && editorialSection.querySelector(".pn-editorial-section"))
        && Boolean(editorialSection && editorialSection.querySelector(".pn-editorial-section-number"))
        && Boolean(editorialSection && editorialSection.querySelector(".pn-editorial-section-body-input"))
        && Array.from(document.querySelectorAll("#pnOutline .pn-outline-label")).some((label) => untitledSectionPattern.test(label.textContent.trim()))
        && editorSource.includes('kind: "section"'),
      editorialSection ? editorialSection.textContent : "missing editorial section"
    );
    const editorialSectionId = editorialSection && editorialSection.dataset.blockId;
    const editorialSectionOutlineItem = editorialSectionId && outline.querySelector('.pn-outline-item[data-block-id="' + editorialSectionId + '"]');
    if (editorialSectionOutlineItem) editorialSectionOutlineItem.click();
    await settle(window, () => inspector && Array.from(inspector.querySelectorAll(".pn-inspector-toggle")).some((row) => /Show body|显示正文/.test(row.textContent)));
    let sectionBodyToggle = Array.from(inspector.querySelectorAll(".pn-inspector-toggle")).find((row) => /Show body|显示正文/.test(row.textContent))?.querySelector("input");
    if (sectionBodyToggle) sectionBodyToggle.click();
    await settle(window, () => editorialSectionId && !document.getElementById("pn-block-" + editorialSectionId)?.querySelector(".pn-editorial-section-body-input"));
    check(
      "editor-editorial-section-body-can-be-hidden-without-deletion",
      Boolean(editorialSectionOutlineItem)
        && Boolean(sectionBodyToggle)
        && Boolean(editorialSectionId && !document.getElementById("pn-block-" + editorialSectionId)?.querySelector(".pn-editorial-section-body-input"))
        && editorSource.includes("setEditorialBodyVisible")
        && editorSource.includes("editorialBodyVisible(block)"),
      inspector ? inspector.textContent : "missing editorial section body display control"
    );
    sectionBodyToggle = Array.from(inspector.querySelectorAll(".pn-inspector-toggle")).find((row) => /Show body|显示正文/.test(row.textContent))?.querySelector("input");
    if (sectionBodyToggle) sectionBodyToggle.click();
    await settle(window, () => editorialSectionId && Boolean(document.getElementById("pn-block-" + editorialSectionId)?.querySelector(".pn-editorial-section-body-input")));
    check(
      "editor-editorial-section-body-can-be-restored",
      Boolean(sectionBodyToggle) && Boolean(editorialSectionId && document.getElementById("pn-block-" + editorialSectionId)?.querySelector(".pn-editorial-section-body-input")),
      editorialSectionId ? document.getElementById("pn-block-" + editorialSectionId)?.textContent : "hidden section body did not return"
    );

    // Inspector actions must use the same subtree ranges as the Outline. Move
    // Method after the newly-created root section and confirm Procedure stays
    // nested inside it instead of being left behind as a detached H2.
    const methodCanvasForInspector = canvasBlockNodes(document).find((block) => blockHasControlValue(block, "Method"));
    if (methodCanvasForInspector) methodCanvasForInspector.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle(window, () => detail && !detail.hidden && inspector && inspector.querySelector(".pn-inspector-overflow"));
    const inspectorOverflow = inspector && inspector.querySelector(".pn-inspector-overflow");
    if (inspectorOverflow) inspectorOverflow.open = true;
    const inspectorMoveDown = inspectorOverflow && inspectorOverflow.querySelectorAll(".pn-inspector-overflow-item")[1];
    if (inspectorMoveDown) inspectorMoveDown.click();
    await settle(window, () => {
      const roots = Array.from(outline.children);
      const rootLabel = (node) => node.firstElementChild && node.firstElementChild.querySelector(".pn-outline-label");
      const methodRoot = roots.findIndex((node) => rootLabel(node)?.textContent.trim() === "Method");
      const sectionRoot = roots.findIndex((node) => rootLabel(node) && untitledSectionPattern.test(rootLabel(node).textContent.trim()));
      return methodRoot > sectionRoot;
    });
    const movedMethodRoot = Array.from(outline.children).find((node) => node.firstElementChild && node.firstElementChild.querySelector(".pn-outline-label")?.textContent.trim() === "Method");
    check(
      "editor-inspector-moves-structural-subtree-as-a-unit",
      Boolean(inspectorMoveDown)
        && Boolean(movedMethodRoot)
        && Boolean(movedMethodRoot && Array.from(movedMethodRoot.querySelectorAll(".pn-outline-label")).some((label) => label.textContent.trim() === "Procedure"))
        && editorSource.includes("moveStructuralNode(block.id"),
      movedMethodRoot ? movedMethodRoot.textContent : "missing moved Method root"
    );

    const deleteMethodItem = findOutlineItem("Method");
    const deleteMethodMore = deleteMethodItem && deleteMethodItem.closest(".pn-outline-row").querySelector(".pn-outline-more");
    if (deleteMethodMore) deleteMethodMore.click();
    await settle(window, () => outlineMenu && !outlineMenu.hidden);
    const deleteMethod = outlineMenu && outlineMenu.querySelector('[data-command="delete-section"]');
    if (deleteMethod) deleteMethod.click();
    await settle(window, () => confirmModal && !confirmModal.hidden);
    check(
      "editor-outline-delete-subtree-requires-counted-confirmation",
      Boolean(confirmModal)
        && confirmModal.hidden === false
        && /Method/.test(confirmModal.textContent)
        && /content block|内容块/.test(confirmModal.textContent),
      confirmModal ? confirmModal.textContent : "missing confirmation"
    );
    const acceptDelete = document.querySelector("#pnConfirmAccept");
    if (acceptDelete) acceptDelete.click();
    const undoToast = document.querySelector("#pnUndoToast");
    await settle(window, () => !findOutlineItem("Method") && undoToast && !undoToast.hidden);
    const undoButton = document.querySelector("#pnUndoButton");
    if (undoButton) undoButton.click();
    await settle(window, () => Boolean(findOutlineItem("Method")) && undoToast && undoToast.hidden);
    check(
      "editor-outline-delete-subtree-has-one-time-undo",
      Boolean(findOutlineItem("Method")) && Boolean(undoToast) && undoToast.hidden === true,
      undoToast ? undoToast.textContent : "missing undo"
    );

    const documentLibrary = document.querySelector("#pnDocuments");
    const documentCountBeforeNew = documentLibrary ? documentLibrary.querySelectorAll(".pn-document-item").length : 0;
    const newDocument = document.querySelector("#pnNew");
    const newProjectModal = document.querySelector("#pnNewProjectModal");
    const newProjectName = document.querySelector("#pnNewProjectName");
    const createProject = document.querySelector("#pnCreateProject");
    if (newDocument) newDocument.click();
    await settle(window, () => newProjectModal && newProjectModal.hidden === false);
    if (newProjectName) newProjectName.value = "Field notes";
    if (createProject) createProject.click();
    await settle(window, () => documentLibrary && documentLibrary.querySelectorAll(".pn-document-item").length === documentCountBeforeNew + 1);
    check(
      "editor-new-project-creates-a-named-library-document",
      Boolean(documentLibrary)
        && documentLibrary.querySelectorAll(".pn-document-item").length === documentCountBeforeNew + 1
        && newProjectModal.hidden === true
        && canvas.classList.contains("pn-project-document")
        && Array.from(document.querySelectorAll("#pnCanvas .pn-document-title input, #pnCanvas .pn-document-title textarea")).some((control) => control.value === "Field notes")
        && blockHasControlValue(document.querySelector("#pnCanvas .pn-canvas-proof-header"), "A concise statement of the result.")
        && canvasBlockNodes(document).some((block) => block.classList.contains("pn-canvas-semantic") && block.querySelector(".pn-editorial-section") && blockHasControlValue(block, "Introduction"))
        && !canvasBlockNodes(document).some((block) => block.classList.contains("pn-canvas-heading") && blockHasControlValue(block, "Introduction"))
        && Boolean(document.querySelector("#pnCanvas .pn-proof-metadata-author-input"))
        && Boolean(document.querySelector("#pnCanvas .pn-proof-metadata-date-input"))
        && document.querySelector("#pnCanvas .pn-proof-metadata-date-input").value === new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
        && document.querySelector("#pnPageHeader .pn-running-left").value === "Field notes"
        && document.querySelector("#pnPageHeader .pn-running-right").value === "Project",
      documentLibrary ? documentLibrary.textContent : "missing document library"
    );
    const documentCountBeforeDuplicateName = documentLibrary ? documentLibrary.querySelectorAll(".pn-document-item").length : 0;
    if (newDocument) newDocument.click();
    await settle(window, () => newProjectModal && newProjectModal.hidden === false);
    if (newProjectName) newProjectName.value = "Field notes";
    if (createProject) createProject.click();
    await settle(window, () => documentLibrary && documentLibrary.querySelectorAll(".pn-document-item").length === documentCountBeforeDuplicateName + 1);
    check(
      "editor-new-project-disambiguates-duplicate-names",
      Boolean(documentLibrary)
        && Array.from(document.querySelectorAll("#pnCanvas .pn-document-title input, #pnCanvas .pn-document-title textarea")).some((control) => control.value === "Field notes(1)")
        && document.querySelector("#pnPageHeader .pn-running-left").value === "Field notes(1)",
      documentLibrary ? documentLibrary.textContent : "missing automatic duplicate name"
    );
    const projectHeaderName = document.querySelector("#pnPageHeader .pn-running-left");
    const projectFooterName = document.querySelector("#pnFooterName");
    const projectCanvasTitle = document.querySelector("#pnCanvas .pn-canvas-title-input");
    if (projectHeaderName) {
      projectHeaderName.value = "Header rename";
      projectHeaderName.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    await settle(window, () => projectFooterName?.textContent === "Header rename" && projectCanvasTitle?.value === "Header rename");
    if (projectFooterName) {
      projectFooterName.textContent = "Footer rename";
      projectFooterName.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    await settle(window, () => document.querySelector("#pnPageHeader .pn-running-left")?.value === "Footer rename" && projectCanvasTitle?.value === "Footer rename");
    check(
      "editor-project-running-title-and-footer-share-one-document-name",
      projectFooterName?.getAttribute("contenteditable") === "true"
        && projectFooterName?.textContent === "Footer rename"
        && document.querySelector("#pnPageHeader .pn-running-left")?.value === "Footer rename"
        && projectCanvasTitle?.value === "Footer rename"
        && editorSource.includes("function setProjectDocumentName(value, source)")
        && editorSource.includes("function syncProjectDocumentNameControls(value, source)"),
      JSON.stringify({ footer: projectFooterName?.textContent, header: document.querySelector("#pnPageHeader .pn-running-left")?.value, title: projectCanvasTitle?.value })
    );
    check(
      "editor-project-header-shares-proofnote-editorial-rhythm",
      editorCss.includes(".pn-proofnote-document .pn-document-title,.pn-project-document .pn-document-title")
        && editorCss.includes(".pn-proofnote-document .pn-document-subtitle,.pn-project-document .pn-document-subtitle")
        && editorSource.includes('const metadataAfter = documentMetadata && subtitleVisible ? "subtitle" : "title";')
        && editorSource.includes('els.canvas.classList.toggle("pn-project-document", isProjectDocument());')
        && editorSource.includes('["introduction", "section"].includes(block.kind)')
        && editorSource.includes('["introduction", "problem", "result", "theorem"].includes(block.kind)'),
      "Project title, subtitle, metadata, and exported page header must share Proof Note's editorial sequence"
    );
    check(
      "editor-project-preset-restores-editorial-reading-rhythm",
      editorSource.includes('if (block.type === "heading") return (isProofNoteDocument() || isProjectDocument()) && block.level === 1;')
        && editorCss.includes("--pn-doc-body-size: 12.75pt;")
        && editorCss.includes("--pn-doc-body-leading: 1.68;")
        && editorCss.includes("--pn-doc-title-size: 31.5pt;")
        && editorCss.includes(".pn-project-document .pn-editorial-section { margin-bottom: 36pt; }")
        && editorCss.includes(".pn-project-document .pn-semantic")
        && editorSource.includes("const EXPORT_PROJECT_EDITORIAL_CSS")
        && editorSource.includes(".pn-project-document{max-width:820px")
        && editorSource.includes(".pn-project-document .pn-document-title,.pn-project-document .pn-document-subtitle")
        && editorSource.includes(".pn-project-document .pn-table-wrap,.pn-project-document .pn-equation,.pn-project-document .pn-code{width:calc(100% + 60px);max-width:none;margin-left:-30px;margin-right:-30px}")
        && editorSource.includes("@media print{.pn-project-document{max-width:none;padding:16mm 15mm}.pn-project-document .pn-table-wrap,.pn-project-document .pn-equation,.pn-project-document .pn-code{width:auto;margin-left:0;margin-right:0}}")
        && editorSource.includes("EXPORT_PROJECT_EDITORIAL_CSS + EXPORT_POLISH_CSS"),
      "Blank Projects must keep a 760px reading rail while complex export blocks may use the 820px outer measure"
    );
    check(
      "editor-editorial-renderer-is-scoped-to-editorial-presets",
      editorSource.includes('return isProofNoteDocument() || (isProjectDocument() && block && block.type === "semantic" && ["introduction", "section"].includes(block.kind))')
        && editorSource.includes('if (block.type === "heading") return (isProofNoteDocument() || isProjectDocument()) && block.level === 1;'),
      "Imported and general documents must retain neutral H1 and semantic rendering unless they explicitly choose an appearance"
    );
    check(
      "editor-editorial-section-compatibility-preserves-the-folio-number",
      editorSource.includes("function editorialDisplayTitle(block, key)")
        && editorSource.includes("value: editorialDisplayTitle(block, titleKey)")
        && editorSource.includes("const title = editorialDisplayTitle(block, titleKey)"),
      "Legacy level-one headings should use the editorial section renderer without repeating an AI-generated number in their title"
    );
    const projectClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    let copiedProjectAiInstructions = "";
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { copiedProjectAiInstructions = text; } }
    });
    const projectCopyAi = document.querySelector("#pnCopyAi");
    if (projectCopyAi) projectCopyAi.click();
    await settle(window, () => copiedProjectAiInstructions.length > 0);
    if (projectClipboardDescriptor) Object.defineProperty(window.navigator, "clipboard", projectClipboardDescriptor);
    else delete window.navigator.clipboard;
    check(
      "editor-project-copy-ai-uses-one-coherent-document-architect-brief",
      editorSource.includes("function aiInstructionsForCurrentDocument()")
        && editorSource.includes("isProjectDocument() ? PROJECT_AI_DOCUMENT_INSTRUCTIONS : AI_DOCUMENT_INSTRUCTIONS")
        && editorSource.includes("const instructions = aiInstructionsForCurrentDocument();")
        && !editorSource.includes("PROJECT_AI_EDITORIAL_SECTION_GUIDANCE")
        && projectAiInstructions.includes("You are acting as an editor and document architect for Proofnote.")
        && projectAiInstructions.includes("Return exactly one valid JSON object in Proofnote Document Format 1.0.")
        && copiedProjectAiInstructions.includes('"documentType": "Project"')
        && copiedProjectAiInstructions.includes('"kind": "section"')
        && copiedProjectAiInstructions.includes('"appearance": "editorial"')
        && copiedProjectAiInstructions.includes("inline KaTeX delimiters")
        && copiedProjectAiInstructions.includes("\\u005c")
        && copiedProjectAiInstructions.includes("Do not use a level-1 heading")
        && !copiedProjectAiInstructions.includes("level 1 for major sections"),
      "Blank projects must copy one coherent Project brief with editorial section rules and JSON-safe LaTeX serialization"
    );
    const importedProjectPayload = {
      format: "proofnote-document",
      version: "1.0",
      metadata: { name: "Imported prime-family notes", documentType: "Project", language: "zh-CN" },
      blocks: [
        { type: "title", content: "当前核心通用结构" },
        { type: "subtitle", content: "A compact research summary." },
        { type: "semantic", kind: "introduction", title: "Introduction", content: "Opening context." },
        { type: "heading", level: 1, content: "1. Core prime-family bounds" },
        { type: "paragraph", content: "The main bound follows." },
        { type: "code", language: "javascript", content: "const answer = \"ready\";" },
        { type: "code", language: "python", content: "def solve(x):\n    return x + 1" }
      ]
    };
    const importText = document.querySelector("#pnImportText");
    const confirmImport = document.querySelector("#pnConfirmImport");
    const importReport = document.querySelector("#pnImportReport");
    const blankProjectImportPayload = {
      format: "proofnote-document",
      version: "1.0",
      metadata: { name: "Third-party metadata" },
      blocks: [
        { type: "title", content: "Imported from blank Project" },
        { type: "paragraph", content: "This is a new imported document." }
      ]
    };
    const documentCountBeforeBlankProjectImport = documentLibrary ? documentLibrary.querySelectorAll(".pn-document-item").length : 0;
    const blankProjectSourceDate = document.querySelector("#pnCanvas .pn-proof-metadata-date-input")?.value || "";
    if (importText) importText.value = JSON.stringify(blankProjectImportPayload);
    if (confirmImport) confirmImport.click();
    await settle(window, () => canvas.classList.contains("pn-project-document")
      && document.querySelector("#pnPageHeader .pn-running-left")?.value === "Imported from blank Project"
      && document.querySelector("#pnFooterName")?.textContent === "Imported from blank Project");
    const documentNamesAfterBlankProjectImport = documentLibrary
      ? Array.from(documentLibrary.querySelectorAll(".pn-document-open")).map((item) => item.textContent) : [];
    check(
      "editor-blank-project-import-creates-a-new-project-without-copying-document-metadata",
        Boolean(blankProjectSourceDate)
        && canvas.classList.contains("pn-project-document")
        && documentLibrary?.querySelectorAll(".pn-document-item").length === documentCountBeforeBlankProjectImport + 1
        && documentNamesAfterBlankProjectImport.includes("Footer rename")
        && documentNamesAfterBlankProjectImport.includes("Imported from blank Project")
        && document.querySelector("#pnPageHeader .pn-running-left")?.value === "Imported from blank Project"
        && document.querySelector("#pnPageHeader .pn-running-right")?.value === "Project"
        && document.querySelector("#pnFooterName")?.textContent === "Imported from blank Project"
        && !document.querySelector("#pnCanvas .pn-proof-metadata")
        && editorSource.includes("function isBlankProjectImportSource()"),
      JSON.stringify({ sourceDate: blankProjectSourceDate, header: document.querySelector("#pnPageHeader .pn-running-left")?.value, footer: document.querySelector("#pnFooterName")?.textContent, documentNamesAfterBlankProjectImport })
    );
    const invalidLatexJson = [
      "{",
      '  "format": "proofnote-document",',
      '  "version": "1.0",',
      '  "metadata": { "name": "Bad escape" },',
      '  "blocks": [',
      '    { "type": "equation", "content": "Let \\(G_n = n" }',
      "  ]",
      "}"
    ].join("\n");
    if (importText) importText.value = invalidLatexJson;
    if (confirmImport) confirmImport.click();
    await settle(window, () => /JSON syntax error|JSON 语法错误/.test(importReport?.textContent || ""));
    check(
      "editor-import-reports-json-syntax-with-a-source-location-and-latex-fix",
      /JSON syntax error|JSON 语法错误/.test(importReport?.textContent || "")
        && /Line 6|第 6 行/.test(importReport?.textContent || "")
        && /\\u005c\(/.test(importReport?.textContent || "")
        && Boolean(importReport?.querySelector(".pn-import-diagnostic-snippet"))
        && Boolean(importReport?.querySelector(".pn-import-diagnostic-copy"))
        && editorSource.includes("jsonSyntaxDetails")
        && editorSource.includes("STRICT_JSON_PARSE_OPTIONS"),
      importReport?.textContent || "missing JSON syntax diagnostic"
    );
    const silentlyCorruptedLatexJson = [
      "{",
      '  "format": "proofnote-document",',
      '  "version": "1.0",',
      '  "metadata": { "name": "Corrupted LaTeX" },',
      '  "blocks": [',
      '    { "type": "equation", "content": "\\boxed{x}" }',
      "  ]",
      "}"
    ].join("\n");
    if (importText) importText.value = silentlyCorruptedLatexJson;
    if (confirmImport) confirmImport.click();
    await settle(window, () => /Possible malformed LaTeX|可能已损坏的 LaTeX/.test(importReport?.textContent || ""));
    check(
      "editor-import-stops-silently-corrupted-latex-escapes",
      /Possible malformed LaTeX|可能已损坏的 LaTeX/.test(importReport?.textContent || "")
        && /\\u005cboxed/.test(importReport?.textContent || "")
        && editorSource.includes("potentialLatexCorruptions"),
      importReport?.textContent || "missing LaTeX corruption diagnostic"
    );
    const invalidSchemaJson = JSON.stringify({ format: "proofnote-document", version: "1.0", metadata: { name: "Bad structure" }, blocks: "not an array" }, null, 2);
    if (importText) importText.value = invalidSchemaJson;
    if (confirmImport) confirmImport.click();
    await settle(window, () => /Document structure error|文档结构错误/.test(importReport?.textContent || ""));
    check(
      "editor-import-renders-schema-errors-as-structured-path-diagnostics",
      /Document structure error|文档结构错误/.test(importReport?.textContent || "")
        && /blocks/.test(importReport?.textContent || "")
        && Boolean(importReport?.querySelector(".pn-import-diagnostic-list"))
        && editorSource.includes("renderSchemaDiagnostics"),
      importReport?.textContent || "missing schema diagnostic"
    );
    const shortTableRowJson = JSON.stringify({
      format: "proofnote-document",
      version: "1.0",
      metadata: { name: "Short table row" },
      blocks: [{ type: "table", columns: ["Name", "Score", "Status"], rows: [["Alice", "98"]] }]
    }, null, 2);
    if (importText) importText.value = shortTableRowJson;
    if (confirmImport) confirmImport.click();
    await settle(window, () => /recoverable notice|可恢复提示/.test(document.querySelector("#pnStatus")?.textContent || ""));
    check(
      "editor-import-allows-short-table-rows-with-a-recoverable-notice",
      /recoverable notice|可恢复提示/.test(document.querySelector("#pnStatus")?.textContent || "")
        && document.querySelector("#pnImportModal")?.hidden === true,
      document.querySelector("#pnStatus")?.textContent || "short table rows should import with a recoverable notice"
    );
    const longTableRowJson = JSON.stringify({
      format: "proofnote-document",
      version: "1.0",
      metadata: { name: "Long table row" },
      blocks: [{ type: "table", columns: ["Name", "Score", "Status"], rows: [["Bob", "91", "Pass", "EXTRA CELL"]] }]
    }, null, 2);
    if (importText) importText.value = longTableRowJson;
    if (confirmImport) confirmImport.click();
    await settle(window, () => /Document structure error|文档结构错误/.test(importReport?.textContent || ""));
    check(
      "editor-import-blocks-long-table-rows-before-any-cell-is-discarded",
      /Document structure error|文档结构错误/.test(importReport?.textContent || "")
        && /blocks\[0\]\.rows\[0\]/.test(importReport?.textContent || "")
        && /Expected 3 cells, found 4/.test(importReport?.textContent || "")
        && importText?.value.includes("EXTRA CELL"),
      importReport?.textContent || "long table rows should be rejected before cells are lost"
    );
    const multilineParagraphJson = JSON.stringify({
      format: "proofnote-document",
      version: "1.0",
      metadata: { name: "Multiline paragraph" },
      blocks: [{ type: "paragraph", content: "First line\nSecond line" }]
    }, null, 2);
    if (importText) importText.value = multilineParagraphJson;
    if (confirmImport) confirmImport.click();
    await settle(window, () => document.querySelector("#pnCanvas .pn-canvas-paragraph-input")?.value === "First line\nSecond line");
    check(
      "editor-import-allows-legal-json-newline-escapes",
      document.querySelector("#pnCanvas .pn-canvas-paragraph-input")?.value === "First line\nSecond line"
        && !/Possible malformed LaTeX|可能已损坏的 LaTeX/.test(importReport?.textContent || "")
        && editorSource.includes("SILENT_JSON_LATEX_COMMANDS"),
      importReport?.textContent || "a legal JSON newline escape should import as a multiline paragraph"
    );
    const documentCountBeforeProjectImport = documentLibrary ? documentLibrary.querySelectorAll(".pn-document-item").length : 0;
    const documentNamesBeforeProjectImport = documentLibrary
      ? Array.from(documentLibrary.querySelectorAll(".pn-document-open")).map((item) => item.textContent) : [];
    if (importText) importText.value = JSON.stringify(importedProjectPayload);
    if (confirmImport) confirmImport.click();
    await settle(window, () => canvas.classList.contains("pn-project-document")
      && Boolean(document.querySelector("#pnCanvas .pn-canvas-semantic .pn-editorial-section"))
      && Boolean(document.querySelector("#pnCanvas .pn-canvas-heading .pn-editorial-section"))
      && document.querySelector("#pnPageHeader .pn-running-left")?.value === "当前核心通用结构"
      && document.querySelector("#pnFooterName")?.textContent === "当前核心通用结构");
    const importedHeading = document.querySelector("#pnCanvas .pn-canvas-heading .pn-editorial-section-title-input");
    const documentNamesAfterProjectImport = documentLibrary
      ? Array.from(documentLibrary.querySelectorAll(".pn-document-open")).map((item) => item.textContent) : [];
    const projectImportState = {
      project: canvas.classList.contains("pn-project-document"),
      introduction: Boolean(document.querySelector("#pnCanvas .pn-canvas-semantic .pn-editorial-section")),
      genericIntroduction: Boolean(document.querySelector("#pnCanvas .pn-semantic-introduction")),
      heading: Boolean(document.querySelector("#pnCanvas .pn-canvas-heading .pn-editorial-section")),
      genericHeading: Boolean(document.querySelector("#pnCanvas .pn-heading-1")),
      headingValue: importedHeading && importedHeading.value,
      libraryCount: documentLibrary?.querySelectorAll(".pn-document-item").length,
      header: document.querySelector("#pnPageHeader .pn-running-left")?.value,
      footer: document.querySelector("#pnFooterName")?.textContent
    };
    check(
      "editor-project-import-creates-a-new-project-with-complete-chrome",
      Boolean(importText && confirmImport)
        && canvas.classList.contains("pn-project-document")
        && Boolean(document.querySelector("#pnCanvas .pn-canvas-semantic .pn-editorial-section"))
        && !document.querySelector("#pnCanvas .pn-semantic-introduction")
        && Boolean(document.querySelector("#pnCanvas .pn-canvas-heading .pn-editorial-section"))
        && !document.querySelector("#pnCanvas .pn-heading-1")
        && importedHeading?.value === "Core prime-family bounds"
        && documentLibrary?.querySelectorAll(".pn-document-item").length === documentCountBeforeProjectImport + 1
        && documentNamesBeforeProjectImport.every((name) => documentNamesAfterProjectImport.includes(name))
        && documentNamesAfterProjectImport.includes("当前核心通用结构")
        && document.querySelector("#pnPageHeader .pn-running-left")?.value === "当前核心通用结构"
        && document.querySelector("#pnPageHeader .pn-running-right")?.value === "Project"
        && document.querySelector("#pnFooterName")?.textContent === "当前核心通用结构"
        && /Import as new document|导入为新文档/.test(confirmImport?.textContent || "")
        && editorSource.includes("const importProjectContext = isBlankProjectImportSource() ? projectImportContext() : null;")
        && editorSource.includes("function prepareImportedProjectDocument(document, context)")
        && editorSource.includes('next.metadata.documentType = "Project";'),
      JSON.stringify(projectImportState)
    );
    const originalCreateObjectUrl = window.URL.createObjectURL;
    const originalRevokeObjectUrl = window.URL.revokeObjectURL;
    const originalAnchorClick = window.HTMLAnchorElement.prototype.click;
    let exportedProjectBlob = null;
    window.URL.createObjectURL = (blob) => {
      exportedProjectBlob = blob;
      return "blob:proofnote-project-export";
    };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
    const exportProjectHtml = document.querySelector("#pnExportHtml");
    if (exportProjectHtml) exportProjectHtml.click();
    await settle(window, () => Boolean(exportedProjectBlob));
    const exportedProjectHtml = exportedProjectBlob ? await exportedProjectBlob.text() : "";
    window.URL.createObjectURL = originalCreateObjectUrl;
    window.URL.revokeObjectURL = originalRevokeObjectUrl;
    window.HTMLAnchorElement.prototype.click = originalAnchorClick;
    check(
      "editor-project-import-export-applies-the-project-editorial-wrapper",
      Boolean(exportProjectHtml)
        && exportedProjectHtml.includes('<article class="pn-document pn-project-document">')
        && exportedProjectHtml.includes('<html lang="zh-CN">')
        && exportedProjectHtml.includes('<title>当前核心通用结构</title>')
        && exportedProjectHtml.includes('.pn-project-document{max-width:820px')
        && exportedProjectHtml.includes('.pn-project-document .pn-table-wrap,.pn-project-document .pn-equation,.pn-project-document .pn-code{width:calc(100% + 60px);max-width:none;margin-left:-30px;margin-right:-30px}')
        && exportedProjectHtml.includes('@media print{.pn-project-document{max-width:none;padding:16mm 15mm}.pn-project-document .pn-table-wrap,.pn-project-document .pn-equation,.pn-project-document .pn-code{width:auto;margin-left:0;margin-right:0}}')
        && exportedProjectHtml.includes('class="pn-export-running pn-project-running"')
        && exportedProjectHtml.includes('<span class="pn-running-brand">当前核心通用结构</span><span class="pn-running-type">Project</span>')
        && !exportedProjectHtml.includes('class="pn-proof-metadata"')
        && exportedProjectHtml.includes('class="pn-editorial-section pn-editorial-section-introduction"')
        && exportedProjectHtml.includes('class="pn-editorial-section pn-editorial-section-heading"')
        && exportedProjectHtml.includes('<span class="pn-editorial-section-number">01</span><h2>Introduction</h2>')
        && exportedProjectHtml.includes('<span class="pn-editorial-section-number">02</span><h2>Core prime-family bounds</h2>')
        && !exportedProjectHtml.includes("<h2>1. Core prime-family bounds</h2>"),
      exportedProjectHtml.slice(0, 1500)
    );
    check(
      "editor-html-export-renders-code-with-prism-without-mutating-source-code",
      exportedProjectHtml.includes('class="pn-code pn-code-highlighted language-javascript"')
        && exportedProjectHtml.includes('<span class="token keyword">const</span>')
        && exportedProjectHtml.includes('<span class="token string">"ready"</span>')
        && exportedProjectHtml.includes('class="pn-code pn-code-highlighted language-python"')
        && exportedProjectHtml.includes('<span class="token keyword">def</span>')
        && exportedProjectHtml.includes("EXPORT_CODE_SYNTAX_CSS") === false
        && exportedProjectHtml.includes(".pn-code .token.keyword")
        && editorSource.includes("Prism")
        && projectAiInstructions.includes("Keep content as raw code"),
      exportedProjectHtml.slice(-1800)
    );
    const firstTemplate = templateLibrary && templateLibrary.querySelector(".pn-template-item");
    const documentCountBeforeTemplate = documentLibrary ? documentLibrary.querySelectorAll(".pn-document-item").length : 0;
    if (firstTemplate) firstTemplate.click();
    await settle(window, () => documentLibrary && documentLibrary.querySelectorAll(".pn-document-item").length === documentCountBeforeTemplate + 1);
    check(
      "editor-template-creates-a-new-library-document",
      Boolean(documentLibrary)
        && documentLibrary.querySelectorAll(".pn-document-item").length === documentCountBeforeTemplate + 1
        && confirmModal.hidden === true
        && editorSource.includes("Store.createDocument"),
      documentLibrary ? documentLibrary.textContent : "template did not create a document"
    );

    const documentCountBeforeCurrentDelete = documentLibrary ? documentLibrary.querySelectorAll(".pn-document-item").length : 0;
    const activeDocument = documentLibrary && documentLibrary.querySelector('.pn-document-open[aria-current="true"]');
    const activeRow = activeDocument && activeDocument.closest(".pn-document-item");
    const activeActions = activeRow && activeRow.querySelector(".pn-document-more");
    const deleteCurrent = activeActions && Array.from(activeActions.querySelectorAll("button")).find((control) => /Delete document|删除文档/.test(control.textContent));
    if (activeActions) activeActions.open = true;
    if (deleteCurrent) deleteCurrent.click();
    await settle(window, () => confirmModal && confirmModal.hidden === false);
    const deleteAccept = document.querySelector("#pnConfirmAccept");
    if (deleteAccept) deleteAccept.click();
    await settle(window, () => documentLibrary && documentLibrary.querySelectorAll(".pn-document-item").length === documentCountBeforeCurrentDelete - 1);
    check(
      "editor-deleting-current-document-opens-an-existing-document-without-creating-one",
      Boolean(documentLibrary && activeDocument && deleteCurrent)
        && documentLibrary.querySelectorAll(".pn-document-item").length === documentCountBeforeCurrentDelete - 1
        && documentLibrary.querySelector('.pn-document-open[aria-current="true"]') !== activeDocument
        && editorSource.includes("openRemainingDocumentAfterDeletion")
        && !editorSource.includes("createBlankLibraryDocument"),
      documentLibrary ? documentLibrary.textContent : "current-document deletion should not create a replacement while documents remain"
    );

    // Hold the first write open, edit again, then request a document switch.
    // The transition must wait for the second snapshot rather than treating
    // the older completion as sufficient and discarding the later edit.
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    const originalSaveDocument = window.ProofnoteStore.saveDocument;
    const deferredSaves = [];
    window.ProofnoteStore.saveDocument = (id, savedDocument) => new Promise((resolve) => {
      deferredSaves.push({ id, document: JSON.parse(JSON.stringify(savedDocument)), resolve });
    });
    const autosaveTitle = document.querySelector("#pnCanvas .pn-document-title input, #pnCanvas .pn-document-title textarea");
    const originalDocumentName = document.querySelector('.pn-document-open[aria-current="true"]')?.textContent.trim();
    const transitionTarget = Array.from(document.querySelectorAll('.pn-document-open[aria-current="false"]'))[0];
    if (autosaveTitle) {
      autosaveTitle.value = "Autosave revision A";
      autosaveTitle.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    if (transitionTarget) transitionTarget.click();
    await settle(window, () => deferredSaves.length === 1, 1000);
    if (autosaveTitle) {
      autosaveTitle.value = "Autosave revision B";
      autosaveTitle.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    const firstSnapshot = deferredSaves[0];
    if (firstSnapshot) firstSnapshot.resolve("localStorage");
    await settle(window, () => deferredSaves.length === 2, 1000);
    const secondSnapshot = deferredSaves[1];
    if (secondSnapshot) secondSnapshot.resolve("localStorage");
    await settle(window, () => {
      const active = document.querySelector('.pn-document-open[aria-current="true"]');
      return Boolean(active && active.textContent.trim() !== originalDocumentName);
    }, 1000);
    window.ProofnoteStore.saveDocument = originalSaveDocument;
    const titleFromSnapshot = (snapshot) => {
      const title = snapshot && snapshot.document.blocks.find((block) => block.type === "title");
      return title && title.content;
    };
    check(
      "editor-document-switch-flushes-all-newer-autosave-revisions",
      Boolean(autosaveTitle)
        && Boolean(transitionTarget)
        && titleFromSnapshot(firstSnapshot) === "Autosave revision A"
        && titleFromSnapshot(secondSnapshot) === "Autosave revision B"
        && editorSource.includes("let saveQueue = Promise.resolve()")
        && editorSource.includes("editRevision === snapshot.revision")
        && editorSource.includes("flushCurrentDocumentUntilClean"),
      JSON.stringify(deferredSaves.map((save) => titleFromSnapshot(save)))
    );
    check(
      "editor-autosave-flushes-on-document-lifecycle",
      editorSource.includes('document.addEventListener("visibilitychange"')
        && editorSource.includes('root.addEventListener("pagehide"')
        && editorSource.includes("flushBeforeLeaving"),
      "pending autosaves need a hidden/pagehide flush"
    );

    const sectionsBeforePickerInsert = new Set(canvasBlockNodes(document).map((block) => block.dataset.blockId));
    const pickerTrigger = canvas.querySelector(".pn-insert-last .pn-insert-trigger");
    if (pickerTrigger) pickerTrigger.click();
    await settle(window, () => Array.from(canvas.querySelectorAll(".pn-insert-choice")).some((choice) => /Section|章节/.test(choice.textContent)));
    const pickerSection = Array.from(canvas.querySelectorAll(".pn-insert-choice")).find((choice) => /Section|章节/.test(choice.textContent));
    if (pickerSection) pickerSection.click();
    await settle(window, () => canvasBlockNodes(document).some((block) => !sectionsBeforePickerInsert.has(block.dataset.blockId) && block.classList.contains("pn-canvas-semantic")));
    const insertedSection = canvasBlockNodes(document).find((block) => !sectionsBeforePickerInsert.has(block.dataset.blockId) && block.classList.contains("pn-canvas-semantic"));
    check(
      "editor-picker-section-creates-editorial-semantic-section",
      Boolean(pickerTrigger)
        && Boolean(pickerSection)
        && Boolean(insertedSection && insertedSection.querySelector(".pn-editorial-section"))
        && Boolean(insertedSection && insertedSection.querySelector(".pn-editorial-section-number"))
        && Boolean(insertedSection && Array.from(insertedSection.querySelectorAll("input, textarea")).some((control) => untitledSectionPattern.test(control.value))),
      insertedSection ? insertedSection.textContent : "the Add block picker did not create an editorial semantic section"
    );

    check("editor-no-runtime-errors", runtimeErrors.length === 0, runtimeErrors.join(" | ").slice(0, 500));
  } catch (error) {
    check("editor-test-harness", false, error && error.stack ? error.stack : String(error));
  } finally {
    window.console.error = originalConsoleError;
    dom.window.close();
  }

  const pass = results.filter((result) => result.pass).length;
  results.forEach((result) => {
    console.log((result.pass ? "PASS" : "FAIL") + "  " + result.name);
    if (!result.pass && result.detail) console.log("      " + String(result.detail).slice(0, 600));
  });
  console.log("\n" + pass + " / " + results.length + " passed");
  process.exitCode = pass === results.length ? 0 : 1;
}

main();
