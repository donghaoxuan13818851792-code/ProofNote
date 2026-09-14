/* Proofnote's block-document editor. This is intentionally a thin UI over
 * document-model.js: all interchange normalisation and legacy adaptation stay
 * outside the rendering layer. */
(function (root, document) {
  "use strict";
  const Model = root.ProofnoteDocument;
  const Store = root.ProofnoteStore;
  if (!Model || !Store) return;

  const TYPE_OPTIONS = [
    ["title", "Title", "标题"], ["subtitle", "Subtitle", "副标题"], ["heading", "Heading", "章节标题"],
    ["paragraph", "Paragraph", "正文"], ["equation", "Equation", "公式"], ["code", "Code", "代码"],
    ["table", "Table", "表格"], ["image", "Image", "图片"], ["quote", "Quote", "引用"],
    ["divider", "Divider", "分隔线"], ["page-break", "Page break", "分页"], ["callout", "Callout", "提示框"],
    ["semantic", "Semantic block", "语义模块"], ["list", "List", "列表"], ["key-value", "Key–value", "键值列表"], ["stats", "Stats", "统计卡片"]
  ];
  const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map(([type, en, zh]) => [type, { en, zh }]));
  const OUTLINE_SEMANTIC_LABEL = {
    problem: { zh: "问题", en: "Problem" },
    theorem: { zh: "定理", en: "Theorem" },
    proof: { zh: "证明", en: "Proof" },
    result: { zh: "结果", en: "Result" },
    verification: { zh: "验证", en: "Verify" }
  };
  let state = null;
  let templates = [];
  let saveTimer = null;
  let statusTimer = null;
  let selectedTemplateId = "";
  let selectedBlockId = "";
  let activeOutlineBlockId = "";
  let collapsedOutlineIds = new Set();
  let outlineViewportFrame = 0;
  let outlineMenuNodeId = "";
  let undoAction = null;
  let undoTimer = null;
  let confirmActionHandler = null;
  let insertionIndex = null;
  // Keep the reader-facing navigator at the user's established width. The
  // sidebar remains resizable, but it is a proper navigation surface rather
  // than the deliberately compact outline rail used in the interim design.
  const SIDEBAR_WIDTH_KEY = "proofnote-document:sidebar-width";
  const OUTLINE_COLLAPSE_KEY = "proofnote-document:outline-collapsed:v1";
  const SIDEBAR_DEFAULT_WIDTH = 232;
  const SIDEBAR_MIN_WIDTH = 180;
  const SIDEBAR_MAX_WIDTH = 360;
  const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
  const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
  const OUTLINE_UNDO_WINDOW_MS = 8000;
  let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  let els = {};

  function english() { return document.documentElement.lang === "en"; }
  function tr(zh, en) { return english() ? en : zh; }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function inline(value) {
    return root.__snTest && root.__snTest.inlineMd ? root.__snTest.inlineMd(String(value || "")) : escapeHtml(value);
  }
  function math(value) {
    return root.__snTest && root.__snTest.renderMathTex ? root.__snTest.renderMathTex(String(value || ""), true) : "<code>" + escapeHtml(value) + "</code>";
  }
  function localDate() { return new Date().toLocaleString(english() ? "en-AU" : "zh-CN", { dateStyle: "medium" }); }
  function setStatus(message, kind) {
    clearTimeout(statusTimer);
    els.status.textContent = message || "";
    els.status.dataset.kind = kind || "";
    // The full confirmation is useful immediately after an operation, but it
    // should not occupy the toolbar once the moment has passed.
    if (kind === "saved" && message !== tr("已保存", "Saved")) {
      statusTimer = setTimeout(() => {
        if (els.status.dataset.kind === "saved") els.status.textContent = tr("已保存", "Saved");
      }, 1800);
    }
  }
  function optionText(type) { const item = TYPE_LABEL[type] || TYPE_LABEL.paragraph; return english() ? item.en : item.zh; }
  function blockTitle(block, index) {
    if (block.type === "heading") return block.content || tr("未命名章节", "Untitled heading");
    if (block.type === "title" || block.type === "subtitle") return block.content || optionText(block.type);
    if (block.type === "semantic") return block.title || block.label || tr("语义模块", "Semantic block");
    return optionText(block.type) + " " + (index + 1);
  }
  function blockEditorLabel(block) {
    if (block.type === "heading") return "H" + block.level;
    if (block.type === "semantic") {
      const semantic = OUTLINE_SEMANTIC_LABEL[block.kind || "result"] || OUTLINE_SEMANTIC_LABEL.result;
      return english() ? semantic.en : semantic.zh;
    }
    if (block.type === "callout") {
      const kinds = {
        note: { zh: "说明", en: "Note" }, tip: { zh: "提示", en: "Tip" },
        warning: { zh: "注意", en: "Warning" }, info: { zh: "信息", en: "Info" }
      };
      const callout = kinds[block.kind || "note"] || kinds.note;
      return english() ? callout.en : callout.zh;
    }
    return optionText(block.type);
  }
  function element(name, attrs, text) {
    const node = document.createElement(name);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className, onClick, title) {
    return element("button", { type: "button", class: className || "pn-btn", title: title || "", onclick: onClick }, text);
  }
  function inputField(labelText, value, onInput, options) {
    const opts = options || {};
    const field = element("label", { class: "pn-field" });
    if (opts.fieldClass) field.classList.add(...opts.fieldClass.split(/\s+/).filter(Boolean));
    if (labelText) field.appendChild(element("span", { class: "pn-field-label" }, labelText));
    const control = element(opts.multiline ? "textarea" : "input", { class: "input pn-input" + (opts.controlClass ? " " + opts.controlClass : "") });
    if (!opts.multiline) control.type = opts.type || "text";
    if (opts.rows) control.rows = String(opts.rows);
    if (opts.placeholder) control.placeholder = opts.placeholder;
    if (opts.ariaLabel) control.setAttribute("aria-label", opts.ariaLabel);
    control.value = value || "";
    const resize = () => {
      if (!opts.autoGrow || !opts.multiline) return;
      control.style.height = "auto";
      control.style.height = Math.max(control.scrollHeight, opts.minHeight || 0) + "px";
    };
    control.addEventListener("input", () => { resize(); onInput(control.value); });
    field.appendChild(control);
    if (opts.autoGrow && opts.multiline) root.requestAnimationFrame(resize);
    return field;
  }
  function selectField(labelText, value, values, onChange) {
    const field = element("label", { class: "pn-field pn-field-compact" });
    field.appendChild(element("span", { class: "pn-field-label" }, labelText));
    const select = element("select", { class: "input pn-input" });
    values.forEach(([key, label]) => {
      const option = element("option", { value: key }, label);
      option.selected = key === value;
      select.appendChild(option);
    });
    select.addEventListener("change", () => onChange(select.value));
    field.appendChild(select);
    return field;
  }

  function mount() {
    document.body.classList.add("proofnote-document-mode");
    const app = element("div", { id: "proofnoteDocumentApp" });
    app.innerHTML = `
      <header class="pn-workspace-toolbar">
        <div class="pn-wordmark"><strong>Proofnote</strong></div>
        <label class="pn-document-name-field"><span class="pn-visually-hidden">${tr("文档名称", "Document name")}</span><input id="pnDocumentName" type="text" spellcheck="false"></label>
        <p id="pnStatus" class="pn-status" role="status"></p>
        <div class="pn-toolbar-menu">
          <button class="pn-toolbar-actions" id="pnActionsToggle" type="button" aria-expanded="false" aria-controls="pnActionMenu" aria-label="${tr("文档操作", "Document actions")}" title="${tr("文档操作", "Document actions")}">•••</button>
          <div class="pn-action-menu" id="pnActionMenu" role="menu" aria-label="${tr("文档操作", "Document actions")}" hidden>
            <div class="pn-action-menu-label">${tr("文件", "File")}</div>
            <button class="pn-action-menu-item" id="pnImport" type="button" role="menuitem">${tr("导入 JSON", "Import JSON")}</button>
            <button class="pn-action-menu-item" id="pnExport" type="button" role="menuitem">${tr("导出文档", "Export document")}</button>
            <button class="pn-action-menu-item" id="pnExportHtml" type="button" role="menuitem">${tr("导出 HTML", "Export HTML")}</button>
            <button class="pn-action-menu-item" id="pnExportLegacy" type="button" role="menuitem">${tr("导出 Solution Note", "Export Solution Note")}</button>
            <div class="pn-action-menu-rule" aria-hidden="true"></div>
            <button class="pn-action-menu-item" id="pnCopyAi" type="button" role="menuitem">${tr("复制 AI 格式说明", "Copy AI format")}</button>
            <div class="pn-action-menu-rule" aria-hidden="true"></div>
            <div class="pn-action-menu-label">${tr("文档信息", "Document info")}</div>
            <p class="pn-action-menu-note">Proofnote Document Format 1.0</p>
          </div>
        </div>
        <button class="pn-toolbar-lang" id="pnLang" type="button">${english() ? "切换至中文" : "Switch to English"}</button>
      </header>
      <div class="pn-shell">
        <aside class="pn-utility" id="pnUtility" aria-label="${tr("文档导航", "Document navigation")}">
          <button class="pn-utility-toggle" id="pnUtilityToggle" type="button" aria-expanded="false" aria-label="${tr("打开侧栏", "Open sidebar")}" title="${tr("打开侧栏", "Open sidebar")}"><span class="pn-utility-icon">☰</span><span class="pn-utility-label">${tr("文档导航", "Document navigation")}</span></button>
          <div class="pn-utility-content">
            <div class="pn-sidebar-tabs" role="tablist" aria-label="${tr("侧栏内容", "Sidebar content")}">
              <button class="pn-sidebar-tab is-active" id="pnTemplatesTab" type="button" role="tab" aria-selected="true" aria-controls="pnTemplatesPanel">${tr("模板", "Templates")}</button>
              <button class="pn-sidebar-tab" id="pnOutlineTab" type="button" role="tab" aria-selected="false" aria-controls="pnOutlinePanel">${tr("大纲", "Outline")}</button>
            </div>
            <section class="pn-sidebar-panel" id="pnTemplatesPanel" role="tabpanel" aria-labelledby="pnTemplatesTab">
              <div class="pn-sidebar-heading">${tr("模板", "Templates")}</div>
              <div class="pn-template-list" id="pnTemplates" role="list" aria-label="${tr("选择模板", "Choose template")}"></div>
              <div class="pn-template-footer">
                <button class="pn-template-new" id="pnNew" type="button">${tr("＋ 新建文档", "+ New document")}</button>
                <div class="pn-template-menu-wrap">
                  <button class="pn-template-more" id="pnTemplateMenuToggle" type="button" aria-expanded="false" aria-controls="pnTemplateMenu" aria-label="${tr("模板操作", "Template actions")}" title="${tr("模板操作", "Template actions")}">•••</button>
                  <div class="pn-template-menu" id="pnTemplateMenu" role="menu" aria-label="${tr("模板操作", "Template actions")}" hidden>
                    <button class="pn-template-menu-item" id="pnSaveTemplate" type="button" role="menuitem">${tr("存为模板", "Save as template")}</button>
                    <button class="pn-template-menu-item" id="pnImportTemplate" type="button" role="menuitem">${tr("导入模板…", "Import template…")}</button>
                    <button class="pn-template-menu-item" id="pnExportTemplate" type="button" role="menuitem">${tr("导出当前模板", "Export current template")}</button>
                  </div>
                </div>
              </div>
            </section>
            <section class="pn-sidebar-panel" id="pnOutlinePanel" role="tabpanel" aria-labelledby="pnOutlineTab" hidden>
              <div class="pn-sidebar-heading pn-outline-heading"><span>${tr("文档大纲", "Outline")}</span><span class="pn-outline-count" id="pnOutlineCount"></span></div>
              <nav id="pnOutline" class="pn-outline" aria-label="${tr("文档大纲", "Document outline")}"></nav>
            </section>
          </div>
        </aside>
        <div class="pn-sidebar-resize" id="pnSidebarResize" role="separator" aria-orientation="vertical" aria-label="${tr("调整导航栏宽度", "Resize navigation sidebar")}" aria-valuemin="${SIDEBAR_MIN_WIDTH}" aria-valuemax="${SIDEBAR_MAX_WIDTH}" tabindex="-1"></div>
        <main class="pn-canvas-pane" aria-label="${tr("可编辑文档", "Editable document")}">
          <doc-page margin="0.85in" size="a4" id="pnDocPage">
            <div slot="header" class="pn-page-chrome" id="pnPageHeader" hidden></div>
            <article class="pn-document pn-document-canvas" id="pnCanvas" aria-label="${tr("文档内容", "Document content")}"></article>
            <div slot="footer" class="pn-page-chrome pn-page-footer"><span id="pnFooterName"></span><span id="pnFooterStatus"></span></div>
          </doc-page>
        </main>
        <aside class="pn-detail" id="pnDetail" aria-label="${tr("检查器", "Inspector")}" aria-hidden="true" hidden>
          <div class="pn-detail-content">
            <section class="pn-inspector-section">
              <div class="pn-inspector-topline"><div class="pn-utility-title">${tr("内容块", "Block")}</div><button class="pn-close-inspector" id="pnCloseInspector" type="button" aria-label="${tr("关闭检查器", "Close inspector")}" title="${tr("关闭检查器", "Close inspector")}">×</button></div>
              <div id="pnInspector"></div>
            </section>
          </div>
        </aside>
      </div>
      <div class="pn-modal-backdrop" id="pnImportModal" hidden>
        <section class="pn-modal" role="dialog" aria-modal="true" aria-label="${tr("导入文档", "Import document")}">
          <div class="pn-modal-heading"><h2>${tr("导入 JSON", "Import JSON")}</h2><button type="button" class="pn-close" id="pnCloseImport" aria-label="${tr("关闭", "Close")}">×</button></div>
          <p class="pn-modal-copy">${tr("支持 Proofnote Document、用户模板和原有 Solution Note 1.0。Solution Note 会无损优先地迁移为可编辑 blocks。", "Supports Proofnote Document, user templates, and Solution Note 1.0. Solution Notes are migrated into editable blocks.")}</p>
          <textarea class="input pn-import-text" id="pnImportText" rows="10" placeholder='{ "format": "proofnote-document", ... }'></textarea>
          <div class="pn-actions"><label class="btn btn-secondary pn-file-label">${tr("选择文件", "Choose file")}<input id="pnImportFile" type="file" accept="application/json" hidden></label><button class="btn btn-primary" id="pnConfirmImport" type="button">${tr("导入并替换", "Import and replace")}</button></div>
          <p id="pnImportReport" class="pn-import-report" role="status"></p>
        </section>
      </div>
      <div class="pn-modal-backdrop" id="pnConfirmModal" hidden>
        <section class="pn-modal pn-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="pnConfirmTitle" aria-describedby="pnConfirmCopy">
          <p class="pn-confirm-kicker">${tr("确认操作", "CONFIRM ACTION")}</p>
          <h2 id="pnConfirmTitle"></h2>
          <p id="pnConfirmCopy" class="pn-modal-copy"></p>
          <div class="pn-actions pn-confirm-actions"><button class="btn btn-secondary" id="pnConfirmCancel" type="button">${tr("取消", "Cancel")}</button><button class="btn btn-primary" id="pnConfirmAccept" type="button"></button></div>
        </section>
      </div>
      <div class="pn-outline-menu" id="pnOutlineMenu" role="menu" aria-label="${tr("大纲结构操作", "Outline structure actions")}" hidden></div>
      <div class="pn-undo-toast" id="pnUndoToast" role="status" hidden><span id="pnUndoCopy"></span><button class="pn-undo-button" id="pnUndoButton" type="button">${tr("撤销", "Undo")}</button></div>`;
    document.body.appendChild(app);
    els = {
      app, utility: app.querySelector("#pnUtility"), utilityToggle: app.querySelector("#pnUtilityToggle"), sidebarResize: app.querySelector("#pnSidebarResize"), detail: app.querySelector("#pnDetail"), detailClose: app.querySelector("#pnCloseInspector"), actionToggle: app.querySelector("#pnActionsToggle"), actionMenu: app.querySelector("#pnActionMenu"), templateMenuToggle: app.querySelector("#pnTemplateMenuToggle"), templateMenu: app.querySelector("#pnTemplateMenu"), name: app.querySelector("#pnDocumentName"), templates: app.querySelector("#pnTemplates"), outlineCount: app.querySelector("#pnOutlineCount"), status: app.querySelector("#pnStatus"),
      outline: app.querySelector("#pnOutline"), canvasPane: app.querySelector(".pn-canvas-pane"), docPage: app.querySelector("#pnDocPage"), canvas: app.querySelector("#pnCanvas"), inspector: app.querySelector("#pnInspector"), pageHeader: app.querySelector("#pnPageHeader"), footer: app.querySelector("#pnFooterName"), footerStatus: app.querySelector("#pnFooterStatus"), modal: app.querySelector("#pnImportModal"), confirmModal: app.querySelector("#pnConfirmModal"), confirmTitle: app.querySelector("#pnConfirmTitle"), confirmCopy: app.querySelector("#pnConfirmCopy"), confirmCancel: app.querySelector("#pnConfirmCancel"), confirmAccept: app.querySelector("#pnConfirmAccept"),
      importText: app.querySelector("#pnImportText"), importFile: app.querySelector("#pnImportFile"), importReport: app.querySelector("#pnImportReport"),
      outlineMenu: app.querySelector("#pnOutlineMenu"), undoToast: app.querySelector("#pnUndoToast"), undoCopy: app.querySelector("#pnUndoCopy"), undoButton: app.querySelector("#pnUndoButton")
    };
    bindToolbar(app);
  }

  function bindToolbar(app) {
    app.querySelector("#pnUtilityToggle").addEventListener("click", () => setUtilityOpen(!els.utility.classList.contains("is-open")));
    els.actionToggle.addEventListener("click", () => setActionMenuOpen(els.actionMenu.hidden));
    els.templateMenuToggle.addEventListener("click", () => setTemplateMenuOpen(els.templateMenu.hidden));
    els.detailClose.addEventListener("click", () => setDetailOpen(false));
    app.addEventListener("click", (event) => {
      if (!event.target.closest(".pn-toolbar-menu")) setActionMenuOpen(false);
      if (!event.target.closest(".pn-template-menu-wrap")) setTemplateMenuOpen(false);
    });
    // Close the Outline menu on the *next pointer down* outside it, rather
    // than on click. A secondary click dispatches contextmenu before some
    // browsers emit a follow-up click; closing on that click made the menu
    // flash and disappear immediately after it opened.
    document.addEventListener("pointerdown", (event) => {
      if (!els.outlineMenu || els.outlineMenu.hidden) return;
      if (event.target.closest(".pn-outline-menu") || event.target.closest(".pn-outline-more")) return;
      closeOutlineMenu();
    });
    // The structural menu lives at document.body so it can escape the clipped
    // sidebar. Listen at document level as well, otherwise Escape stops
    // working whenever the active element is inside that floating menu.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      setActionMenuOpen(false);
      setTemplateMenuOpen(false);
      closeOutlineMenu();
      if (!els.modal.hidden) closeImport();
      if (!els.confirmModal.hidden) closeConfirm();
    });
    app.querySelector("#pnTemplatesTab").addEventListener("click", () => setSidebarTab("templates"));
    app.querySelector("#pnOutlineTab").addEventListener("click", () => setSidebarTab("outline"));
    app.querySelector("#pnNew").addEventListener("click", () => chooseNewDocument());
    app.querySelector("#pnSaveTemplate").addEventListener("click", () => { setTemplateMenuOpen(false); saveCurrentAsTemplate(); });
    app.querySelector("#pnImport").addEventListener("click", openImport);
    app.querySelector("#pnImportTemplate").addEventListener("click", openImport);
    app.querySelector("#pnCloseImport").addEventListener("click", closeImport);
    els.modal.addEventListener("click", (event) => { if (event.target === els.modal) closeImport(); });
    els.confirmCancel.addEventListener("click", closeConfirm);
    els.confirmAccept.addEventListener("click", () => {
      const handler = confirmActionHandler;
      closeConfirm();
      if (handler) handler();
    });
    els.confirmModal.addEventListener("click", (event) => { if (event.target === els.confirmModal) closeConfirm(); });
    els.undoButton.addEventListener("click", undoLastStructuralDelete);
    app.querySelector("#pnConfirmImport").addEventListener("click", importFromDialog);
    els.importFile.addEventListener("change", readImportFile);
    app.querySelector("#pnExport").addEventListener("click", () => { exportDocument(); setActionMenuOpen(false); });
    app.querySelector("#pnExportHtml").addEventListener("click", () => { exportHtml(); setActionMenuOpen(false); });
    app.querySelector("#pnCopyAi").addEventListener("click", () => { copyAiInstructions(); setActionMenuOpen(false); });
    app.querySelector("#pnExportTemplate").addEventListener("click", () => { exportTemplate(); setTemplateMenuOpen(false); });
    app.querySelector("#pnExportLegacy").addEventListener("click", () => { exportLegacy(); setActionMenuOpen(false); });
    app.querySelector("#pnLang").addEventListener("click", () => { try { root.localStorage.setItem("sn-lang", english() ? "zh" : "en"); } catch (_) {} root.location.reload(); });
    els.name.addEventListener("input", () => { state.metadata.name = els.name.value; changed(); });
    bindSidebarResize();
    bindOutlineViewportTracking();
  }
  function shouldPrioritiseCanvas() {
    return typeof root.innerWidth === "number" && root.innerWidth < 1320;
  }
  function canResizeSidebar() {
    return typeof root.innerWidth !== "number" || root.innerWidth >= 1024;
  }
  function syncCanvasScale() {
    if (!els.canvasPane || !els.docPage) return;
    // Below the desktop rail breakpoint the document keeps the existing
    // responsive sheet behaviour. Above it, preserve a fixed paper layout
    // and scale the whole page when a rail reduces its available width.
    if (!canResizeSidebar()) {
      els.docPage.style.setProperty("--doc-page-screen-scale", "1");
      return;
    }
    const stageX = Number.parseFloat(root.getComputedStyle(els.docPage).getPropertyValue("--pn-canvas-stage-x")) || 0;
    const naturalSheetWidth = 8.5 * 96;
    const availableWidth = Math.max(1, els.canvasPane.clientWidth - stageX * 2);
    const scale = Math.min(1, availableWidth / naturalSheetWidth);
    els.docPage.style.setProperty("--doc-page-screen-scale", scale.toFixed(4));
  }
  function clampSidebarWidth(value) {
    if (value == null || value === "") return SIDEBAR_DEFAULT_WIDTH;
    const number = Number(value);
    if (!Number.isFinite(number)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, number)));
  }
  function sidebarValueText(width) {
    return english() ? "Navigation sidebar width: " + width + " pixels" : "导航栏宽度：" + width + " 像素";
  }
  function syncSidebarResize() {
    if (!els.sidebarResize || !els.utility) return;
    const enabled = canResizeSidebar() && els.utility.classList.contains("is-open");
    els.sidebarResize.hidden = !enabled;
    els.sidebarResize.tabIndex = enabled ? 0 : -1;
    els.sidebarResize.setAttribute("aria-valuenow", String(sidebarWidth));
    els.sidebarResize.setAttribute("aria-valuetext", sidebarValueText(sidebarWidth));
    els.sidebarResize.title = tr("拖动调整宽度；双击恢复默认", "Drag to resize; double-click to reset");
  }
  function applySidebarWidth(value, persist) {
    sidebarWidth = clampSidebarWidth(value);
    if (els.utility && els.utility.classList.contains("is-open")) els.app.style.setProperty("--pn-left", sidebarWidth + "px");
    syncSidebarResize();
    root.requestAnimationFrame(syncCanvasScale);
    if (persist) {
      try { root.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch (_) {}
    }
  }
  function bindSidebarResize() {
    const resize = els.sidebarResize;
    if (!resize) return;
    resize.addEventListener("pointerdown", (event) => {
      if (!canResizeSidebar() || !els.utility.classList.contains("is-open") || event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const move = (moveEvent) => applySidebarWidth(startWidth + moveEvent.clientX - startX, false);
      const finish = () => {
        document.body.classList.remove("pn-sidebar-resizing");
        root.removeEventListener("pointermove", move);
        root.removeEventListener("pointerup", finish);
        root.removeEventListener("pointercancel", finish);
        applySidebarWidth(sidebarWidth, true);
      };
      document.body.classList.add("pn-sidebar-resizing");
      if (resize.setPointerCapture) resize.setPointerCapture(event.pointerId);
      root.addEventListener("pointermove", move);
      root.addEventListener("pointerup", finish);
      root.addEventListener("pointercancel", finish);
    });
    resize.addEventListener("dblclick", () => applySidebarWidth(SIDEBAR_DEFAULT_WIDTH, true));
    resize.addEventListener("keydown", (event) => {
      if (!canResizeSidebar() || !els.utility.classList.contains("is-open")) return;
      const delta = event.shiftKey ? 24 : 8;
      if (event.key === "ArrowLeft") { event.preventDefault(); applySidebarWidth(sidebarWidth - delta, true); }
      if (event.key === "ArrowRight") { event.preventDefault(); applySidebarWidth(sidebarWidth + delta, true); }
      if (event.key === "Home") { event.preventDefault(); applySidebarWidth(SIDEBAR_MIN_WIDTH, true); }
      if (event.key === "End") { event.preventDefault(); applySidebarWidth(SIDEBAR_MAX_WIDTH, true); }
    });
    root.addEventListener("resize", () => { syncSidebarResize(); syncCanvasScale(); });
  }
  function setActionMenuOpen(open) {
    els.actionMenu.hidden = !open;
    els.actionToggle.setAttribute("aria-expanded", String(Boolean(open)));
  }
  function setTemplateMenuOpen(open) {
    els.templateMenu.hidden = !open;
    els.templateMenuToggle.setAttribute("aria-expanded", String(Boolean(open)));
  }
  function openImport() {
    setActionMenuOpen(false);
    setTemplateMenuOpen(false);
    els.modal.hidden = false;
    els.importText.focus();
  }
  function setUtilityOpen(open) {
    // On a compact desktop, two expanded rails squeeze the A4 sheet into an
    // editor-like layout. Keep one contextual rail at a time so the document
    // remains the dominant surface.
    if (open && shouldPrioritiseCanvas() && els.detail.classList.contains("is-open")) setDetailOpen(false);
    els.utility.classList.toggle("is-open", Boolean(open));
    els.app.style.setProperty("--pn-left", open ? sidebarWidth + "px" : "48px");
    els.utilityToggle.setAttribute("aria-expanded", String(Boolean(open)));
    const label = open ? tr("收起侧栏", "Collapse sidebar") : tr("打开侧栏", "Open sidebar");
    els.utilityToggle.setAttribute("aria-label", label);
    els.utilityToggle.title = label;
    syncSidebarResize();
    root.requestAnimationFrame(syncCanvasScale);
    try { root.localStorage.setItem("proofnote-document:utility-open", open ? "1" : "0"); } catch (_) {}
  }
  function setSidebarTab(tab) {
    const templatesActive = tab !== "outline";
    const selected = templatesActive ? "templates" : "outline";
    const templateTab = document.getElementById("pnTemplatesTab");
    const outlineTab = document.getElementById("pnOutlineTab");
    const templatePanel = document.getElementById("pnTemplatesPanel");
    const outlinePanel = document.getElementById("pnOutlinePanel");
    templateTab.classList.toggle("is-active", templatesActive);
    outlineTab.classList.toggle("is-active", !templatesActive);
    templateTab.setAttribute("aria-selected", String(templatesActive));
    outlineTab.setAttribute("aria-selected", String(!templatesActive));
    templatePanel.hidden = !templatesActive;
    outlinePanel.hidden = templatesActive;
    try { root.localStorage.setItem("proofnote-document:sidebar-tab", selected); } catch (_) {}
  }
  function setDetailOpen(open) {
    if (open && shouldPrioritiseCanvas() && els.utility.classList.contains("is-open")) setUtilityOpen(false);
    els.detail.classList.toggle("is-open", Boolean(open));
    els.detail.hidden = !open;
    els.detail.setAttribute("aria-hidden", String(!open));
    els.app.style.setProperty("--pn-right", open ? "276px" : "0px");
    root.requestAnimationFrame(syncCanvasScale);
  }
  function closeImport() { els.modal.hidden = true; els.importReport.textContent = ""; }
  function openConfirm(options) {
    const opts = options || {};
    confirmActionHandler = typeof opts.onConfirm === "function" ? opts.onConfirm : null;
    els.confirmTitle.textContent = opts.title || tr("继续操作？", "Continue?");
    els.confirmCopy.textContent = opts.message || "";
    els.confirmAccept.textContent = opts.confirmLabel || tr("继续", "Continue");
    els.confirmModal.hidden = false;
    root.requestAnimationFrame(() => els.confirmCancel.focus());
  }
  function closeConfirm() {
    confirmActionHandler = null;
    els.confirmModal.hidden = true;
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const backend = await Store.saveCurrent(state);
        if (backend === "failed") {
          setStatus(tr("自动保存失败；请立即导出文档备份。", "Autosave failed — export a backup now."), "error");
          return;
        }
        setStatus(backend === "indexeddb" ? tr("已自动保存到此设备", "Saved on this device") : tr("已自动保存（本地存储）", "Saved locally"), "saved");
      } catch (_) {
        setStatus(tr("自动保存失败；请立即导出文档备份。", "Autosave failed — export a backup now."), "error");
      }
    }, 350);
  }
  async function refreshTemplates() {
    const custom = await Store.listTemplates();
    const preferredOrder = ["proof-note", "research-note", "blank-document", "lab-report", "essay-report"];
    templates = Model.builtInTemplates().concat(custom.map(Model.normalizeTemplate)).sort((first, second) => {
      const firstRank = preferredOrder.indexOf(first.template.id);
      const secondRank = preferredOrder.indexOf(second.template.id);
      if (firstRank !== secondRank) return (firstRank < 0 ? 99 : firstRank) - (secondRank < 0 ? 99 : secondRank);
      if (first.template.builtIn !== second.template.builtIn) return first.template.builtIn ? -1 : 1;
      return first.template.name.localeCompare(second.template.name);
    });
    renderTemplateLibrary();
  }
  function currentTemplateId() {
    if (templateById(selectedTemplateId)) return selectedTemplateId;
    const name = state && state.metadata ? String(state.metadata.templateName || "").trim() : "";
    const matchingTemplate = name && templates.find((template) => template.template.name === name);
    return matchingTemplate ? matchingTemplate.template.id : "";
  }
  function renderTemplateLibrary() {
    if (!els.templates) return;
    const activeId = currentTemplateId();
    if (!selectedTemplateId && activeId) selectedTemplateId = activeId;
    els.templates.innerHTML = "";
    let customLabelAdded = false;
    templates.forEach((template) => {
      if (!template.template.builtIn && !customLabelAdded) {
        els.templates.appendChild(element("div", { class: "pn-template-group-label" }, tr("我的模板", "My templates")));
        customLabelAdded = true;
      }
      const item = button("", "pn-template-item" + (template.template.id === activeId ? " is-active" : ""), () => useSelectedTemplate(template.template.id), template.template.description || template.template.name);
      item.dataset.templateId = template.template.id;
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-current", String(template.template.id === activeId));
      item.appendChild(element("span", { class: "pn-template-item-name" }, template.template.name));
      if (template.template.description) item.appendChild(element("span", { class: "pn-template-item-description" }, template.template.description));
      els.templates.appendChild(item);
    });
  }
  function templateById(templateId) { return templates.find((template) => template.template.id === templateId); }
  function chooseNewDocument() {
    const blank = templateById("blank-document");
    if (!blank) return;
    openConfirm({
      title: tr("新建空白文档？", "Start a blank document?"),
      message: tr("这会替换当前文档内容。", "This replaces the current document."),
      confirmLabel: tr("新建并替换", "Replace document"),
      onConfirm: () => {
        clearStructuralUndo();
        selectedTemplateId = "blank-document";
        state = Model.normalizeDocument(blank.document);
        state.metadata.name = tr("未命名文档", "Untitled document");
        renderAll();
        root.requestAnimationFrame(syncCanvasScale);
        scheduleSave();
      }
    });
  }
  function useSelectedTemplate(templateId) {
    const template = templateById(templateId);
    if (!template) return;
    openConfirm({
      title: tr("使用此模板？", "Use this template?"),
      message: tr("应用“" + template.template.name + "”会替换当前文档。", "Applying “" + template.template.name + "” replaces the current document."),
      confirmLabel: tr("使用模板", "Use template"),
      onConfirm: () => {
        clearStructuralUndo();
        selectedTemplateId = template.template.id;
        state = Model.normalizeDocument(template.document);
        state.metadata.name = template.template.name;
        renderAll();
        scheduleSave();
      }
    });
  }
  async function saveCurrentAsTemplate() {
    const name = root.prompt(tr("模板名称", "Template name"), state.metadata.name || tr("我的模板", "My template"));
    if (!name || !name.trim()) return;
    const template = Model.makeTemplate(state, { name: name.trim(), description: tr("由当前 Proofnote 文档保存", "Saved from the current Proofnote document") });
    const backend = await Store.saveTemplate(template);
    if (backend === "failed") {
      setStatus(tr("模板保存失败；请导出模板备份。", "Template save failed — export a backup."), "error");
      return;
    }
    selectedTemplateId = template.template.id;
    await refreshTemplates();
    setStatus(tr("模板已保存到此设备", "Template saved on this device"), "saved");
  }

  function outlineTitle(block) {
    if (block.type === "heading") return String(block.content || "").trim();
    if (block.type === "semantic") return String(block.title || block.label || "").trim();
    return "";
  }
  // The outline is intentionally a view over the ordered block list, not a
  // second tree-shaped document model. Templates influence participation via
  // their structural blocks (headings and named semantic blocks); content
  // remains flat so import, export, pagination and old-note migration stay
  // straightforward.
  function buildOutlineTree() {
    const roots = [];
    const entries = [];
    const stack = [];
    let semanticLevel = 0;
    state.blocks.forEach((block, index) => {
      let level;
      let title = "";
      if (block.type === "heading") {
        title = outlineTitle(block);
        // An empty heading is not a meaningful outline node, and it should not
        // create an invisible parent that indents the following content.
        if (!title) { semanticLevel = 0; return; }
        level = Math.max(0, Number(block.level || 1) - 1);
        semanticLevel = level + 1;
      } else if (block.type === "semantic") {
        title = outlineTitle(block);
        if (!title) return;
        level = semanticLevel;
      } else {
        return;
      }
      const node = { id: block.id, block, index, title, level, children: [], parent: null };
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1] || null;
      if (parent) { parent.children.push(node); node.parent = parent; }
      else roots.push(node);
      stack.push(node);
      entries.push(node);
    });
    return { roots, entries };
  }
  function outlineNodeFor(blockId) {
    return buildOutlineTree().entries.find((entry) => entry.id === blockId) || null;
  }
  // All structural commands below use these three helpers. In particular,
  // sibling insertion happens after a node's complete subtree, never directly
  // after a heading where it could capture the former node's content.
  function getSectionRange(blockId) {
    const node = outlineNodeFor(blockId);
    if (!node) return null;
    const { entries } = buildOutlineTree();
    const nextBoundary = entries.find((entry) => entry.index > node.index && entry.level <= node.level);
    return {
      node,
      start: node.index,
      end: nextBoundary ? nextBoundary.index : state.blocks.length,
      blocks: state.blocks.slice(node.index, nextBoundary ? nextBoundary.index : state.blocks.length)
    };
  }
  function getSiblingInsertionIndex(blockId) {
    const range = getSectionRange(blockId);
    return range ? range.end : -1;
  }
  function getChildInsertionIndex(blockId) {
    const range = getSectionRange(blockId);
    return range ? range.end : -1;
  }
  function isPrimaryStructureNode(node) { return node && node.level === 0; }
  function isSecondaryStructureNode(node) { return node && node.level === 1; }
  function focusOutlineNodeTitle(blockId) {
    focusBlock(blockId);
    root.requestAnimationFrame(() => {
      const canvasBlock = document.getElementById("pn-block-" + blockId);
      if (!canvasBlock) return;
      const control = canvasBlock.querySelector(".pn-editorial-section-title-input,.pn-canvas-heading-input,.pn-editorial-detail-title-input,.pn-canvas-component-title-input,input,textarea");
      if (!control) return;
      control.focus();
      if (typeof control.select === "function") control.select();
    });
  }
  function uniqueBlockCopy(block) {
    const values = Object.assign({}, block);
    delete values.id;
    return Model.createBlock(block.type, values);
  }
  function finishStructuralChange(selectedId, focusTitle) {
    selectedBlockId = selectedId || "";
    activeOutlineBlockId = "";
    changed({ structure: true, outline: true, inspector: true, chrome: true });
    if (selectedBlockId) {
      root.requestAnimationFrame(() => {
        if (focusTitle) focusOutlineNodeTitle(selectedBlockId);
        else focusBlock(selectedBlockId);
      });
    }
  }
  function insertStructuralBlock(index, block, focusTitle) {
    if (index < 0) return;
    clearStructuralUndo();
    state.blocks.splice(index, 0, block);
    finishStructuralChange(block.id, Boolean(focusTitle));
  }
  function addSectionAfter(blockId) {
    const index = getSiblingInsertionIndex(blockId);
    insertStructuralBlock(index, Model.createBlock("heading", { level: 1, content: tr("未命名章节", "Untitled section") }), true);
  }
  function addSubsection(blockId, placement) {
    const index = placement === "after" ? getSiblingInsertionIndex(blockId) : getChildInsertionIndex(blockId);
    insertStructuralBlock(index, Model.createBlock("heading", { level: 2, content: tr("未命名小节", "Untitled subsection") }), true);
  }
  function addContentToSection(blockId, type) {
    const index = getChildInsertionIndex(blockId);
    if (index < 0) return;
    const values = type === "semantic" ? { kind: "result", title: "", content: "" } : {};
    insertStructuralBlock(index, Model.createBlock(type, values), false);
  }
  function duplicateStructuralNode(blockId) {
    const range = getSectionRange(blockId);
    if (!range) return;
    const copies = range.blocks.map(uniqueBlockCopy);
    if (!copies.length) return;
    clearStructuralUndo();
    state.blocks.splice(range.end, 0, ...copies);
    finishStructuralChange(copies[0].id, false);
  }
  function removeHeadingOnly(blockId) {
    const range = getSectionRange(blockId);
    if (!range) return;
    clearStructuralUndo();
    state.blocks.splice(range.start, 1);
    const next = state.blocks[range.start] || state.blocks[range.start - 1] || null;
    finishStructuralChange(next ? next.id : "", false);
  }
  function deleteSectionAndContents(blockId) {
    const range = getSectionRange(blockId);
    if (!range) return;
    const contentCount = Math.max(0, range.end - range.start - 1);
    const title = range.node.title;
    openConfirm({
      title: tr("删除章节与内容？", "Delete section and contents?"),
      message: tr("将删除“" + title + "”及其 " + contentCount + " 个内容块。", "Delete “" + title + "” and its " + contentCount + " content block" + (contentCount === 1 ? "" : "s") + "?"),
      confirmLabel: tr("删除", "Delete"),
      onConfirm: () => {
        const removed = state.blocks.splice(range.start, range.end - range.start);
        const next = state.blocks[range.start] || state.blocks[range.start - 1] || null;
        finishStructuralChange(next ? next.id : "", false);
        showStructuralUndo(tr("已删除章节与内容", "Section and contents deleted"), () => {
          state.blocks.splice(range.start, 0, ...removed);
          finishStructuralChange(removed[0] ? removed[0].id : "", false);
        });
      }
    });
  }
  function clearStructuralUndo() {
    if (undoTimer) root.clearTimeout(undoTimer);
    undoTimer = null;
    undoAction = null;
    if (els.undoToast) els.undoToast.hidden = true;
  }
  function showStructuralUndo(message, action) {
    clearStructuralUndo();
    undoAction = action;
    els.undoCopy.textContent = message;
    els.undoToast.hidden = false;
    undoTimer = root.setTimeout(clearStructuralUndo, OUTLINE_UNDO_WINDOW_MS);
  }
  function undoLastStructuralDelete() {
    const action = undoAction;
    if (!action) return;
    clearStructuralUndo();
    action();
    setStatus(tr("已撤销删除", "Deletion undone"), "saved");
  }
  function closeOutlineMenu() {
    if (!els.outlineMenu) return;
    outlineMenuNodeId = "";
    els.outlineMenu.hidden = true;
    els.outlineMenu.innerHTML = "";
  }
  function addOutlineMenuButton(menu, labelText, command, handler, options) {
    const opts = options || {};
    const item = button(labelText, "pn-outline-menu-item" + (opts.danger ? " pn-outline-menu-danger" : ""), (event) => {
      event.stopPropagation();
      closeOutlineMenu();
      handler();
    });
    item.dataset.command = command;
    item.setAttribute("role", "menuitem");
    menu.appendChild(item);
    return item;
  }
  function addOutlineMenuRule(menu) { menu.appendChild(element("div", { class: "pn-outline-menu-rule", "aria-hidden": "true" })); }
  function addContentMenu(menu, node) {
    const wrap = element("div", { class: "pn-outline-menu-submenu-wrap" });
    const trigger = button(tr("添加内容", "Add content"), "pn-outline-menu-item pn-outline-menu-submenu-trigger", () => {});
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.appendChild(element("span", { class: "pn-outline-menu-arrow", "aria-hidden": "true" }, "›"));
    const submenu = element("div", { class: "pn-outline-menu pn-outline-menu-submenu", role: "menu", "aria-label": tr("添加内容", "Add content") });
    [
      ["paragraph", tr("正文", "Text")], ["equation", tr("公式", "Equation")], ["table", tr("表格", "Table")],
      ["code", tr("代码", "Code")], ["image", tr("图片", "Image")], ["list", tr("列表", "List")],
      ["quote", tr("引用", "Quote")], ["callout", tr("提示", "Callout")], ["semantic", tr("语义模块", "Semantic block")]
    ].forEach(([type, name]) => addOutlineMenuButton(submenu, name, "add-content-" + type, () => addContentToSection(node.id, type)));
    wrap.append(trigger, submenu);
    menu.appendChild(wrap);
  }
  function populateOutlineMenu(node) {
    const menu = els.outlineMenu;
    const primary = isPrimaryStructureNode(node);
    const secondary = isSecondaryStructureNode(node);
    if (primary) {
      addOutlineMenuButton(menu, tr("在后方添加章节", "Add section after"), "add-section-after", () => addSectionAfter(node.id));
      addOutlineMenuButton(menu, tr("添加小节", "Add subsection"), "add-subsection", () => addSubsection(node.id, "child"));
      addOutlineMenuRule(menu);
      addOutlineMenuButton(menu, tr("重命名", "Rename"), "rename", () => focusOutlineNodeTitle(node.id));
      addOutlineMenuButton(menu, tr("复制章节", "Duplicate section"), "duplicate-section", () => duplicateStructuralNode(node.id));
    } else if (secondary) {
      addOutlineMenuButton(menu, tr("在后方添加小节", "Add subsection after"), "add-subsection-after", () => addSubsection(node.id, "after"));
      addContentMenu(menu, node);
      addOutlineMenuRule(menu);
      addOutlineMenuButton(menu, tr("重命名", "Rename"), "rename", () => focusOutlineNodeTitle(node.id));
      addOutlineMenuButton(menu, tr("复制小节", "Duplicate subsection"), "duplicate-subsection", () => duplicateStructuralNode(node.id));
    } else {
      // H3 remains navigable and collapsible, but it is not promoted to a
      // third fully-editable structural tier in this first version.
      addOutlineMenuButton(menu, tr("重命名", "Rename"), "rename", () => focusOutlineNodeTitle(node.id));
    }
    addOutlineMenuRule(menu);
    addOutlineMenuButton(menu, tr("仅移除标题", "Remove heading only"), "remove-heading", () => removeHeadingOnly(node.id));
    addOutlineMenuButton(menu, tr("删除章节与内容…", "Delete section and contents…"), "delete-section", () => deleteSectionAndContents(node.id), { danger: true });
  }
  function openOutlineMenu(node, position) {
    if (!node || !els.outlineMenu) return;
    outlineMenuNodeId = node.id;
    els.outlineMenu.innerHTML = "";
    populateOutlineMenu(node);
    const point = position || {};
    const fallback = point.target && point.target.getBoundingClientRect ? point.target.getBoundingClientRect() : null;
    const left = Number.isFinite(point.clientX) ? point.clientX : (fallback ? fallback.right : 12);
    const top = Number.isFinite(point.clientY) ? point.clientY : (fallback ? fallback.bottom + 4 : 12);
    els.outlineMenu.style.left = left + "px";
    els.outlineMenu.style.top = top + "px";
    els.outlineMenu.hidden = false;
    root.requestAnimationFrame(() => {
      if (els.outlineMenu.hidden || outlineMenuNodeId !== node.id) return;
      const rect = els.outlineMenu.getBoundingClientRect();
      const maxLeft = Math.max(8, root.innerWidth - rect.width - 8);
      const maxTop = Math.max(8, root.innerHeight - rect.height - 8);
      els.outlineMenu.style.left = Math.max(8, Math.min(left, maxLeft)) + "px";
      els.outlineMenu.style.top = Math.max(8, Math.min(top, maxTop)) + "px";
    });
  }
  function persistOutlineCollapseState() {
    try { root.localStorage.setItem(OUTLINE_COLLAPSE_KEY, JSON.stringify(Array.from(collapsedOutlineIds))); } catch (_) {}
  }
  function setOutlineCollapsed(blockId, collapsed) {
    if (collapsed) collapsedOutlineIds.add(blockId);
    else collapsedOutlineIds.delete(blockId);
    persistOutlineCollapseState();
    renderOutline();
  }
  function syncOutlineActiveState() {
    if (!els.outline) return;
    els.outline.querySelectorAll(".pn-outline-item").forEach((item) => {
      const active = item.dataset.blockId === activeOutlineBlockId;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "location");
      else item.removeAttribute("aria-current");
    });
  }
  function setActiveOutlineForBlock(blockId) {
    const { entries } = buildOutlineTree();
    const index = state.blocks.findIndex((block) => block.id === blockId);
    const nearest = entries.filter((entry) => entry.index <= index).pop();
    const nextId = nearest ? nearest.id : "";
    if (nextId === activeOutlineBlockId) return;
    activeOutlineBlockId = nextId;
    syncOutlineActiveState();
  }
  function renderOutlineNode(node) {
    const wrapper = element("div", { class: "pn-outline-node" });
    wrapper.style.setProperty("--pn-outline-level", String(node.level));
    const row = element("div", { class: "pn-outline-row" });
    const collapsed = collapsedOutlineIds.has(node.id);
    if (node.children.length) {
      const disclosure = button("▸", "pn-outline-disclosure" + (collapsed ? "" : " is-expanded"), (event) => {
        event.stopPropagation();
        setOutlineCollapsed(node.id, !collapsed);
      }, collapsed ? tr("展开章节", "Expand section") : tr("折叠章节", "Collapse section"));
      disclosure.setAttribute("aria-expanded", String(!collapsed));
      disclosure.setAttribute("aria-label", (collapsed ? tr("展开", "Expand") : tr("折叠", "Collapse")) + " “" + node.title + "”");
      row.appendChild(disclosure);
    } else {
      row.appendChild(element("span", { class: "pn-outline-disclosure-spacer", "aria-hidden": "true" }));
    }
    const item = button("", "pn-outline-item", () => focusBlock(node.id), node.title);
    item.dataset.blockId = node.id;
    item.setAttribute("aria-label", node.title);
    item.appendChild(element("span", { class: "pn-outline-label" }, node.title));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOutlineMenu(node, event);
    });
    row.appendChild(item);
    const more = button("⋯", "pn-outline-more", (event) => {
      event.stopPropagation();
      openOutlineMenu(node, { clientX: event.clientX, clientY: event.clientY, target: more });
    }, tr("章节操作", "Section actions"));
    more.setAttribute("aria-label", tr("打开“" + node.title + "”的结构操作", "Open structure actions for “" + node.title + "”"));
    row.appendChild(more);
    wrapper.appendChild(row);
    if (node.children.length) {
      const children = element("div", { class: "pn-outline-children", role: "group" });
      children.hidden = collapsed;
      node.children.forEach((child) => children.appendChild(renderOutlineNode(child)));
      wrapper.appendChild(children);
    }
    return wrapper;
  }
  function renderOutline() {
    closeOutlineMenu();
    els.outline.innerHTML = "";
    const tree = buildOutlineTree();
    if (els.outlineCount) els.outlineCount.textContent = String(tree.entries.length);
    if (!tree.entries.length) {
      els.outline.appendChild(element("p", { class: "pn-empty-outline" }, tr("添加有标题的章节后会显示大纲。", "Named headings and sections appear here.")));
      return;
    }
    tree.roots.forEach((node) => els.outline.appendChild(renderOutlineNode(node)));
    syncOutlineActiveState();
  }
  function selectedIndex() { return state ? state.blocks.findIndex((block) => block.id === selectedBlockId) : -1; }
  function selectedBlock() { const index = selectedIndex(); return index < 0 ? null : state.blocks[index]; }
  function applyCanvasSelection() {
    document.querySelectorAll(".pn-canvas-block").forEach((node) => node.classList.toggle("is-selected", node.dataset.blockId === selectedBlockId));
  }
  function selectBlock(blockId, options) {
    if (!blockId || !state.blocks.some((block) => block.id === blockId)) return;
    selectedBlockId = blockId;
    insertionIndex = null;
    applyCanvasSelection();
    setActiveOutlineForBlock(blockId);
    renderInspector();
    if (!options || options.openInspector !== false) setDetailOpen(true);
  }
  function focusBlock(blockId) {
    selectBlock(blockId, { openInspector: false });
    const target = document.getElementById("pn-block-" + blockId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("pn-focused");
    setTimeout(() => target.classList.remove("pn-focused"), 850);
  }
  function updateViewportOutlineActive() {
    if (!els.canvasPane || !state) return;
    // A direct edit is an explicit navigation decision and must win over the
    // passive viewport heuristic. Without this guard, scrollIntoView() can
    // briefly move the outline back to the preceding section.
    if (selectedBlockId) {
      setActiveOutlineForBlock(selectedBlockId);
      return;
    }
    const { entries } = buildOutlineTree();
    if (!entries.length) return;
    const paneRect = els.canvasPane.getBoundingClientRect();
    const marker = paneRect.top + Math.min(170, Math.max(64, paneRect.height * 0.28));
    let active = null;
    entries.forEach((entry) => {
      const node = document.getElementById("pn-block-" + entry.id);
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.top <= marker) active = entry;
      if (!active && rect.bottom >= marker) active = entry;
    });
    if (active && active.id !== activeOutlineBlockId) {
      activeOutlineBlockId = active.id;
      syncOutlineActiveState();
    }
  }
  function bindOutlineViewportTracking() {
    if (!els.canvasPane) return;
    els.canvasPane.addEventListener("scroll", () => {
      if (outlineViewportFrame) return;
      outlineViewportFrame = root.requestAnimationFrame(() => {
        outlineViewportFrame = 0;
        updateViewportOutlineActive();
      });
    }, { passive: true });
    if (els.outline) els.outline.addEventListener("scroll", closeOutlineMenu, { passive: true });
  }
  function changeOptions(options) {
    if (typeof options === "boolean") return { structure: options, outline: true, inspector: options, chrome: true };
    return Object.assign({ structure: false, outline: false, inspector: false, chrome: false }, options || {});
  }
  function changed(options) {
    const changes = changeOptions(options);
    state.metadata.updatedAt = new Date().toISOString();
    if (changes.structure) renderCanvas();
    if (changes.outline) renderOutline();
    if (changes.inspector) renderInspector();
    if (changes.chrome) renderDocumentChrome();
    scheduleSave();
  }
  function update(block, key, value, options) {
    block[key] = value;
    // Changing a remote URL is a new network request, so a previous explicit
    // approval can never accidentally carry over to it.
    if (block.type === "image" && key === "src") delete block.remoteApproved;
    const affectsOutline = block.type === "title" || block.type === "heading" || block.type === "semantic";
    changed(Object.assign({ outline: affectsOutline }, options || {}));
  }
  function canvasField(block, key, options) {
    const opts = options || {};
    return inputField("", block[key], (value) => update(block, key, value, opts.change), {
      multiline: opts.multiline !== false,
      rows: opts.rows || 1,
      placeholder: opts.placeholder || "",
      fieldClass: "pn-canvas-field " + (opts.fieldClass || ""),
      controlClass: "pn-canvas-input " + (opts.controlClass || ""),
      ariaLabel: opts.ariaLabel || optionText(block.type),
      autoGrow: opts.autoGrow !== false
    });
  }
  function isProofNoteDocument() {
    return Boolean(state && state.metadata && String(state.metadata.templateName || "").trim() === "Proof Note");
  }
  function semanticAppearance(block) {
    if (block && (block.appearance === "editorial" || block.appearance === "card")) return block.appearance;
    return isProofNoteDocument() ? "editorial" : "card";
  }
  function isEditorialPrimary(block) {
    if (!isProofNoteDocument()) return false;
    if (block.type === "heading") return block.level === 1;
    return block.type === "semantic" && semanticAppearance(block) === "editorial" && ["problem", "result", "theorem"].includes(block.kind);
  }
  function editorialSectionNumber(index) {
    let number = 0;
    state.blocks.slice(0, index + 1).forEach((block) => { if (isEditorialPrimary(block)) number += 1; });
    return String(number).padStart(2, "0");
  }
  function proofMetadataValues() {
    const metadata = state && state.metadata ? state.metadata : {};
    return {
      noteNumber: String(metadata.noteNumber || ""),
      author: String(metadata.author || ""),
      date: String(metadata.date || ""),
      status: String(metadata.status || ""),
      source: String(metadata.source || "")
    };
  }
  function renderProofMetadata() {
    const values = proofMetadataValues();
    const metadata = element("section", { class: "pn-proof-metadata", "aria-label": tr("文档信息", "Document details") });
    const grid = element("dl", { class: "pn-proof-metadata-grid" });
    const fields = [
      ["author", tr("作者", "Author")], ["date", tr("日期", "Date")], ["status", tr("状态", "Status")]
    ];
    fields.forEach(([key, label]) => {
      const item = element("div", { class: "pn-proof-metadata-item pn-proof-metadata-" + key });
      item.appendChild(element("dt", {}, label));
      const value = element("dd");
      value.appendChild(inputField("", values[key], (next) => {
        state.metadata[key] = next;
        changed({ chrome: true });
      }, {
        multiline: false,
        fieldClass: "pn-proof-metadata-field",
        controlClass: "pn-proof-metadata-input pn-proof-metadata-" + key + "-input",
        placeholder: "—",
        ariaLabel: label
      }));
      item.appendChild(value); grid.appendChild(item);
    });
    metadata.appendChild(grid);
    if (values.source.trim()) {
      const source = element("dl", { class: "pn-proof-source" });
      source.appendChild(element("dt", {}, tr("来源", "Source")));
      const sourceValue = element("dd");
      sourceValue.appendChild(inputField("", values.source, (next) => { state.metadata.source = next; changed({ chrome: true }); }, {
        multiline: true, rows: 1, autoGrow: true, fieldClass: "pn-proof-source-field", controlClass: "pn-proof-source-input", ariaLabel: tr("来源", "Source")
      }));
      source.appendChild(sourceValue); metadata.appendChild(source);
    }
    return metadata;
  }
  function renderCanvas() {
    els.canvas.innerHTML = "";
    els.canvas.classList.toggle("pn-proofnote-document", isProofNoteDocument());
    const metadataIndex = isProofNoteDocument()
      ? Math.max(0, state.blocks.findIndex((block) => block.type === "subtitle") >= 0 ? state.blocks.findIndex((block) => block.type === "subtitle") : state.blocks.findIndex((block) => block.type === "title"))
      : -1;
    state.blocks.forEach((block, index) => {
      els.canvas.appendChild(renderCanvasBlock(block, index));
      if (index === metadataIndex) els.canvas.appendChild(renderProofMetadata());
      els.canvas.appendChild(renderInsertAffordance(index + 1, index === state.blocks.length - 1));
    });
    if (!state.blocks.length) els.canvas.appendChild(renderInsertAffordance(0, true));
    applyCanvasSelection();
    renderDocumentChrome();
    root.requestAnimationFrame(updateViewportOutlineActive);
  }
  function renderCanvasBlock(block, index) {
    const canvasBlock = element("section", { class: "pn-canvas-block pn-canvas-" + block.type, id: "pn-block-" + block.id });
    canvasBlock.dataset.blockId = block.id;
    const grip = button("⋮⋮", "pn-canvas-grip", () => selectBlock(block.id), tr("选择内容块", "Select block"));
    grip.setAttribute("aria-label", tr("选择 " + blockEditorLabel(block), "Select " + blockEditorLabel(block)));
    canvasBlock.appendChild(grip);
    const overflow = button("⋯", "pn-canvas-overflow", () => selectBlock(block.id), tr("打开内容块设置", "Open block settings"));
    overflow.setAttribute("aria-label", tr("打开内容块设置", "Open block settings"));
    canvasBlock.appendChild(overflow);
    const content = element("div", { class: "pn-canvas-content" });
    buildCanvasFields(content, block, index);
    canvasBlock.appendChild(content);
    canvasBlock.addEventListener("pointerdown", (event) => {
      selectBlock(block.id, { openInspector: !event.target.closest("input, textarea, select") });
    });
    canvasBlock.addEventListener("click", (event) => {
      if (!event.target.closest("input, textarea, select, button")) selectBlock(block.id);
    });
    canvasBlock.addEventListener("focusin", () => selectBlock(block.id, { openInspector: false }));
    return canvasBlock;
  }
  function buildCanvasFields(body, block, index) {
    const label = (zh, en) => tr(zh, en);
    if (block.type === "title") {
      body.className = "pn-document-title";
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-title", controlClass: "pn-canvas-title-input", placeholder: label("未命名文档", "Untitled document"), change: { outline: true } }));
      return;
    }
    if (block.type === "subtitle") {
      body.className = "pn-document-subtitle";
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-subtitle", controlClass: "pn-canvas-subtitle-input", placeholder: label("添加副标题", "Add a subtitle") }));
      return;
    }
    if (block.type === "heading" && isEditorialPrimary(block)) {
      buildEditorialPrimary(body, block, index, "content");
      return;
    }
    if (block.type === "heading") {
      body.className = "pn-heading pn-heading-" + block.level;
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-heading pn-canvas-heading-" + block.level, controlClass: "pn-canvas-heading-input", placeholder: label("未命名章节", "Untitled heading"), change: { outline: true } }));
      return;
    }
    if (block.type === "paragraph") {
      body.className = "pn-canvas-paragraph";
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-paragraph-field", controlClass: "pn-canvas-paragraph-input", placeholder: label("开始输入…", "Start writing…") }));
      return;
    }
    if (block.type === "equation") {
      body.className = "pn-equation pn-canvas-equation";
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-equation-field", controlClass: "pn-canvas-equation-input", placeholder: "\\\\[ … \\]" }));
      return;
    }
    if (block.type === "semantic" && semanticAppearance(block) === "editorial") {
      if (isEditorialPrimary(block)) buildEditorialPrimary(body, block, index, "title");
      else buildEditorialSemantic(body, block);
      return;
    }
    if (block.type === "semantic" || block.type === "callout") {
      const isSemantic = block.type === "semantic";
      body.className = (isSemantic ? "pn-semantic pn-semantic-" : "pn-callout pn-callout-") + block.kind;
      const defaultLabel = isSemantic && OUTLINE_SEMANTIC_LABEL[block.kind] ? (english() ? OUTLINE_SEMANTIC_LABEL[block.kind].en : OUTLINE_SEMANTIC_LABEL[block.kind].zh) : optionText(block.type);
      body.appendChild(element("div", { class: "pn-component-label" }, block.label || defaultLabel));
      body.appendChild(canvasField(block, "title", { multiline: false, fieldClass: "pn-canvas-component-title", controlClass: "pn-canvas-component-title-input", placeholder: label("标题", "Title"), change: { outline: isSemantic } }));
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-component-body", controlClass: "pn-canvas-component-body-input", placeholder: label("开始输入…", "Start writing…") }));
      if (isSemantic && ["result", "verification"].includes(block.kind)) body.appendChild(canvasField(block, "summary", { fieldClass: "pn-canvas-component-summary", controlClass: "pn-canvas-component-summary-input", placeholder: label("添加备注…", "Add note…") }));
      return;
    }
    if (block.type === "code") {
      body.className = "pn-code pn-canvas-code";
      body.appendChild(element("span", { class: "pn-code-language" }, block.language || "CODE"));
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-code-field", controlClass: "pn-canvas-code-input", rows: 6, placeholder: label("粘贴或输入代码", "Paste or write code") }));
      return;
    }
    if (block.type === "quote") {
      body.className = "pn-quote";
      const quote = element("blockquote");
      quote.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-quote-field", controlClass: "pn-canvas-quote-input", rows: 2, placeholder: label("引用文字", "Quote") }));
      body.appendChild(quote);
      if (block.citation) body.appendChild(element("figcaption", {}, "— " + block.citation));
      return;
    }
    if (block.type === "divider") { body.appendChild(element("hr", { class: "pn-divider" })); return; }
    if (block.type === "page-break") { body.appendChild(element("div", { class: "pn-page-break pn-canvas-page-break" }, label("分页符", "Page break"))); return; }
    if (block.type === "image") { body.innerHTML = renderImage(block); return; }
    if (block.type === "table") { buildCanvasTable(body, block); return; }
    if (block.type === "list") { buildCanvasList(body, block); return; }
    if (block.type === "key-value" || block.type === "stats") { buildCanvasData(body, block); return; }
    body.appendChild(element("p", { class: "pn-block-note" }, label("在检查器中选择内容块类型。", "Choose a block type in Inspector.")));
  }
  function buildEditorialPrimary(body, block, index, titleKey) {
    const label = (zh, en) => tr(zh, en);
    body.className = "pn-editorial-section";
    const head = element("div", { class: "pn-editorial-section-head" });
    head.appendChild(element("span", { class: "pn-editorial-section-number", "aria-hidden": "true" }, editorialSectionNumber(index)));
    head.appendChild(canvasField(block, titleKey, {
      multiline: false,
      fieldClass: "pn-editorial-section-title",
      controlClass: "pn-editorial-section-title-input",
      placeholder: label("未命名章节", "Untitled section"),
      change: { outline: true }
    }));
    body.appendChild(head);
    if (block.type === "semantic") {
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-editorial-section-body", controlClass: "pn-editorial-section-body-input", placeholder: label("开始输入…", "Start writing…") }));
      if (block.summary) body.appendChild(canvasField(block, "summary", { fieldClass: "pn-editorial-section-summary", controlClass: "pn-editorial-section-summary-input", placeholder: label("添加备注…", "Add note…") }));
    }
  }
  function buildEditorialSemantic(body, block) {
    const label = (zh, en) => tr(zh, en);
    const semanticLabel = semanticExportLabel(block);
    body.className = "pn-editorial-detail pn-editorial-" + block.kind;
    body.appendChild(element("div", { class: "pn-component-label" }, semanticLabel));
    body.appendChild(canvasField(block, "title", { multiline: false, fieldClass: "pn-editorial-detail-title", controlClass: "pn-editorial-detail-title-input", placeholder: label("标题", "Title"), change: { outline: true } }));
    body.appendChild(canvasField(block, "content", { fieldClass: "pn-editorial-detail-body", controlClass: "pn-editorial-detail-body-input", placeholder: label("开始输入…", "Start writing…") }));
    if (block.summary) body.appendChild(canvasField(block, "summary", { fieldClass: "pn-editorial-detail-summary", controlClass: "pn-editorial-detail-summary-input", placeholder: label("添加备注…", "Add note…") }));
  }
  function buildCanvasList(body, block) {
    const list = element(block.ordered ? "ol" : "ul", { class: "pn-list pn-canvas-list" });
    block.items.forEach((item, itemIndex) => {
      const row = element("li");
      row.appendChild(inputField("", item, (value) => { block.items[itemIndex] = value; changed(); }, { multiline: true, rows: 1, fieldClass: "pn-canvas-list-field", controlClass: "pn-canvas-list-input", autoGrow: true, ariaLabel: tr("列表项目", "List item") }));
      list.appendChild(row);
    });
    body.appendChild(list);
  }
  function buildCanvasData(body, block) {
    if (block.type === "key-value") {
      const list = element("dl", { class: "pn-key-value pn-canvas-key-value" });
      block.items.forEach((item, itemIndex) => {
        const row = element("div");
        const term = element("dt"); const description = element("dd");
        term.appendChild(inputField("", item.label, (value) => { item.label = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-key", controlClass: "pn-canvas-key-input", ariaLabel: tr("名称", "Label") }));
        description.appendChild(inputField("", item.value, (value) => { item.value = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-value", controlClass: "pn-canvas-value-input", ariaLabel: tr("内容", "Value") }));
        row.append(term, description); list.appendChild(row);
      });
      body.appendChild(list); return;
    }
    const cards = element("div", { class: "pn-stats pn-canvas-stats" });
    block.items.forEach((item, itemIndex) => {
      const card = element("div", { class: "pn-stat" });
      card.appendChild(inputField("", item.kicker, (value) => { item.kicker = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-stat-kicker", controlClass: "pn-canvas-stat-kicker-input", ariaLabel: tr("标签", "Kicker") }));
      card.appendChild(inputField("", item.value, (value) => { item.value = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-stat-value", controlClass: "pn-canvas-stat-value-input", ariaLabel: tr("数值", "Value") }));
      card.appendChild(inputField("", item.body, (value) => { item.body = value; changed(); }, { multiline: true, rows: 1, fieldClass: "pn-canvas-stat-body", controlClass: "pn-canvas-stat-body-input", autoGrow: true, ariaLabel: tr("说明", "Description") }));
      cards.appendChild(card);
    });
    body.appendChild(cards);
  }
  function buildCanvasTable(body, block) {
    const wrap = element("div", { class: "pn-table-wrap pn-canvas-table-wrap" });
    const table = element("table", { class: "pn-table pn-canvas-table" });
    const head = element("thead"); const headRow = element("tr");
    block.columns.forEach((column, columnIndex) => {
      const cell = element("th");
      cell.appendChild(inputField("", column, (value) => { block.columns[columnIndex] = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-table-field", controlClass: "pn-canvas-table-input", ariaLabel: tr("列名", "Column") }));
      headRow.appendChild(cell);
    });
    head.appendChild(headRow); table.appendChild(head);
    const tableBody = element("tbody");
    block.rows.forEach((row, rowIndex) => {
      const rowEl = element("tr");
      block.columns.forEach((_, columnIndex) => {
        const cell = element("td");
        cell.appendChild(inputField("", row[columnIndex], (value) => { row[columnIndex] = value; changed(); }, { multiline: true, rows: 1, fieldClass: "pn-canvas-table-field", controlClass: "pn-canvas-table-input", autoGrow: true, ariaLabel: tr("单元格", "Cell") }));
        rowEl.appendChild(cell);
      });
      tableBody.appendChild(rowEl);
    });
    table.appendChild(tableBody); wrap.appendChild(table); body.appendChild(wrap);
  }
  function renderInsertAffordance(index, isLast) {
    const point = element("div", { class: "pn-insert-point" + (isLast ? " pn-insert-last" : "") });
    if (insertionIndex === index) {
      const menu = element("div", { class: "pn-insert-menu", role: "group", "aria-label": tr("选择内容块", "Choose block") });
      TYPE_OPTIONS.forEach(([type]) => menu.appendChild(button(optionText(type), "pn-insert-choice", () => insertBlock(type, index))));
      point.appendChild(menu);
      point.appendChild(button(tr("取消", "Cancel"), "pn-insert-cancel", () => { insertionIndex = null; renderCanvas(); }));
      return point;
    }
    point.appendChild(button(isLast ? tr("+ 添加内容块", "+ Add block") : "+", "pn-insert-trigger", () => { insertionIndex = index; renderCanvas(); }, isLast ? tr("添加内容块", "Add block") : tr("在此处添加内容块", "Insert block here")));
    return point;
  }
  function insertBlock(type, index) {
    clearStructuralUndo();
    const block = Model.createBlock(type);
    state.blocks.splice(index, 0, block);
    selectedBlockId = block.id;
    insertionIndex = null;
    changed({ structure: true, outline: true, inspector: true, chrome: true });
    setDetailOpen(true);
    root.requestAnimationFrame(() => focusBlock(block.id));
  }
  function moveBlock(index, delta) {
    clearStructuralUndo();
    const destination = index + delta;
    if (destination < 0 || destination >= state.blocks.length) return;
    const moved = state.blocks.splice(index, 1)[0];
    state.blocks.splice(destination, 0, moved);
    selectedBlockId = moved.id;
    changed({ structure: true, outline: true, inspector: true });
    focusBlock(moved.id);
  }
  function duplicateBlock(index) {
    clearStructuralUndo();
    const copy = Model.normalizeBlock(Object.assign({}, state.blocks[index], { id: "" }));
    state.blocks.splice(index + 1, 0, copy);
    selectedBlockId = copy.id;
    changed({ structure: true, outline: true, inspector: true });
    focusBlock(copy.id);
  }
  function removeBlock(index) {
    clearStructuralUndo();
    if (state.blocks.length === 1) { setStatus(tr("文档至少保留一个内容块。", "A document needs at least one block."), "warning"); return; }
    state.blocks.splice(index, 1);
    const next = state.blocks[Math.min(index, state.blocks.length - 1)];
    selectedBlockId = next ? next.id : "";
    changed({ structure: true, outline: true, inspector: true });
  }
  function renderInspector() {
    if (!els.inspector) return;
    els.inspector.innerHTML = "";
    const index = selectedIndex();
    const block = selectedBlock();
    if (!block || index < 0) {
      els.inspector.appendChild(element("p", { class: "pn-inspector-empty" }, tr("选择纸面上的内容块以查看其设置。", "Select a block on the page to see its settings.")));
      return;
    }
    // The Inspector is deliberately a compact tool surface, not a second
    // document. The canvas already shows the block's reader-facing title.
    const context = element("div", { class: "pn-inspector-context" });
    context.appendChild(element("span", { class: "pn-inspector-context-label" }, optionText(block.type)));
    const overflow = element("details", { class: "pn-inspector-overflow" });
    const overflowSummary = element("summary", { class: "pn-inspector-overflow-trigger", "aria-label": tr("更多内容块操作", "More block actions") }, "⋯");
    const overflowMenu = element("div", { class: "pn-inspector-overflow-menu" });
    overflowMenu.appendChild(button(tr("上移", "Move up"), "pn-inspector-overflow-item", () => moveBlock(index, -1)));
    overflowMenu.appendChild(button(tr("下移", "Move down"), "pn-inspector-overflow-item", () => moveBlock(index, 1)));
    overflow.append(overflowSummary, overflowMenu);
    context.appendChild(overflow);
    els.inspector.appendChild(context);
    const structure = element("section", { class: "pn-inspector-group", "aria-label": tr("结构", "Structure") });
    structure.appendChild(element("div", { class: "pn-inspector-group-title" }, tr("结构", "Structure")));
    els.inspector.appendChild(structure);
    const type = selectField(tr("内容块类型", "Block type"), block.type, TYPE_OPTIONS.map(([key]) => [key, optionText(key)]), (value) => {
      const keep = { id: block.id, content: block.content, title: block.title, summary: block.summary, label: block.label };
      state.blocks[index] = Model.createBlock(value, keep);
      selectedBlockId = block.id;
      changed({ structure: true, outline: true, inspector: true });
    });
    type.classList.add("pn-inspector-field"); structure.appendChild(type);
    const label = (zh, en) => tr(zh, en);
    if (block.type === "heading") {
      structure.appendChild(selectField(label("层级", "Level"), String(block.level), [["1", "H1"], ["2", "H2"], ["3", "H3"]], (value) => { block.level = Number(value); block.preset = "heading-" + value; changed({ structure: true, outline: true, inspector: true }); }));
    }
    if (block.type === "semantic") {
      structure.appendChild(selectField(label("语义类型", "Semantic type"), block.kind, [["problem", label("问题", "Problem")], ["theorem", "Theorem"], ["proof", "Proof"], ["result", label("结果", "Result")], ["verification", label("验证", "Verification")]], (value) => { block.kind = value; block.preset = "semantic-" + value; changed({ structure: true, outline: true, inspector: true }); }));
      const appearance = element("section", { class: "pn-inspector-group", "aria-label": label("外观", "Appearance") });
      appearance.appendChild(element("div", { class: "pn-inspector-group-title" }, label("外观", "Appearance")));
      appearance.appendChild(selectField(label("呈现方式", "Presentation"), semanticAppearance(block), [["editorial", label("出版式", "Editorial")], ["card", label("卡片", "Card")]], (value) => { block.appearance = value; changed({ structure: true, inspector: true }); }));
      const advanced = element("details", { class: "pn-inspector-advanced" });
      advanced.open = Boolean(block.label);
      advanced.appendChild(element("summary", {}, label("高级选项", "Advanced")));
      advanced.appendChild(inputField(label("标签", "Label"), block.label, (value) => update(block, "label", value, { structure: true, outline: true }), { placeholder: "—" }));
      appearance.appendChild(advanced);
      els.inspector.appendChild(appearance);
    }
    if (block.type === "callout") structure.appendChild(selectField(label("样式", "Style"), block.kind, [["note", label("说明", "Note")], ["tip", label("提示", "Tip")], ["warning", label("注意", "Warning")], ["info", label("信息", "Info")]], (value) => { block.kind = value; block.preset = "callout-" + value; changed({ structure: true, inspector: true }); }));
    if (block.type === "code") structure.appendChild(inputField(label("语言", "Language"), block.language, (value) => update(block, "language", value, { structure: true }), { placeholder: "—" }));
    if (block.type === "quote") structure.appendChild(inputField(label("出处", "Citation"), block.citation, (value) => update(block, "citation", value, { structure: true }), { placeholder: "—" }));
    if (block.type === "image") buildImageInspector(structure, block);
    if (block.type === "list") structure.appendChild(selectField(label("列表类型", "List type"), block.ordered ? "ordered" : "unordered", [["unordered", label("项目符号", "Bullets")], ["ordered", label("编号", "Numbered")]], (value) => { block.ordered = value === "ordered"; changed({ structure: true, inspector: true }); }));
    const page = element("section", { class: "pn-inspector-group pn-inspector-page", "aria-label": label("页面", "Page") });
    page.appendChild(element("div", { class: "pn-inspector-group-title" }, label("页面", "Page")));
    const flow = element("div", { class: "pn-inspector-property" });
    flow.append(element("span", { class: "pn-inspector-property-label" }, label("流动", "Flow")), element("span", { class: "pn-inspector-property-value" }, block.type === "page-break" ? label("新页开始", "New page") : label("正常", "Normal")));
    page.appendChild(flow);
    els.inspector.appendChild(page);
    const actions = element("section", { class: "pn-inspector-actions", "aria-label": label("内容块操作", "Block actions") });
    actions.appendChild(button(label("复制", "Duplicate"), "pn-inspector-action", () => duplicateBlock(index)));
    actions.appendChild(button(label("删除内容块", "Delete block"), "pn-inspector-action pn-danger", () => removeBlock(index)));
    els.inspector.appendChild(actions);
  }
  function buildImageInspector(panel, block) {
    const label = (zh, en) => tr(zh, en);
    panel.appendChild(inputField(label("图片 URL 或 data URL", "Image URL or data URL"), block.src, (value) => update(block, "src", value, { structure: true }), { placeholder: "https://…" }));
    panel.appendChild(inputField(label("替代文字", "Alt text"), block.alt, (value) => update(block, "alt", value, { structure: true })));
    panel.appendChild(inputField(label("图片说明", "Caption"), block.caption, (value) => update(block, "caption", value, { structure: true })));
    if (/^https:\/\//i.test(String(block.src || "").trim()) && block.remoteApproved !== true) {
      panel.appendChild(element("p", { class: "pn-inspector-note" }, label("远程图片不会自动加载。确认后才会请求该地址。", "Remote images do not load automatically. Confirm before requesting this address.")));
      panel.appendChild(button(label("加载远程图片", "Load remote image"), "pn-add-inline", () => {
        block.remoteApproved = true;
        changed({ structure: true, inspector: true });
      }));
    }
    const file = element("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", hidden: "" });
    const choose = button(label("选择本地图片", "Choose local image"), "pn-add-inline", () => file.click());
    file.addEventListener("change", () => {
      const image = file.files && file.files[0];
      if (!image) return;
      if (image.size > MAX_LOCAL_IMAGE_BYTES) {
        setStatus(tr("图片超过 10MB 上限。", "Image exceeds the 10 MB limit."), "error");
        file.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { block.src = String(reader.result || ""); delete block.remoteApproved; if (!block.alt) block.alt = image.name.replace(/\.[^.]+$/, ""); changed({ structure: true, inspector: true }); };
      reader.readAsDataURL(image);
    });
    panel.append(choose, file);
  }

  function safeImageSource(block) {
    const source = String(block && block.src || "").trim();
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(source)) return source;
    if (/^https:\/\//i.test(source) && block && block.remoteApproved === true) return source;
    return "";
  }
  function paragraphs(value) {
    return String(value || "").split(/\n\s*\n/).filter((part) => part.trim()).map((part) => "<p>" + inline(part.replace(/\n/g, " ")) + "</p>").join("");
  }
  function renderBlock(block, index) {
    switch (block.type) {
      case "title": return "<header class=\"pn-document-title\"><h1>" + (inline(block.content) || tr("未命名文档", "Untitled document")) + "</h1></header>";
      case "subtitle": return block.content.trim() ? "<p class=\"pn-document-subtitle\">" + inline(block.content) + "</p>" : "";
      case "heading": return isEditorialPrimary(block) ? renderEditorialPrimary(block, index, "content") : "<section class=\"pn-heading pn-heading-" + block.level + "\"><h" + (block.level + 1) + ">" + inline(block.content || tr("未命名章节", "Untitled heading")) + "</h" + (block.level + 1) + "></section>";
      case "paragraph": return paragraphs(block.content);
      case "equation": return block.content.trim() ? "<div class=\"pn-equation\">" + math(block.content) + "</div>" : "";
      case "code": return block.content ? "<pre class=\"pn-code\"><span class=\"pn-code-language\">" + escapeHtml(block.language || "CODE") + "</span><code>" + escapeHtml(block.content) + "</code></pre>" : "";
      case "table": return renderTable(block);
      case "image": return renderImage(block);
      case "quote": return block.content.trim() ? "<figure class=\"pn-quote\"><blockquote>“" + inline(block.content) + "”</blockquote>" + (block.citation.trim() ? "<figcaption>— " + inline(block.citation) + "</figcaption>" : "") + "</figure>" : "";
      case "divider": return "<hr class=\"pn-divider\">";
      case "page-break": return "<div class=\"pn-page-break\" aria-label=\"Page break\"></div>";
      case "callout": return "<aside class=\"pn-callout pn-callout-" + escapeHtml(block.kind) + "\">" + (block.title.trim() ? "<div class=\"pn-component-label\">" + inline(block.title) + "</div>" : "") + paragraphs(block.content) + "</aside>";
      case "semantic": return renderSemantic(block, index);
      case "list": return renderList(block);
      case "key-value": return renderKeyValue(block);
      case "stats": return renderStats(block);
      default: return "";
    }
  }
  function renderTable(block) {
    const columns = block.columns || [];
    const rows = block.rows || [];
    return "<div class=\"pn-table-wrap\"><table class=\"pn-table\"><thead><tr>" + columns.map((column) => "<th>" + inline(column) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((row) => "<tr>" + columns.map((_, index) => "<td>" + inline(row[index] || "") + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
  }
  function renderImage(block) {
    const source = safeImageSource(block);
    if (!source) {
      const remote = /^https:\/\//i.test(String(block.src || "").trim());
      const message = remote
        ? tr("远程图片等待确认加载。", "Remote image awaits approval to load.")
        : tr("添加安全的 https 图片 URL，或选择本地图片。", "Add a safe https image URL or choose a local image.");
      return "<div class=\"pn-image-empty\">" + escapeHtml(message) + "</div>";
    }
    return "<figure class=\"pn-image\"><img referrerpolicy=\"no-referrer\" src=\"" + escapeHtml(source) + "\" alt=\"" + escapeHtml(block.alt) + "\">" + (block.caption.trim() ? "<figcaption>" + inline(block.caption) + "</figcaption>" : "") + "</figure>";
  }
  function semanticExportLabel(block) {
    if (String(block.label || "").trim()) return block.label;
    const semantic = OUTLINE_SEMANTIC_LABEL[block.kind];
    return semantic ? semantic.en : (block.kind || "Block");
  }
  function renderEditorialPrimary(block, index, titleKey) {
    const title = String(block[titleKey] || "") || tr("未命名章节", "Untitled section");
    const body = block.type === "semantic"
      ? paragraphs(block.content) + (String(block.summary || "").trim() ? "<p class=\"pn-editorial-section-summary\">" + inline(block.summary) + "</p>" : "")
      : "";
    return "<section class=\"pn-editorial-section pn-editorial-section-" + escapeHtml(block.kind || "heading") + "\"><div class=\"pn-editorial-section-head\"><span class=\"pn-editorial-section-number\">" + editorialSectionNumber(index) + "</span><h2>" + inline(title) + "</h2></div>" + body + "</section>";
  }
  function renderSemantic(block, index) {
    if (semanticAppearance(block) === "editorial") {
      if (isEditorialPrimary(block)) return renderEditorialPrimary(block, index, "title");
      const label = semanticExportLabel(block);
      return "<section class=\"pn-editorial-detail pn-editorial-" + escapeHtml(block.kind) + "\"><div class=\"pn-component-label\">" + escapeHtml(label) + "</div>" + (block.title.trim() ? "<h3>" + inline(block.title) + "</h3>" : "") + paragraphs(block.content) + (block.summary.trim() ? "<p class=\"pn-editorial-detail-summary\">" + inline(block.summary) + "</p>" : "") + "</section>";
    }
    const label = semanticExportLabel(block);
    return "<section class=\"pn-semantic pn-semantic-" + escapeHtml(block.kind) + "\"><div class=\"pn-component-label\">" + escapeHtml(label) + "</div>" + (block.title.trim() ? "<h3>" + inline(block.title) + "</h3>" : "") + paragraphs(block.content) + (block.summary.trim() ? "<p class=\"pn-semantic-summary\">" + inline(block.summary) + "</p>" : "") + "</section>";
  }
  function renderList(block) {
    const tag = block.ordered ? "ol" : "ul";
    const content = (block.items || []).filter((item) => item.trim()).map((item) => "<li>" + inline(item) + "</li>").join("");
    return content ? "<" + tag + " class=\"pn-list\">" + content + "</" + tag + ">" : "";
  }
  function renderKeyValue(block) {
    const rows = (block.items || []).filter((item) => item.label.trim() || item.value.trim()).map((item) => "<div><dt>" + inline(item.label) + "</dt><dd>" + inline(item.value) + "</dd></div>").join("");
    return rows ? "<dl class=\"pn-key-value\">" + rows + "</dl>" : "";
  }
  function renderStats(block) {
    const cards = (block.items || []).filter((item) => item.kicker.trim() || item.value.trim() || item.body.trim()).map((item) => "<div class=\"pn-stat\"><span>" + inline(item.kicker) + "</span><strong>" + inline(item.value) + "</strong><p>" + inline(item.body) + "</p></div>").join("");
    return cards ? "<div class=\"pn-stats\">" + cards + "</div>" : "";
  }
  function proofMetadataHtml() {
    const values = proofMetadataValues();
    const item = (title, value, extraClass) => "<div class=\"pn-proof-metadata-item " + (extraClass || "") + "\"><dt>" + escapeHtml(title) + "</dt><dd>" + (String(value || "").trim() ? inline(value) : "&mdash;") + "</dd></div>";
    const source = values.source.trim() ? "<dl class=\"pn-proof-source\"><dt>" + escapeHtml(tr("来源", "Source")) + "</dt><dd>" + inline(values.source) + "</dd></dl>" : "";
    return "<section class=\"pn-proof-metadata\"><dl class=\"pn-proof-metadata-grid\">" + item(tr("作者", "Author"), values.author) + item(tr("日期", "Date"), values.date) + item(tr("状态", "Status"), values.status, "pn-proof-metadata-status") + "</dl>" + source + "</section>";
  }
  function renderDocumentChrome() {
    if (!state) return;
    const templateLabel = String(state.metadata.templateName || "").trim();
    if (isProofNoteDocument()) {
      const left = element("span", { class: "pn-running-brand" }, "Proofnote");
      const right = element("span", { class: "pn-running-type" }, state.metadata.documentType || "Solution Note");
      els.pageHeader.replaceChildren(left, right);
      els.pageHeader.classList.add("pn-proofnote-running");
      els.pageHeader.hidden = false;
      els.footer.textContent = tr("笔记 ", "Note ") + (state.metadata.noteNumber || "—");
      els.footerStatus.textContent = state.metadata.status || "";
      return;
    }
    els.pageHeader.textContent = templateLabel ? templateLabel.toUpperCase() : "";
    els.pageHeader.classList.remove("pn-proofnote-running");
    els.pageHeader.hidden = !templateLabel;
    els.footer.textContent = state.metadata.name || tr("未命名文档", "UNTITLED DOCUMENT");
    els.footerStatus.textContent = "";
  }
  function renderAll() {
    els.name.value = state.metadata.name;
    selectedBlockId = "";
    activeOutlineBlockId = "";
    insertionIndex = null;
    // A new/imported document should open quietly around the paper. The
    // inspector is contextual: selecting a block opens it when it is useful.
    if (els.detail.classList.contains("is-open")) setDetailOpen(false);
    renderCanvas(); renderOutline(); renderInspector(); renderDocumentChrome(); renderTemplateLibrary();
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/json" });
    const url = URL.createObjectURL(blob);
    const link = element("a", { href: url, download: filename });
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }
  function slug() { return (state.metadata.name || "proofnote-document").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "proofnote-document"; }
  function exportDocument() { download(slug() + ".proofnote.json", JSON.stringify(Model.normalizeDocument(state), null, 2)); setStatus(tr("已导出 Document JSON", "Document JSON exported"), "saved"); }
  function exportTemplate() {
    const selected = templateById(currentTemplateId());
    const template = selected || Model.makeTemplate(state, { name: state.metadata.name || tr("我的模板", "My template") });
    download((template.template.name || "proofnote-template").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".template.json", JSON.stringify(template, null, 2));
  }
  function exportLegacy() {
    const exported = Model.documentToSolutionNote(state);
    const validation = root.__snTest && root.__snTest.validateRaw ? root.__snTest.validateRaw(exported.note) : { errors: [], warnings: [] };
    if (validation.errors && validation.errors.length) {
      setStatus(tr("兼容格式导出失败；请导出 Document JSON 备份。", "Compatibility export failed — export Document JSON as a backup."), "error");
      return;
    }
    const notices = exported.warnings.concat(validation.warnings || []);
    download(slug() + ".solution-note.json", JSON.stringify(exported.note, null, 2));
    setStatus(notices.length ? tr("已导出兼容格式；请查看兼容性提示。", "Compatibility export complete; review compatibility notices.") : tr("已导出兼容 Solution Note", "Solution Note exported"), notices.length ? "warning" : "saved");
  }
  const AI_DOCUMENT_INSTRUCTIONS = `Return one valid JSON object in Proofnote Document Format 1.0. Do not return Markdown fences or commentary.

Required envelope:
{
  "format": "proofnote-document",
  "version": "1.0",
  "metadata": { "name": "A concise document name" },
  "blocks": []
}

Use ordered blocks. Supported block types: title, subtitle, heading (with level 1, 2, or 3), paragraph, equation, code, table, image, quote, divider, page-break, callout, semantic, list, key-value, and stats.

Use semantic.kind only as problem, theorem, proof, result, or verification. Use callout.kind only as note, tip, warning, or info. A semantic block may optionally use appearance "editorial" or "card"; otherwise the selected template decides. Do not add CSS, fonts, font sizes, colours, margins, coordinates, or HTML. Proofnote owns the visual presets.

For LaTeX inside prose, return valid JSON: escape every literal backslash. For example, JSON source must contain "\\\\(x \\\\le \\\\sqrt{2}\\\\)" for inline math. Preserve code as code, using only normal JSON escaping.`;
  async function copyAiInstructions() {
    try {
      await root.navigator.clipboard.writeText(AI_DOCUMENT_INSTRUCTIONS);
      setStatus(tr("AI 格式说明已复制", "AI format instructions copied"), "saved");
    } catch (_) {
      root.prompt(tr("请复制以下 AI 格式说明：", "Copy these AI format instructions:"), AI_DOCUMENT_INSTRUCTIONS);
    }
  }
  function decodeBase64(value) {
    const binary = root.atob(value); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); return new TextDecoder("utf-8").decode(bytes);
  }
  const EXPORT_CSS = `:root{--ink:#201f1d;--accent:#b68235;--paper:#fff;--soft:#fff3e4;--line:rgba(32,31,29,.17);--heading:"Cormorant Garamond",Georgia,serif;--body:"Lora",Georgia,serif}*{box-sizing:border-box}body{margin:0;background:#f3f2f2;color:var(--ink);font:17px/1.68 var(--body)}.pn-document{max-width:760px;margin:0 auto;padding:62px 30px 96px}.pn-document-title{margin:0 0 12px;padding-bottom:16px;border-bottom:1px solid var(--line)}.pn-document-title h1{margin:0;font:400 44px/1.1 var(--heading);letter-spacing:-.025em}.pn-document-subtitle{margin:0 0 28px;font:italic 21px/1.42 var(--heading);color:rgba(32,31,29,.7)}.pn-heading{margin:42px 0 16px;border-bottom:1px solid var(--line);padding-bottom:8px}.pn-heading h2,.pn-heading h3,.pn-heading h4{margin:0;font-family:var(--heading);font-weight:400}.pn-heading h2{font-size:30px}.pn-heading h3{font-size:24px}.pn-heading h4{font-size:20px}.pn-document p{margin:0 0 15px}.pn-equation{overflow-x:auto;margin:18px 0}.pn-code{position:relative;margin:18px 0;padding:27px 16px 16px;border:1px solid var(--line);background:#f7f6f4;overflow:auto;white-space:pre-wrap;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.pn-code-language{position:absolute;top:7px;left:14px;font:600 10px var(--heading);letter-spacing:.14em;color:rgba(32,31,29,.55)}.pn-table-wrap{overflow:auto;margin:18px 0}.pn-table{border-collapse:collapse;width:100%;font-size:14px}.pn-table th,.pn-table td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}.pn-table th{background:#f3f2f2;font-family:var(--heading);font-weight:600}.pn-image{margin:22px 0}.pn-image img{display:block;max-width:100%;height:auto}.pn-image figcaption,.pn-quote figcaption{margin-top:7px;font-size:13px;color:rgba(32,31,29,.62)}.pn-image-empty{margin:18px 0;padding:14px;border:1px dashed var(--line);font-size:13px;color:rgba(32,31,29,.6)}.pn-quote{margin:22px 0;padding:2px 0 2px 22px;border-left:3px solid var(--accent)}.pn-quote blockquote{margin:0;font:italic 22px/1.42 var(--heading)}.pn-divider{border:0;border-top:1px solid var(--line);margin:34px 0}.pn-page-break{break-before:page;page-break-before:always;height:0}.pn-callout,.pn-semantic{margin:20px 0;padding:18px 20px;border:1px solid #facb8d;background:var(--soft);break-inside:avoid}.pn-callout-warning{background:#fff7e8;border-color:#edc778}.pn-callout-info{background:#f5f7fb;border-color:#b7c6e3}.pn-component-label{margin-bottom:6px;font:600 10px var(--heading);letter-spacing:.15em;text-transform:uppercase;color:#5a3b0a}.pn-semantic h3{margin:0 0 8px;font:600 22px/1.15 var(--heading)}.pn-semantic-summary{margin-bottom:0!important;font-style:italic;color:rgba(32,31,29,.72)}.pn-list{margin:16px 0;padding-left:24px}.pn-list li{margin-bottom:5px}.pn-key-value{margin:18px 0}.pn-key-value>div{display:grid;grid-template-columns:150px 1fr;gap:12px;margin-bottom:7px}.pn-key-value dt{font:600 10px var(--heading);letter-spacing:.12em;text-transform:uppercase;color:rgba(32,31,29,.55)}.pn-key-value dd{margin:0}.pn-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0}.pn-stat{padding:13px;border:1px solid var(--line);background:#f7f6f4}.pn-stat span{display:block;font:600 10px var(--heading);letter-spacing:.12em;text-transform:uppercase;color:rgba(32,31,29,.55)}.pn-stat strong{display:block;margin:5px 0;font:400 28px var(--heading)}.pn-stat p{margin:0!important;font-size:13px}@media print{body{background:#fff}.pn-document{max-width:none;padding:16mm 15mm}.pn-heading,.pn-semantic,.pn-callout,.pn-code,.pn-image,.pn-table-wrap{break-inside:avoid;page-break-inside:avoid}.pn-page-break{display:block}}`;
  // Keep this in deliberate lockstep with the document tokens in
  // document-editor.css. UI chrome is intentionally absent here: exported
  // documents use the original Proofnote editorial scale, not an app scale.
  const EXPORT_DOCUMENT_TYPOGRAPHY_CSS = `
    :root{
      --heading:"Cormorant Garamond","Songti SC",STSong,"Noto Serif CJK SC","Source Han Serif SC",Georgia,serif;
      --body:"Lora","Songti SC",STSong,"Noto Serif CJK SC","Source Han Serif SC",Georgia,serif;
      --pn-doc-body-size:16px;--pn-doc-body-leading:1.6;
      --pn-doc-title-size:40px;--pn-doc-title-leading:1.12;
      --pn-doc-summary-size:19.333px;--pn-doc-summary-leading:1.42;
      --pn-doc-section-1-size:26.667px;--pn-doc-section-2-size:24px;--pn-doc-section-3-size:18.667px;
      --pn-doc-label-size:10px;--pn-doc-meta-size:14px;
    }
    body{font:var(--pn-doc-body-size)/var(--pn-doc-body-leading) var(--body)}
    .pn-document{max-width:712px;padding:46px 30px 76px}.pn-document-title{margin:0 0 14.667px;padding-bottom:18.667px}.pn-document-title h1{font:400 var(--pn-doc-title-size)/var(--pn-doc-title-leading) var(--heading);letter-spacing:-.02em}.pn-document-subtitle{margin:-2.667px 0 25.333px;font:italic var(--pn-doc-summary-size)/var(--pn-doc-summary-leading) var(--heading)}.pn-heading{margin:32px 0 13.333px;padding-bottom:8px}.pn-heading h2{font-size:var(--pn-doc-section-1-size);line-height:1.18}.pn-heading h3{font-size:var(--pn-doc-section-2-size);line-height:1.24}.pn-heading h4{font-size:var(--pn-doc-section-3-size);line-height:1.3;font-weight:600}.pn-document p{margin-bottom:14.667px}.pn-equation{margin:16px 0}.pn-code{margin:16px 0;padding:30.667px 13.333px 13.333px;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.pn-code-language{top:9.333px;left:13.333px;font-size:10px}.pn-table-wrap{margin:16px 0}.pn-table{font-size:14px}.pn-table th,.pn-table td{padding:8px 10.667px}.pn-image{margin:20px 0}.pn-image figcaption,.pn-quote figcaption{margin-top:6.667px;font-size:12.667px}.pn-image-empty{margin:16px 0;padding:13.333px;font-size:12.667px}.pn-quote{margin:20px 0;padding:2.667px 0 2.667px 18.667px}.pn-quote blockquote{font-size:21.333px}.pn-divider{margin:32px 0}.pn-semantic{margin:13.333px 0;padding:13.667px;border-radius:4px}.pn-callout{margin:17.333px 0;padding:5.333px 0 5.333px 18.667px;border:0;border-left:2px solid #e1ad66;background:transparent}.pn-callout-warning{border-left-color:#d8a846;background:transparent}.pn-callout-info{border-left-color:#8aa2cc;background:transparent}.pn-component-label{margin-bottom:6.667px;font-size:var(--pn-doc-label-size);letter-spacing:.14em}.pn-semantic h3{margin:0 0 8px;font:400 var(--pn-doc-section-1-size)/1.15 var(--heading)}.pn-list{margin:13.333px 0;padding-left:25.333px}.pn-list li{margin-bottom:4px}.pn-key-value{margin:16px 0;font-size:var(--pn-doc-meta-size)}.pn-key-value>div{grid-template-columns:149.333px 1fr;gap:9.333px;margin-bottom:6.667px}.pn-key-value dt{font-size:var(--pn-doc-label-size);letter-spacing:.12em}.pn-stats{grid-template-columns:repeat(auto-fit,minmax(146.667px,1fr));gap:10.667px;margin:16px 0}.pn-stat{padding:13.333px}.pn-stat strong{margin:4px 0;font-size:28px}.pn-stat p{font-size:12.667px}
    @media print{.pn-document{max-width:none;padding:16mm 15mm}}
  `;
  // The Proof Note template intentionally carries the original, continuous
  // editorial treatment. These rules are shared by the downloaded standalone
  // HTML and the interactive canvas equivalents in document-editor.css.
  const EXPORT_PROOFNOTE_EDITORIAL_CSS = `
    .pn-proofnote-document .pn-export-running{display:flex;align-items:baseline;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--line);font:600 10px/1 var(--heading);letter-spacing:.14em;text-transform:uppercase;color:rgba(32,31,29,.5)}
    .pn-proofnote-document .pn-running-brand{color:var(--accent)}
    .pn-proofnote-document .pn-document-title{margin:29.333px 0 13.333px;padding-bottom:0;border-bottom:0}.pn-proofnote-document .pn-document-subtitle{margin:0;padding-bottom:24px;border-bottom:1px solid var(--line)}
    .pn-proof-metadata{margin:13.333px 0 26.667px}.pn-proof-metadata-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13.333px 21.333px;margin:0}.pn-proof-metadata-item dt,.pn-proof-source dt{margin:0 0 2.667px;font:600 var(--pn-doc-label-size)/1.2 var(--heading);letter-spacing:.12em;text-transform:uppercase;color:rgba(32,31,29,.54)}.pn-proof-metadata-item dd,.pn-proof-source dd{margin:0;font:var(--pn-doc-meta-size)/1.45 var(--body)}.pn-proof-metadata-status dd{font-family:var(--heading);font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8c6228}.pn-proof-source{margin:12px 0 0}
    .pn-editorial-section{margin:0 0 28px;break-inside:avoid;page-break-inside:avoid}.pn-editorial-section-head{display:flex;align-items:baseline;gap:13.333px;margin-bottom:13.333px;padding-bottom:8px;border-bottom:1px solid var(--line)}.pn-editorial-section-number{flex:none;font:600 12px/1 var(--heading);letter-spacing:.12em;font-feature-settings:'tnum';color:var(--accent)}.pn-editorial-section-head h2{margin:0;font:400 var(--pn-doc-section-1-size)/1.15 var(--heading);letter-spacing:-.015em}.pn-editorial-section p{margin:0 0 13.333px}.pn-editorial-section-summary,.pn-editorial-detail-summary{margin-top:5.333px!important;font-style:italic;color:rgba(32,31,29,.72)}
    .pn-editorial-detail{margin:0 0 16px;break-inside:avoid;page-break-inside:avoid}.pn-editorial-detail .pn-component-label{margin-bottom:4px;color:rgba(32,31,29,.55)}.pn-editorial-detail h3{margin:0 0 4px;font:400 18.667px/1.2 var(--heading)}.pn-editorial-detail p{margin:0 0 13.333px}
    .pn-export-footer{display:flex;justify-content:space-between;margin-top:34.667px;padding-top:8px;border-top:1px solid var(--line);font:10px/1 var(--heading);letter-spacing:.1em;text-transform:uppercase;color:rgba(32,31,29,.45)}.pn-export-footer span:last-child{color:#8c6228}
  `;
  // Keep downloaded documents in step with the quieter, denser semantic cards
  // on the editing canvas. Empty summaries are omitted by renderBlock(), so an
  // editor-only placeholder can never leak into the exported document.
  const EXPORT_POLISH_CSS = `.pn-semantic{border-color:#fde6c8;background:#fff9f1}`;
  function renderStandaloneDocument() {
    const proofNote = isProofNoteDocument();
    const blocks = state.blocks.map((block, index) => {
      const rendered = renderBlock(block, index);
      return rendered + (proofNote && block.type === "subtitle" ? proofMetadataHtml() : "");
    }).join("\n");
    if (!proofNote) return "<article class=\"pn-document\">" + blocks + "</article>";
    const type = escapeHtml(state.metadata.documentType || "Solution Note");
    const note = escapeHtml(state.metadata.noteNumber || "—");
    const status = escapeHtml(state.metadata.status || "");
    return "<article class=\"pn-document pn-proofnote-document\"><div class=\"pn-export-running pn-proofnote-running\"><span class=\"pn-running-brand\">Proofnote</span><span class=\"pn-running-type\">" + type + "</span></div>" + blocks + "<footer class=\"pn-export-footer\"><span>" + escapeHtml(tr("笔记 ", "Note ")) + note + "</span><span>" + status + "</span></footer></article>";
  }
  function exportHtml() {
    let katexCss = "", fontsCss = "";
    try { katexCss = root.SOLUTION_NOTE_KATEX_EMBED ? decodeBase64(root.SOLUTION_NOTE_KATEX_EMBED.css) : ""; } catch (_) {}
    try { fontsCss = root.SOLUTION_NOTE_FONTS_EMBED ? decodeBase64(root.SOLUTION_NOTE_FONTS_EMBED.css) : ""; } catch (_) {}
    const title = escapeHtml(state.metadata.name || "Proofnote document");
    const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title><style>" + katexCss.replace(/<\/style/gi, "<\\/style") + "</style><style>" + fontsCss.replace(/<\/style/gi, "<\\/style") + "</style><style>" + EXPORT_CSS + EXPORT_DOCUMENT_TYPOGRAPHY_CSS + EXPORT_PROOFNOTE_EDITORIAL_CSS + EXPORT_POLISH_CSS + "</style></head><body>" + renderStandaloneDocument() + "</body></html>";
    download(slug() + ".html", html, "text/html");
  }

  function readImportFile() {
    const file = els.importFile.files && els.importFile.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      els.importReport.textContent = tr("文件超过 25MB 导入上限。", "File exceeds the 25 MB import limit.");
      els.importFile.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { els.importText.value = String(reader.result || ""); els.importReport.textContent = ""; };
    reader.readAsText(file);
  }
  async function importFromDialog() {
    if (els.importText.value.length > MAX_IMPORT_BYTES / 2) {
      els.importReport.textContent = tr("JSON 文本超过 25MB 导入上限。", "JSON text exceeds the 25 MB import limit.");
      return;
    }
    let raw;
    try { raw = JSON.parse(els.importText.value); } catch (error) { els.importReport.textContent = tr("JSON 无法解析：", "Could not parse JSON: ") + error.message; return; }
    let next, warnings = [];
    if (raw && raw.format === "solution-note") {
      const legacyValidation = root.__snTest && root.__snTest.validateRaw ? root.__snTest.validateRaw(raw) : { errors: [], warnings: [] };
      if (legacyValidation.errors.length) { els.importReport.textContent = tr("Solution Note 校验失败：", "Solution Note validation failed: ") + legacyValidation.errors.map((item) => item.path + " — " + item.message).join("; "); return; }
      warnings = legacyValidation.warnings || [];
      next = Model.migrateSolutionNote(raw);
    } else if (raw && raw.format === Model.TEMPLATE_FORMAT) {
      const validation = Model.validateTemplateRaw(raw);
      if (validation.errors.length) { els.importReport.textContent = tr("模板校验失败：", "Template validation failed: ") + validation.errors.map((item) => item.path + " — " + item.message).join("; "); return; }
      const template = Model.normalizeTemplate(raw);
      const backend = await Store.saveTemplate(template);
      if (backend === "failed") { els.importReport.textContent = tr("模板无法保存到此设备；请释放存储空间后重试。", "Template could not be saved on this device; free storage and try again."); return; }
      selectedTemplateId = template.template.id;
      await refreshTemplates();
      next = Model.normalizeDocument(template.document);
      warnings = validation.warnings.concat([tr("模板已保存到此设备。", "Template saved on this device.")]);
    } else {
      const validation = Model.validateDocumentRaw(raw);
      if (validation.errors.length) { els.importReport.textContent = tr("Document 校验失败：", "Document validation failed: ") + validation.errors.map((item) => item.path + " — " + item.message).join("; "); return; }
      warnings = validation.warnings;
      next = Model.normalizeDocument(raw);
    }
    clearStructuralUndo();
    state = next;
    closeImport(); renderAll(); scheduleSave();
    setStatus(warnings.length ? tr("已导入；有 " + warnings.length + " 条可恢复提示。", "Imported with " + warnings.length + " recoverable notice(s).") : tr("文档已导入", "Document imported"), warnings.length ? "warning" : "saved");
  }
  async function initialise() {
    mount();
    try { applySidebarWidth(root.localStorage.getItem(SIDEBAR_WIDTH_KEY), false); } catch (_) { applySidebarWidth(SIDEBAR_DEFAULT_WIDTH, false); }
    try {
      const savedCollapsed = JSON.parse(root.localStorage.getItem(OUTLINE_COLLAPSE_KEY) || "[]");
      collapsedOutlineIds = new Set(Array.isArray(savedCollapsed) ? savedCollapsed.filter((id) => typeof id === "string") : []);
    } catch (_) { collapsedOutlineIds = new Set(); }
    try { setUtilityOpen(root.localStorage.getItem("proofnote-document:utility-open") === "1"); } catch (_) { setUtilityOpen(false); }
    setDetailOpen(false);
    try { setSidebarTab(root.localStorage.getItem("proofnote-document:sidebar-tab") || "outline"); } catch (_) { setSidebarTab("outline"); }
    await refreshTemplates();
    const stored = await Store.loadCurrent();
    if (stored && stored.format === Model.FORMAT) state = Model.normalizeDocument(stored, { allowRemoteImages: true });
    else {
      let legacy = null;
      try { legacy = JSON.parse(root.localStorage.getItem("solution-note-generator:v1") || "null"); } catch (_) {}
      const proofTemplate = templateById("proof-note");
      state = legacy ? Model.migrateSolutionNote(legacy) : Model.normalizeDocument(proofTemplate.document);
    }
    renderAll();
    scheduleSave();
    setStatus(tr("已自动保存到此设备", "Saved on this device"), "saved");
  }
  initialise().catch((error) => { console.error("Proofnote Document editor could not start", error); });
})(window, document);
