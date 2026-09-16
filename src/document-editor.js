/* Proofnote's block-document editor. This is intentionally a thin UI over
 * document-model.js: all interchange normalisation and legacy adaptation stay
 * outside the rendering layer. */
(function (root, document) {
  "use strict";
  const Model = root.ProofnoteDocument;
  const Store = root.ProofnoteStore;
  if (!Model || !Store) return;

  // Increment this small, user-facing version for each released workspace update.
  const APP_VERSION = "v1.19";
  const TYPE_OPTIONS = [
    ["title", "Title", "标题"], ["subtitle", "Subtitle", "副标题"], ["heading", "Heading", "章节标题"],
    ["paragraph", "Paragraph", "正文"], ["equation", "Standalone equation", "独立公式"], ["code", "Code", "代码"],
    ["table", "Table", "表格"], ["image", "Image", "图片"], ["quote", "Citation", "引文"],
    ["divider", "Divider", "分隔线"], ["page-break", "Page break", "分页"], ["callout", "Callout", "注释框"],
    ["semantic", "Semantic block", "语义模块"], ["list", "List", "列表"], ["key-value", "Key–value", "键值列表"], ["stats", "Stats", "统计卡片"]
  ];
  const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map(([type, en, zh]) => [type, { en, zh }]));
  // Code is a reading surface rather than a mini IDE. Keep the supported
  // language set intentionally small, known, and shared by the Inspector,
  // canvas label, AI contract, and Prism export renderer.
  const CODE_LANGUAGE_OPTIONS = [
    ["text", "Plain text", "纯文本"], ["python", "Python", "Python"],
    ["javascript", "JavaScript", "JavaScript"], ["typescript", "TypeScript", "TypeScript"],
    ["c", "C", "C"], ["cpp", "C++", "C++"], ["java", "Java", "Java"],
    ["bash", "Bash", "Bash"], ["sql", "SQL", "SQL"], ["json", "JSON", "JSON"],
    ["html", "HTML", "HTML"], ["css", "CSS", "CSS"]
  ];
  const CODE_LANGUAGE_ALIASES = {
    text: "text", plain: "text", plaintext: "text", txt: "text",
    python: "python", py: "python",
    javascript: "javascript", js: "javascript",
    typescript: "typescript", ts: "typescript",
    c: "c", cpp: "cpp", "c++": "cpp", cxx: "cpp",
    java: "java", bash: "bash", sh: "bash", shell: "bash",
    sql: "sql", json: "json", html: "html", xml: "html", markup: "html", css: "css"
  };
  // The inline/page-bottom picker is intentionally a focused authoring menu,
  // not a catalogue of every block the document format can represent.  Title
  // and subtitle belong to the document masthead; the remaining hidden types
  // stay supported for imported documents and Inspector conversions.
  const INSERTABLE_BLOCK_TYPES = [
    // "section" is a picker action, rather than a document-model block type:
    // it creates Proofnote's numbered editorial semantic section.
    "section", "paragraph", "equation", "code", "table", "quote",
    "divider", "page-break", "callout", "semantic", "list"
  ];
  const OUTLINE_SEMANTIC_LABEL = {
    section: { zh: "章节", en: "Section" },
    introduction: { zh: "引言", en: "Introduction" },
    problem: { zh: "问题", en: "Problem" },
    theorem: { zh: "定理", en: "Theorem" },
    proof: { zh: "证明", en: "Proof" },
    result: { zh: "结果", en: "Result" },
    verification: { zh: "验证", en: "Verify" }
  };
  // The Proof Note masthead is one editor surface: title, subtitle, and its
  // optional metadata row keep their editorial rhythm while selecting as one
  // coherent document block.
  const PROOF_METADATA_SELECTION = "__proofnote_header__";
  const PROOF_METADATA_FIELDS = ["author", "date", "status"];
  let state = null;
  let templates = [];
  let documents = [];
  let currentDocumentId = "";
  let renamingDocumentId = "";
  let saveTimer = null;
  // A document may be edited again while an earlier IndexedDB write is still
  // in flight. Keep immutable snapshots in a serial queue so an older save
  // can never finish after, and overwrite, a newer edit.
  let saveQueue = Promise.resolve();
  let editRevision = 0;
  let hasUnsavedChanges = false;
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
  // The navigator opens at its widest useful reading width on every reload.
  // Dragging is session-only so a temporary adjustment never becomes a
  // surprising long-term workspace preference.
  const OUTLINE_COLLAPSE_KEY = "proofnote-document:outline-collapsed:v1";
  const SIDEBAR_DEFAULT_WIDTH = 360;
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
  function insertionOptionText(type) {
    return type === "section" ? tr("章节", "Section") : optionText(type);
  }
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
  function canonicalCodeLanguage(value) {
    const source = String(value == null ? "" : value).trim().toLowerCase();
    return CODE_LANGUAGE_ALIASES[source] || "";
  }
  function codeLanguageOptions() {
    return CODE_LANGUAGE_OPTIONS.map(([key, en, zh]) => [key, tr(zh, en)]);
  }
  function codeLanguageSelectValue(value) {
    return canonicalCodeLanguage(value) || "text";
  }
  function codeLanguageDisplay(value) {
    const source = String(value == null ? "" : value).trim();
    if (!source) return "CODE";
    const language = canonicalCodeLanguage(source);
    const option = CODE_LANGUAGE_OPTIONS.find(([key]) => key === language);
    return option ? tr(option[2], option[1]) : source.toUpperCase();
  }
  function codePrismLanguage(value) {
    const language = canonicalCodeLanguage(value);
    return language === "html" ? "markup" : language;
  }
  function highlightedCodeHtml(content, language) {
    const source = String(content == null ? "" : content);
    const prism = root.Prism;
    const grammarName = codePrismLanguage(language);
    if (!grammarName || grammarName === "text" || !prism || !prism.languages || !prism.languages[grammarName]) return escapeHtml(source);
    try {
      return prism.highlight(source, prism.languages[grammarName], grammarName);
    } catch (_) {
      // Exporting a document must never depend on a grammar successfully
      // parsing every edge case; raw escaped code is always a safe fallback.
      return escapeHtml(source);
    }
  }

  function mount() {
    document.body.classList.add("proofnote-document-mode");
    const app = element("div", { id: "proofnoteDocumentApp" });
    app.innerHTML = `
      <header class="pn-workspace-toolbar">
        <div class="pn-wordmark"><strong>Proofnote</strong><span class="pn-app-version" aria-label="Proofnote version ${APP_VERSION.slice(1)}">${APP_VERSION}</span></div>
        <p id="pnStatus" class="pn-status" role="status"></p>
        <div class="pn-toolbar-menu">
          <button class="pn-toolbar-actions" id="pnActionsToggle" type="button" aria-expanded="false" aria-controls="pnActionMenu" aria-label="${tr("文档操作", "Document actions")}" title="${tr("文档操作", "Document actions")}">•••</button>
          <div class="pn-action-menu" id="pnActionMenu" role="menu" aria-label="${tr("文档操作", "Document actions")}" hidden>
            <div class="pn-action-menu-label">${tr("文件", "File")}</div>
            <button class="pn-action-menu-item" id="pnImport" type="button" role="menuitem">${tr("导入 JSON", "Import JSON")}</button>
            <button class="pn-action-menu-item" id="pnExportHtml" type="button" role="menuitem">${tr("导出 HTML", "Export HTML")}</button>
            <div class="pn-action-menu-submenu-wrap">
              <button class="pn-action-menu-item pn-action-menu-submenu-trigger" id="pnExportMore" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="pnExportMoreMenu"><span>${tr("更多导出", "More exports")}</span><span class="pn-action-menu-arrow" aria-hidden="true">›</span></button>
              <div class="pn-action-menu pn-action-menu-submenu" id="pnExportMoreMenu" role="menu" aria-label="${tr("更多导出", "More exports")}" hidden>
                <button class="pn-action-menu-item" id="pnExport" type="button" role="menuitem">${tr("备份项目（Proofnote 文件）", "Back up project (Proofnote file)")}</button>
              </div>
            </div>
            <div class="pn-action-menu-rule" aria-hidden="true"></div>
            <button class="pn-action-menu-item" id="pnCopyAi" type="button" role="menuitem">${tr("复制 AI 格式说明", "Copy AI format")}</button>
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
              <section class="pn-library-section" aria-labelledby="pnTemplatesHeading">
                <div class="pn-sidebar-heading" id="pnTemplatesHeading">${tr("模板", "Templates")}</div>
                <div class="pn-template-list" id="pnTemplates" role="list" aria-label="${tr("选择模板", "Choose template")}"></div>
              </section>
              <section class="pn-library-section pn-library-documents" aria-labelledby="pnDocumentsHeading">
                <div class="pn-library-heading-row"><div class="pn-sidebar-heading" id="pnDocumentsHeading">${tr("文档", "Documents")}</div><button class="pn-template-new" id="pnNew" type="button">${tr("＋ 新建项目", "+ New project")}</button></div>
                <div class="pn-document-list" id="pnDocuments" role="list" aria-label="${tr("文档，按最近修改排序", "Documents, most recently modified first")}"></div>
              </section>
              <div class="pn-template-footer">
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
            <div slot="footer" class="pn-page-chrome pn-page-footer"><span class="pn-footer-name" id="pnFooterName"></span><span id="pnFooterStatus"></span></div>
          </doc-page>
        </main>
        <aside class="pn-detail" id="pnDetail" aria-label="${tr("检查器", "Inspector")}" aria-hidden="true" hidden>
          <div class="pn-detail-content">
            <section class="pn-inspector-section">
              <div class="pn-inspector-topline"><div class="pn-utility-title" id="pnInspectorTopLabel">${tr("内容块", "Block")}</div><button class="pn-close-inspector" id="pnCloseInspector" type="button" aria-label="${tr("关闭检查器", "Close inspector")}" title="${tr("关闭检查器", "Close inspector")}">×</button></div>
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
          <section id="pnImportReport" class="pn-import-report" role="status" aria-live="polite"></section>
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
      <div class="pn-modal-backdrop" id="pnNewProjectModal" hidden>
        <section class="pn-modal pn-confirm-modal pn-new-project-modal" role="dialog" aria-modal="true" aria-labelledby="pnNewProjectTitle" aria-describedby="pnNewProjectCopy">
          <p class="pn-confirm-kicker">${tr("新建文档", "NEW DOCUMENT")}</p>
          <h2 id="pnNewProjectTitle">${tr("新建项目", "New project")}</h2>
          <p id="pnNewProjectCopy" class="pn-modal-copy">${tr("命名项目后，Proofnote 会自动创建同名文档、填入今天的日期，并添加一个“引言”语义小节。", "Name the project and Proofnote will create a matching document, add today’s date, and start it with an editorial Introduction section.")}</p>
          <label class="pn-new-project-field" for="pnNewProjectName"><span class="pn-new-project-label">${tr("项目名称", "Project name")}</span><input class="pn-new-project-input" id="pnNewProjectName" type="text" autocomplete="off" maxlength="200" required></label>
          <div class="pn-actions pn-confirm-actions"><button class="btn btn-secondary" id="pnNewProjectCancel" type="button">${tr("取消", "Cancel")}</button><button class="btn btn-primary" id="pnCreateProject" type="button">${tr("创建项目", "Create project")}</button></div>
        </section>
      </div>
      <div class="pn-outline-menu" id="pnOutlineMenu" role="menu" aria-label="${tr("大纲结构操作", "Outline structure actions")}" hidden></div>
      <div class="pn-undo-toast" id="pnUndoToast" role="status" hidden><span id="pnUndoCopy"></span><button class="pn-undo-button" id="pnUndoButton" type="button">${tr("撤销", "Undo")}</button></div>`;
    document.body.appendChild(app);
    els = {
      app, utility: app.querySelector("#pnUtility"), utilityToggle: app.querySelector("#pnUtilityToggle"), sidebarResize: app.querySelector("#pnSidebarResize"), detail: app.querySelector("#pnDetail"), detailClose: app.querySelector("#pnCloseInspector"), actionToggle: app.querySelector("#pnActionsToggle"), actionMenu: app.querySelector("#pnActionMenu"), exportMore: app.querySelector("#pnExportMore"), exportMoreMenu: app.querySelector("#pnExportMoreMenu"), templateMenuToggle: app.querySelector("#pnTemplateMenuToggle"), templateMenu: app.querySelector("#pnTemplateMenu"), templates: app.querySelector("#pnTemplates"), documents: app.querySelector("#pnDocuments"), outlineCount: app.querySelector("#pnOutlineCount"), status: app.querySelector("#pnStatus"),
      outline: app.querySelector("#pnOutline"), canvasPane: app.querySelector(".pn-canvas-pane"), docPage: app.querySelector("#pnDocPage"), canvas: app.querySelector("#pnCanvas"), inspector: app.querySelector("#pnInspector"), inspectorTopLabel: app.querySelector("#pnInspectorTopLabel"), pageHeader: app.querySelector("#pnPageHeader"), footer: app.querySelector("#pnFooterName"), footerStatus: app.querySelector("#pnFooterStatus"), modal: app.querySelector("#pnImportModal"), confirmModal: app.querySelector("#pnConfirmModal"), confirmTitle: app.querySelector("#pnConfirmTitle"), confirmCopy: app.querySelector("#pnConfirmCopy"), confirmCancel: app.querySelector("#pnConfirmCancel"), confirmAccept: app.querySelector("#pnConfirmAccept"), newProjectModal: app.querySelector("#pnNewProjectModal"), newProjectName: app.querySelector("#pnNewProjectName"), newProjectCancel: app.querySelector("#pnNewProjectCancel"), newProjectCreate: app.querySelector("#pnCreateProject"),
      importText: app.querySelector("#pnImportText"), importFile: app.querySelector("#pnImportFile"), importReport: app.querySelector("#pnImportReport"),
      outlineMenu: app.querySelector("#pnOutlineMenu"), undoToast: app.querySelector("#pnUndoToast"), undoCopy: app.querySelector("#pnUndoCopy"), undoButton: app.querySelector("#pnUndoButton")
    };
    bindToolbar(app);
    bindProjectFooterNameEditing();
  }

  function bindProjectFooterNameEditing() {
    if (!els.footer) return;
    els.footer.addEventListener("input", () => {
      if (!isProjectDocument()) return;
      updateProjectRunningHeader("left", els.footer.textContent || "", els.footer);
    });
    els.footer.addEventListener("keydown", (event) => {
      // A running title is one line. Enter finishes the inline edit without
      // introducing an invisible line break into the persistent document name.
      if (event.key !== "Enter") return;
      event.preventDefault();
      els.footer.blur();
    });
  }

  function bindToolbar(app) {
    app.querySelector("#pnUtilityToggle").addEventListener("click", () => setUtilityOpen(!els.utility.classList.contains("is-open")));
    els.actionToggle.addEventListener("click", () => setActionMenuOpen(els.actionMenu.hidden));
    els.exportMore.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setExportMoreOpen(els.exportMoreMenu.hidden, true);
    });
    els.exportMore.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") { event.preventDefault(); setExportMoreOpen(true, true); }
      if (event.key === "Escape") { event.preventDefault(); setExportMoreOpen(false); els.actionToggle.focus(); }
    });
    els.templateMenuToggle.addEventListener("click", () => setTemplateMenuOpen(els.templateMenu.hidden));
    els.detailClose.addEventListener("click", () => setDetailOpen(false));
    app.addEventListener("click", (event) => {
      if (!event.target.closest(".pn-toolbar-menu")) setActionMenuOpen(false);
      if (!event.target.closest(".pn-template-menu-wrap")) setTemplateMenuOpen(false);
    });
    // The paper remains the primary editing surface. A click on its open
    // whitespace should return it to a quiet reading state, rather than
    // leaving a formerly selected block visually pinned in place.
    els.canvasPane.addEventListener("pointerdown", (event) => {
      if (!selectedBlockId) return;
      if (event.target.closest(".pn-canvas-block, .pn-insert-point, input, textarea, select, button, a, label")) return;
      clearCanvasSelection();
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
      if (!els.newProjectModal.hidden) closeNewProject();
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
    els.newProjectCancel.addEventListener("click", closeNewProject);
    els.newProjectCreate.addEventListener("click", createNewProject);
    els.newProjectModal.addEventListener("click", (event) => { if (event.target === els.newProjectModal) closeNewProject(); });
    els.newProjectName.addEventListener("input", () => els.newProjectName.removeAttribute("aria-invalid"));
    els.newProjectName.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      createNewProject();
    });
    els.undoButton.addEventListener("click", undoLastStructuralDelete);
    app.querySelector("#pnConfirmImport").addEventListener("click", importFromDialog);
    els.importFile.addEventListener("change", readImportFile);
    app.querySelector("#pnExport").addEventListener("click", () => { exportDocument(); setActionMenuOpen(false); });
    app.querySelector("#pnExportHtml").addEventListener("click", () => { exportHtml(); setActionMenuOpen(false); });
    app.querySelector("#pnCopyAi").addEventListener("click", () => { copyAiInstructions(); setActionMenuOpen(false); });
    app.querySelector("#pnExportTemplate").addEventListener("click", () => { exportTemplate(); setTemplateMenuOpen(false); });
    app.querySelector("#pnLang").addEventListener("click", () => { try { root.localStorage.setItem("sn-lang", english() ? "zh" : "en"); } catch (_) {} root.location.reload(); });
    // A debounce timer is convenient during editing, but a tab can be hidden
    // or closed before it fires. Queue the current immutable snapshot on both
    // lifecycle boundaries; the store queue preserves its order with saves
    // already in flight.
    const flushBeforeLeaving = () => {
      if (!hasUnsavedChanges) return;
      saveActiveDocumentNow().catch(() => {});
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushBeforeLeaving();
    });
    root.addEventListener("pagehide", flushBeforeLeaving);
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
  function applySidebarWidth(value) {
    sidebarWidth = clampSidebarWidth(value);
    if (els.utility && els.utility.classList.contains("is-open")) els.app.style.setProperty("--pn-left", sidebarWidth + "px");
    syncSidebarResize();
    root.requestAnimationFrame(syncCanvasScale);
  }
  function bindSidebarResize() {
    const resize = els.sidebarResize;
    if (!resize) return;
    resize.addEventListener("pointerdown", (event) => {
      if (!canResizeSidebar() || !els.utility.classList.contains("is-open") || event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const move = (moveEvent) => applySidebarWidth(startWidth + moveEvent.clientX - startX);
      const finish = () => {
        document.body.classList.remove("pn-sidebar-resizing");
        root.removeEventListener("pointermove", move);
        root.removeEventListener("pointerup", finish);
        root.removeEventListener("pointercancel", finish);
        applySidebarWidth(sidebarWidth);
      };
      document.body.classList.add("pn-sidebar-resizing");
      if (resize.setPointerCapture) resize.setPointerCapture(event.pointerId);
      root.addEventListener("pointermove", move);
      root.addEventListener("pointerup", finish);
      root.addEventListener("pointercancel", finish);
    });
    resize.addEventListener("dblclick", () => applySidebarWidth(SIDEBAR_DEFAULT_WIDTH));
    resize.addEventListener("keydown", (event) => {
      if (!canResizeSidebar() || !els.utility.classList.contains("is-open")) return;
      const delta = event.shiftKey ? 24 : 8;
      if (event.key === "ArrowLeft") { event.preventDefault(); applySidebarWidth(sidebarWidth - delta); }
      if (event.key === "ArrowRight") { event.preventDefault(); applySidebarWidth(sidebarWidth + delta); }
      if (event.key === "Home") { event.preventDefault(); applySidebarWidth(SIDEBAR_MIN_WIDTH); }
      if (event.key === "End") { event.preventDefault(); applySidebarWidth(SIDEBAR_MAX_WIDTH); }
    });
    root.addEventListener("resize", () => { syncSidebarResize(); syncCanvasScale(); });
  }
  function setActionMenuOpen(open) {
    els.actionMenu.hidden = !open;
    els.actionToggle.setAttribute("aria-expanded", String(Boolean(open)));
    if (!open) setExportMoreOpen(false);
  }
  function setExportMoreOpen(open, focusFirstItem) {
    if (!els.exportMore || !els.exportMoreMenu) return;
    els.exportMoreMenu.hidden = !open;
    els.exportMore.setAttribute("aria-expanded", String(Boolean(open)));
    if (!open || !focusFirstItem) return;
    root.requestAnimationFrame(() => els.exportMoreMenu.querySelector('[role="menuitem"]')?.focus());
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
  function clearImportReport() {
    if (!els.importReport) return;
    els.importReport.replaceChildren();
    els.importReport.className = "pn-import-report";
  }
  function showImportMessage(message, kind) {
    if (!els.importReport) return;
    els.importReport.className = "pn-import-report" + (kind ? " is-" + kind : "");
    els.importReport.replaceChildren(element("p", { class: "pn-import-message" }, message));
  }
  function closeImport() { els.modal.hidden = true; clearImportReport(); }
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
    if (!hasUnsavedChanges) return;
    saveTimer = setTimeout(async () => {
      try {
        const result = await saveActiveDocument();
        if (result.backend === "unchanged" || !result.current) return;
        if (result.backend === "failed") {
          setStatus(tr("自动保存失败；请立即导出文档备份。", "Autosave failed — export a backup now."), "error");
          return;
        }
        setStatus(result.backend === "indexeddb" ? tr("已自动保存到此设备", "Saved on this device") : tr("已自动保存（本地存储）", "Saved locally"), "saved");
      } catch (_) {
        setStatus(tr("自动保存失败；请立即导出文档备份。", "Autosave failed — export a backup now."), "error");
      }
    }, 350);
  }

  function saveSnapshot() {
    if (!state) return null;
    // The model is portable JSON by design, which gives us a clean, immutable
    // snapshot without retaining mutable block objects across an await.
    const document = Model.normalizeDocument(JSON.parse(JSON.stringify(state)), { allowRemoteImages: true });
    return { documentId: currentDocumentId, revision: editRevision, document };
  }

  function queueDocumentSave(snapshot) {
    const task = async () => {
      let documentId = snapshot.documentId;
      let backend = "failed";
      if (!documentId) {
        // This only occurs while bootstrapping an empty library. If an earlier
        // queued creation has already supplied an id, save this newer snapshot
        // into that same document rather than creating a duplicate.
        documentId = currentDocumentId;
        if (!documentId) {
          const created = await Store.createDocument(snapshot.document);
          if (!created || !created.record) return { backend: "failed", current: false };
          documentId = created.record.id;
          backend = created.backend;
          if (currentDocumentId === "") {
            currentDocumentId = documentId;
            documents = [created.record].concat(documents.filter((record) => record.id !== documentId));
            renderDocumentLibrary();
          }
        }
      }
      if (backend !== "failed" || documentId) {
        if (backend === "failed") backend = await Store.saveDocument(documentId, snapshot.document);
        if (backend === "failed") return { backend, current: false };
      }
      const current = currentDocumentId === documentId && editRevision === snapshot.revision;
      if (current) hasUnsavedChanges = false;
      await refreshDocuments();
      return { backend, current };
    };
    const job = saveQueue.then(task, task);
    // Keep the queue usable even if an unforeseen exception escaped `task`.
    saveQueue = job.catch(() => undefined);
    return job;
  }

  async function saveActiveDocument() {
    if (!state) return { backend: "failed", current: false };
    if (currentDocumentId && !hasUnsavedChanges) return { backend: "unchanged", current: true };
    const snapshot = saveSnapshot();
    return snapshot ? queueDocumentSave(snapshot) : { backend: "failed", current: false };
  }
  async function flushCurrentDocumentUntilClean() {
    clearTimeout(saveTimer);
    let documentId = currentDocumentId;
    try {
      // A transition must not proceed after merely *one* successful write.
      // If the author edits while that write is in flight, queue and await the
      // newer snapshot too. This is deliberately a loop instead of trusting
      // an older completion's backend label.
      while (state) {
        const result = await saveActiveDocument();
        if (result.backend === "failed") return result;
        if (!documentId && currentDocumentId) documentId = currentDocumentId;
        if (currentDocumentId !== documentId) return { backend: "failed", current: false };
        if (result.current && !hasUnsavedChanges) return result;
      }
    } catch (_) {}
    return { backend: "failed", current: false };
  }
  async function saveActiveDocumentNow() {
    return (await flushCurrentDocumentUntilClean()).backend;
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
  async function refreshDocuments() {
    documents = await Store.listDocuments();
    renderDocumentLibrary();
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
    templates.filter((template) => !template.template.builtIn || template.template.id === "proof-note").forEach((template) => {
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
  function documentName(record) {
    const metadata = record && record.document && record.document.metadata || {};
    const portableName = String(metadata.name || "").trim();
    const templateName = String(metadata.templateName || "").trim();
    const title = record && record.document && Array.isArray(record.document.blocks)
      ? record.document.blocks.find((block) => block && block.type === "title") : null;
    const titleName = String(title && title.content || "").trim();
    // Built-in templates historically used their template name as metadata.
    // In a library that makes every new note look identical, so prefer the
    // actual document title until the author explicitly renames the file.
    if (titleName && (!portableName || portableName === templateName)) return titleName;
    return portableName || titleName || tr("未命名文档", "Untitled document");
  }
  function renderDocumentLibrary() {
    if (!els.documents) return;
    els.documents.innerHTML = "";
    if (!documents.length) {
      els.documents.appendChild(element("p", { class: "pn-library-empty" }, tr("还没有其他文档。", "No other documents yet.")));
      return;
    }
    documents.forEach((record) => {
      const row = element("div", { class: "pn-document-item" + (record.id === currentDocumentId ? " is-active" : ""), role: "listitem" });
      if (renamingDocumentId === record.id) {
        const rename = element("input", { class: "pn-document-rename", type: "text", value: documentName(record), "aria-label": tr("重命名文档", "Rename document") });
        const save = () => finishDocumentRename(record.id, rename.value);
        rename.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); save(); }
          if (event.key === "Escape") { event.preventDefault(); renamingDocumentId = ""; renderDocumentLibrary(); }
        });
        row.append(rename, button(tr("保存", "Save"), "pn-document-rename-save", save), button(tr("取消", "Cancel"), "pn-document-rename-cancel", () => { renamingDocumentId = ""; renderDocumentLibrary(); }));
        els.documents.appendChild(row);
        root.requestAnimationFrame(() => rename.focus());
        return;
      }
      const open = button(documentName(record), "pn-document-open", () => openLibraryDocument(record.id), documentName(record));
      open.setAttribute("aria-current", String(record.id === currentDocumentId));
      const actions = element("details", { class: "pn-document-more" });
      actions.appendChild(element("summary", { class: "pn-document-more-trigger", "aria-label": tr("文档操作", "Document actions") }, "•••"));
      const menu = element("div", { class: "pn-document-more-menu" });
      menu.append(
        button(tr("重命名", "Rename"), "pn-document-more-item", () => { renamingDocumentId = record.id; renderDocumentLibrary(); }),
        button(tr("制作副本", "Duplicate"), "pn-document-more-item", () => duplicateLibraryDocument(record.id)),
        button(tr("删除文档", "Delete document"), "pn-document-more-item pn-document-danger", () => requestDeleteLibraryDocument(record.id))
      );
      actions.appendChild(menu);
      row.append(open, actions);
      els.documents.appendChild(row);
    });
  }
  function templateById(templateId) { return templates.find((template) => template.template.id === templateId); }
  async function activateDocument(record, options) {
    if (!record || !record.document) return;
    clearStructuralUndo();
    currentDocumentId = record.id;
    selectedTemplateId = "";
    state = Model.normalizeDocument(record.document, { allowRemoteImages: true });
    editRevision = 0;
    hasUnsavedChanges = false;
    renderAll();
    await refreshDocuments();
    root.requestAnimationFrame(syncCanvasScale);
    if (!options || options.status !== false) setStatus(tr("已打开文档", "Document opened"), "saved");
  }
  function localToday() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }
  function openNewProject() {
    els.newProjectName.value = "";
    els.newProjectName.removeAttribute("aria-invalid");
    els.newProjectModal.hidden = false;
    root.requestAnimationFrame(() => els.newProjectName.focus());
  }
  function closeNewProject() {
    els.newProjectModal.hidden = true;
    els.newProjectName.removeAttribute("aria-invalid");
  }
  function uniqueLibraryDocumentName(requestedName) {
    const name = String(requestedName || "").trim();
    const normalise = (value) => String(value || "").trim().toLocaleLowerCase();
    const occupied = new Set(documents.map((record) => normalise(documentName(record))).filter(Boolean));
    if (!occupied.has(normalise(name))) return name;
    let suffix = 1;
    let candidate = name + "(" + suffix + ")";
    while (occupied.has(normalise(candidate))) {
      suffix += 1;
      candidate = name + "(" + suffix + ")";
    }
    return candidate;
  }
  async function createNewProject() {
    const requestedName = String(els.newProjectName.value || "").trim();
    if (!requestedName) {
      els.newProjectName.setAttribute("aria-invalid", "true");
      els.newProjectName.focus();
      return;
    }
    const saved = await saveActiveDocumentNow();
    if (saved === "failed") {
      setStatus(tr("自动保存失败；请导出文档备份后再新建。", "Autosave failed — export a backup before creating a document."), "error");
      return;
    }
    await refreshDocuments();
    const name = uniqueLibraryDocumentName(requestedName);
    const project = Model.blankDocument({
      name,
      documentType: "Project",
      date: localToday(),
      proofMetadata: { fields: ["author", "date"] },
      runningHeader: { left: name, right: "Project" },
      headerSubtitle: { visible: true },
      blocks: [
        Model.createBlock("title", { content: name }),
        Model.createBlock("subtitle", { content: "A concise statement of the result." }),
        Model.createBlock("semantic", { kind: "introduction", appearance: "editorial", title: "Introduction", content: "" })
      ]
    });
    const created = await Store.createDocument(project);
    if (!created || !created.record || created.backend === "failed") {
      setStatus(tr("新建项目失败。", "Could not create project."), "error");
      return;
    }
    closeNewProject();
    await activateDocument(created.record, { status: false });
    setStatus(tr("已新建项目", "New project created"), "saved");
  }
  function chooseNewDocument() { openNewProject(); }
  async function useSelectedTemplate(templateId) {
    const template = templateById(templateId);
    if (!template) return;
    const saved = await saveActiveDocumentNow();
    if (saved === "failed") { setStatus(tr("自动保存失败；请导出文档备份后再继续。", "Autosave failed — export a backup before continuing."), "error"); return; }
    const document = Model.normalizeDocument(template.document);
    const title = document.blocks.find((block) => block.type === "title");
    document.metadata.name = String(title && title.content || "").trim() || template.template.name;
    const created = await Store.createDocument(document);
    if (!created || !created.record || created.backend === "failed") { setStatus(tr("无法从模板创建文档。", "Could not create a document from this template."), "error"); return; }
    selectedTemplateId = template.template.id;
    await activateDocument(created.record, { status: false });
    selectedTemplateId = template.template.id;
    renderTemplateLibrary();
    setStatus(tr("已从模板新建文档", "Document created from template"), "saved");
  }
  async function openLibraryDocument(id) {
    if (!id || id === currentDocumentId) return;
    const saved = await saveActiveDocumentNow();
    if (saved === "failed") { setStatus(tr("自动保存失败；请导出文档备份后再切换。", "Autosave failed — export a backup before switching documents."), "error"); return; }
    const opened = await Store.openDocument(id);
    if (!opened || !opened.record || opened.backend === "failed") { setStatus(tr("无法打开文档。", "Could not open document."), "error"); return; }
    await activateDocument(opened.record);
  }
  async function finishDocumentRename(id, name) {
    // Renaming a current document used to cancel the debounce timer and write
    // the older in-memory record back later. Flush first, then rename.
    if (id === currentDocumentId) {
      const saved = await saveActiveDocumentNow();
      if (saved === "failed") {
        setStatus(tr("重命名前无法保存当前更改。", "Could not save current changes before renaming."), "error");
        return;
      }
    }
    const renamed = await Store.renameDocument(id, name);
    if (!renamed || !renamed.record || renamed.backend === "failed") { setStatus(tr("重命名失败。", "Could not rename document."), "error"); return; }
    renamingDocumentId = "";
    if (id === currentDocumentId) {
      state.metadata.name = renamed.record.document.metadata.name;
      state.metadata.updatedAt = renamed.record.document.metadata.updatedAt;
      renderDocumentChrome();
    }
    await refreshDocuments();
    setStatus(tr("文档已重命名", "Document renamed"), "saved");
  }
  async function duplicateLibraryDocument(id) {
    if (id === currentDocumentId) {
      const saved = await saveActiveDocumentNow();
      if (saved === "failed") { setStatus(tr("自动保存失败；请导出文档备份后再复制。", "Autosave failed — export a backup before duplicating."), "error"); return; }
    }
    const source = documents.find((record) => record.id === id);
    const copiedName = documentName(source) + tr(" 副本", " copy");
    const duplicate = await Store.duplicateDocument(id, copiedName);
    if (!duplicate || !duplicate.record || duplicate.backend === "failed") { setStatus(tr("复制文档失败。", "Could not duplicate document."), "error"); return; }
    await activateDocument(duplicate.record, { status: false });
    setStatus(tr("已创建文档副本", "Document duplicated"), "saved");
  }
  async function openRemainingDocumentAfterDeletion() {
    // Deleting the active document must never leave its in-memory contents
    // detached from a local record. Otherwise opening another document would
    // first autosave that deleted state as an unintended extra document.
    currentDocumentId = "";
    hasUnsavedChanges = false;
    documents = await Store.listDocuments();
    const next = documents[0];
    if (next) {
      const opened = await Store.openDocument(next.id);
      if (!opened || !opened.record || opened.backend === "failed") return false;
      await activateDocument(opened.record, { status: false });
      return true;
    }

    // A completely empty library still needs an editable starting document.
    const created = await Store.createDocument(Model.blankDocument());
    if (!created || !created.record || created.backend === "failed") return false;
    await activateDocument(created.record, { status: false });
    return true;
  }
  function requestDeleteLibraryDocument(id) {
    const record = documents.find((item) => item.id === id);
    if (!record) return;
    openConfirm({
      title: tr("删除此文档？", "Delete this document?"),
      message: tr("“" + documentName(record) + "”将从此设备移除。", "“" + documentName(record) + "” will be removed from this device."),
      confirmLabel: tr("删除文档", "Delete document"),
      onConfirm: async () => {
        const backend = await Store.deleteDocument(id);
        if (backend === "failed") { setStatus(tr("删除文档失败。", "Could not delete document."), "error"); return; }
        if (id === currentDocumentId) {
          const opened = await openRemainingDocumentAfterDeletion();
          if (!opened) { setStatus(tr("删除后无法打开其余文档。", "Could not open a remaining document after deletion."), "error"); return; }
          setStatus(tr("文档已删除", "Document deleted"), "saved");
        } else {
          await refreshDocuments();
          setStatus(tr("文档已删除", "Document deleted"), "saved");
        }
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
  function outlineEditorialNumber(node) {
    if (!node || node.level !== 0 || !isEditorialPrimary(node.block)) return "";
    return editorialSectionNumber(node.index);
  }
  function outlineDisplayTitle(node) {
    if (!node) return "";
    // Older AI documents often put an ordinal into H1 text. Editorial
    // documents own their folio numbers, so reuse the same stripped title
    // that appears on paper rather than showing two competing numerals.
    if (outlineEditorialNumber(node) && node.block.type === "heading") {
      // An empty editorial H1 is still a visible chapter on the paper: its
      // canvas placeholder reads “Untitled section”. Keep that same useful
      // fallback in the Outline rather than rendering a numbered blank row.
      return editorialDisplayTitle(node.block, "content").trim() || node.title;
    }
    return node.title;
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
        // A blank generic heading is not useful navigation. Editorial H1s are
        // different: they are already a visible, numbered chapter on paper,
        // so retain them in the Outline with the same placeholder. Otherwise
        // a document can visibly have 01 / 02 / 03 while the navigator skips
        // 02, which is both misleading and breaks section operations.
        if (!title && !isEditorialPrimary(block)) { semanticLevel = 0; return; }
        if (!title) title = tr("未命名章节", "Untitled section");
        level = Math.max(0, Number(block.level || 1) - 1);
        semanticLevel = level + 1;
      } else if (block.type === "semantic" && block.kind === "section") {
        title = outlineTitle(block);
        // A neutral Section semantic block is a real top-level chapter: it
        // shares the editorial appearance of Introduction without inheriting
        // that domain-specific meaning, and can still own subsections.
        if (!title) { semanticLevel = 0; return; }
        level = 0;
        semanticLevel = 1;
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
  function getDirectContentInsertionIndex(blockId) {
    const range = getSectionRange(blockId);
    if (!range) return -1;
    // Direct content cannot be appended after a child subtree: doing that
    // makes it read as part of the final child when the flat block sequence is
    // rebuilt. Place it after existing direct content but before the first
    // structural child instead.
    const firstChild = range.node.children[0];
    return firstChild ? firstChild.index : range.end;
  }
  function getChildSectionInsertionIndex(blockId) {
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
    insertStructuralBlock(index, Model.createBlock("semantic", {
      kind: "section",
      appearance: "editorial",
      title: tr("未命名章节", "Untitled section"),
      content: ""
    }), true);
  }
  function addSubsection(blockId, placement) {
    const index = placement === "after" ? getSiblingInsertionIndex(blockId) : getChildSectionInsertionIndex(blockId);
    insertStructuralBlock(index, Model.createBlock("heading", { level: 2, content: tr("未命名小节", "Untitled subsection") }), true);
  }
  function addContentToSection(blockId, type) {
    const index = getDirectContentInsertionIndex(blockId);
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
  function moveStructuralNode(blockId, delta) {
    const range = getSectionRange(blockId);
    if (!range || !delta) return;
    const siblings = range.node.parent ? range.node.parent.children : buildOutlineTree().roots;
    const position = siblings.findIndex((node) => node.id === blockId);
    const target = siblings[position + delta];
    if (!target) return;
    const targetRange = getSectionRange(target.id);
    if (!targetRange) return;
    clearStructuralUndo();
    const moved = state.blocks.splice(range.start, range.end - range.start);
    const destination = delta > 0 ? targetRange.end - moved.length : targetRange.start;
    state.blocks.splice(destination, 0, ...moved);
    finishStructuralChange(blockId, false);
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
    const submenu = element("div", { class: "pn-outline-menu pn-outline-menu-submenu", role: "menu", "aria-label": tr("添加内容", "Add content") });
    let submenuOpen = false;
    let trigger = null;
    const setSubmenuOpen = (next, focusFirstItem) => {
      submenuOpen = Boolean(next);
      wrap.classList.toggle("is-open", submenuOpen);
      trigger.setAttribute("aria-expanded", String(submenuOpen));
      if (!submenuOpen || !focusFirstItem) return;
      root.requestAnimationFrame(() => {
        const firstItem = submenu.querySelector('[role="menuitem"]');
        if (firstItem) firstItem.focus();
      });
    };
    trigger = button(tr("添加内容", "Add content"), "pn-outline-menu-item pn-outline-menu-submenu-trigger", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Opening this is an explicit action, not a hover toggle. Pointer focus
      // happens before click in browsers; toggling here would immediately
      // close a submenu that focus had just revealed.
      setSubmenuOpen(true);
    });
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.appendChild(element("span", { class: "pn-outline-menu-arrow", "aria-hidden": "true" }, "›"));
    [
      ["paragraph", tr("正文", "Text")], ["equation", tr("独立公式", "Standalone equation")], ["table", tr("表格", "Table")],
      ["code", tr("代码", "Code")], ["image", tr("图片", "Image")], ["list", tr("列表", "List")],
      ["quote", tr("引文", "Citation")], ["callout", tr("注释框", "Callout")]
    ].forEach(([type, name]) => addOutlineMenuButton(submenu, name, "add-content-" + type, () => addContentToSection(node.id, type)));
    wrap.append(trigger, submenu);
    // The chooser must not disappear while the pointer crosses from the
    // parent menu into it. Keep it open until a command, Escape, or an
    // outside click closes the entire structural menu.
    wrap.addEventListener("focusin", (event) => {
      // :focus-within keeps the submenu available when the trigger receives
      // focus. Once a choice itself receives focus, retain the explicit state.
      if (event.target !== trigger) setSubmenuOpen(true);
    });
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setSubmenuOpen(true, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSubmenuOpen(false);
        trigger.focus();
      }
    });
    menu.appendChild(wrap);
  }
  function populateOutlineMenu(node) {
    const menu = els.outlineMenu;
    const primary = isPrimaryStructureNode(node);
    const secondary = isSecondaryStructureNode(node);
    if (primary) {
      addOutlineMenuButton(menu, tr("添加同级章节", "Add sibling section"), "add-section-after", () => addSectionAfter(node.id));
      addOutlineMenuButton(menu, tr("添加子章节", "Add child section"), "add-subsection", () => addSubsection(node.id, "child"));
      addContentMenu(menu, node);
      addOutlineMenuRule(menu);
      addOutlineMenuButton(menu, tr("复制章节", "Duplicate section"), "duplicate-section", () => duplicateStructuralNode(node.id));
      addOutlineMenuRule(menu);
    } else if (secondary) {
      addOutlineMenuButton(menu, tr("添加同级小节", "Add sibling subsection"), "add-subsection-after", () => addSubsection(node.id, "after"));
      addContentMenu(menu, node);
      addOutlineMenuRule(menu);
      addOutlineMenuButton(menu, tr("复制小节", "Duplicate subsection"), "duplicate-subsection", () => duplicateStructuralNode(node.id));
      addOutlineMenuRule(menu);
    }
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
    const editorialNumber = outlineEditorialNumber(node);
    const title = outlineDisplayTitle(node);
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
    const item = button("", "pn-outline-item", () => focusBlock(node.id), title);
    item.dataset.blockId = node.id;
    item.setAttribute("aria-label", (editorialNumber ? editorialNumber + " " : "") + title);
    if (editorialNumber) item.appendChild(element("span", { class: "pn-outline-number", "aria-hidden": "true" }, editorialNumber));
    item.appendChild(element("span", { class: "pn-outline-label" }, title));
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
    more.setAttribute("aria-label", tr("打开“" + title + "”的结构操作", "Open structure actions for “" + title + "”"));
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
  function isProofMetadataSelected() { return selectedBlockId === PROOF_METADATA_SELECTION; }
  function applyCanvasSelection() {
    document.querySelectorAll(".pn-canvas-block").forEach((node) => {
      const selected = node.dataset.blockId === selectedBlockId || (node.dataset.documentHeader === "proof" && isProofMetadataSelected());
      node.classList.toggle("is-selected", selected);
    });
  }
  function selectProofMetadata(options) {
    if (!hasDocumentMetadataHeader()) return;
    selectedBlockId = PROOF_METADATA_SELECTION;
    activeOutlineBlockId = "";
    insertionIndex = null;
    applyCanvasSelection();
    syncOutlineActiveState();
    renderInspector();
    if (!options || options.openInspector !== false) setDetailOpen(true);
  }
  function clearCanvasSelection() {
    if (!selectedBlockId) return;
    selectedBlockId = "";
    activeOutlineBlockId = "";
    insertionIndex = null;
    applyCanvasSelection();
    syncOutlineActiveState();
    renderInspector();
    setDetailOpen(false);
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
    if (selectedBlockId && !isProofMetadataSelected()) {
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
    editRevision += 1;
    hasUnsavedChanges = true;
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
    if (isProjectDocument() && block.type === "title" && key === "content") {
      setProjectDocumentName(value, null);
    }
    const affectsOutline = block.type === "title" || block.type === "heading" || block.type === "semantic";
    changed(Object.assign({ outline: affectsOutline }, options || {}));
  }
  function canvasField(block, key, options) {
    const opts = options || {};
    return inputField("", opts.value === undefined ? block[key] : opts.value, (value) => update(block, key, value, opts.change), {
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
  function isProjectDocument() {
    return Boolean(state && state.metadata && state.metadata.documentType === "Project");
  }
  function projectRunningHeader() {
    const metadata = state && state.metadata ? state.metadata : {};
    const header = metadata.runningHeader && typeof metadata.runningHeader === "object" ? metadata.runningHeader : {};
    const has = (key) => Object.prototype.hasOwnProperty.call(header, key);
    return {
      // The left running title and page footer are both the document name.
      // An explicitly blank runningHeader.left intentionally hides a running
      // title in older/imported Projects. Any subsequent title edit writes the
      // canonical metadata name to both surfaces.
      left: has("left") ? String(header.left || "") : String(metadata.name || tr("未命名文档", "Untitled document")),
      right: has("right") ? String(header.right || "") : "Project"
    };
  }
  function syncProjectDocumentNameControls(value, source) {
    const name = String(value || "");
    const controls = [
      els.pageHeader && els.pageHeader.querySelector(".pn-running-left"),
      els.canvas && els.canvas.querySelector(".pn-canvas-title-input"),
      els.footer
    ];
    controls.filter(Boolean).forEach((control) => {
      if (control === source) return;
      if (control === els.footer) control.textContent = name;
      else if (control.value !== name) control.value = name;
    });
  }
  function setProjectDocumentName(value, source) {
    if (!state || !isProjectDocument()) return;
    const name = String(value || "");
    const current = projectRunningHeader();
    state.metadata.name = name;
    state.metadata.runningHeader = { left: name, right: current.right };
    const title = state.blocks.find((block) => block && block.type === "title");
    if (title) title.content = name;
    syncProjectDocumentNameControls(name, source);
  }
  function updateProjectRunningHeader(side, value, source) {
    if (!state || !isProjectDocument()) return;
    const current = projectRunningHeader();
    if (side === "left") setProjectDocumentName(value, source);
    else state.metadata.runningHeader = { left: current.left, right: String(value || "") };
    // Do not rerender the chrome while its input has focus: doing so would
    // reset the caret on every character. The sibling values are patched above.
    changed();
  }
  function hasDocumentMetadataHeader() {
    return isProofNoteDocument() || isProjectDocument();
  }
  function semanticAppearance(block) {
    if (block && (block.appearance === "editorial" || block.appearance === "card")) return block.appearance;
    // Structural sections and introductions are continuous reading surfaces
    // only in the editorial Project and Proof Note presets. Imported/general
    // documents remain neutral unless their block explicitly opts in.
    return isProofNoteDocument() || (isProjectDocument() && block && block.type === "semantic" && ["introduction", "section"].includes(block.kind))
      ? "editorial" : "card";
  }
  function semanticPresentationValue(block) {
    return block && (block.appearance === "editorial" || block.appearance === "card") ? block.appearance : "auto";
  }
  function setSemanticPresentation(block, value) {
    if (!block) return;
    if (value === "auto") delete block.appearance;
    else block.appearance = value;
    changed({ structure: true, inspector: true });
  }
  function isEditorialPrimary(block) {
    // Level-one headings are a compatibility path for older/generated JSON
    // inside the editorial presets. General imports retain their own H1 look.
    if (block.type === "heading") return (isProofNoteDocument() || isProjectDocument()) && block.level === 1;
    if (block.type !== "semantic" || semanticAppearance(block) !== "editorial") return false;
    if (["section", "introduction"].includes(block.kind)) return true;
    return (isProofNoteDocument() || isProjectDocument()) && ["introduction", "problem", "result", "theorem"].includes(block.kind);
  }
  function editorialDisplayTitle(block, key) {
    const title = String(block && block[key] || "");
    if (!block || block.type !== "heading" || block.level !== 1) return title;
    // Older AI prompts frequently generated "1. Title" or "01 Title".
    // The renderer already supplies that number as a separate visual element,
    // so omit only a leading one- or two-digit/roman-numeral marker on paper.
    return title.replace(/^\s*(?:(?:\d{1,2}|[ivxlcdm]+)\s*(?:[.)]|[：:])\s*|(?:\d{1,2}|[ivxlcdm]+)\s+)(?=\S)/i, "");
  }
  function editorialBodyVisible(block) {
    return !block || block.bodyVisible !== false;
  }
  function setEditorialBodyVisible(block, visible) {
    if (!block || block.type !== "semantic") return;
    if (visible) delete block.bodyVisible;
    else block.bodyVisible = false;
    changed({ structure: true, inspector: true });
  }
  function semanticSummaryVisible(block) {
    return Boolean(block && (String(block.summary || "").trim() || block.__pnSummaryDraft));
  }
  function showSemanticSummary(block) {
    if (!block) return;
    // An empty note opened by the author is an editor-only affordance. The
    // portable document remains unchanged until the author writes its text.
    block.__pnSummaryDraft = true;
    changed({ structure: true, inspector: true });
    focusCanvasControl(block.id, ".pn-canvas-component-summary-input");
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
  function proofMetadataFields() {
    const metadata = state && state.metadata ? state.metadata : {};
    const configured = metadata.proofMetadata && Array.isArray(metadata.proofMetadata.fields)
      ? metadata.proofMetadata.fields : PROOF_METADATA_FIELDS;
    const requested = new Set(configured.filter((field) => PROOF_METADATA_FIELDS.includes(field)));
    return PROOF_METADATA_FIELDS.filter((field) => requested.has(field));
  }
  function setProofMetadataFieldVisible(field, visible) {
    const next = new Set(proofMetadataFields());
    if (visible) next.add(field);
    else next.delete(field);
    state.metadata.proofMetadata = { fields: PROOF_METADATA_FIELDS.filter((key) => next.has(key)) };
    // A completely hidden group remains selected in the Inspector, so it can
    // always be restored without relying on an accidental browser refresh.
    changed({ structure: true, inspector: true, chrome: true });
  }
  function enableProofMetadata() {
    state.metadata.proofMetadata = { fields: PROOF_METADATA_FIELDS.slice() };
    changed({ structure: true, inspector: true, chrome: true });
  }
  function headerTitleIndex() {
    return state ? state.blocks.findIndex((block) => block.type === "title") : -1;
  }
  function headerSubtitleIndex() {
    const titleIndex = headerTitleIndex();
    if (titleIndex < 0 || !state) return -1;
    const subtitleIndex = state.blocks.findIndex((block) => block.type === "subtitle");
    return subtitleIndex === titleIndex + 1 ? subtitleIndex : -1;
  }
  function headerSubtitleVisible() {
    const display = state && state.metadata && state.metadata.headerSubtitle;
    return headerSubtitleIndex() >= 0 && !(display && display.visible === false);
  }
  function setHeaderSubtitleVisible(visible) {
    if (!state || !hasDocumentMetadataHeader()) return;
    const titleIndex = headerTitleIndex();
    if (visible && titleIndex >= 0 && headerSubtitleIndex() < 0) {
      state.blocks.splice(titleIndex + 1, 0, Model.createBlock("subtitle", { content: "A concise statement of the result." }));
    }
    state.metadata.headerSubtitle = { visible: Boolean(visible) };
    changed({ structure: true, inspector: true, chrome: true });
  }
  function renderProofMetadata(options) {
    const opts = options || {};
    const values = proofMetadataValues();
    const fields = proofMetadataFields().map((key) => [key, {
      author: tr("作者", "Author"), date: tr("日期", "Date"), status: tr("状态", "Status")
    }[key]]);
    if (!fields.length) return null;
    const metadata = element("section", { class: "pn-proof-metadata", "aria-label": tr("文档信息", "Document details") });
    if (!opts.embedded) metadata.tabIndex = 0;
    const grid = element("dl", { class: "pn-proof-metadata-grid" });
    grid.style.gridTemplateColumns = "repeat(" + fields.length + ", minmax(0, 1fr))";
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
    if (!opts.embedded) {
      metadata.addEventListener("pointerdown", (event) => {
        selectProofMetadata({ openInspector: !event.target.closest("input, textarea, select") });
      });
      metadata.addEventListener("click", (event) => {
        if (!event.target.closest("input, textarea, select, button")) selectProofMetadata();
      });
      metadata.addEventListener("focusin", () => selectProofMetadata({ openInspector: false }));
    }
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
  function proofHeaderRange() {
    if (!hasDocumentMetadataHeader()) return null;
    const titleIndex = headerTitleIndex();
    const subtitleIndex = state.blocks.findIndex((block) => block.type === "subtitle");
    if (titleIndex < 0) return null;
    // A template may intentionally omit its subtitle, but unrelated content
    // must never be silently pulled into the masthead by a non-adjacent block.
    if (subtitleIndex >= 0 && subtitleIndex !== titleIndex + 1) return null;
    return { titleIndex, subtitleIndex, subtitleVisible: headerSubtitleVisible(), endIndex: subtitleIndex >= 0 ? subtitleIndex : titleIndex };
  }
  function renderProofHeader(range) {
    const header = element("section", { class: "pn-canvas-block pn-canvas-proof-header", "aria-label": tr("文档标题区", "Document header"), tabindex: "0" });
    header.dataset.documentHeader = "proof";
    const grip = button("⋮⋮", "pn-canvas-grip", () => selectProofMetadata(), tr("选择文档标题区", "Select document header"));
    grip.setAttribute("aria-label", tr("选择文档标题区", "Select document header"));
    const overflow = button("⋯", "pn-canvas-overflow", () => selectProofMetadata(), tr("打开文档标题区设置", "Open document header settings"));
    overflow.setAttribute("aria-label", tr("打开文档标题区设置", "Open document header settings"));
    header.append(grip, overflow);
    const content = element("div", { class: "pn-canvas-content" });
    const title = state.blocks[range.titleIndex];
    const titleContent = element("div");
    buildCanvasFields(titleContent, title, range.titleIndex);
    content.appendChild(titleContent);
    if (range.subtitleIndex >= 0 && range.subtitleVisible) {
      const subtitle = state.blocks[range.subtitleIndex];
      const subtitleContent = element("div");
      buildCanvasFields(subtitleContent, subtitle, range.subtitleIndex);
      content.appendChild(subtitleContent);
    }
    const metadata = renderProofMetadata({ embedded: true });
    if (metadata) content.appendChild(metadata);
    header.appendChild(content);
    header.addEventListener("pointerdown", (event) => {
      selectProofMetadata({ openInspector: !event.target.closest("input, textarea, select") });
    });
    header.addEventListener("click", (event) => {
      if (!event.target.closest("input, textarea, select, button")) selectProofMetadata();
    });
    header.addEventListener("focusin", () => selectProofMetadata({ openInspector: false }));
    return header;
  }
  function renderCanvas() {
    els.canvas.innerHTML = "";
    els.canvas.classList.toggle("pn-proofnote-document", isProofNoteDocument());
    els.canvas.classList.toggle("pn-project-document", isProjectDocument());
    const headerRange = proofHeaderRange();
    // Older imported Proof Note documents can place title and subtitle apart.
    // Preserve the metadata in that unusual ordering instead of dropping it
    // simply because those blocks cannot safely form one visual header.
    const fallbackMetadataIndex = !headerRange && hasDocumentMetadataHeader()
      ? state.blocks.findIndex((block) => block.type === "subtitle")
      : -1;
    state.blocks.forEach((block, index) => {
      if (headerRange && index === headerRange.titleIndex) {
        els.canvas.appendChild(renderProofHeader(headerRange));
        els.canvas.appendChild(renderInsertAffordance(headerRange.endIndex + 1, headerRange.endIndex === state.blocks.length - 1));
        return;
      }
      if (headerRange && index === headerRange.subtitleIndex) return;
      els.canvas.appendChild(renderCanvasBlock(block, index));
      if (index === fallbackMetadataIndex) {
        const metadata = renderProofMetadata();
        if (metadata) els.canvas.appendChild(metadata);
      }
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
      // A control inside a block performs its own focused action. In
      // particular, copying code should not turn a lightweight confirmation
      // into an unexpected Inspector transition.
      selectBlock(block.id, { openInspector: !event.target.closest("input, textarea, select, button") });
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
      // Keep the paragraph's inner content class distinct from the outer
      // `.pn-canvas-paragraph` block. Sharing that name let the inner
      // spacing rule override the outer canvas gutter and visibly shifted
      // paragraphs to the right of editorial section bodies.
      body.className = "pn-canvas-paragraph-content";
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-paragraph-field", controlClass: "pn-canvas-paragraph-input", placeholder: label("开始输入…", "Start writing…") }));
      return;
    }
    if (block.type === "equation") {
      body.className = "pn-equation pn-canvas-equation";
      const field = canvasField(block, "content", { fieldClass: "pn-canvas-equation-field", controlClass: "pn-canvas-equation-input", placeholder: "\\\\[ … \\]" });
      const preview = element("div", { class: "pn-equation-preview", "aria-live": "polite" });
      const refreshPreview = () => {
        const value = String(block.content || "").trim();
        preview.hidden = !value;
        preview.innerHTML = value ? math(value) : "";
      };
      field.querySelector("textarea, input").addEventListener("input", refreshPreview);
      refreshPreview();
      body.append(field, preview);
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
      if (isSemantic && ["result", "verification"].includes(block.kind)) {
        if (semanticSummaryVisible(block)) {
          body.appendChild(canvasField(block, "summary", { fieldClass: "pn-canvas-component-summary", controlClass: "pn-canvas-component-summary-input", placeholder: label("添加备注…", "Add note…") }));
        } else {
          body.appendChild(button(label("＋ 添加备注", "+ Add note"), "pn-component-add-summary", () => showSemanticSummary(block)));
        }
      }
      return;
    }
    if (block.type === "code") {
      body.className = "pn-code pn-canvas-code";
      body.appendChild(element("span", { class: "pn-code-language" }, codeLanguageDisplay(block.language)));
      body.appendChild(canvasField(block, "content", { fieldClass: "pn-canvas-code-field", controlClass: "pn-canvas-code-input", rows: 6, placeholder: label("粘贴或输入代码", "Paste or write code") }));
      const codeCopy = button("", "pn-code-copy", async () => {
        const copied = await copyBlockText(block.content);
        if (!copied) return;
        setCodeCopyButtonState(codeCopy, true);
        root.setTimeout(() => setCodeCopyButtonState(codeCopy, false), 1350);
      });
      setCodeCopyButtonState(codeCopy, false);
      body.appendChild(codeCopy);
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
    if (block.type === "image") { buildCanvasImage(body, block); return; }
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
      value: editorialDisplayTitle(block, titleKey),
      fieldClass: "pn-editorial-section-title",
      controlClass: "pn-editorial-section-title-input",
      placeholder: label("未命名章节", "Untitled section"),
      change: { outline: true }
    }));
    body.appendChild(head);
    if (block.type === "semantic" && editorialBodyVisible(block)) {
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
  function focusCanvasControl(blockId, selector) {
    root.requestAnimationFrame(() => {
      const canvasBlock = document.getElementById("pn-block-" + blockId);
      const control = canvasBlock && canvasBlock.querySelector(selector);
      if (!control) return;
      control.focus();
      if (typeof control.setSelectionRange === "function") control.setSelectionRange(0, 0);
    });
  }
  function reachedCollectionLimit(limit, message) {
    if (limit === undefined || limit === null) return false;
    if (Number.isFinite(limit) && limit > 0) return false;
    setStatus(message, "warning");
    return true;
  }
  function collectionTools(actions) {
    const tools = element("div", { class: "pn-collection-tools", "aria-label": tr("内容操作", "Content actions") });
    actions.forEach(([text, className, handler]) => tools.appendChild(button(text, "pn-collection-action " + (className || ""), handler)));
    return tools;
  }
  function addListItem(block, index, initialValue) {
    if (reachedCollectionLimit(Model.LIMITS.maxListItems - block.items.length, tr("列表最多可包含 1000 项。", "A list can contain at most 1,000 items."))) return;
    const nextIndex = Math.max(0, Math.min(block.items.length, index));
    block.items.splice(nextIndex, 0, initialValue || "");
    changed({ structure: true, inspector: true });
    focusCanvasControl(block.id, '.pn-canvas-list-input[data-item-index="' + nextIndex + '"]');
  }
  function removeListItem(block, index) {
    if (block.items.length <= 1) {
      block.items[0] = "";
      changed();
      focusCanvasControl(block.id, '.pn-canvas-list-input[data-item-index="0"]');
      return;
    }
    block.items.splice(index, 1);
    const nextIndex = Math.max(0, Math.min(index - 1, block.items.length - 1));
    changed({ structure: true, inspector: true });
    focusCanvasControl(block.id, '.pn-canvas-list-input[data-item-index="' + nextIndex + '"]');
  }
  function buildCanvasList(body, block) {
    const list = element(block.ordered ? "ol" : "ul", { class: "pn-list pn-canvas-list" });
    block.items.forEach((item, itemIndex) => {
      const row = element("li", { class: "pn-canvas-list-row" });
      const field = inputField("", item, (value) => { block.items[itemIndex] = value; changed(); }, { multiline: true, rows: 1, fieldClass: "pn-canvas-list-field", controlClass: "pn-canvas-list-input", autoGrow: true, ariaLabel: tr("列表项目", "List item") });
      const control = field.querySelector("textarea, input");
      control.dataset.itemIndex = String(itemIndex);
      control.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const start = Number.isFinite(control.selectionStart) ? control.selectionStart : String(block.items[itemIndex] || "").length;
          const value = String(block.items[itemIndex] || "");
          block.items[itemIndex] = value.slice(0, start);
          addListItem(block, itemIndex + 1, value.slice(start));
        } else if (event.key === "Backspace" && !control.value && control.selectionStart === 0) {
          event.preventDefault();
          removeListItem(block, itemIndex);
        }
      });
      row.append(field, button("×", "pn-collection-remove", () => removeListItem(block, itemIndex), tr("删除此项", "Remove item")));
      list.appendChild(row);
    });
    body.append(list, collectionTools([[tr("＋ 添加项目", "+ Add item"), "", () => addListItem(block, block.items.length, "")]]));
  }
  function dataItemDefault(type) {
    return type === "key-value" ? { label: "", value: "" } : { kicker: "", value: "", body: "" };
  }
  function addDataItem(block) {
    if (reachedCollectionLimit(Model.LIMITS.maxDataItems - block.items.length, tr("此内容块最多可包含 1000 项。", "This block can contain at most 1,000 items."))) return;
    block.items.push(dataItemDefault(block.type));
    changed({ structure: true, inspector: true });
  }
  function removeDataItem(block, index) {
    if (block.items.length <= 1) {
      block.items[0] = dataItemDefault(block.type);
      changed({ structure: true, inspector: true });
      return;
    }
    block.items.splice(index, 1);
    changed({ structure: true, inspector: true });
  }
  function buildCanvasData(body, block) {
    if (block.type === "key-value") {
      const list = element("dl", { class: "pn-key-value pn-canvas-key-value" });
      block.items.forEach((item, itemIndex) => {
        const row = element("div");
        const term = element("dt"); const description = element("dd");
        term.appendChild(inputField("", item.label, (value) => { item.label = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-key", controlClass: "pn-canvas-key-input", ariaLabel: tr("名称", "Label") }));
        description.appendChild(inputField("", item.value, (value) => { item.value = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-value", controlClass: "pn-canvas-value-input", ariaLabel: tr("内容", "Value") }));
        row.append(term, description, button("×", "pn-collection-remove", () => removeDataItem(block, itemIndex), tr("删除此项", "Remove item"))); list.appendChild(row);
      });
      body.append(list, collectionTools([[tr("＋ 添加项目", "+ Add item"), "", () => addDataItem(block)]])); return;
    }
    const cards = element("div", { class: "pn-stats pn-canvas-stats" });
    block.items.forEach((item, itemIndex) => {
      const card = element("div", { class: "pn-stat" });
      card.appendChild(inputField("", item.kicker, (value) => { item.kicker = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-stat-kicker", controlClass: "pn-canvas-stat-kicker-input", ariaLabel: tr("标签", "Kicker") }));
      card.appendChild(inputField("", item.value, (value) => { item.value = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-stat-value", controlClass: "pn-canvas-stat-value-input", ariaLabel: tr("数值", "Value") }));
      card.appendChild(inputField("", item.body, (value) => { item.body = value; changed(); }, { multiline: true, rows: 1, fieldClass: "pn-canvas-stat-body", controlClass: "pn-canvas-stat-body-input", autoGrow: true, ariaLabel: tr("说明", "Description") }));
      card.appendChild(button("×", "pn-collection-remove", () => removeDataItem(block, itemIndex), tr("删除此项", "Remove item")));
      cards.appendChild(card);
    });
    body.append(cards, collectionTools([[tr("＋ 添加项目", "+ Add item"), "", () => addDataItem(block)]]));
  }
  function tableHasHeader(block) { return block.header !== false; }
  function tableColumnCount(block) { return Array.isArray(block.columns) && block.columns.length ? block.columns.length : 1; }
  function addTableRow(block) {
    if (reachedCollectionLimit(Model.LIMITS.maxTableRows - block.rows.length, tr("表格最多可包含 500 行。", "A table can contain at most 500 rows."))) return;
    block.rows.push(Array.from({ length: tableColumnCount(block) }, () => ""));
    changed({ structure: true, inspector: true });
    focusCanvasControl(block.id, '.pn-canvas-table-input[data-row-index="' + (block.rows.length - 1) + '"][data-column-index="0"]');
  }
  function removeTableRow(block, rowIndex) {
    if (block.rows.length <= 1) {
      block.rows[0] = Array.from({ length: tableColumnCount(block) }, () => "");
    } else block.rows.splice(rowIndex, 1);
    changed({ structure: true, inspector: true });
  }
  function addTableColumn(block) {
    if (reachedCollectionLimit(Model.LIMITS.maxTableColumns - tableColumnCount(block), tr("表格最多可包含 50 列。", "A table can contain at most 50 columns."))) return;
    const columnIndex = tableColumnCount(block);
    block.columns.push(tableHasHeader(block) ? tr("列 " + (columnIndex + 1), "Column " + (columnIndex + 1)) : "");
    block.rows.forEach((row) => row.push(""));
    changed({ structure: true, inspector: true });
  }
  function removeTableColumn(block, columnIndex) {
    if (tableColumnCount(block) <= 1) {
      setStatus(tr("表格至少需要一列。", "A table needs at least one column."), "warning");
      return;
    }
    block.columns.splice(columnIndex, 1);
    block.rows.forEach((row) => row.splice(columnIndex, 1));
    changed({ structure: true, inspector: true });
  }
  function setTableHeader(block, visible) {
    const isVisible = tableHasHeader(block);
    if (visible === isVisible) return;
    if (visible) {
      const firstRow = block.rows.shift() || Array.from({ length: tableColumnCount(block) }, () => "");
      block.columns = Array.from({ length: tableColumnCount(block) }, (_, index) => String(firstRow[index] || ""));
      block.header = true;
    } else {
      block.rows.unshift(block.columns.slice());
      block.columns = block.columns.map(() => "");
      block.header = false;
    }
    changed({ structure: true, inspector: true });
  }
  function imageFilePicker(block, labelText) {
    const file = element("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", hidden: "" });
    const choose = button(labelText || tr("选择本地图片", "Choose local image"), "pn-add-inline", () => file.click());
    file.addEventListener("change", () => {
      const image = file.files && file.files[0];
      if (!image) return;
      if (image.size > MAX_LOCAL_IMAGE_BYTES) {
        setStatus(tr("图片超过 10MB 上限。", "Image exceeds the 10 MB limit."), "error");
        file.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        block.src = String(reader.result || "");
        delete block.remoteApproved;
        if (!block.alt) block.alt = image.name.replace(/\.[^.]+$/, "");
        changed({ structure: true, inspector: true });
      };
      reader.readAsDataURL(image);
    });
    const picker = element("div", { class: "pn-image-picker" });
    picker.append(choose, file);
    return picker;
  }
  function buildCanvasImage(body, block) {
    const source = safeImageSource(block);
    if (source) {
      const figure = element("figure", { class: "pn-image pn-canvas-image" });
      figure.appendChild(element("img", { src: source, alt: block.alt || "", referrerpolicy: "no-referrer" }));
      const caption = canvasField(block, "caption", {
        multiline: false,
        fieldClass: "pn-canvas-image-caption",
        controlClass: "pn-canvas-image-caption-input",
        placeholder: tr("添加图片说明…", "Add a caption…")
      });
      figure.appendChild(caption);
      body.append(figure, imageFilePicker(block, tr("替换图片", "Replace image")));
      return;
    }
    const remote = /^https:\/\//i.test(String(block.src || "").trim());
    body.appendChild(element("div", { class: "pn-image-empty" }, remote
      ? tr("远程图片等待确认加载。", "Remote image awaits approval to load.")
      : tr("选择一张本地图片，或在检查器中添加安全的图片 URL。", "Choose a local image, or add a safe image URL in Inspector.")));
    body.appendChild(imageFilePicker(block, tr("选择本地图片", "Choose local image")));
  }
  function buildCanvasTable(body, block) {
    const wrap = element("div", { class: "pn-table-wrap pn-canvas-table-wrap" });
    const table = element("table", { class: "pn-table pn-canvas-table" });
    if (tableHasHeader(block)) {
      const head = element("thead"); const headRow = element("tr");
      block.columns.forEach((column, columnIndex) => {
        const cell = element("th", { class: "pn-canvas-table-head-cell" });
        const field = inputField("", column, (value) => { block.columns[columnIndex] = value; changed(); }, { multiline: false, fieldClass: "pn-canvas-table-field", controlClass: "pn-canvas-table-input", ariaLabel: tr("列名", "Column") });
        field.querySelector("textarea, input").dataset.columnIndex = String(columnIndex);
        cell.append(field, button("×", "pn-table-column-remove", () => removeTableColumn(block, columnIndex), tr("删除此列", "Remove column")));
        headRow.appendChild(cell);
      });
      head.appendChild(headRow); table.appendChild(head);
    }
    const tableBody = element("tbody");
    block.rows.forEach((row, rowIndex) => {
      const rowEl = element("tr");
      block.columns.forEach((_, columnIndex) => {
        const cell = element("td");
        const field = inputField("", row[columnIndex], (value) => { row[columnIndex] = value; changed(); }, { multiline: true, rows: 1, fieldClass: "pn-canvas-table-field", controlClass: "pn-canvas-table-input", autoGrow: true, ariaLabel: tr("单元格", "Cell") });
        const control = field.querySelector("textarea, input");
        control.dataset.rowIndex = String(rowIndex);
        control.dataset.columnIndex = String(columnIndex);
        cell.appendChild(field);
        if (columnIndex === tableColumnCount(block) - 1) cell.appendChild(button("×", "pn-table-row-remove", () => removeTableRow(block, rowIndex), tr("删除此行", "Remove row")));
        rowEl.appendChild(cell);
      });
      tableBody.appendChild(rowEl);
    });
    table.appendChild(tableBody); wrap.appendChild(table);
    body.append(wrap, collectionTools([
      [tr("＋ 添加行", "+ Add row"), "", () => addTableRow(block)],
      [tr("＋ 添加列", "+ Add column"), "", () => addTableColumn(block)]
    ]));
  }
  function renderInsertAffordance(index, isLast) {
    const point = element("div", { class: "pn-insert-point" + (isLast ? " pn-insert-last" : "") });
    if (insertionIndex === index) {
      const menu = element("div", { class: "pn-insert-menu", role: "group", "aria-label": tr("选择内容块", "Choose block") });
      INSERTABLE_BLOCK_TYPES.forEach((type) => menu.appendChild(button(insertionOptionText(type), "pn-insert-choice", () => insertBlock(type, index))));
      point.appendChild(menu);
      point.appendChild(button(tr("取消", "Cancel"), "pn-insert-cancel", () => { insertionIndex = null; renderCanvas(); }));
      return point;
    }
    point.appendChild(button(isLast ? tr("+ 添加内容块", "+ Add block") : "+", "pn-insert-trigger", () => { insertionIndex = index; renderCanvas(); }, isLast ? tr("添加内容块", "Add block") : tr("在此处添加内容块", "Insert block here")));
    return point;
  }
  function insertBlock(type, index) {
    clearStructuralUndo();
    // Adding a chapter from the document picker should produce the same
    // numbered, ruled editorial section used by a new project's Introduction,
    // never a bare generic H1.
    const block = type === "section"
      ? Model.createBlock("semantic", {
        kind: "section",
        appearance: "editorial",
        title: tr("未命名章节", "Untitled section"),
        content: ""
      })
      : Model.createBlock(type);
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
  function copyWithLegacyClipboard(text) {
    const fallback = element("textarea", { "aria-hidden": "true", tabindex: "-1" });
    fallback.value = text;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    fallback.style.pointerEvents = "none";
    document.body.appendChild(fallback);
    try {
      fallback.select();
      return Boolean(document.execCommand && document.execCommand("copy"));
    } finally {
      fallback.remove();
    }
  }
  function codeCopyIcon(copied) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pn-code-copy-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const line = (d) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    };
    if (copied) line("m5 12 4 4L19 6");
    else {
      line("M8 6.5h7.5l3 3v10.5H8z");
      line("M15.5 6.5v3h3");
      line("M5.5 9.5v10h10");
    }
    return svg;
  }
  function setCodeCopyButtonState(control, copied) {
    const isCopied = Boolean(copied);
    control.classList.toggle("is-copied", isCopied);
    control.setAttribute("aria-label", isCopied ? tr("代码已复制", "Code copied") : tr("复制代码", "Copy code"));
    control.title = isCopied ? tr("代码已复制", "Code copied") : tr("复制代码", "Copy code");
    control.replaceChildren(codeCopyIcon(isCopied));
  }
  async function copyBlockText(value) {
    const text = String(value || "");
    if (!text) {
      setStatus(tr("没有可复制的内容。", "There is nothing to copy."), "warning");
      return false;
    }
    try {
      let copied = false;
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        try {
          await root.navigator.clipboard.writeText(text);
          copied = true;
        } catch (_) {
          // The API can exist while permission is denied. Try the compatible
          // path before asking the author to copy the code manually.
        }
      }
      if (!copied) copied = copyWithLegacyClipboard(text);
      if (!copied) throw new Error("copy failed");
      setStatus(tr("已复制代码。", "Code copied."), "saved");
      return true;
    } catch (_) {
      setStatus(tr("无法复制；请手动复制。", "Could not copy; please copy manually."), "warning");
      return false;
    }
  }
  function inspectorActionRow(labelText, actions) {
    const row = element("div", { class: "pn-inspector-property pn-inspector-action-row" });
    row.appendChild(element("span", { class: "pn-inspector-property-label" }, labelText));
    const controls = element("span", { class: "pn-inspector-property-controls" });
    actions.forEach(([text, handler, danger]) => controls.appendChild(button(text, "pn-inspector-mini-action" + (danger ? " pn-danger" : ""), handler)));
    row.appendChild(controls);
    return row;
  }
  function buildTableInspector(panel, block) {
    const label = (zh, en) => tr(zh, en);
    const appearance = element("section", { class: "pn-inspector-group", "aria-label": label("表格", "Table") });
    appearance.appendChild(element("div", { class: "pn-inspector-group-title" }, label("表格", "Table")));
    appearance.appendChild(inspectorToggle(label("显示表头", "Header row"), tableHasHeader(block), (visible) => setTableHeader(block, visible)));
    appearance.appendChild(inspectorActionRow(label("行", "Rows"), [
      [label("添加", "Add"), () => addTableRow(block)],
      [label("删除末行", "Remove last"), () => removeTableRow(block, block.rows.length - 1)]
    ]));
    appearance.appendChild(inspectorActionRow(label("列", "Columns"), [
      [label("添加", "Add"), () => addTableColumn(block)],
      [label("删除末列", "Remove last"), () => removeTableColumn(block, tableColumnCount(block) - 1)]
    ]));
    panel.appendChild(appearance);
  }
  function renderInspector() {
    if (!els.inspector) return;
    els.inspector.innerHTML = "";
    if (els.inspectorTopLabel) els.inspectorTopLabel.textContent = isProofMetadataSelected() ? tr("文档", "Document") : tr("内容块", "Block");
    if (isProofMetadataSelected()) {
      renderProofMetadataInspector();
      return;
    }
    const index = selectedIndex();
    const block = selectedBlock();
    if (!block || index < 0) {
      els.inspector.appendChild(element("p", { class: "pn-inspector-empty" }, tr("选择纸面上的内容块以查看其设置。", "Select a block on the page to see its settings.")));
      return;
    }
    const structuralNode = outlineNodeFor(block.id);
    // The Inspector is deliberately a compact tool surface, not a second
    // document. The canvas already shows the block's reader-facing title.
    const context = element("div", { class: "pn-inspector-context" });
    context.appendChild(element("span", { class: "pn-inspector-context-label" }, optionText(block.type)));
    const overflow = element("details", { class: "pn-inspector-overflow" });
    const overflowSummary = element("summary", { class: "pn-inspector-overflow-trigger", "aria-label": tr("更多内容块操作", "More block actions") }, "⋯");
    const overflowMenu = element("div", { class: "pn-inspector-overflow-menu" });
    overflowMenu.appendChild(button(tr("上移", "Move up"), "pn-inspector-overflow-item", () => {
      if (structuralNode) moveStructuralNode(block.id, -1);
      else moveBlock(index, -1);
    }));
    overflowMenu.appendChild(button(tr("下移", "Move down"), "pn-inspector-overflow-item", () => {
      if (structuralNode) moveStructuralNode(block.id, 1);
      else moveBlock(index, 1);
    }));
    overflow.append(overflowSummary, overflowMenu);
    context.appendChild(overflow);
    els.inspector.appendChild(context);
    // The contextual title already identifies this block. The Inspector keeps
    // to editable properties instead of becoming a second conversion/actions
    // surface alongside the canvas and Outline menus.
    const structure = element("section", { class: "pn-inspector-group", "aria-label": tr("结构", "Structure") });
    structure.appendChild(element("div", { class: "pn-inspector-group-title" }, tr("结构", "Structure")));
    const appendStructure = (control) => {
      structure.appendChild(control);
      if (!structure.parentNode) els.inspector.appendChild(structure);
    };
    const label = (zh, en) => tr(zh, en);
    if (block.type === "title" && hasDocumentMetadataHeader() && !proofMetadataFields().length) {
      const metadata = element("section", { class: "pn-inspector-group", "aria-label": tr("文档元数据", "Document metadata") });
      metadata.appendChild(element("div", { class: "pn-inspector-group-title" }, tr("文档元数据", "Document metadata")));
      const row = element("div", { class: "pn-inspector-property" });
      row.appendChild(element("span", { class: "pn-inspector-property-label" }, tr("元数据块已隐藏", "Metadata block hidden")));
      row.appendChild(button(tr("重新启用", "Enable"), "pn-inspector-enable-metadata", enableProofMetadata));
      metadata.appendChild(row);
      els.inspector.appendChild(metadata);
    }
    if (block.type === "heading") {
      appendStructure(selectField(label("层级", "Level"), String(block.level), [["1", "H1"], ["2", "H2"], ["3", "H3"]], (value) => { block.level = Number(value); block.preset = "heading-" + value; changed({ structure: true, outline: true, inspector: true }); }));
    }
    if (block.type === "semantic") {
      appendStructure(selectField(label("语义类型", "Semantic type"), block.kind, [["section", label("章节", "Section")], ["introduction", label("引言", "Introduction")], ["problem", label("问题", "Problem")], ["theorem", "Theorem"], ["proof", "Proof"], ["result", label("结果", "Result")], ["verification", label("验证", "Verification")]], (value) => { block.kind = value; block.preset = "semantic-" + value; changed({ structure: true, outline: true, inspector: true }); }));
      const advanced = element("details", { class: "pn-inspector-advanced" });
      // This is a low-frequency disclosure, never a second default settings
      // form. Even when a label has been set, open it deliberately.
      advanced.open = false;
      advanced.appendChild(element("summary", {}, label("高级选项", "Advanced")));
      advanced.appendChild(selectField(label("呈现方式", "Presentation"), semanticPresentationValue(block), [["auto", label("自动", "Auto")], ["editorial", label("出版式", "Editorial")], ["card", label("卡片", "Card")]], (value) => setSemanticPresentation(block, value)));
      if (isEditorialPrimary(block)) advanced.appendChild(inspectorToggle(label("显示正文", "Show body"), editorialBodyVisible(block), (visible) => setEditorialBodyVisible(block, visible)));
      advanced.appendChild(inputField(label("标签", "Label"), block.label, (value) => update(block, "label", value, { structure: true, outline: true }), { placeholder: label("可选标签", "Optional label") }));
      // Keep low-frequency controls visually subordinate to Structure rather
      // than letting them read as peer fields within the same section.
      els.inspector.appendChild(advanced);
    }
    if (block.type === "callout") appendStructure(selectField(label("样式", "Style"), block.kind, [["note", label("说明", "Note")], ["tip", label("提示", "Tip")], ["warning", label("注意", "Warning")], ["info", label("信息", "Info")]], (value) => { block.kind = value; block.preset = "callout-" + value; changed({ structure: true, inspector: true }); }));
    if (block.type === "code") appendStructure(selectField(label("语言", "Language"), codeLanguageSelectValue(block.language), codeLanguageOptions(), (value) => update(block, "language", value, { structure: true })));
    if (block.type === "quote") appendStructure(inputField(label("出处", "Citation"), block.citation, (value) => update(block, "citation", value, { structure: true }), { placeholder: "—" }));
    if (block.type === "image") { buildImageInspector(structure, block); if (!structure.parentNode) els.inspector.appendChild(structure); }
    if (block.type === "list") appendStructure(selectField(label("列表类型", "List type"), block.ordered ? "ordered" : "unordered", [["unordered", label("项目符号", "Bullets")], ["ordered", label("编号", "Numbered")]], (value) => { block.ordered = value === "ordered"; changed({ structure: true, inspector: true }); }));
    if (block.type === "table") buildTableInspector(els.inspector, block);
  }
  function inspectorToggle(labelText, checked, onChange) {
    const row = element("label", { class: "pn-inspector-toggle" });
    row.appendChild(element("span", { class: "pn-inspector-toggle-label" }, labelText));
    const control = element("input", { class: "pn-inspector-toggle-control", type: "checkbox" });
    control.checked = Boolean(checked);
    control.addEventListener("change", () => onChange(control.checked));
    row.appendChild(control);
    return row;
  }
  function renderProofMetadataInspector() {
    const context = element("div", { class: "pn-inspector-context" });
    context.appendChild(element("span", { class: "pn-inspector-context-label" }, tr("文档元数据", "Document metadata")));
    els.inspector.appendChild(context);
    const display = element("section", { class: "pn-inspector-group", "aria-label": tr("显示", "Display") });
    display.appendChild(element("div", { class: "pn-inspector-group-title" }, tr("显示", "Display")));
    display.appendChild(inspectorToggle(tr("显示副标题", "Show subtitle"), headerSubtitleVisible(), setHeaderSubtitleVisible));
    const active = new Set(proofMetadataFields());
    [
      ["author", tr("作者", "Author")],
      ["date", tr("日期", "Date")],
      ["status", tr("状态", "Status")]
    ].forEach(([field, label]) => display.appendChild(inspectorToggle(label, active.has(field), (visible) => setProofMetadataFieldVisible(field, visible))));
    els.inspector.appendChild(display);
    if (!active.size) els.inspector.appendChild(element("p", { class: "pn-inspector-note" }, tr("这组元数据已从纸面隐藏；勾选任意字段即可重新显示。", "This metadata group is hidden from the page. Select any field to restore it.")));
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
    panel.appendChild(imageFilePicker(block, label("选择本地图片", "Choose local image")));
    if (block.src || block.alt || block.caption) panel.appendChild(button(label("移除图片", "Remove image"), "pn-add-inline pn-danger", () => {
      block.src = "";
      block.alt = "";
      block.caption = "";
      delete block.remoteApproved;
      changed({ structure: true, inspector: true });
    }));
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
      case "code": return renderCode(block);
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
  function renderCode(block) {
    const content = String(block && block.content || "");
    if (!content) return "";
    const language = canonicalCodeLanguage(block.language) || "text";
    return "<pre class=\"pn-code pn-code-highlighted language-" + escapeHtml(language) + "\"><span class=\"pn-code-language\">"
      + escapeHtml(codeLanguageDisplay(block.language)) + "</span><code class=\"language-" + escapeHtml(language) + "\">"
      + highlightedCodeHtml(content, block.language) + "</code></pre>";
  }
  function renderTable(block) {
    const columns = block.columns || [];
    const rows = block.rows || [];
    const header = block.header !== false
      ? "<thead><tr>" + columns.map((column) => "<th>" + inline(column) + "</th>").join("") + "</tr></thead>"
      : "";
    return "<div class=\"pn-table-wrap\"><table class=\"pn-table\">" + header + "<tbody>" + rows.map((row) => "<tr>" + columns.map((_, index) => "<td>" + inline(row[index] || "") + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
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
    const title = editorialDisplayTitle(block, titleKey) || tr("未命名章节", "Untitled section");
    const body = block.type === "semantic" && editorialBodyVisible(block)
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
    const fields = proofMetadataFields();
    if (!fields.length) return "";
    const item = (title, value, extraClass) => "<div class=\"pn-proof-metadata-item " + (extraClass || "") + "\"><dt>" + escapeHtml(title) + "</dt><dd>" + (String(value || "").trim() ? inline(value) : "&mdash;") + "</dd></div>";
    const source = values.source.trim() ? "<dl class=\"pn-proof-source\"><dt>" + escapeHtml(tr("来源", "Source")) + "</dt><dd>" + inline(values.source) + "</dd></dl>" : "";
    const labels = { author: tr("作者", "Author"), date: tr("日期", "Date"), status: tr("状态", "Status") };
    // Project metadata is optional publication furniture, not an unfinished
    // template. Export only populated Project fields and omit the whole
    // section when neither a field nor a source has a value. Proof Note keeps
    // its deliberate visible placeholders on its specialised template.
    const exportedFields = isProjectDocument()
      ? fields.filter((field) => String(values[field] || "").trim())
      : fields;
    if (!exportedFields.length && !source) return "";
    const items = exportedFields.map((field) => item(labels[field], values[field], field === "status" ? "pn-proof-metadata-status" : "")).join("");
    const grid = items
      ? "<dl class=\"pn-proof-metadata-grid\" style=\"grid-template-columns:repeat(" + exportedFields.length + ",minmax(0,1fr))\">" + items + "</dl>"
      : "";
    return "<section class=\"pn-proof-metadata\">" + grid + source + "</section>";
  }
  function renderDocumentChrome() {
    if (!state) return;
    const templateLabel = String(state.metadata.templateName || "").trim();
    const renderFooterName = (value, editable) => {
      els.footer.textContent = value;
      els.footer.classList.toggle("pn-footer-name-editable", editable);
      if (editable) {
        els.footer.setAttribute("contenteditable", "true");
        els.footer.setAttribute("role", "textbox");
        els.footer.setAttribute("aria-label", tr("页脚文档标题", "Footer document title"));
        els.footer.setAttribute("aria-multiline", "false");
      } else {
        els.footer.removeAttribute("contenteditable");
        els.footer.removeAttribute("role");
        els.footer.removeAttribute("aria-label");
        els.footer.removeAttribute("aria-multiline");
      }
    };
    if (isProofNoteDocument()) {
      const left = element("span", { class: "pn-running-brand" }, "Proofnote");
      const right = element("span", { class: "pn-running-type" }, state.metadata.documentType || "Solution Note");
      els.pageHeader.replaceChildren(left, right);
      els.pageHeader.classList.remove("pn-project-running");
      els.pageHeader.classList.add("pn-proofnote-running");
      els.pageHeader.hidden = false;
      renderFooterName(tr("笔记 ", "Note ") + (state.metadata.noteNumber || "—"), false);
      els.footerStatus.textContent = state.metadata.status || "";
      return;
    }
    if (isProjectDocument()) {
      const header = projectRunningHeader();
      const control = (side, value) => {
        const input = element("input", {
          type: "text",
          class: "pn-running-input pn-running-" + side,
          "aria-label": side === "left" ? tr("页眉左侧标题", "Left running title") : tr("页眉右侧标题", "Right running title")
        });
        input.value = value;
        input.addEventListener("input", () => updateProjectRunningHeader(side, input.value));
        return input;
      };
      els.pageHeader.replaceChildren(control("left", header.left), control("right", header.right));
      els.pageHeader.classList.remove("pn-proofnote-running");
      els.pageHeader.classList.add("pn-project-running");
      els.pageHeader.hidden = false;
      renderFooterName(state.metadata.name || tr("未命名文档", "UNTITLED DOCUMENT"), true);
      els.footerStatus.textContent = "";
      return;
    }
    els.pageHeader.textContent = templateLabel ? templateLabel.toUpperCase() : "";
    els.pageHeader.classList.remove("pn-proofnote-running", "pn-project-running");
    els.pageHeader.hidden = !templateLabel;
    renderFooterName(state.metadata.name || tr("未命名文档", "UNTITLED DOCUMENT"), false);
    els.footerStatus.textContent = "";
  }
  function renderAll() {
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
  const AI_DOCUMENT_INSTRUCTIONS = `Return one valid JSON object in Proofnote Document Format 1.0. Do not return Markdown fences or commentary.

Required envelope:
{
  "format": "proofnote-document",
  "version": "1.0",
  "metadata": { "name": "A concise document name" },
  "blocks": []
}

Use ordered blocks. Supported block types: title, subtitle, heading (with level 1, 2, or 3), paragraph, equation, code, table, image, quote, divider, page-break, callout, semantic, list, key-value, and stats.

Use semantic.kind only as section, introduction, problem, theorem, proof, result, or verification. Use callout.kind only as note, tip, warning, or info. A semantic block may optionally use appearance "editorial" or "card"; otherwise the selected template decides. Do not add CSS, fonts, font sizes, colours, margins, coordinates, or HTML. Proofnote owns the visual presets.

For code blocks, preserve the raw code in content. When the language is known, use one of: text, python, javascript, typescript, c, cpp, java, bash, sql, json, html, or css; otherwise use text. Do not add syntax-highlighted HTML to code content.

For LaTeX inside prose, return valid JSON: escape every literal backslash. For example, JSON source must contain "\\\\(x \\\\le \\\\sqrt{2}\\\\)" for inline math. Preserve code as code, using only normal JSON escaping.`;
  // The Project prompt is self-contained in project-ai-instructions.js, so
  // models receive one coherent document contract rather than a base prompt
  // followed by a conflicting visual override.
  const PROJECT_AI_DOCUMENT_INSTRUCTIONS = typeof root.PROOFNOTE_PROJECT_AI_INSTRUCTIONS === "string"
    ? root.PROOFNOTE_PROJECT_AI_INSTRUCTIONS
    : AI_DOCUMENT_INSTRUCTIONS;
  function aiInstructionsForCurrentDocument() {
    return isProjectDocument() ? PROJECT_AI_DOCUMENT_INSTRUCTIONS : AI_DOCUMENT_INSTRUCTIONS;
  }
  async function copyAiInstructions() {
    const instructions = aiInstructionsForCurrentDocument();
    try {
      await root.navigator.clipboard.writeText(instructions);
      setStatus(tr("AI 格式说明已复制", "AI format instructions copied"), "saved");
    } catch (_) {
      root.prompt(tr("请复制以下 AI 格式说明：", "Copy these AI format instructions:"), instructions);
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
    .pn-proofnote-document .pn-export-running,.pn-project-running{display:flex;align-items:baseline;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--line);font:600 10px/1 var(--heading);letter-spacing:.14em;text-transform:uppercase;color:rgba(32,31,29,.5)}
    .pn-proofnote-document .pn-running-brand,.pn-project-running .pn-running-brand{color:var(--accent)}
    .pn-proofnote-document .pn-document-title,.pn-project-document .pn-document-title{margin:29.333px 0 13.333px;padding-bottom:0;border-bottom:0}.pn-proofnote-document .pn-document-subtitle,.pn-project-document .pn-document-subtitle{margin:0;padding-bottom:24px;border-bottom:1px solid var(--line)}
    .pn-proof-metadata{margin:13.333px 0 26.667px}.pn-proof-metadata-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13.333px 21.333px;margin:0}.pn-proof-metadata-item dt,.pn-proof-source dt{margin:0 0 2.667px;font:600 var(--pn-doc-label-size)/1.2 var(--heading);letter-spacing:.12em;text-transform:uppercase;color:rgba(32,31,29,.54)}.pn-proof-metadata-item dd,.pn-proof-source dd{margin:0;font:var(--pn-doc-meta-size)/1.45 var(--body)}.pn-proof-metadata-status dd{font-family:var(--heading);font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8c6228}.pn-proof-source{margin:12px 0 0}
    .pn-editorial-section{margin:0 0 28px;break-inside:avoid;page-break-inside:avoid}.pn-editorial-section-head{display:flex;align-items:baseline;gap:13.333px;margin-bottom:13.333px;padding-bottom:8px;border-bottom:1px solid var(--line)}.pn-editorial-section-number{flex:none;font:600 12px/1 var(--heading);letter-spacing:.12em;font-feature-settings:'tnum';color:var(--accent)}.pn-editorial-section-head h2{margin:0;font:400 var(--pn-doc-section-1-size)/1.15 var(--heading);letter-spacing:-.015em}.pn-editorial-section p{margin:0 0 13.333px}.pn-editorial-section-summary,.pn-editorial-detail-summary{margin-top:5.333px!important;font-style:italic;color:rgba(32,31,29,.72)}
    .pn-editorial-detail{margin:0 0 16px;break-inside:avoid;page-break-inside:avoid}.pn-editorial-detail .pn-component-label{margin-bottom:4px;color:rgba(32,31,29,.55)}.pn-editorial-detail h3{margin:0 0 4px;font:400 18.667px/1.2 var(--heading)}.pn-editorial-detail p{margin:0 0 13.333px}
    .pn-export-footer{display:flex;justify-content:space-between;margin-top:34.667px;padding-top:8px;border-top:1px solid var(--line);font:10px/1 var(--heading);letter-spacing:.1em;text-transform:uppercase;color:rgba(32,31,29,.45)}.pn-export-footer span:last-child{color:#8c6228}
  `;
  // Blank Projects use the same composed editorial rhythm as a Proof Note,
  // without forcing their content into a proof-specific structure. Keep this
  // scoped to the Project wrapper so other imported/general documents retain
  // their neutral preset.
  const EXPORT_PROJECT_EDITORIAL_CSS = `
    .pn-project-document{max-width:820px;padding:62px 30px 96px;--pn-doc-body-size:17px;--pn-doc-body-leading:1.68;--pn-doc-title-size:42px;--pn-doc-section-1-size:28px;--pn-doc-section-2-size:22px;--pn-doc-section-3-size:18px}
    .pn-project-document .pn-document-title,.pn-project-document .pn-document-subtitle,.pn-project-document .pn-proof-metadata,.pn-project-document .pn-editorial-section-head,.pn-project-document .pn-editorial-section>p,.pn-project-document .pn-editorial-section-summary,.pn-project-document .pn-editorial-detail,.pn-project-document .pn-list,.pn-project-document .pn-quote,.pn-project-document .pn-callout,.pn-project-document .pn-semantic{max-width:760px}
    .pn-project-document .pn-table-wrap,.pn-project-document .pn-equation,.pn-project-document .pn-code{width:calc(100% + 60px);max-width:none;margin-left:-30px;margin-right:-30px}
    .pn-project-document .pn-proof-metadata{margin:16px 0 36px}
    .pn-project-document .pn-editorial-section{margin:0 0 48px}
    .pn-project-document .pn-editorial-section-head{margin-bottom:18px;padding-bottom:8px}
    .pn-project-document .pn-editorial-section p{margin-bottom:15px}
    .pn-project-document .pn-semantic{margin:20px 0;padding:20px 22px;border-color:#facb8d;background:#fff3e4}
    @media print{.pn-project-document .pn-table-wrap,.pn-project-document .pn-equation,.pn-project-document .pn-code{width:auto;margin-left:0;margin-right:0}}
  `;
  // Keep downloaded documents in step with the quieter, denser semantic cards
  // on the editing canvas. Empty summaries are omitted by renderBlock(), so an
  // editor-only placeholder can never leak into the exported document.
  const EXPORT_POLISH_CSS = `.pn-semantic{border-color:#fde6c8;background:#fff9f1}`;
  // Prism only gives us semantic token spans. The palette remains deliberately
  // restrained so an exported Proofnote reads like a typeset document rather
  // than an IDE screenshot.
  const EXPORT_CODE_SYNTAX_CSS = `
    .pn-code-highlighted code{display:block;white-space:pre-wrap;tab-size:2}
    .pn-code .token.comment,.pn-code .token.prolog,.pn-code .token.doctype,.pn-code .token.cdata{color:rgba(32,31,29,.47);font-style:italic}
    .pn-code .token.keyword,.pn-code .token.atrule{color:#765a2d}
    .pn-code .token.string,.pn-code .token.char,.pn-code .token.attr-value{color:#567061}
    .pn-code .token.number,.pn-code .token.boolean,.pn-code .token.constant,.pn-code .token.symbol{color:#875f40}
    .pn-code .token.function,.pn-code .token.class-name{color:#476171}
    .pn-code .token.property,.pn-code .token.attr-name,.pn-code .token.variable{color:#705b78}
    .pn-code .token.operator,.pn-code .token.punctuation{color:rgba(32,31,29,.72)}
  `;
  function renderStandaloneDocument() {
    const proofNote = isProofNoteDocument();
    const project = isProjectDocument();
    const documentMetadata = hasDocumentMetadataHeader();
    const subtitleVisible = headerSubtitleVisible();
    const hiddenSubtitleIndex = documentMetadata && !subtitleVisible ? headerSubtitleIndex() : -1;
    const metadataAfter = documentMetadata && subtitleVisible ? "subtitle" : "title";
    const blocks = state.blocks.map((block, index) => {
      const rendered = index === hiddenSubtitleIndex ? "" : renderBlock(block, index);
      return rendered + (documentMetadata && block.type === metadataAfter ? proofMetadataHtml() : "");
    }).join("\n");
    if (!proofNote) {
      const header = project ? projectRunningHeader() : null;
      const hasRunningContent = header && [header.left, header.right].some((value) => String(value || "").trim());
      const running = hasRunningContent ? "<div class=\"pn-export-running pn-project-running\"><span class=\"pn-running-brand\">" + escapeHtml(header.left) + "</span><span class=\"pn-running-type\">" + escapeHtml(header.right) + "</span></div>" : "";
      return "<article class=\"pn-document" + (project ? " pn-project-document" : "") + "\">" + running + blocks + "</article>";
    }
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
    const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title><style>" + katexCss.replace(/<\/style/gi, "<\\/style") + "</style><style>" + fontsCss.replace(/<\/style/gi, "<\\/style") + "</style><style>" + EXPORT_CSS + EXPORT_DOCUMENT_TYPOGRAPHY_CSS + EXPORT_PROOFNOTE_EDITORIAL_CSS + EXPORT_PROJECT_EDITORIAL_CSS + EXPORT_POLISH_CSS + EXPORT_CODE_SYNTAX_CSS + "</style></head><body>" + renderStandaloneDocument() + "</body></html>";
    download(slug() + ".html", html, "text/html");
  }

  function readImportFile() {
    const file = els.importFile.files && els.importFile.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showImportMessage(tr("文件超过 25MB 导入上限。", "File exceeds the 25 MB import limit."), "error");
      els.importFile.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { els.importText.value = String(reader.result || ""); clearImportReport(); };
    reader.readAsText(file);
  }
  function utf8ByteLength(value) {
    const text = String(value || "");
    if (typeof root.TextEncoder === "function") return new root.TextEncoder().encode(text).byteLength;
    // TextEncoder is available in supported browsers, but Blob keeps the
    // boundary correct for older WebViews too (notably for non-ASCII JSON).
    return new Blob([text]).size;
  }
  const STRICT_JSON_PARSE_OPTIONS = { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false };
  // A raw JSON escape can silently consume only b, f, n, r, or t. Restrict
  // the extra diagnostic to commands that are actually LaTeX, rather than
  // treating ordinary JSON text such as "First line\\nSecond line" as math.
  const SILENT_JSON_LATEX_COMMANDS = new Set([
    "begin", "beta", "big", "bigg", "binom", "boldsymbol", "boxed",
    "fbox", "forall", "frac",
    "nabla", "ne", "neq", "newline", "not", "notin",
    "right", "rightarrow",
    "tan", "text", "textbf", "textcolor", "textit", "tfrac", "therefore", "theta", "times", "tiny", "to", "top", "triangle"
  ]);
  function diagnosticPath(path) {
    if (!Array.isArray(path) || !path.length) return tr("文档根节点", "Document root");
    return path.reduce((result, part) => {
      return typeof part === "number" ? result + "[" + part + "]" : (result ? result + "." : "") + part;
    }, "");
  }
  function importSourceExcerpt(source, requestedOffset) {
    const text = String(source || "");
    const offset = Math.max(0, Math.min(Number(requestedOffset) || 0, text.length));
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    const rows = text.split("\n");
    const lineIndex = Math.max(0, line - 1);
    const first = Math.max(0, lineIndex - 1);
    const last = Math.min(rows.length - 1, lineIndex + 1);
    const width = String(last + 1).length;
    const excerpt = [];
    for (let index = first; index <= last; index += 1) {
      const raw = String(rows[index] || "").replace(/\r$/, "");
      const isTarget = index === lineIndex;
      const targetColumn = Math.max(0, column - 1);
      const start = isTarget ? Math.max(0, targetColumn - 54) : 0;
      const end = isTarget ? Math.min(raw.length, Math.max(targetColumn + 42, 96)) : Math.min(raw.length, 112);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < raw.length ? "…" : "";
      const shown = prefix + raw.slice(start, end) + suffix;
      excerpt.push(String(index + 1).padStart(width) + " │ " + shown);
      if (isTarget) {
        const caret = prefix.length + Math.max(0, Math.min(targetColumn - start, shown.length));
        excerpt.push(" ".repeat(width) + " │ " + " ".repeat(caret) + "^");
      }
    }
    return { offset, line, column, text: excerpt.join("\n") };
  }
  function focusImportOffset(offset, length) {
    if (!els.importText) return;
    const excerpt = importSourceExcerpt(els.importText.value, offset);
    const end = Math.max(excerpt.offset + 1, Math.min(els.importText.value.length, excerpt.offset + Math.max(1, Number(length) || 1)));
    els.importText.focus();
    els.importText.setSelectionRange(excerpt.offset, end);
    const lineHeight = parseFloat(root.getComputedStyle(els.importText).lineHeight) || 18;
    els.importText.scrollTop = Math.max(0, (excerpt.line - 2) * lineHeight);
  }
  function escapedBackslashAt(source, offset) {
    let count = 0;
    for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) count += 1;
    return count % 2 === 1;
  }
  function invalidJsonEscapeAt(source, start, length) {
    const from = Math.max(0, Number(start) || 0);
    const to = Math.min(source.length, from + Math.max(1, Number(length) || 1));
    for (let index = from; index < to; index += 1) {
      if (source[index] !== "\\" || escapedBackslashAt(source, index)) continue;
      const next = source[index + 1] || "";
      if (!'"\\/bfnrtu'.includes(next)) return { offset: index, length: Math.min(2, source.length - index) };
      if (next === "u" && !/^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) return { offset: index, length: Math.min(6, source.length - index) };
    }
    return null;
  }
  function jsonSyntaxDetails(parser, source, parseError) {
    const code = parser.printParseErrorCode(parseError.error);
    const invalidEscape = code === "InvalidEscapeCharacter" ? invalidJsonEscapeAt(source, parseError.offset, parseError.length) : null;
    const offset = invalidEscape ? invalidEscape.offset : parseError.offset;
    const length = invalidEscape ? invalidEscape.length : parseError.length;
    const near = String(source || "").slice(offset, Math.min(String(source || "").length, offset + Math.max(1, length)));
    const previous = String(source || "").slice(0, offset).replace(/\s+$/, "");
    let message = tr("JSON 格式不符合规范。", "The JSON syntax is not valid.");
    let help = tr("请检查标记位置附近的 JSON 语法。", "Check the JSON syntax around the marked location.");
    if (code === "InvalidEscapeCharacter") {
      const command = String(source || "").slice(offset).match(/^\\[^\s",}]*/)?.[0] || near || "\\";
      const repaired = "\\u005c" + command.slice(1);
      message = tr("发现无效的 JSON 转义：\"" + command + "\"。", "Invalid JSON escape: \"" + command + "\".");
      help = tr("JSON 字符串中的反斜杠必须被转义。Proofnote 的 LaTeX 请写成 \"" + repaired + "\"，不要写 \"" + command + "\"。", "A backslash inside a JSON string must be escaped. For Proofnote LaTeX, write \"" + repaired + "\", not \"" + command + "\".");
    } else if (code === "CommaExpected") {
      message = tr("这里缺少逗号。", "A comma is missing here.");
      help = tr("对象属性或数组项目之间请添加逗号。", "Add a comma between object properties or array items.");
    } else if ((code === "PropertyNameExpected" || code === "ValueExpected") && /,$/.test(previous)) {
      message = tr("发现尾随逗号。", "A trailing comma was found.");
      help = tr("严格 JSON 不允许最后一个属性或数组项目后保留逗号。", "Strict JSON does not allow a comma after the final property or array item.");
    } else if (code === "UnexpectedEndOfString") {
      message = tr("字符串没有正确结束。", "A JSON string was not closed.");
      help = tr("请补上对应的双引号，并使用 \\n 表示字符串内换行。", "Add the matching double quote, and use \\n for a newline inside a string.");
    } else if (code === "ColonExpected") {
      message = tr("属性名称后缺少冒号。", "A colon is missing after a property name.");
      help = tr("JSON 对象中的键和值必须写成 \"键\": 值。", "JSON object keys and values must use \"key\": value.");
    } else if (code === "CloseBraceExpected" || code === "CloseBracketExpected" || code === "EndOfFileExpected") {
      message = tr("JSON 结构没有正确闭合。", "The JSON structure is not closed.");
      help = tr("请检查是否缺少对应的 }、] 或双引号。", "Check for a missing matching }, ], or double quote.");
    } else if (code === "InvalidCommentToken" || code === "UnexpectedEndOfComment") {
      message = tr("发现注释；Proofnote 只接受严格 JSON。", "A comment was found; Proofnote accepts strict JSON only.");
      help = tr("请移除 // 或 /* … */ 注释后再导入。", "Remove // or /* … */ comments before importing.");
    }
    const excerpt = importSourceExcerpt(source, offset);
    return {
      title: tr("无法导入文档", "Could not import document"),
      heading: tr("JSON 语法错误", "JSON syntax error"),
      position: tr("第 " + excerpt.line + " 行，第 " + excerpt.column + " 列", "Line " + excerpt.line + " · Column " + excerpt.column),
      message, help, source, offset: excerpt.offset, length, snippet: excerpt.text,
      text: [tr("无法导入文档", "Could not import document"), tr("JSON 语法错误", "JSON syntax error"), tr("第 " + excerpt.line + " 行，第 " + excerpt.column + " 列", "Line " + excerpt.line + " · Column " + excerpt.column), message, help].join("\n")
    };
  }
  function potentialLatexCorruptions(parser, source, rawDocument) {
    const issues = [];
    const matcher = /\\([bfnrt])(?=[A-Za-z])/g;
    let match;
    while ((match = matcher.exec(source))) {
      const offset = match.index;
      if (escapedBackslashAt(source, offset)) continue;
      const command = source.slice(offset + 1).match(/^[A-Za-z]+/)?.[0] || match[1];
      if (!SILENT_JSON_LATEX_COMMANDS.has(command.toLowerCase())) continue;
      const location = parser.getLocation(source, offset);
      const path = diagnosticPath(location && location.path);
      const blockIndex = location && Array.isArray(location.path) && location.path[0] === "blocks" ? location.path[1] : -1;
      const block = rawDocument && Array.isArray(rawDocument.blocks) && Number.isInteger(blockIndex) ? rawDocument.blocks[blockIndex] : null;
      // This diagnostic deliberately guards document prose and mathematics,
      // not arbitrary metadata or source-code paths (where an escaped tab or
      // regex token can be intentional rather than damaged LaTeX).
      if (!block || block.type === "code") continue;
      issues.push({
        path, offset, length: command.length + 1,
        message: tr("\"\\" + command + "\" 看起来像 LaTeX 命令，但 JSON 已把 \\" + match[1] + " 解释为控制字符。请改用 \"\\u005c" + command + "\"。", "\"\\" + command + "\" looks like a LaTeX command, but JSON interpreted \\" + match[1] + " as a control escape. Use \"\\u005c" + command + "\" instead.")
      });
    }
    return issues;
  }
  function duplicateJsonKeyWarnings(parser, source) {
    const warnings = [];
    const tree = parser.parseTree(source, [], STRICT_JSON_PARSE_OPTIONS);
    const walk = (node) => {
      if (!node) return;
      if (node.type === "object") {
        const seen = new Set();
        (node.children || []).forEach((property) => {
          const keyNode = property && property.children && property.children[0];
          const valueNode = property && property.children && property.children[1];
          const key = keyNode && String(keyNode.value || "");
          if (keyNode && seen.has(key)) {
            const location = parser.getLocation(source, keyNode.offset);
            warnings.push({ path: diagnosticPath(location && location.path), offset: keyNode.offset, length: keyNode.length, message: tr("重复的 JSON 键；后一个值已被采用。", "Duplicate JSON key; the later value was used.") });
          }
          seen.add(key);
          walk(valueNode);
        });
        return;
      }
      (node.children || []).forEach(walk);
    };
    walk(tree);
    return warnings;
  }
  function inspectImportJson(source) {
    const parser = root.ProofnoteJsoncParser;
    if (!parser || typeof parser.parse !== "function") {
      return { diagnostic: { title: tr("无法导入文档", "Could not import document"), heading: tr("导入诊断未就绪", "Import diagnostics are unavailable"), message: tr("JSON 诊断组件未加载；请重新打开 Proofnote 后重试。", "The JSON diagnostics component did not load. Reopen Proofnote and try again."), text: tr("导入诊断未就绪", "Import diagnostics are unavailable") } };
    }
    const parseErrors = [];
    parser.parse(source, parseErrors, STRICT_JSON_PARSE_OPTIONS);
    if (parseErrors.length) return { diagnostic: jsonSyntaxDetails(parser, source, parseErrors[0]) };
    let raw;
    try { raw = JSON.parse(source); } catch (_) {
      return { diagnostic: { title: tr("无法导入文档", "Could not import document"), heading: tr("JSON 语法错误", "JSON syntax error"), message: tr("JSON 解析器发现了无法安全恢复的问题。", "The JSON parser found an error it could not recover safely."), text: tr("JSON 语法错误", "JSON syntax error") } };
    }
    const latexIssues = potentialLatexCorruptions(parser, source, raw);
    if (latexIssues.length) {
      const first = latexIssues[0];
      const excerpt = importSourceExcerpt(source, first.offset);
      return { diagnostic: {
        title: tr("导入需要修正", "Import needs a correction"), heading: tr("可能已损坏的 LaTeX", "Possible malformed LaTeX"),
        position: tr("第 " + excerpt.line + " 行，第 " + excerpt.column + " 列", "Line " + excerpt.line + " · Column " + excerpt.column),
        message: tr("JSON 可以解析，但数学命令可能已经被 JSON 转义悄悄改变。为避免丢失公式，Proofnote 没有导入该文档。", "The JSON parses, but a math command may have been silently changed by a JSON escape. Proofnote did not import the document to avoid losing the formula."),
        issues: latexIssues, source, offset: first.offset, length: first.length, snippet: excerpt.text,
        help: tr("在原始 JSON 中，每个 LaTeX 反斜杠使用 \\u005c 表示。", "In raw JSON, write every LaTeX backslash as \\u005c."),
        text: [tr("可能已损坏的 LaTeX", "Possible malformed LaTeX"), first.path, first.message].join("\n")
      } };
    }
    return { raw, warnings: duplicateJsonKeyWarnings(parser, source) };
  }
  function renderImportIssues(report, issues, severity) {
    if (!issues || !issues.length) return;
    const heading = element("h3", { class: "pn-import-diagnostic-list-title" }, severity === "warning" ? tr("可恢复提示", "Recoverable notices") : tr("需要修正", "Problems to fix"));
    const list = element("ol", { class: "pn-import-diagnostic-list" });
    issues.slice(0, 8).forEach((issue) => {
      const item = Number.isFinite(issue.offset)
        ? button("", "pn-import-diagnostic-item", () => focusImportOffset(issue.offset, issue.length))
        : element("div", { class: "pn-import-diagnostic-item" });
      item.appendChild(element("strong", { class: "pn-import-diagnostic-path" }, issue.path || tr("文档根节点", "Document root")));
      item.appendChild(element("span", { class: "pn-import-diagnostic-message" }, issue.message));
      list.appendChild(element("li", {}, undefined));
      list.lastChild.appendChild(item);
    });
    report.append(heading, list);
  }
  async function copyImportDiagnostics(text) {
    try {
      let copied = false;
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        try { await root.navigator.clipboard.writeText(text); copied = true; } catch (_) {}
      }
      if (!copied) copied = copyWithLegacyClipboard(text);
      if (!copied) throw new Error("copy failed");
      setStatus(tr("诊断信息已复制", "Diagnostics copied"), "saved");
      return true;
    } catch (_) {
      setStatus(tr("无法复制诊断信息；请手动复制。", "Could not copy diagnostics; please copy them manually."), "warning");
      return false;
    }
  }
  function renderImportDiagnostics(details) {
    if (!els.importReport) return;
    const report = els.importReport;
    report.className = "pn-import-report is-diagnostic";
    report.replaceChildren();
    report.appendChild(element("strong", { class: "pn-import-diagnostic-title" }, details.title));
    report.appendChild(element("h3", { class: "pn-import-diagnostic-heading" }, details.heading));
    if (details.position) report.appendChild(element("p", { class: "pn-import-diagnostic-position" }, details.position));
    if (details.message) report.appendChild(element("p", { class: "pn-import-diagnostic-message" }, details.message));
    if (details.snippet) {
      const snippet = element("pre", { class: "pn-import-diagnostic-snippet", tabindex: "0", title: tr("点击定位到错误", "Click to locate the problem") }, details.snippet);
      snippet.addEventListener("click", () => focusImportOffset(details.offset, details.length));
      snippet.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); focusImportOffset(details.offset, details.length); } });
      report.appendChild(snippet);
    }
    renderImportIssues(report, details.issues, "error");
    renderImportIssues(report, details.warnings, "warning");
    if (details.help) {
      report.appendChild(element("h3", { class: "pn-import-diagnostic-help-title" }, tr("如何修复", "How to fix it")));
      report.appendChild(element("p", { class: "pn-import-diagnostic-help" }, details.help));
    }
    const copy = button(tr("复制诊断信息", "Copy diagnostics"), "pn-import-diagnostic-copy", async () => {
      const copied = await copyImportDiagnostics(details.text || [details.title, details.heading, details.message, details.help].filter(Boolean).join("\n"));
      if (copied) copy.textContent = tr("已复制", "Copied");
    });
    report.appendChild(copy);
  }
  function renderSchemaDiagnostics(title, errors, warnings) {
    const problems = errors || [];
    const notices = warnings || [];
    const toText = (issues) => issues.map((issue) => (issue.path || tr("文档根节点", "Document root")) + " — " + issue.message);
    renderImportDiagnostics({
      title,
      heading: tr("文档结构错误", "Document structure error"),
      message: problems.length
        ? tr("Proofnote 找到 " + problems.length + " 个需要修正的问题。", "Proofnote found " + problems.length + " problem(s) that need correction.")
        : tr("Proofnote 找到可恢复的格式提示。", "Proofnote found recoverable format notices."),
      issues: problems,
      warnings: notices,
      help: problems.length ? tr("请按路径修正字段后再次导入。不会修改当前文档。", "Correct the fields at these paths, then import again. Your current document is unchanged.") : "",
      text: [title, tr("文档结构错误", "Document structure error")].concat(toText(problems), toText(notices)).join("\n")
    });
  }
  async function importFromDialog() {
    if (utf8ByteLength(els.importText.value) > MAX_IMPORT_BYTES) {
      showImportMessage(tr("JSON 文本超过 25MB 导入上限。", "JSON text exceeds the 25 MB import limit."), "error");
      return;
    }
    // The place where a person imports content determines the active
    // document's preset. An AI response is content, not an authority on
    // whether the current Blank Project should stop being a Project.
    const preserveProjectIdentity = isProjectDocument();
    const inspected = inspectImportJson(els.importText.value);
    if (inspected.diagnostic) { renderImportDiagnostics(inspected.diagnostic); return; }
    const raw = inspected.raw;
    let next, warnings = inspected.warnings || [];
    if (raw && raw.format === "solution-note") {
      const legacyValidation = root.__snTest && root.__snTest.validateRaw ? root.__snTest.validateRaw(raw) : { errors: [], warnings: [] };
      if (legacyValidation.errors.length) { renderSchemaDiagnostics(tr("无法导入 Solution Note", "Could not import Solution Note"), legacyValidation.errors, warnings.concat(legacyValidation.warnings || [])); return; }
      warnings = warnings.concat(legacyValidation.warnings || []);
      next = Model.migrateSolutionNote(raw);
    } else if (raw && raw.format === Model.TEMPLATE_FORMAT) {
      const validation = Model.validateTemplateRaw(raw);
      if (validation.errors.length) { renderSchemaDiagnostics(tr("无法导入模板", "Could not import template"), validation.errors, warnings.concat(validation.warnings || [])); return; }
      const template = Model.normalizeTemplate(raw);
      const backend = await Store.saveTemplate(template);
      if (backend === "failed") { showImportMessage(tr("模板无法保存到此设备；请释放存储空间后重试。", "Template could not be saved on this device; free storage and try again."), "error"); return; }
      await refreshTemplates();
      closeImport();
      warnings = warnings.concat(validation.warnings || []);
      setStatus(warnings.length ? tr("模板已保存；有 " + warnings.length + " 条可恢复提示。", "Template saved with " + warnings.length + " recoverable notice(s).") : tr("模板已保存到此设备。", "Template saved on this device."), warnings.length ? "warning" : "saved");
      return;
    } else {
      const validation = Model.validateDocumentRaw(raw);
      if (validation.errors.length) { renderSchemaDiagnostics(tr("无法导入文档", "Could not import document"), validation.errors, warnings.concat(validation.warnings || [])); return; }
      warnings = warnings.concat(validation.warnings || []);
      next = Model.normalizeDocument(raw);
      if (preserveProjectIdentity) next.metadata.documentType = "Project";
    }
    const saved = await saveActiveDocumentNow();
    if (saved === "failed") { showImportMessage(tr("当前文档无法保存；请先导出备份。", "The current document could not be saved; export a backup first."), "error"); return; }
    const created = await Store.createDocument(next);
    if (!created || !created.record || created.backend === "failed") { showImportMessage(tr("导入文档无法保存到此设备。", "The imported document could not be saved on this device."), "error"); return; }
    closeImport();
    await activateDocument(created.record, { status: false });
    setStatus(warnings.length ? tr("已导入为新文档；有 " + warnings.length + " 条可恢复提示。", "Imported as a new document with " + warnings.length + " recoverable notice(s).") : tr("已导入为新文档", "Imported as a new document"), warnings.length ? "warning" : "saved");
  }
  async function initialise() {
    mount();
    applySidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    try {
      const savedCollapsed = JSON.parse(root.localStorage.getItem(OUTLINE_COLLAPSE_KEY) || "[]");
      collapsedOutlineIds = new Set(Array.isArray(savedCollapsed) ? savedCollapsed.filter((id) => typeof id === "string") : []);
    } catch (_) { collapsedOutlineIds = new Set(); }
    try { setUtilityOpen(root.localStorage.getItem("proofnote-document:utility-open") === "1"); } catch (_) { setUtilityOpen(false); }
    setDetailOpen(false);
    try { setSidebarTab(root.localStorage.getItem("proofnote-document:sidebar-tab") || "outline"); } catch (_) { setSidebarTab("outline"); }
    await refreshTemplates();
    let legacy = null;
    try { legacy = JSON.parse(root.localStorage.getItem("solution-note-generator:v1") || "null"); } catch (_) {}
    const proofTemplate = templateById("proof-note");
    const seed = legacy ? Model.migrateSolutionNote(legacy) : Model.normalizeDocument(proofTemplate.document);
    const library = await Store.initialiseDocumentLibrary(seed);
    currentDocumentId = library && library.record ? library.record.id : "";
    state = library && library.record && library.record.document
      ? Model.normalizeDocument(library.record.document, { allowRemoteImages: true })
      : seed;
    hasUnsavedChanges = false;
    await refreshDocuments();
    renderAll();
    setStatus(tr("已保存到此设备", "Saved on this device"), "saved");
  }
  initialise().catch((error) => { console.error("Proofnote Document editor could not start", error); });
})(window, document);
