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
    const Model = window.ProofnoteDocument;
    const fixture = Model.blankDocument({
      name: "Canvas QA",
      templateName: "Proof Note",
      blocks: [
        Model.createBlock("title", { content: "Canvas QA" }),
        Model.createBlock("semantic", { kind: "problem", title: "Canvas problem", content: "Direct editing should keep focus." }),
        Model.createBlock("semantic", { kind: "result", title: "Canvas result", content: "The active outline item must follow the selected block." }),
        Model.createBlock("paragraph", { content: "A closing paragraph." })
      ]
    });
    window.localStorage.setItem("proofnote-document:current:v1", JSON.stringify(fixture));
    window.eval(editorSource);
    const canvasReady = await settle(window, () => document.querySelectorAll("#pnCanvas .pn-canvas-block").length === fixture.blocks.length);

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
    const canvasBlocks = Array.from(document.querySelectorAll("#pnCanvas .pn-canvas-block"));
    const globalActionIds = ["pnImport", "pnExport", "pnExportHtml", "pnExportLegacy", "pnCopyAi"];

    check("editor-external-scripts-boot", Boolean(document.querySelector("#proofnoteDocumentApp")) && Boolean(window.ProofnoteDocument) && Boolean(window.ProofnoteStore), "document-model.js, document-store.js, and document-editor.js did not all boot");
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
        && editorSource.includes("SIDEBAR_WIDTH_KEY")
        && editorSource.includes("bindSidebarResize")
        && editorCss.includes("cursor: col-resize"),
      "the open navigation sidebar needs a persisted, keyboard-accessible resize separator"
    );
    check(
      "editor-outline-is-a-document-structure-tree",
      editorCss.includes(".pn-utility { background: color-mix(in srgb, var(--color-bg) 94%, var(--color-surface)); font-family: var(--pn-doc-body); }")
        && editorCss.includes(".pn-outline-disclosure.is-expanded")
        && editorCss.includes(".pn-outline-item.is-active")
        && editorCss.includes(".pn-sidebar-tabs { display: grid; grid-template-columns: 1fr 1fr;")
        && editorSource.includes("buildOutlineTree")
        && editorSource.includes("setOutlineCollapsed")
        && editorSource.includes("updateViewportOutlineActive")
        && document.querySelectorAll("#pnOutlinePanel .pn-sidebar-heading").length === 1
        && Boolean(outline)
        && outline.querySelectorAll(".pn-outline-item").length === 2
        && outline.textContent.includes("Canvas problem")
        && outline.textContent.includes("Canvas result")
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
    check("editor-single-canvas", canvasReady && document.querySelectorAll("#pnCanvas").length === 1 && canvasBlocks.length === fixture.blocks.length, "expected one populated #pnCanvas; legacy markup may contain a hidden doc-page, so this test intentionally counts canvases rather than all doc-page elements");
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
    check(
      "editor-editorial-export-is-shared",
      editorSource.includes("EXPORT_PROOFNOTE_EDITORIAL_CSS")
        && editorSource.includes("renderStandaloneDocument")
        && editorCss.includes(".pn-editorial-section-head")
        && editorCss.includes(".pn-proofnote-running"),
      "the standalone export and direct canvas must share Proof Note's editorial rendering language"
    );
    check("editor-inline-insert-points", document.querySelectorAll("#pnCanvas .pn-insert-point").length > 0, "expected inline insertion affordances inside #pnCanvas");
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
    check(
      "editor-template-library-not-a-form",
      Boolean(templateLibrary)
        && templateLibrary.getAttribute("role") === "list"
        && !templateLibrary.matches("select")
        && templateLibrary.querySelectorAll(".pn-template-item").length >= 3
        && Boolean(templateMenu)
        && ["pnSaveTemplate", "pnImportTemplate", "pnExportTemplate"].every((id) => templateMenu.contains(document.getElementById(id))),
      "templates should read as a compact library; secondary template actions belong in its overflow menu"
    );
    const firstTemplate = templateLibrary && templateLibrary.querySelector(".pn-template-item");
    if (firstTemplate) firstTemplate.click();
    await settle(window, () => confirmModal && !confirmModal.hidden);
    check(
      "editor-template-confirmation-uses-proofnote-dialog",
      Boolean(confirmModal)
        && confirmModal.hidden === false
        && Boolean(confirmModal.querySelector("#pnConfirmAccept"))
        && editorSource.includes("openConfirm")
        && !editorSource.includes("root.confirm"),
      "replacing a document from the template library should use the Proofnote confirmation dialog, not a browser alert"
    );
    const cancelTemplateConfirm = document.querySelector("#pnConfirmCancel");
    if (cancelTemplateConfirm) cancelTemplateConfirm.click();
    check(
      "editor-format-details-are-contextual",
      !document.querySelector(".pn-wordmark .pn-badge")
        && actionMenu.textContent.includes("Document Format 1.0")
        && !document.querySelector("#pnStatus").textContent.includes("Format"),
      "the format version should live in Document info, not beside the Proofnote wordmark"
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
      }
    }

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
