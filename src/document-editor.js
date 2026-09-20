/* Proofnote's block-document editor. This is intentionally a thin UI over
 * document-model.js: all interchange normalisation and legacy adaptation stay
 * outside the rendering layer. */
(function (root, document) {
  "use strict";
  const Model = root.ProofnoteDocument;
  const Store = root.ProofnoteStore;
  const Renderer = root.ProofnoteRenderer;
  const LegacyBoundary = root.ProofnoteLegacyBoundary;
  if (!Model || !Store || !Renderer || !LegacyBoundary) return;

  // Increment this small, user-facing version for each released workspace update.
  const APP_VERSION = "v1.47";
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
    "section", "paragraph", "equation", "code", "table", "image", "quote",
    "divider", "page-break", "callout", "semantic", "list", "key-value", "stats"
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
  // A Project is a device-local container for independent Proofnote
  // documents. It is intentionally distinct from the portable `Project`
  // document preset: a document can remain fully portable and still belong
  // to a local research project, group, pin order, or landing page.
  let projects = [];
  let activeProjectId = "";
  let projectLandingId = "";
  const projectRevisions = new Map();
  let currentDocumentId = "";
  let renamingDocumentId = "";
  let renamingProjectId = "";
  let projectMoveAnchor = null;
  let saveTimer = null;
  // A document may be edited again while an earlier IndexedDB write is still
  // in flight. Keep immutable snapshots in a serial queue so an older save
  // can never finish after, and overwrite, a newer edit.
  let saveQueue = Promise.resolve();
  // Every successful write increments this local-library revision. Keeping it
  // separate from portable document JSON lets the store reject a stale tab's
  // write instead of silently applying last-write-wins.
  const documentRevisions = new Map();
  // User-initiated document transitions are serialized and only the most
  // recent intent may select a new current document. This prevents rapid
  // open/create/import actions from completing out of order.
  let transitionQueue = Promise.resolve();
  let transitionGeneration = 0;
  let editRevision = 0;
  let editorialNumberRevision = -1;
  let editorialNumberState = null;
  let editorialSectionNumbers = new Map();
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
  // A self-contained editable HTML includes both the reader-facing document
  // and an embedded portable source payload. It is necessarily larger than a
  // `.proofnote.json`, but the embedded document itself remains subject to
  // the same 25 MB portable boundary.
  const MAX_EDITABLE_HTML_BYTES = 64 * 1024 * 1024;
  const MAX_EDITABLE_HTML_SOURCE_BYTES = MAX_IMPORT_BYTES + 16 * 1024;
  const EDITABLE_HTML_FORMAT = "proofnote-editable-html";
  const EDITABLE_HTML_VERSION = "1.0";
  const EDITABLE_HTML_SOURCE_ID = "proofnote-editable-source";
  const EDITABLE_HTML_SOURCE_TYPE = "application/vnd.proofnote.editable-html+json";
  // The full-file integrity check is calculated with this placeholder in
  // place. It lets an importer detect edits to the visible presentation as
  // well as edits to the embedded JSON, without a self-referential hash.
  const EDITABLE_HTML_HASH_PLACEHOLDER = "0".repeat(64);
  // Prism grammars are intentionally optional publication polish. Do not let
  // a schema-valid but very large code sample turn HTML export into a long
  // synchronous regex task; the raw escaped source remains a faithful export.
  const MAX_HIGHLIGHTED_CODE_LENGTH = 50000;
  // Auto-growing every textarea is pleasant for normal prose, but measuring a
  // 200k-character field on every keystroke forces a full layout. Long text
  // remains editable; it simply switches to a bounded scrolling editor.
  const MAX_AUTO_GROW_TEXT_LENGTH = 16000;
  const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 24 * 1000 * 1000;
  // Import diagnostics should help a person repair a document, not become an
  // unbounded secondary parser for deliberately hostile JSON.
  const MAX_IMPORT_DIAGNOSTIC_ISSUES = 32;
  const MAX_IMPORT_DIAGNOSTIC_NODES = 50000;
  const OUTLINE_UNDO_WINDOW_MS = 8000;
  let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  let persistenceAvailable = true;
  let importFileReadGeneration = 0;
  let importMode = "document";
  // HTML is never inferred from the visible page. This is the only source
  // accepted by the editable-HTML path after its envelope, checksum and
  // document boundary have all passed.
  let pendingEditableHtml = null;
  // Older workspace versions could copy an Editable HTML replacement lineage
  // into a second local record. Repair those historical collisions once they
  // are observed, and keep a promise so concurrent library refreshes never
  // run two competing repair passes.
  let editableHtmlLineageRepair = null;
  let editableHtmlLineageRepairNotice = null;
  // An editable HTML commit is intentionally non-cancellable once its write
  // phase starts. The sheet stays open but inert while it creates a new
  // record or runs its recovery-copy + CAS transaction. This prevents a late
  // close or file-picker event from making a committed import look cancelled.
  let editableHtmlImportInProgress = false;
  // Recoverable normalisation notices are content decisions. Keep the import
  // sheet open and require a second, explicit action before committing them.
  let importWarningConfirmation = null;
  // Rendering the document library after an autosave must not replace text an
  // author is actively typing into a rename field with the persisted name.
  const renameDrafts = new Map();
  // Exported publication furniture must follow the document language, not
  // whichever language happens to be selected in the editing workspace.
  let exportLanguageContext = "";
  // FileReader callbacks may finish long after their originating image block
  // has left the canvas. A document generation gives those callbacks a cheap,
  // deterministic way to prove that they still belong to the active record.
  let documentGeneration = 0;
  let els = {};

  function isComposingInput(event) {
    // Safari reports keyCode 229 during IME composition; Chromium also sets
    // isComposing. Neither Enter used to confirm a Chinese/Japanese candidate
    // is an authoring shortcut.
    return Boolean(event && (event.isComposing || event.keyCode === 229));
  }

  function english() { return document.documentElement.lang === "en"; }
  function tr(zh, en) { return english() ? en : zh; }
  function exportTr(zh, en) { return /^zh(?:-|$)/i.test(exportLanguageContext) ? zh : en; }
  function readerTr(zh, en) { return exportLanguageContext ? exportTr(zh, en) : tr(zh, en); }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function inline(value) {
    return Renderer.inline(String(value || ""), {
      missing: tr("KaTeX 未载入", "KaTeX not loaded"),
      invalid: tr("LaTeX 语法错误", "LaTeX syntax error")
    });
  }
  function math(value) {
    const source = String(value || "");
    if (source.length > Model.LIMITS.maxEquationLength) {
      return "<span class=\"pn-math-limit\">" + escapeHtml(tr("公式过长，未渲染预览。", "Equation is too long to preview.")) + "</span>";
    }
    return Renderer.math(source, true, {
      missing: tr("KaTeX 未载入", "KaTeX not loaded"),
      invalid: tr("LaTeX 语法错误", "LaTeX syntax error")
    });
  }
  function localDate() { return new Date().toLocaleString(english() ? "en-AU" : "zh-CN", { dateStyle: "medium" }); }
  function setStatus(message, kind, options) {
    const opts = options || {};
    clearTimeout(statusTimer);
    els.status.textContent = message || "";
    els.status.dataset.kind = kind || "";
    // Only a confirmed persistence operation may collapse into the durable
    // "Saved" state. Copy/export/UI confirmations must never overwrite an
    // earlier persistence failure with a misleading success message.
    if (kind === "saved" && opts.persisted === true && persistenceAvailable && !hasUnsavedChanges && message !== tr("已保存", "Saved")) {
      statusTimer = setTimeout(() => {
        if (els.status.dataset.kind === "saved" && !hasUnsavedChanges && persistenceAvailable) els.status.textContent = tr("已保存", "Saved");
      }, 1800);
    }
  }
  function setPersistenceStatus(message) { setStatus(message, "saved", { persisted: true }); }
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
    // Keep every editable text surface within the portable document limit.
    // Without this, the canvas could create content that a later Proofnote
    // import rightly refuses, or that normalisation would have to truncate.
    if (opts.maxLength !== false) control.maxLength = String(opts.maxLength || Model.LIMITS.maxStringLength);
    if (opts.ariaLabel) control.setAttribute("aria-label", opts.ariaLabel);
    control.value = value || "";
    let resizeFrame = 0;
    const resize = () => {
      resizeFrame = 0;
      if (!opts.autoGrow || !opts.multiline) return;
      if (control.value.length > MAX_AUTO_GROW_TEXT_LENGTH) {
        control.style.height = Math.max(opts.minHeight || 0, 320) + "px";
        control.style.overflowY = "auto";
        return;
      }
      control.style.height = "auto";
      control.style.height = Math.max(control.scrollHeight, opts.minHeight || 0) + "px";
      control.style.overflowY = "hidden";
    };
    const scheduleResize = () => {
      if (!opts.autoGrow || !opts.multiline) return;
      if (resizeFrame) root.cancelAnimationFrame(resizeFrame);
      resizeFrame = root.requestAnimationFrame(resize);
    };
    control.addEventListener("input", () => { scheduleResize(); onInput(control.value); });
    field.appendChild(control);
    // A rich text field is initially hidden behind its reading preview. Keep
    // its resize hook on the field so selection can measure it only after CSS
    // has made the native textarea visible; measuring while `display:none`
    // otherwise records a zero-height editor.
    field.requestAutoGrow = scheduleResize;
    if (opts.autoGrow && opts.multiline) scheduleResize();
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
    if (source.length > MAX_HIGHLIGHTED_CODE_LENGTH) return escapeHtml(source);
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
            <button class="pn-action-menu-item" id="pnImportEditableHtml" type="button" role="menuitem">${tr("导入可编辑 HTML", "Import editable HTML")}</button>
            <button class="pn-action-menu-item" id="pnExportHtml" type="button" role="menuitem">${tr("导出 HTML", "Export HTML")}</button>
            <div class="pn-action-menu-submenu-wrap">
              <button class="pn-action-menu-item pn-action-menu-submenu-trigger" id="pnExportMore" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="pnExportMoreMenu"><span>${tr("更多导出", "More exports")}</span><span class="pn-action-menu-arrow" aria-hidden="true">›</span></button>
              <div class="pn-action-menu pn-action-menu-submenu" id="pnExportMoreMenu" role="menu" aria-label="${tr("更多导出", "More exports")}" hidden>
                <button class="pn-action-menu-item" id="pnExportEditableHtml" type="button" role="menuitem">${tr("导出 Proofnote 可编辑 HTML（可回导）", "Export Proofnote editable HTML (re-importable)")}</button>
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
              <section class="pn-library-section pn-library-projects" aria-labelledby="pnProjectsHeading">
                <div class="pn-library-heading-row"><div class="pn-sidebar-heading" id="pnProjectsHeading">${tr("项目", "Projects")}</div><button class="pn-template-new" id="pnNewContainer" type="button">${tr("＋ 新建项目", "+ New project")}</button></div>
                <div class="pn-project-list" id="pnProjects" role="list" aria-label="${tr("项目", "Projects")}"></div>
              </section>
              <section class="pn-library-section pn-library-documents" aria-labelledby="pnDocumentsHeading">
                <div class="pn-library-heading-row"><div class="pn-sidebar-heading" id="pnDocumentsHeading">${tr("文档", "Documents")}</div><button class="pn-template-new" id="pnNew" type="button">${tr("＋ 新建文档", "+ New document")}</button></div>
                <div class="pn-document-list" id="pnDocuments" role="list" aria-label="${tr("未归属文档，按最近修改排序", "Unfiled documents, most recently modified first")}"></div>
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
          <section class="pn-project-landing" id="pnProjectLanding" aria-live="polite" hidden></section>
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
          <p class="pn-modal-copy">${tr("支持 Proofnote Document、用户模板和原有 Solution Note 1.0。Solution Note 会无损优先地迁移为可编辑 blocks。导入文档会新建一份文档，不会覆盖当前文档。", "Supports Proofnote Document, user templates, and Solution Note 1.0. Solution Notes are migrated into editable blocks. Importing creates a new document and never replaces the current one.")}</p>
          <textarea class="input pn-import-text" id="pnImportText" rows="10" placeholder='{ "format": "proofnote-document", ... }'></textarea>
          <p class="pn-import-editable-summary" id="pnEditableHtmlSummary" role="status" aria-live="polite" hidden></p>
          <div class="pn-actions"><button class="btn btn-secondary pn-file-label" id="pnImportFileTrigger" type="button"><span id="pnImportFileLabel">${tr("选择文件", "Choose file")}</span></button><input id="pnImportFile" type="file" accept="application/json" hidden><button class="btn btn-primary" id="pnConfirmImport" type="button">${tr("导入为新文档", "Import as new document")}</button><button class="btn btn-danger" id="pnReplaceImport" type="button" hidden>${tr("覆盖当前文档…", "Replace current document…")}</button></div>
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
          <h2 id="pnNewProjectTitle">${tr("新建文档", "New document")}</h2>
          <p id="pnNewProjectCopy" class="pn-modal-copy">${tr("命名文档后，Proofnote 会自动创建同名文档、填入今天的日期，并添加一个“引言”语义小节。若当前打开某个项目，文档会加入该项目。", "Name the document and Proofnote will create a matching document, add today’s date, and start it with an editorial Introduction section. When a Project is open, the document joins it.")}</p>
          <label class="pn-new-project-field" for="pnNewProjectName"><span class="pn-new-project-label">${tr("文档名称", "Document name")}</span><input class="pn-new-project-input" id="pnNewProjectName" type="text" autocomplete="off" maxlength="200" required></label>
          <div class="pn-actions pn-confirm-actions"><button class="btn btn-secondary" id="pnNewProjectCancel" type="button">${tr("取消", "Cancel")}</button><button class="btn btn-primary" id="pnCreateProject" type="button">${tr("创建文档", "Create document")}</button></div>
        </section>
      </div>
      <div class="pn-modal-backdrop" id="pnProjectModal" hidden>
        <section class="pn-modal pn-confirm-modal pn-new-project-modal" role="dialog" aria-modal="true" aria-labelledby="pnProjectModalTitle" aria-describedby="pnProjectModalCopy">
          <p class="pn-confirm-kicker">${tr("新建项目", "NEW PROJECT")}</p>
          <h2 id="pnProjectModalTitle">${tr("新建项目", "New project")}</h2>
          <p id="pnProjectModalCopy" class="pn-modal-copy">${tr("项目是本设备上的文档容器。它不会改变文档的 Proofnote 文件、版本或可编辑 HTML 身份。", "A Project is a device-local container for independent documents. It never changes a document’s Proofnote file, revision lineage, or editable-HTML identity.")}</p>
          <label class="pn-new-project-field" for="pnProjectName"><span class="pn-new-project-label">${tr("项目名称", "Project name")}</span><input class="pn-new-project-input" id="pnProjectName" type="text" autocomplete="off" maxlength="200" required></label>
          <div class="pn-actions pn-confirm-actions"><button class="btn btn-secondary" id="pnProjectCancel" type="button">${tr("取消", "Cancel")}</button><button class="btn btn-primary" id="pnProjectCreate" type="button">${tr("创建项目", "Create project")}</button></div>
        </section>
      </div>
      <div class="pn-outline-menu" id="pnOutlineMenu" role="menu" aria-label="${tr("大纲结构操作", "Outline structure actions")}" hidden></div>
      <div class="pn-project-move-menu" id="pnProjectMoveMenu" role="menu" aria-label="${tr("可用项目", "Available projects")}" hidden></div>
      <div class="pn-undo-toast" id="pnUndoToast" role="status" hidden><span id="pnUndoCopy"></span><button class="pn-undo-button" id="pnUndoButton" type="button">${tr("撤销", "Undo")}</button></div>`;
    document.body.appendChild(app);
    els = {
      app, utility: app.querySelector("#pnUtility"), utilityToggle: app.querySelector("#pnUtilityToggle"), sidebarResize: app.querySelector("#pnSidebarResize"), detail: app.querySelector("#pnDetail"), detailClose: app.querySelector("#pnCloseInspector"), actionToggle: app.querySelector("#pnActionsToggle"), actionMenu: app.querySelector("#pnActionMenu"), exportMore: app.querySelector("#pnExportMore"), exportMoreMenu: app.querySelector("#pnExportMoreMenu"), templateMenuToggle: app.querySelector("#pnTemplateMenuToggle"), templateMenu: app.querySelector("#pnTemplateMenu"), templates: app.querySelector("#pnTemplates"), projects: app.querySelector("#pnProjects"), documents: app.querySelector("#pnDocuments"), outlineCount: app.querySelector("#pnOutlineCount"), status: app.querySelector("#pnStatus"),
      outline: app.querySelector("#pnOutline"), canvasPane: app.querySelector(".pn-canvas-pane"), projectLanding: app.querySelector("#pnProjectLanding"), docPage: app.querySelector("#pnDocPage"), canvas: app.querySelector("#pnCanvas"), inspector: app.querySelector("#pnInspector"), inspectorTopLabel: app.querySelector("#pnInspectorTopLabel"), pageHeader: app.querySelector("#pnPageHeader"), footer: app.querySelector("#pnFooterName"), footerStatus: app.querySelector("#pnFooterStatus"), modal: app.querySelector("#pnImportModal"), confirmModal: app.querySelector("#pnConfirmModal"), confirmTitle: app.querySelector("#pnConfirmTitle"), confirmCopy: app.querySelector("#pnConfirmCopy"), confirmCancel: app.querySelector("#pnConfirmCancel"), confirmAccept: app.querySelector("#pnConfirmAccept"), newProjectModal: app.querySelector("#pnNewProjectModal"), newProjectName: app.querySelector("#pnNewProjectName"), newProjectCancel: app.querySelector("#pnNewProjectCancel"), newProjectCreate: app.querySelector("#pnCreateProject"), projectModal: app.querySelector("#pnProjectModal"), projectName: app.querySelector("#pnProjectName"), projectCancel: app.querySelector("#pnProjectCancel"), projectCreate: app.querySelector("#pnProjectCreate"),
      importText: app.querySelector("#pnImportText"), importFile: app.querySelector("#pnImportFile"), importFileTrigger: app.querySelector("#pnImportFileTrigger"), importFileLabel: app.querySelector("#pnImportFileLabel"), editableHtmlSummary: app.querySelector("#pnEditableHtmlSummary"), importConfirm: app.querySelector("#pnConfirmImport"), importReplace: app.querySelector("#pnReplaceImport"), importReport: app.querySelector("#pnImportReport"),
      outlineMenu: app.querySelector("#pnOutlineMenu"), projectMoveMenu: app.querySelector("#pnProjectMoveMenu"), undoToast: app.querySelector("#pnUndoToast"), undoCopy: app.querySelector("#pnUndoCopy"), undoButton: app.querySelector("#pnUndoButton")
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
      if (event.key !== "Enter" || isComposingInput(event)) return;
      event.preventDefault();
      els.footer.blur();
    });
  }

  function bindToolbar(app) {
    app.querySelector("#pnUtilityToggle").addEventListener("click", () => setUtilityOpen(!els.utility.classList.contains("is-open")));
    els.actionToggle.addEventListener("click", () => {
      const opening = els.actionMenu.hidden;
      if (opening) {
        closeDocumentMoreMenus();
        closeProjectMoveMenu();
        closeOutlineMenu();
        setTemplateMenuOpen(false);
      }
      setActionMenuOpen(opening);
    });
    els.exportMore.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setExportMoreOpen(els.exportMoreMenu.hidden, true);
    });
    els.exportMore.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") { event.preventDefault(); setExportMoreOpen(true, true); }
      if (event.key === "Escape") { event.preventDefault(); setExportMoreOpen(false); els.actionToggle.focus(); }
    });
    els.templateMenuToggle.addEventListener("click", () => {
      const opening = els.templateMenu.hidden;
      if (opening) {
        closeDocumentMoreMenus();
        closeProjectMoveMenu();
        closeOutlineMenu();
        setActionMenuOpen(false);
      }
      setTemplateMenuOpen(opening);
    });
    els.detailClose.addEventListener("click", () => setDetailOpen(false));
    app.addEventListener("click", (event) => {
      if (!event.target.closest(".pn-toolbar-menu")) setActionMenuOpen(false);
      if (!event.target.closest(".pn-template-menu-wrap")) setTemplateMenuOpen(false);
      if (!event.target.closest(".pn-document-more") && !event.target.closest("#pnProjectMoveMenu")) {
        closeProjectMoveMenu();
        closeDocumentMoreMenus();
      }
    });
    // Native <details> menus do not close their siblings themselves. Treat
    // every overflow menu as one shared transient surface, so menus cannot
    // stack or overlap in the navigator.
    app.addEventListener("toggle", (event) => {
      const menu = event.target;
      if (!menu || !menu.matches || !menu.matches("details.pn-document-more") || !menu.open) return;
      closeDocumentMoreMenus(menu);
      closeProjectMoveMenu();
      closeOutlineMenu();
      setActionMenuOpen(false);
      setTemplateMenuOpen(false);
    }, true);
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
      const activeModal = activeModalElement();
      if (activeModal && event.key === "Tab") {
        trapModalFocus(event, activeModal);
        return;
      }
      if (event.key !== "Escape") return;
      setActionMenuOpen(false);
      setTemplateMenuOpen(false);
      closeOutlineMenu();
      closeProjectMoveMenu();
      if (!els.modal.hidden) closeImport();
      if (!els.confirmModal.hidden) closeConfirm();
      if (!els.newProjectModal.hidden) closeNewProject();
      if (!els.projectModal.hidden) closeProjectModal();
    });
    app.querySelector("#pnTemplatesTab").addEventListener("click", () => setSidebarTab("templates"));
    app.querySelector("#pnOutlineTab").addEventListener("click", () => setSidebarTab("outline"));
    app.querySelector("#pnNew").addEventListener("click", () => chooseNewDocument());
    app.querySelector("#pnNewContainer").addEventListener("click", openProjectModal);
    app.querySelector("#pnSaveTemplate").addEventListener("click", () => { setTemplateMenuOpen(false); saveCurrentAsTemplate(); });
    app.querySelector("#pnImport").addEventListener("click", () => openImport("document"));
    app.querySelector("#pnImportEditableHtml").addEventListener("click", () => openImport("editable-html"));
    app.querySelector("#pnImportTemplate").addEventListener("click", () => openImport("template"));
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
      if (event.key !== "Enter" || isComposingInput(event)) return;
      event.preventDefault();
      createNewProject();
    });
    els.projectCancel.addEventListener("click", closeProjectModal);
    els.projectCreate.addEventListener("click", createProjectContainer);
    els.projectModal.addEventListener("click", (event) => { if (event.target === els.projectModal) closeProjectModal(); });
    els.projectName.addEventListener("input", () => els.projectName.removeAttribute("aria-invalid"));
    els.projectName.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || isComposingInput(event)) return;
      event.preventDefault();
      createProjectContainer();
    });
    els.undoButton.addEventListener("click", undoLastStructuralDelete);
    els.importConfirm.addEventListener("click", importFromDialog);
    els.importReplace.addEventListener("click", requestEditableHtmlReplacement);
    els.importFileTrigger.addEventListener("click", () => {
      if (!els.importFileTrigger.disabled) els.importFile.click();
    });
    els.importFile.addEventListener("change", readImportFile);
    els.importText.addEventListener("input", () => {
      resetImportWarningConfirmation();
      if (!els.importText.readOnly) els.importConfirm.disabled = false;
    });
    app.querySelector("#pnExport").addEventListener("click", () => { exportDocument(); setActionMenuOpen(false); });
    app.querySelector("#pnExportHtml").addEventListener("click", () => { exportHtml(); setActionMenuOpen(false); });
    app.querySelector("#pnExportEditableHtml").addEventListener("click", () => { exportEditableHtml(); setActionMenuOpen(false); });
    app.querySelector("#pnCopyAi").addEventListener("click", () => { copyAiInstructions(); setActionMenuOpen(false); });
    app.querySelector("#pnExportTemplate").addEventListener("click", () => { exportTemplate(); setTemplateMenuOpen(false); });
    app.querySelector("#pnLang").addEventListener("click", async () => {
      const saved = await saveActiveDocumentNow();
      if (!saveSucceeded(saved)) { reportSaveFailure(saved); return; }
      try { root.localStorage.setItem("sn-lang", english() ? "zh" : "en"); } catch (_) {}
      root.location.reload();
    });
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
    // IndexedDB writes cannot be made synchronously during teardown. Warn
    // instead of pretending that an asynchronous pagehide write is certain
    // to finish: the browser gives the author a chance to stay and let the
    // queued immutable snapshot persist.
    root.addEventListener("beforeunload", (event) => {
      if (!hasUnsavedChanges) return;
      flushBeforeLeaving();
      event.preventDefault();
      event.returnValue = "";
    });
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
    const naturalSheetWidth = 210 / 25.4 * 96;
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
    if (projectLandingIsOpen()) open = false;
    els.exportMoreMenu.hidden = !open;
    els.exportMore.setAttribute("aria-expanded", String(Boolean(open)));
    if (!open || !focusFirstItem) return;
    root.requestAnimationFrame(() => els.exportMoreMenu.querySelector('[role="menuitem"]')?.focus());
  }
  function setTemplateMenuOpen(open) {
    els.templateMenu.hidden = !open;
    els.templateMenuToggle.setAttribute("aria-expanded", String(Boolean(open)));
  }
  function requireDocumentAction() {
    if (!projectLandingIsOpen()) return true;
    setStatus(tr("项目概览中没有选中的文档；请先打开一份文档。", "Project overview has no selected document. Open a document first."), "warning");
    return false;
  }
  function closeDocumentMoreMenus(except) {
    if (!els || !els.app) return;
    els.app.querySelectorAll("details.pn-document-more[open]").forEach((menu) => {
      if (menu !== except) menu.open = false;
    });
  }
  function openImport(mode) {
    if (editableHtmlImportInProgress) return;
    setActionMenuOpen(false);
    setTemplateMenuOpen(false);
    // Any pending FileReader belongs to the previous import sheet state. A
    // fresh mode may not be populated by that old asynchronous callback.
    importFileReadGeneration += 1;
    importMode = mode === "template" ? "template" : mode === "editable-html" ? "editable-html" : "document";
    pendingEditableHtml = null;
    resetImportWarningConfirmation();
    els.modal.hidden = false;
    els.importText.value = "";
    els.importFile.value = "";
    const editableHtml = importMode === "editable-html";
    els.importText.hidden = editableHtml;
    els.importText.readOnly = editableHtml;
    els.editableHtmlSummary.hidden = !editableHtml;
    els.editableHtmlSummary.textContent = editableHtml
      ? tr("请选择 Proofnote 可编辑 HTML 文件。Proofnote 只恢复明确标记的语义字段；普通网页和展示版 HTML 不支持回导。", "Choose a Proofnote Editable HTML file. Proofnote recovers only explicit semantic fields; ordinary webpages and presentation HTML cannot be re-imported.")
      : "";
    els.importFile.accept = editableHtml ? ".html,.htm,text/html" : "application/json";
    els.importFileLabel.textContent = editableHtml ? tr("选择 Proofnote 可编辑 HTML", "Choose Proofnote editable HTML") : tr("选择文件", "Choose file");
    els.importFile.disabled = false;
    els.importFileTrigger.disabled = false;
    if (editableHtml) els.importFileTrigger.setAttribute("aria-describedby", "pnEditableHtmlSummary");
    else els.importFileTrigger.removeAttribute("aria-describedby");
    els.importConfirm.disabled = editableHtml;
    els.importReplace.hidden = !editableHtml;
    els.importReplace.disabled = true;
    const templateImport = importMode === "template";
    const heading = els.modal.querySelector(".pn-modal-heading h2");
    const copy = els.modal.querySelector(".pn-modal-copy");
    if (heading) heading.textContent = templateImport
      ? tr("导入模板", "Import template")
      : editableHtml ? tr("导入 Proofnote 可编辑 HTML", "Import Proofnote editable HTML") : tr("导入 JSON", "Import JSON");
    if (copy) copy.textContent = templateImport
      ? tr("仅支持 Proofnote 模板文件。导入模板不会切换或覆盖当前文档。", "Only Proofnote template files are accepted. Importing a template never switches or replaces the current document.")
      : editableHtml
        ? tr("仅接受带有完整 Proofnote Editable HTML 协议的文件：它必须包含唯一的 baseline source、稳定的 block/field 关系和版本身份。外部可以修改正文、结构和支持的语义属性；CSS、class、非语义 wrapper 与 KaTeX 预览只属于展示层，导入时会忽略并重新生成。字段重复、归属含糊或跨 block 时，Proofnote 不会猜测，而会拒绝导入。普通网页、展示版 HTML 导出和旧版 Proofnote HTML 都不支持回导。可编辑 HTML 包含完整原始内容，请只与可信对象共享。", "Only a file with the complete Proofnote Editable HTML protocol is accepted: it must contain one baseline source, stable block/field relationships, and version identity. External editors may change text, structure, and supported semantic properties; CSS, classes, non-semantic wrappers, and KaTeX previews are presentation-only and will be ignored and regenerated. If fields are duplicated, ambiguous, or cross blocks, Proofnote refuses to guess. Ordinary webpages, presentation exports, and legacy Proofnote HTML cannot be re-imported. Editable HTML contains complete source content, so share it only with people you trust.")
      : tr("支持 Proofnote Document 和原有 Solution Note 1.0。Solution Note 会无损优先地迁移为可编辑 blocks。导入文档会新建一份文档，不会覆盖当前文档。", "Supports Proofnote Document and Solution Note 1.0. Solution Notes are migrated into editable blocks. Importing creates a new document and never replaces the current one.");
    els.importConfirm.textContent = importConfirmLabel();
    clearImportReport();
    syncModalIsolation();
    root.requestAnimationFrame(() => (editableHtml ? els.importFileTrigger : els.importText).focus());
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
  function importConfirmLabel() {
    return importMode === "template" ? tr("导入模板", "Import template") : tr("导入为新文档", "Import as new document");
  }
  function resetImportWarningConfirmation() {
    importWarningConfirmation = null;
    if (els.importConfirm) els.importConfirm.textContent = importConfirmLabel();
    if (els.importReplace) els.importReplace.textContent = tr("覆盖当前文档…", "Replace current document…");
  }
  function confirmImportWarnings(warnings, title) {
    if (!warnings || !warnings.length) return true;
    const source = importMode === "editable-html" && pendingEditableHtml
      ? String(pendingEditableHtml.sourceKey || "")
      : String(els.importText && els.importText.value || "");
    const key = importMode + "\u0000" + source;
    if (importWarningConfirmation === key) return true;
    importWarningConfirmation = key;
    renderSchemaDiagnostics(title, [], warnings);
    els.importConfirm.textContent = tr("仍要导入", "Import anyway");
    if (importMode === "editable-html" && els.importReplace) els.importReplace.textContent = tr("仍要覆盖当前文档…", "Replace current document anyway…");
    return false;
  }
  function activeModalElement() {
    // Confirmation/new-project sheets sit above the import sheet if a flow
    // ever opens them consecutively, so trap focus in the visually topmost
    // dialog rather than whichever backdrop appears first in the DOM.
    return [els.projectModal, els.newProjectModal, els.confirmModal, els.modal].find((modal) => modal && !modal.hidden) || null;
  }
  function modalFocusableElements(modal) {
    if (!modal) return [];
    return Array.from(modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
  }
  function trapModalFocus(event, modal) {
    const focusable = modalFocusableElements(modal);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (!modal.contains(current)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && current === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
  }
  function syncModalIsolation() {
    const blocked = Boolean(activeModalElement());
    [els.app && els.app.querySelector(".pn-workspace-toolbar"), els.app && els.app.querySelector(".pn-shell"), els.outlineMenu, els.undoToast].forEach((surface) => {
      if (!surface) return;
      // `inert` makes the visual backdrop a real interaction boundary. Keep
      // aria-hidden in sync for assistive technology that does not yet honour
      // inert independently.
      surface.inert = blocked;
      surface.setAttribute("aria-hidden", String(blocked));
    });
    if (blocked) {
      closeOutlineMenu();
      setActionMenuOpen(false);
      setTemplateMenuOpen(false);
    }
  }
  function showImportMessage(message, kind) {
    if (!els.importReport) return;
    els.importReport.className = "pn-import-report" + (kind ? " is-" + kind : "");
    els.importReport.replaceChildren(element("p", { class: "pn-import-message" }, message));
  }
  function setEditableHtmlImportBusy(busy) {
    editableHtmlImportInProgress = Boolean(busy);
    if (!els || !els.modal) return;
    els.modal.classList.toggle("is-busy", editableHtmlImportInProgress);
    const close = els.modal.querySelector("#pnCloseImport");
    if (close) close.disabled = editableHtmlImportInProgress;
    if (editableHtmlImportInProgress) {
      els.importFile.disabled = true;
      els.importFileTrigger.disabled = true;
      els.importConfirm.disabled = true;
      els.importReplace.disabled = true;
      return;
    }
    if (importMode === "editable-html" && !els.modal.hidden) syncEditableHtmlImportActions();
  }
  function editableHtmlCanReplace(candidate) {
    const protocol = root.ProofnoteEditableHtml;
    if (!candidate || candidate.protocolVersion !== "2" || candidate.status === "STALE" || candidate.replacementEligible !== true) return false;
    if (!protocol || typeof protocol.protocolLineage !== "function") return false;
    const currentLineage = protocol.protocolLineage(state);
    // A pre-v2.1 library may still contain two historical records with the
    // same portable lineage. The repair pass normally forks them on startup;
    // this gate is the fail-closed backstop if another tab changed a record
    // during repair or an old client creates a collision later.
    return Boolean(currentLineage && candidate.documentId && currentLineage === candidate.documentId && hasExclusiveEditableHtmlLineage(state));
  }
  function syncEditableHtmlImportActions() {
    if (importMode !== "editable-html" || els.modal.hidden) return;
    const verified = Boolean(pendingEditableHtml);
    els.importFile.disabled = false;
    els.importFileTrigger.disabled = false;
    els.importConfirm.disabled = !verified;
    els.importReplace.disabled = !editableHtmlCanReplace(pendingEditableHtml);
  }
  function closeImport(options) {
    const opts = options || {};
    if (editableHtmlImportInProgress && !opts.force) return false;
    // A user dismissing this sheet has cancelled its in-flight import. A
    // successful import opts out so its final document activation keeps the
    // transition generation it started with.
    if (opts.cancelTransition !== false) transitionGeneration += 1;
    importFileReadGeneration += 1;
    pendingEditableHtml = null;
    els.importText.value = "";
    els.importText.hidden = false;
    els.importText.readOnly = false;
    els.importFile.value = "";
    els.importFile.disabled = false;
    els.importFileTrigger.disabled = false;
    els.importFileTrigger.removeAttribute("aria-describedby");
    els.importFile.accept = "application/json";
    els.importFileLabel.textContent = tr("选择文件", "Choose file");
    els.editableHtmlSummary.hidden = true;
    els.editableHtmlSummary.textContent = "";
    els.importConfirm.disabled = false;
    els.importReplace.hidden = true;
    els.importReplace.disabled = false;
    els.modal.hidden = true;
    importMode = "document";
    resetImportWarningConfirmation();
    clearImportReport();
    syncModalIsolation();
    return true;
  }
  function openConfirm(options) {
    const opts = options || {};
    confirmActionHandler = typeof opts.onConfirm === "function" ? opts.onConfirm : null;
    els.confirmTitle.textContent = opts.title || tr("继续操作？", "Continue?");
    els.confirmCopy.textContent = opts.message || "";
    els.confirmAccept.textContent = opts.confirmLabel || tr("继续", "Continue");
    els.confirmModal.hidden = false;
    syncModalIsolation();
    root.requestAnimationFrame(() => els.confirmCancel.focus());
  }
  function closeConfirm() {
    confirmActionHandler = null;
    els.confirmModal.hidden = true;
    syncModalIsolation();
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    if (!hasUnsavedChanges) return;
    saveTimer = setTimeout(async () => {
      try {
        const result = await saveActiveDocument();
        if (result.backend === "unchanged" || !result.current) return;
        if (!saveSucceeded(result.backend)) {
          reportSaveFailure(result.backend);
          return;
        }
        persistenceAvailable = true;
        setPersistenceStatus(result.backend === "indexeddb" ? tr("已自动保存到此设备", "Saved on this device") : tr("已自动保存（本地存储）", "Saved locally"));
      } catch (_) {
        reportSaveFailure("failed");
      }
    }, 350);
  }

  function saveSnapshot() {
    if (!state) return null;
    // normalizeDocument already makes a defensive, portable clone. Avoid an
    // additional JSON stringify/parse pass for every autosave, particularly
    // for documents containing embedded images.
    const document = Model.normalizeDocument(state, { allowRemoteImages: true });
    return { documentId: currentDocumentId, revision: editRevision, document };
  }

  function saveSucceeded(backend) {
    return backend === "indexeddb" || backend === "localStorage" || backend === "unchanged";
  }
  function reportSaveFailure(backend) {
    // Do not let unrelated non-persistence actions, or the next keystroke,
    // overwrite a truthful save failure with a generic green confirmation.
    persistenceAvailable = false;
    if (backend === "conflict") {
      setStatus(tr("此文档已在另一标签页更新；为避免覆盖，请先导出当前版本备份。", "This document changed in another tab. Export this version before resolving the conflict."), "error");
      return;
    }
    setStatus(tr("自动保存失败；请立即导出文档备份。", "Autosave failed — export a backup now."), "error");
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
          documentRevisions.set(documentId, Number.isSafeInteger(created.record.revision) ? created.record.revision : 0);
          if (currentDocumentId === "") {
            currentDocumentId = documentId;
            documents = [created.record].concat(documents.filter((record) => record.id !== documentId));
            renderDocumentLibrary();
          }
        }
      }
      if (backend !== "failed" || documentId) {
        if (backend === "failed") {
          const expectedRevision = documentRevisions.get(documentId);
          backend = await Store.saveDocument(documentId, snapshot.document, expectedRevision);
          if (backend === "indexeddb" || backend === "localStorage") documentRevisions.set(documentId, (expectedRevision || 0) + 1);
        }
        if (!saveSucceeded(backend)) return { backend, current: false };
        persistenceAvailable = true;
      }
      const current = currentDocumentId === documentId && editRevision === snapshot.revision;
      if (current) hasUnsavedChanges = false;
      // Autosave must not reread every full document (and every embedded
      // image) merely to redraw the library. The library is refreshed on
      // explicit navigation/creation/deletion; its active record summary is
      // enough between those low-frequency operations.
      const libraryRecord = documents.find((record) => record.id === documentId);
      if (libraryRecord) {
        libraryRecord.document = snapshot.document;
        libraryRecord.updatedAt = snapshot.document.metadata.updatedAt;
      }
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
        if (!saveSucceeded(result.backend)) return result;
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
    const repairedCustom = [];
    for (const rawTemplate of custom) {
      const normalized = Model.normalizeTemplate(rawTemplate);
      const hasStoredId = Boolean(rawTemplate && rawTemplate.template && Object.prototype.hasOwnProperty.call(rawTemplate.template, "id"));
      const storedId = hasStoredId ? String(rawTemplate.template.id == null ? "" : rawTemplate.template.id) : "";
      // Normalisation regenerates unsafe/missing IDs. Persist that migration
      // immediately so subsequent refreshes refer to the same template.
      if (hasStoredId && normalized.template.id !== storedId && typeof Store.repairTemplate === "function") {
        try {
          const repaired = await Store.repairTemplate(storedId, normalized);
          if (!saveSucceeded(repaired)) {
            setStatus(tr("一个旧模板的安全 ID 无法保存；它不会被用作当前模板。", "A legacy template's repaired ID could not be saved; it will not be used as the active template."), "warning");
            continue;
          }
        } catch (_) {
          setStatus(tr("一个旧模板无法安全修复。", "A legacy template could not be repaired safely."), "warning");
          continue;
        }
      }
      repairedCustom.push(normalized);
    }
    templates = Model.builtInTemplates().concat(repairedCustom).sort((first, second) => {
      const firstRank = preferredOrder.indexOf(first.template.id);
      const secondRank = preferredOrder.indexOf(second.template.id);
      if (firstRank !== secondRank) return (firstRank < 0 ? 99 : firstRank) - (secondRank < 0 ? 99 : secondRank);
      if (first.template.builtIn !== second.template.builtIn) return first.template.builtIn ? -1 : 1;
      return first.template.name.localeCompare(second.template.name);
    });
    renderTemplateLibrary();
  }
  function localRecordOrder(first, second) {
    // Keep the currently open record's legacy identity whenever possible.
    // Otherwise retain the oldest local record deterministically, so a repair
    // is stable across reloads and tabs rather than depending on array order.
    const firstCurrent = first && first.id === currentDocumentId;
    const secondCurrent = second && second.id === currentDocumentId;
    if (firstCurrent !== secondCurrent) return firstCurrent ? -1 : 1;
    const firstCreated = String(first && first.createdAt || "");
    const secondCreated = String(second && second.createdAt || "");
    const byCreated = firstCreated.localeCompare(secondCreated);
    return byCreated || String(first && first.id || "").localeCompare(String(second && second.id || ""));
  }
  function duplicateEditableHtmlLineageGroups(records) {
    const groups = new Map();
    (records || []).forEach((record) => {
      const lineage = editableHtmlProtocolLineage(record && record.document);
      if (!lineage) return;
      const group = groups.get(lineage) || [];
      group.push(record);
      groups.set(lineage, group);
    });
    return Array.from(groups.values()).filter((group) => group.length > 1).map((group) => group.slice().sort(localRecordOrder));
  }
  function hasExclusiveEditableHtmlLineage(document) {
    const lineage = editableHtmlProtocolLineage(document);
    if (!lineage) return true;
    return documents.filter((record) => editableHtmlProtocolLineage(record && record.document) === lineage).length === 1;
  }
  async function repairDuplicateEditableHtmlLineages() {
    if (editableHtmlLineageRepair) return editableHtmlLineageRepair;
    const repair = async () => {
      const groups = duplicateEditableHtmlLineageGroups(documents);
      if (!groups.length) return { repaired: 0, unresolved: 0 };
      let repaired = 0;
      let unresolved = 0;
      for (const group of groups) {
        // The first record remains the deterministic owner of the historical
        // lineage. Every other record keeps its content and local ID but gets
        // a fresh lineage by a revision-checked write.
        for (const record of group.slice(1)) {
          const expectedRevision = Number.isSafeInteger(record && record.revision) ? record.revision : 0;
          let forked;
          try { forked = forkEditableHtmlLineage(record.document); }
          catch (_) { unresolved += 1; continue; }
          let result = null;
          try { result = await Store.replaceDocument(record.id, forked, expectedRevision, { makeCurrent: false }); }
          catch (_) { unresolved += 1; continue; }
          if (result && result.record && saveSucceeded(result.backend)) {
            repaired += 1;
            documentRevisions.set(record.id, Number.isSafeInteger(result.record.revision) ? result.record.revision : expectedRevision + 1);
          } else {
            // A concurrent writer wins over a migration. Leave its content
            // untouched; replacement remains disabled until a later refresh
            // can prove this lineage is no longer shared.
            unresolved += 1;
          }
        }
      }
      if (repaired || unresolved) {
        const library = typeof Store.listDocumentLibrary === "function"
          ? await Store.listDocumentLibrary()
          : { records: await Store.listDocuments(), backend: "unknown" };
        if (library && library.backend !== "failed") {
          documents = Array.isArray(library.records) ? library.records : [];
          renderDocumentLibrary();
        }
      }
      if (repaired || unresolved) editableHtmlLineageRepairNotice = { repaired, unresolved };
      return { repaired, unresolved };
    };
    editableHtmlLineageRepair = repair().catch(() => ({ repaired: 0, unresolved: 1 })).finally(() => { editableHtmlLineageRepair = null; });
    return editableHtmlLineageRepair;
  }
  async function refreshDocuments() {
    const [library, projectLibrary] = await Promise.all([
      typeof Store.listDocumentLibrary === "function"
        ? Store.listDocumentLibrary()
        : Promise.resolve({ records: Store.listDocuments ? Store.listDocuments() : [], backend: "unknown" }),
      typeof Store.listProjects === "function"
        ? Store.listProjects()
        : Promise.resolve({ projects: [], backend: "unknown" })
    ]);
    documents = Array.isArray(library && library.records) ? library.records : [];
    projects = Array.isArray(projectLibrary && projectLibrary.projects) ? projectLibrary.projects : [];
    projectRevisions.clear();
    projects.forEach((project) => projectRevisions.set(project.id, Number.isSafeInteger(project.revision) ? project.revision : 0));
    if (activeProjectId && !projects.some((project) => project.id === activeProjectId)) activeProjectId = "";
    if (projectLandingId && !projects.some((project) => project.id === projectLandingId)) projectLandingId = "";
    renderProjectLibrary();
    renderDocumentLibrary();
    renderProjectLanding();
    if (library && library.backend !== "failed") await repairDuplicateEditableHtmlLineages();
    return library && library.backend !== "failed" && projectLibrary && projectLibrary.backend !== "failed"
      ? library.backend : "failed";
  }
  function currentTemplateId() {
    if (templateById(selectedTemplateId)) return selectedTemplateId;
    const metadata = state && state.metadata ? state.metadata : {};
    const durableId = String(metadata.templateId || "").trim();
    if (templateById(durableId)) return durableId;
    const name = String(metadata.templateName || "").trim();
    const matches = name ? templates.filter((template) => template.template.name === name) : [];
    // Old documents have only a display name. Use it only when it identifies
    // one template unambiguously; never point a document at an arbitrary
    // same-named custom template.
    return matches.length === 1 ? matches[0].template.id : "";
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
      if (template.template.builtIn) {
        els.templates.appendChild(item);
        return;
      }
      const row = element("div", { class: "pn-template-item-row", role: "listitem" });
      item.removeAttribute("role");
      row.append(item, button("×", "pn-template-delete", () => requestDeleteTemplate(template), tr("删除模板", "Delete template")));
      els.templates.appendChild(row);
    });
  }
  function requestDeleteTemplate(template) {
    if (!template || !template.template || template.template.builtIn) return;
    const name = template.template.name || tr("此模板", "this template");
    openConfirm({
      title: tr("删除模板？", "Delete template?"),
      message: tr("将删除“" + name + "”。此操作不会影响已用它创建的文档。", "This deletes “" + name + "”. Documents already created from it are unaffected."),
      confirmLabel: tr("删除模板", "Delete template"),
      onConfirm: async () => {
        const backend = await Store.deleteTemplate(template.template.id);
        if (!saveSucceeded(backend)) { setStatus(tr("删除模板失败。", "Could not delete template."), "error"); return; }
        if (selectedTemplateId === template.template.id) selectedTemplateId = "";
        await refreshTemplates();
        setStatus(tr("模板已删除", "Template deleted"), "saved");
      }
    });
  }
  function documentName(record) {
    const metadata = record && record.document && record.document.metadata || {};
    const portableName = String(metadata.name || "").trim();
    const title = record && record.document && Array.isArray(record.document.blocks)
      ? record.document.blocks.find((block) => block && block.type === "title") : null;
    const titleName = String(title && title.content || "").trim();
    return portableName || titleName || tr("未命名文档", "Untitled document");
  }
  function localProjectMembership(record) {
    const position = Number(record && record.projectPosition);
    return {
      projectId: String(record && record.projectId || "").trim(),
      projectGroup: String(record && record.projectGroup || "").trim(),
      projectPinned: Boolean(record && record.projectPinned),
      projectPosition: Number.isFinite(position) && position >= 0 ? position : 0
    };
  }
  function projectDocumentOrder(first, second) {
    // Project navigation follows work that changed, not a manual queue or
    // reading history. Opening only updates lastOpenedAt, which is never used
    // here, so it cannot move a document within its Project.
    const recency = String(second.updatedAt || second.createdAt || "").localeCompare(String(first.updatedAt || first.createdAt || ""));
    if (recency) return recency;
    return documentName(first).localeCompare(documentName(second)) || String(first.id || "").localeCompare(String(second.id || ""));
  }
  function projectById(projectId) { return projects.find((project) => project && project.id === projectId) || null; }
  function projectLandingIsOpen() { return Boolean(projectLandingId && projectById(projectLandingId)); }
  function projectCreationContextId() { return projectLandingIsOpen() ? projectLandingId : activeProjectId || ""; }
  function syncProjectLandingActionAvailability() {
    const unavailable = projectLandingIsOpen();
    const reason = unavailable ? tr("请先打开一份文档", "Open a document first") : "";
    ["pnExportHtml", "pnExportMore", "pnExportEditableHtml", "pnExport", "pnCopyAi", "pnSaveTemplate", "pnExportTemplate"].forEach((id) => {
      const control = els && els.app ? els.app.querySelector("#" + id) : null;
      if (!control) return;
      control.disabled = unavailable;
      control.setAttribute("aria-disabled", String(unavailable));
      if (unavailable) control.title = reason;
      else control.removeAttribute("title");
    });
    if (unavailable) setExportMoreOpen(false);
  }
  function projectDocuments(projectId) {
    return documents.filter((record) => localProjectMembership(record).projectId === projectId).sort(projectDocumentOrder);
  }
  function projectGroupLabel(group) {
    const labels = {
      Main: tr("主线", "Main"), Research: tr("研究", "Research"),
      Experiments: tr("实验", "Experiments"), Archive: tr("归档", "Archive")
    };
    return labels[group] || tr("文档", "Documents");
  }
  function projectGroupBuckets(records) {
    const buckets = new Map();
    records.forEach((record) => {
      const group = localProjectMembership(record).projectGroup;
      const bucket = buckets.get(group) || [];
      bucket.push(record);
      buckets.set(group, bucket);
    });
    return Array.from(buckets.entries()).sort(([first], [second]) => {
      if (!first) return -1;
      if (!second) return 1;
      return first.localeCompare(second);
    });
  }
  function renderProjectLibrary() {
    if (!els.projects) return;
    closeProjectMoveMenu();
    els.projects.innerHTML = "";
    if (!projects.length) {
      els.projects.appendChild(element("p", { class: "pn-library-empty" }, tr("还没有项目。", "No projects yet.")));
      return;
    }
    projects.forEach((project) => {
      const projectId = project.id;
      // A Project landing page and a document row are alternative selections.
      // `activeProjectId` remains the creation/import context, but must never
      // make the parent Project look selected alongside its open document.
      const projectSelected = projectId === projectLandingId;
      const row = element("section", { class: "pn-project-item" + (projectSelected ? " is-active" : ""), role: "listitem" });
      const heading = element("div", { class: "pn-project-heading" });
      const open = button(project.name, "pn-project-open", () => showProjectLanding(projectId), project.name);
      open.setAttribute("aria-current", String(projectSelected));
      const actions = element("details", { class: "pn-document-more pn-project-more" });
      actions.appendChild(element("summary", { class: "pn-document-more-trigger", "aria-label": tr("项目操作", "Project actions") }, "•••"));
      const menu = element("div", { class: "pn-document-more-menu" });
      menu.append(
        button(tr("重命名", "Rename"), "pn-document-more-item", () => requestRenameProject(project)),
        button(tr("查看概览", "View overview"), "pn-document-more-item", () => showProjectLanding(projectId)),
        button(tr("删除项目", "Delete Project"), "pn-document-more-item pn-document-danger", () => requestDeleteProject(project))
      );
      actions.appendChild(menu);
      heading.append(open, actions);
      row.appendChild(heading);
      const projectRecords = projectDocuments(projectId);
      if (!projectRecords.length) {
        row.appendChild(element("p", { class: "pn-library-empty pn-project-empty" }, tr("还没有文档。", "No documents yet.")));
      } else {
        projectGroupBuckets(projectRecords).forEach(([group, records]) => {
          const groupNode = element("div", { class: "pn-project-group" });
          if (group || projectRecords.some((record) => localProjectMembership(record).projectGroup)) groupNode.appendChild(element("div", { class: "pn-library-subheading" }, projectGroupLabel(group)));
          records.forEach((record) => groupNode.appendChild(renderDocumentRow(record)));
          row.appendChild(groupNode);
        });
      }
      els.projects.appendChild(row);
    });
  }
  function renderDocumentRow(record) {
    const documentSelected = !projectLandingId && record.id === currentDocumentId;
    const row = element("div", { class: "pn-document-item" + (documentSelected ? " is-active" : ""), role: "listitem" });
    row.dataset.documentId = record.id;
    if (renamingDocumentId === record.id) {
      const rename = element("input", { class: "pn-document-rename", type: "text", value: renameDrafts.has(record.id) ? renameDrafts.get(record.id) : documentName(record), "aria-label": tr("重命名文档", "Rename document") });
      const save = () => finishDocumentRename(record.id, rename.value);
      rename.addEventListener("input", () => renameDrafts.set(record.id, rename.value));
      rename.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !isComposingInput(event)) { event.preventDefault(); save(); }
        if (event.key === "Escape") { event.preventDefault(); renameDrafts.delete(record.id); renamingDocumentId = ""; renderProjectLibrary(); renderDocumentLibrary(); }
      });
      row.append(rename, button(tr("保存", "Save"), "pn-document-rename-save", save), button(tr("取消", "Cancel"), "pn-document-rename-cancel", () => { renameDrafts.delete(record.id); renamingDocumentId = ""; renderProjectLibrary(); renderDocumentLibrary(); }));
      root.requestAnimationFrame(() => rename.focus());
      return row;
    }
    const open = button(documentName(record), "pn-document-open", () => openLibraryDocument(record.id), documentName(record));
    open.setAttribute("aria-current", String(documentSelected));
    const actions = element("details", { class: "pn-document-more" });
    actions.appendChild(element("summary", { class: "pn-document-more-trigger", "aria-label": tr("文档操作", "Document actions") }, "•••"));
    const menu = element("div", { class: "pn-document-more-menu" });
    const menuItems = [
      button(tr("重命名", "Rename"), "pn-document-more-item", () => { renameDrafts.set(record.id, documentName(record)); renamingDocumentId = record.id; renderProjectLibrary(); renderDocumentLibrary(); }),
      button(tr("复制", "Copy"), "pn-document-more-item", () => duplicateLibraryDocument(record.id)),
      projectMoveTrigger(record),
      button(tr("删除文档", "Delete document"), "pn-document-more-item pn-document-danger", () => requestDeleteLibraryDocument(record.id))
    ].filter(Boolean);
    menu.append(...menuItems);
    actions.appendChild(menu);
    row.append(open, actions);
    return row;
  }
  function projectMoveTrigger(record) {
    const trigger = button("", "pn-document-more-item pn-document-more-project-trigger", () => toggleProjectMoveMenu(record, trigger));
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.append(
      element("span", {}, tr("移动至项目", "Move to project")),
      element("span", { class: "pn-document-more-project-arrow", "aria-hidden": "true" }, "›")
    );
    return trigger;
  }
  function closeProjectMoveMenu() {
    if (!els || !els.projectMoveMenu) return;
    els.projectMoveMenu.hidden = true;
    els.projectMoveMenu.replaceChildren();
    if (projectMoveAnchor) projectMoveAnchor.setAttribute("aria-expanded", "false");
    projectMoveAnchor = null;
  }
  function toggleProjectMoveMenu(record, anchor) {
    if (!record || !anchor || !els.projectMoveMenu) return;
    if (!els.projectMoveMenu.hidden && projectMoveAnchor === anchor) {
      closeProjectMoveMenu();
      return;
    }
    const owner = anchor.closest ? anchor.closest("details.pn-document-more") : null;
    closeDocumentMoreMenus(owner);
    closeProjectMoveMenu();
    closeOutlineMenu();
    setActionMenuOpen(false);
    setTemplateMenuOpen(false);
    const membership = localProjectMembership(record);
    const menu = els.projectMoveMenu;
    if (membership.projectId) menu.appendChild(button(tr("移出项目", "Remove from project"), "pn-document-more-item", () => moveDocumentDirect(record.id, "")));
    const available = projects.filter((project) => project && project.id !== membership.projectId);
    if (!available.length) {
      menu.appendChild(element("p", { class: "pn-document-more-project-empty" }, tr("没有其他可用项目。", "No other available projects.")));
    } else {
      available.forEach((project) => menu.appendChild(button(project.name, "pn-document-more-item pn-document-more-project-choice", () => moveDocumentDirect(record.id, project.id), project.name)));
    }
    const anchorBox = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(anchorBox.right + 4, root.innerWidth - 238)) + "px";
    menu.style.top = Math.max(8, anchorBox.top - 4) + "px";
    menu.hidden = false;
    projectMoveAnchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    const menuBox = menu.getBoundingClientRect();
    if (menuBox.right > root.innerWidth - 8) menu.style.left = Math.max(8, anchorBox.left - menuBox.width - 4) + "px";
    if (menuBox.bottom > root.innerHeight - 8) menu.style.top = Math.max(8, root.innerHeight - menuBox.height - 8) + "px";
  }
  function renderDocumentLibrary() {
    if (!els.documents) return;
    closeProjectMoveMenu();
    els.documents.innerHTML = "";
    // A stale local membership must never make a document disappear from the
    // navigator. Treat an unknown project ID as unfiled until the author
    // deliberately moves it again.
    const unfiled = documents.filter((record) => {
      const projectId = localProjectMembership(record).projectId;
      return !projectId || !projectById(projectId);
    });
    if (!unfiled.length) {
      els.documents.appendChild(element("p", { class: "pn-library-empty" }, projects.length ? tr("没有未归属文档。", "No unfiled documents.") : tr("还没有其他文档。", "No other documents yet.")));
      return;
    }
    unfiled.forEach((record) => els.documents.appendChild(renderDocumentRow(record)));
  }
  function renderProjectLanding() {
    if (!els.projectLanding || !els.docPage) return;
    const project = projectById(projectLandingId);
    const open = Boolean(project);
    els.projectLanding.hidden = !open;
    els.docPage.hidden = open;
    syncProjectLandingActionAvailability();
    if (!open) return;
    const records = projectDocuments(project.id);
    const recent = records.slice(0, 5);
    const contents = [
      element("p", { class: "pn-project-landing-kicker" }, tr("项目概览", "PROJECT OVERVIEW")),
      element("h1", { class: "pn-project-landing-title" }, project.name),
      element("p", { class: "pn-project-landing-summary" }, tr(
        records.length + " 份文档，按最近编辑排序。项目归属仅保存在本设备，不会进入 Proofnote 文件或可编辑 HTML。",
        records.length + " document" + (records.length === 1 ? "" : "s") + ", ordered by most recent edit. Project membership stays on this device; it is never written into a Proofnote file or editable HTML."
      )),
      button(tr("＋ 新建文档", "+ New document"), "pn-project-landing-new", () => chooseNewDocument()),
      projectLandingSection(tr("最近编辑", "Recent"), recent)
    ].filter(Boolean);
    els.projectLanding.replaceChildren(...contents);
  }
  function projectLandingSection(title, records) {
    const section = element("section", { class: "pn-project-landing-section" });
    section.appendChild(element("h2", {}, title));
    if (!records.length) {
      section.appendChild(element("p", { class: "pn-library-empty" }, tr("还没有文档。", "No documents yet.")));
      return section;
    }
    const list = element("div", { class: "pn-project-landing-list" });
    records.forEach((record) => {
      const row = button("", "pn-project-landing-document", () => openLibraryDocument(record.id), documentName(record));
      row.append(element("span", { class: "pn-project-landing-document-name" }, documentName(record)));
      const membership = localProjectMembership(record);
      row.append(element("span", { class: "pn-project-landing-document-meta" }, membership.projectGroup ? projectGroupLabel(membership.projectGroup) : tr("文档", "Document")));
      list.appendChild(row);
    });
    section.appendChild(list);
    return section;
  }
  function templateById(templateId) { return templates.find((template) => template.template.id === templateId); }
  async function activateDocument(record, options) {
    if (!record || !record.document) return;
    documentGeneration += 1;
    clearStructuralUndo();
    currentDocumentId = record.id;
    projectLandingId = "";
    activeProjectId = localProjectMembership(record).projectId;
    syncProjectLandingActionAvailability();
    documentRevisions.set(record.id, Number.isSafeInteger(record.revision) ? record.revision : 0);
    restoreOutlineCollapseState(record.id, false);
    selectedTemplateId = "";
    state = Model.normalizeDocument(record.document, { allowRemoteImages: true });
    editRevision = 0;
    hasUnsavedChanges = false;
    renderAll();
    await refreshDocuments();
    root.requestAnimationFrame(syncCanvasScale);
    if (!options || options.status !== false) setStatus(tr("已打开文档", "Document opened"), "saved");
  }
  function enqueueDocumentTransition(operation) {
    const generation = ++transitionGeneration;
    const task = () => operation(generation);
    const job = transitionQueue.then(task, task);
    transitionQueue = job.catch(() => undefined);
    return job;
  }
  function transitionIsCurrent(generation) { return generation === transitionGeneration; }
  async function selectAndActivateDocument(record, generation, options) {
    if (!record || !transitionIsCurrent(generation)) return false;
    const selected = await Store.setCurrentDocument(record.id);
    if (!selected || !selected.record || selected.backend === "failed") return false;
    if (!transitionIsCurrent(generation)) return false;
    await activateDocument(selected.record, options);
    return true;
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
    syncModalIsolation();
    root.requestAnimationFrame(() => els.newProjectName.focus());
  }
  function closeNewProject() {
    els.newProjectModal.hidden = true;
    els.newProjectName.removeAttribute("aria-invalid");
    syncModalIsolation();
  }
  function showProjectLanding(projectId) {
    const project = projectById(projectId);
    if (!project) return;
    activeProjectId = project.id;
    projectLandingId = project.id;
    clearCanvasSelection();
    setDetailOpen(false);
    renderProjectLibrary();
    renderDocumentLibrary();
    renderProjectLanding();
    root.requestAnimationFrame(syncCanvasScale);
  }
  function openProjectModal() {
    els.projectName.value = "";
    els.projectName.removeAttribute("aria-invalid");
    els.projectModal.hidden = false;
    syncModalIsolation();
    root.requestAnimationFrame(() => els.projectName.focus());
  }
  function closeProjectModal() {
    els.projectModal.hidden = true;
    els.projectName.removeAttribute("aria-invalid");
    syncModalIsolation();
  }
  function uniqueProjectName(requestedName, excludedId) {
    const name = String(requestedName || "").trim();
    const normalise = (value) => String(value || "").trim().toLocaleLowerCase();
    const occupied = new Set(projects.filter((project) => project && project.id !== excludedId).map((project) => normalise(project.name)).filter(Boolean));
    if (!occupied.has(normalise(name))) return name;
    let suffix = 1;
    let candidate = name + " (" + suffix + ")";
    while (occupied.has(normalise(candidate))) {
      suffix += 1;
      candidate = name + " (" + suffix + ")";
    }
    return candidate;
  }
  async function createProjectContainer() {
    const requestedName = String(els.projectName.value || "").trim();
    if (!requestedName) {
      els.projectName.setAttribute("aria-invalid", "true");
      els.projectName.focus();
      return;
    }
    return enqueueDocumentTransition(async (generation) => {
      const saved = await saveActiveDocumentNow();
      if (!saveSucceeded(saved)) { reportSaveFailure(saved); return; }
      await refreshDocuments();
      if (!transitionIsCurrent(generation)) return;
      const created = await Store.createProject(uniqueProjectName(requestedName));
      if (!created || !created.project || !saveSucceeded(created.backend)) {
        setStatus(tr("新建项目失败。", "Could not create project."), "error");
        return;
      }
      closeProjectModal();
      projects.push(created.project);
      projectRevisions.set(created.project.id, Number.isSafeInteger(created.project.revision) ? created.project.revision : 0);
      if (!transitionIsCurrent(generation)) return;
      showProjectLanding(created.project.id);
      setStatus(tr("已新建项目", "New project created"), "saved");
    });
  }
  async function requestRenameProject(project) {
    if (!project) return;
    const requested = root.prompt(tr("项目名称", "Project name"), project.name);
    if (requested == null) return;
    const nextName = String(requested || "").trim();
    if (!nextName) return;
    const renamed = await Store.renameProject(project.id, uniqueProjectName(nextName, project.id), projectRevisions.get(project.id));
    if (!renamed || !renamed.project || !saveSucceeded(renamed.backend)) {
      setStatus(renamed && renamed.backend === "conflict" ? tr("项目已在另一标签页更新；请刷新项目列表后重试。", "This project changed in another tab. Refresh the project list and try again.") : tr("重命名项目失败。", "Could not rename project."), "error");
      return;
    }
    projectRevisions.set(project.id, Number.isSafeInteger(renamed.project.revision) ? renamed.project.revision : 0);
    projects = projects.map((entry) => entry.id === project.id ? renamed.project : entry);
    renderProjectLibrary();
    renderProjectLanding();
    setStatus(tr("项目已重命名", "Project renamed"), "saved");
  }
  function requestDeleteProject(project) {
    if (!project || typeof Store.deleteProject !== "function") return;
    openConfirm({
      title: tr("删除项目？", "Delete Project?"),
      message: tr(
        "将删除“" + project.name + "”这个本地项目容器。其中的文档会保留，并移至未归属文档。此操作不会删除任何文档内容。",
        "This deletes the local Project container “" + project.name + "”. Its documents will remain and move to Unfiled documents. No document content will be deleted."
      ),
      confirmLabel: tr("删除项目", "Delete Project"),
      onConfirm: () => enqueueDocumentTransition(async (generation) => {
        const saved = await saveActiveDocumentNow();
        if (!saveSucceeded(saved)) { reportSaveFailure(saved); return; }
        if (!transitionIsCurrent(generation)) return;
        const deleted = await Store.deleteProject(project.id, projectRevisions.get(project.id));
        if (!deleted || !saveSucceeded(deleted.backend)) {
          setStatus(deleted && deleted.backend === "conflict"
            ? tr("项目已在另一标签页更新；请刷新项目列表后重试。", "This Project changed in another tab. Refresh the Project list and try again.")
            : tr("删除项目失败。", "Could not delete Project."), "error");
          return;
        }
        if (!transitionIsCurrent(generation)) return;
        projectRevisions.delete(project.id);
        if (activeProjectId === project.id) activeProjectId = "";
        if (projectLandingId === project.id) projectLandingId = "";
        const detached = Array.isArray(deleted.records) ? deleted.records : [];
        detached.forEach((record) => documentRevisions.set(record.id, Number.isSafeInteger(record.revision) ? record.revision : 0));
        await refreshDocuments();
        setStatus(detached.length
          ? tr("项目已删除；其中的 " + detached.length + " 份文档已移至未归属文档。", "Project deleted; its " + detached.length + " document" + (detached.length === 1 ? " was" : "s were") + " moved to Unfiled documents.")
          : tr("项目已删除。", "Project deleted."), "saved");
      })
    });
  }
  async function updateDocumentProject(documentId, assignment) {
    const record = documents.find((entry) => entry && entry.id === documentId);
    if (!record || typeof Store.assignDocumentToProject !== "function") return false;
    if (documentId === currentDocumentId) {
      const saved = await saveActiveDocumentNow();
      if (!saveSucceeded(saved)) { reportSaveFailure(saved); return false; }
    }
    const result = await Store.assignDocumentToProject(documentId, assignment, documentRevisions.get(documentId));
    if (!result || !result.record || !saveSucceeded(result.backend)) {
      setStatus(result && result.backend === "conflict" ? tr("文档已在另一标签页更新；请刷新后再整理。", "This document changed in another tab. Refresh before organizing it.") : tr("无法更新文档项目归属。", "Could not update the document’s project membership."), "error");
      return false;
    }
    documentRevisions.set(documentId, Number.isSafeInteger(result.record.revision) ? result.record.revision : 0);
    documents = documents.map((entry) => entry.id === documentId ? result.record : entry);
    // A landing page owns the creation context while it is visible. Its
    // hidden previous document may move elsewhere, but must not silently
    // redirect the next New/Import/Template action to that destination.
    if (documentId === currentDocumentId && !projectLandingIsOpen()) activeProjectId = localProjectMembership(result.record).projectId;
    renderProjectLibrary();
    renderDocumentLibrary();
    renderProjectLanding();
    return true;
  }
  async function moveDocumentDirect(documentId, projectId) {
    const record = documents.find((entry) => entry && entry.id === documentId);
    const destination = String(projectId || "").trim();
    if (!record || localProjectMembership(record).projectId === destination) return;
    const project = destination ? projectById(destination) : null;
    if (destination && !project) {
      setStatus(tr("目标项目已不存在；请刷新后重试。", "That Project no longer exists. Refresh and try again."), "error");
      return;
    }
    const moved = await updateDocumentProject(documentId, {
      projectId: destination,
      projectGroup: "",
      projectPinned: false
    });
    if (!moved) return;
    setStatus(destination ? tr("文档已移至“" + project.name + "”", "Document moved to “" + project.name + "”") : tr("文档已移出项目", "Document removed from Project"), "saved");
  }
  function uniqueLibraryDocumentName(requestedName, excludedId) {
    const name = String(requestedName || "").trim();
    const normalise = (value) => String(value || "").trim().toLocaleLowerCase();
    const occupied = new Set(documents.filter((record) => record && record.id !== excludedId).map((record) => normalise(documentName(record))).filter(Boolean));
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
    return enqueueDocumentTransition(async (generation) => {
    const saved = await saveActiveDocumentNow();
    if (!saveSucceeded(saved)) {
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
    if (!transitionIsCurrent(generation)) return;
    const created = await Store.createDocument(project, { makeCurrent: false, projectId: projectCreationContextId() });
    if (!created || !created.record || created.backend === "failed") {
      setStatus(tr("新建文档失败。", "Could not create document."), "error");
      return;
    }
    const finalSaved = await saveActiveDocumentNow();
    if (!saveSucceeded(finalSaved)) { reportSaveFailure(finalSaved); return; }
    if (!transitionIsCurrent(generation)) return;
    closeNewProject();
    if (!await selectAndActivateDocument(created.record, generation, { status: false })) return;
    setStatus(tr("已新建文档", "New document created"), "saved");
    });
  }
  function chooseNewDocument() { openNewProject(); }
  async function useSelectedTemplate(templateId) {
    const template = templateById(templateId);
    if (!template) return;
    return enqueueDocumentTransition(async (generation) => {
    const saved = await saveActiveDocumentNow();
    if (!saveSucceeded(saved)) { reportSaveFailure(saved); return; }
    let document = Model.normalizeDocument(template.document);
    // A template is a starting point, not a second handle to the source
    // document.  In particular, never let a template instance inherit the
    // Editable HTML replacement lineage of the document from which somebody
    // saved the template.
    if (editableHtmlProtocolLineage(document)) document = forkEditableHtmlLineage(document);
    const title = document.blocks.find((block) => block.type === "title");
    document.metadata.name = String(title && title.content || "").trim() || template.template.name;
    document.metadata.templateName = template.template.name;
    document.metadata.templateId = template.template.id;
    const now = new Date().toISOString();
    document.metadata.createdAt = now;
    document.metadata.updatedAt = now;
    // Custom Project templates are portable content, so treat their
    // instantiation exactly like a Project import: repair absent masthead
    // chrome, create a title if space permits, and avoid library-name
    // collisions before the document receives a local identity.
    if (document.metadata.documentType === "Project") prepareImportedProjectDocument(document, null);
    if (!transitionIsCurrent(generation)) return;
    const created = await Store.createDocument(document, { makeCurrent: false, projectId: projectCreationContextId() });
    if (!created || !created.record || created.backend === "failed") { setStatus(tr("无法从模板创建文档。", "Could not create a document from this template."), "error"); return; }
    const finalSaved = await saveActiveDocumentNow();
    if (!saveSucceeded(finalSaved)) { reportSaveFailure(finalSaved); return; }
    if (!transitionIsCurrent(generation)) return;
    selectedTemplateId = template.template.id;
    if (!await selectAndActivateDocument(created.record, generation, { status: false })) return;
    selectedTemplateId = template.template.id;
    renderTemplateLibrary();
    setStatus(tr("已从模板新建文档", "Document created from template"), "saved");
    });
  }
  async function openLibraryDocument(id) {
    // A Project landing page deliberately retains the previously open document
    // as the active record.  That document must still be reopenable from the
    // landing tree; otherwise its row is incorrectly treated as a no-op.
    if (!id || (id === currentDocumentId && !projectLandingId)) return;
    return enqueueDocumentTransition(async (generation) => {
    const saved = await saveActiveDocumentNow();
    if (!saveSucceeded(saved)) { reportSaveFailure(saved); return; }
    if (!transitionIsCurrent(generation)) return;
    const opened = await Store.openDocument(id, { makeCurrent: false });
    if (!opened || !opened.record || opened.backend === "failed") { setStatus(tr("无法打开文档。", "Could not open document."), "error"); return; }
    const finalSaved = await saveActiveDocumentNow();
    if (!saveSucceeded(finalSaved)) { reportSaveFailure(finalSaved); return; }
    if (!await selectAndActivateDocument(opened.record, generation)) return;
    });
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
    const record = documents.find((item) => item && item.id === id);
    const requestedName = record && record.document && record.document.metadata && record.document.metadata.documentType === "Project"
      ? uniqueLibraryDocumentName(cleanProjectName(name, documentName(record)), id)
      : name;
    const renamed = await Store.renameDocument(id, requestedName, documentRevisions.get(id));
    if (!renamed || !renamed.record || !saveSucceeded(renamed.backend)) { reportSaveFailure(renamed && renamed.backend); return; }
    documentRevisions.set(id, Number.isSafeInteger(renamed.record.revision) ? renamed.record.revision : 0);
    renameDrafts.delete(id);
    renamingDocumentId = "";
    if (id === currentDocumentId) {
      const persisted = Model.normalizeDocument(renamed.record.document, { allowRemoteImages: true });
      state.metadata.name = persisted.metadata.name;
      state.metadata.updatedAt = persisted.metadata.updatedAt;
      if (isProjectDocument()) {
        state.metadata.runningHeader = Object.assign({}, persisted.metadata.runningHeader);
        const liveTitle = state.blocks.find((block) => block && block.type === "title");
        const persistedTitle = persisted.blocks.find((block) => block && block.type === "title");
        if (liveTitle && persistedTitle) liveTitle.content = persistedTitle.content;
        syncProjectDocumentNameControls(state.metadata.name, null);
      }
      changed({ outline: isProjectDocument(), chrome: true });
      const reconciled = await saveActiveDocumentNow();
      if (!saveSucceeded(reconciled)) {
        reportSaveFailure(reconciled);
        return;
      }
      renderAll();
      root.requestAnimationFrame(syncCanvasScale);
    }
    await refreshDocuments();
    setStatus(tr("文档已重命名", "Document renamed"), "saved");
  }
  async function duplicateLibraryDocument(id) {
    // Activating a duplicate is a document transition even when the
    // source row is not the currently open document. Flush the active
    // record first so its pending edits cannot be lost when the copy
    // replaces the in-memory editor state.
    return enqueueDocumentTransition(async (generation) => {
    const saved = await saveActiveDocumentNow();
    if (!saveSucceeded(saved)) { reportSaveFailure(saved); return; }
    const source = documents.find((record) => record.id === id);
    const copiedName = uniqueLibraryDocumentName(documentName(source) + tr(" 副本", " copy"));
    if (!transitionIsCurrent(generation)) return;
    const duplicate = await Store.duplicateDocument(id, copiedName, {
      makeCurrent: false,
      // Keep the identity fork inside Store's duplicate transaction.  A
      // copied document is independently editable and must never be accepted
      // as a same-lineage replacement target for the source document.
      transformDocument: (document) => editableHtmlProtocolLineage(document) ? forkEditableHtmlLineage(document) : document
    });
    if (!duplicate || !duplicate.record || duplicate.backend === "failed") { setStatus(tr("复制文档失败。", "Could not duplicate document."), "error"); return; }
    const finalSaved = await saveActiveDocumentNow();
    if (!saveSucceeded(finalSaved)) { reportSaveFailure(finalSaved); return; }
    if (!await selectAndActivateDocument(duplicate.record, generation, { status: false })) return;
    setStatus(tr("已创建文档副本", "Document duplicated"), "saved");
    });
  }
  async function openRemainingDocumentAfterDeletion() {
    // Deleting the active document must never leave its in-memory contents
    // detached from a local record. Otherwise opening another document would
    // first autosave that deleted state as an unintended extra document.
    currentDocumentId = "";
    hasUnsavedChanges = false;
    documentRevisions.clear();
    // Immediately sever the deleted payload from the editor. If storage is
    // unavailable while finding a successor, subsequent typing starts a
    // genuinely blank new document rather than resurrecting deleted content.
    state = Model.blankDocument();
    selectedBlockId = "";
    activeOutlineBlockId = "";
    insertionIndex = null;
    renderAll();
    const library = typeof Store.listDocumentLibrary === "function"
      ? await Store.listDocumentLibrary()
      : { records: await Store.listDocuments(), backend: "unknown" };
    if (!library || library.backend === "failed") {
      documents = [];
      renderDocumentLibrary();
      return false;
    }
    documents = Array.isArray(library.records) ? library.records : [];
    renderDocumentLibrary();
    const next = documents[0];
    if (next) {
      const opened = await Store.openDocument(next.id, { makeCurrent: false });
      if (!opened || !opened.record || opened.backend === "failed") return false;
      const selected = await Store.setCurrentDocument(opened.record.id);
      if (!selected || !selected.record || selected.backend === "failed") return false;
      await activateDocument(selected.record, { status: false });
      return true;
    }

    // A completely empty library still needs an editable starting document.
    const created = await Store.createDocument(state);
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
      onConfirm: () => enqueueDocumentTransition(async (generation) => {
        const deletingCurrent = id === currentDocumentId;
        if (deletingCurrent) {
          // Deletion intentionally discards edits that have not entered the
          // save queue yet. A write already in flight must complete before
          // deletion so it cannot recreate the record afterwards.
          clearTimeout(saveTimer);
          try { await saveQueue; } catch (_) {}
        }
        if (!transitionIsCurrent(generation)) return;
        const backend = await Store.deleteDocument(id);
        if (!saveSucceeded(backend)) { setStatus(tr("删除文档失败。", "Could not delete document."), "error"); return; }
        documentRevisions.delete(id);
        try { root.localStorage.removeItem(outlineCollapseStorageKey(id)); } catch (_) {}
        if (deletingCurrent) {
          const opened = await openRemainingDocumentAfterDeletion();
          if (!opened) { setStatus(tr("删除后无法打开其余文档。", "Could not open a remaining document after deletion."), "error"); return; }
        } else {
          await refreshDocuments();
        }
        setStatus(tr("文档已删除", "Document deleted"), "saved");
      })
    });
  }
  async function saveCurrentAsTemplate() {
    if (!requireDocumentAction()) return;
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
        // An empty editorial section is still a real navigable chapter on the
        // paper. Match its visible placeholder instead of making it vanish
        // from Outline and leaving a section with no structural controls.
        if (!title) title = tr("未命名章节", "Untitled section");
        level = 0;
        semanticLevel = 1;
      } else if (block.type === "semantic") {
        title = outlineTitle(block);
        if (!title && isEditorialPrimary(block)) title = tr("未命名章节", "Untitled section");
        if (!title) return;
        // Any semantic block that is rendered as an editorial primary on the
        // paper must also become a first-level Outline node. Otherwise its
        // folio number says "chapter" while navigation says "child item".
        if (isEditorialPrimary(block)) {
          level = 0;
          semanticLevel = 1;
        } else level = semanticLevel;
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
  function hasBlockCapacity(additional) {
    const requested = Math.max(0, Number(additional) || 0);
    if (!state || state.blocks.length + requested <= Model.LIMITS.maxBlocks) return hasRenderCapacity(requested);
    setStatus(tr("文档最多包含 " + Model.LIMITS.maxBlocks + " 个内容块。", "A document can contain at most " + Model.LIMITS.maxBlocks + " blocks."), "warning");
    return false;
  }
  function blockRenderUnits(block) {
    if (!block || typeof block !== "object") return 1;
    if (block.type === "table") return Math.max(1, tableColumnCount(block) * Math.max(1, Array.isArray(block.rows) ? block.rows.length : 1));
    if (["list", "key-value", "stats"].includes(block.type)) return Math.max(1, Array.isArray(block.items) ? block.items.length : 1);
    return 1;
  }
  function documentRenderUnits(blocks) {
    return (Array.isArray(blocks) ? blocks : []).reduce((total, block) => total + blockRenderUnits(block), 0);
  }
  function hasRenderCapacity(additional) {
    const requested = Math.max(0, Number(additional) || 0);
    if (!state || documentRenderUnits(state.blocks) + requested <= Model.LIMITS.maxRenderUnits) return true;
    setStatus(tr("文档内容过多，无法安全地在当前页面中渲染。", "This document has reached the safe rendering limit."), "warning");
    return false;
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
    if (index < 0 || !hasBlockCapacity(1)) return;
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
    if (!copies.length || !hasBlockCapacity(copies.length) || !hasRenderCapacity(documentRenderUnits(copies))) return;
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
    closeDocumentMoreMenus();
    closeProjectMoveMenu();
    setActionMenuOpen(false);
    setTemplateMenuOpen(false);
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
    if (!currentDocumentId) return;
    const knownIds = new Set(buildOutlineTree().entries.map((entry) => entry.id));
    collapsedOutlineIds = new Set(Array.from(collapsedOutlineIds).filter((id) => knownIds.has(id)));
    try { root.localStorage.setItem(outlineCollapseStorageKey(currentDocumentId), JSON.stringify(Array.from(collapsedOutlineIds))); } catch (_) {}
  }
  function outlineCollapseStorageKey(documentId) {
    return OUTLINE_COLLAPSE_KEY + ":" + encodeURIComponent(String(documentId || ""));
  }
  function restoreOutlineCollapseState(documentId, migrateLegacy) {
    if (!documentId) { collapsedOutlineIds = new Set(); return; }
    try {
      const key = outlineCollapseStorageKey(documentId);
      let stored = root.localStorage.getItem(key);
      // One-time migration from the formerly global key. New documents never
      // read it, so matching imported block IDs cannot leak state across files.
      if (stored === null && migrateLegacy) {
        stored = root.localStorage.getItem(OUTLINE_COLLAPSE_KEY);
        if (stored !== null) root.localStorage.removeItem(OUTLINE_COLLAPSE_KEY);
      }
      const parsed = JSON.parse(stored || "[]");
      collapsedOutlineIds = new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
    } catch (_) { collapsedOutlineIds = new Set(); }
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
    // The selection rule swaps a rich preview for the underlying textarea.
    // Wait until the browser has applied that display change, then recompute
    // auto-grow dimensions for every newly visible rich editor. This covers
    // editorial sections, semantic details, quotes, lists, and paragraphs
    // through the same mechanism instead of special-casing one block type.
    root.requestAnimationFrame(() => {
      document.querySelectorAll(".pn-canvas-block.is-selected .pn-canvas-rich-field > .pn-field").forEach((field) => {
        if (typeof field.requestAutoGrow === "function") field.requestAutoGrow();
      });
    });
  }
  function selectProofMetadata(options) {
    if (!hasDocumentMetadataHeader()) return;
    // A blank Project masthead should read like a finished page, not an
    // unfinished three-column form. Its grip/overflow still reveals the
    // configured fields on demand, without making a title-input focus rerender
    // the paper and lose the caret.
    const revealBlankProjectMetadata = isProjectDocument()
      && !isProofMetadataSelected()
      && proofMetadataIsBlank(proofMetadataValues())
      && (!options || options.revealEmptyMetadata === true);
    selectedBlockId = PROOF_METADATA_SELECTION;
    activeOutlineBlockId = "";
    insertionIndex = null;
    if (revealBlankProjectMetadata) renderCanvas();
    else applyCanvasSelection();
    syncOutlineActiveState();
    renderInspector();
    if (!options || options.openInspector !== false) setDetailOpen(true);
  }
  function clearCanvasSelection() {
    if (!selectedBlockId) return;
    const hideBlankProjectMetadata = isProjectDocument()
      && isProofMetadataSelected()
      && proofMetadataIsBlank(proofMetadataValues());
    selectedBlockId = "";
    activeOutlineBlockId = "";
    insertionIndex = null;
    if (hideBlankProjectMetadata) renderCanvas();
    else applyCanvasSelection();
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
    if (persistenceAvailable) setStatus(tr("正在保存…", "Saving…"), "saving");
    if (changes.structure) renderCanvas();
    if (changes.outline) renderOutline();
    if (changes.inspector) renderInspector();
    if (changes.chrome) renderDocumentChrome();
    scheduleSave();
  }
  function update(block, key, value, options) {
    block[key] = typeof value === "string" && value.length > Model.LIMITS.maxStringLength
      ? value.slice(0, Model.LIMITS.maxStringLength) : value;
    // Changing a remote URL is a new network request, so a previous explicit
    // approval can never accidentally carry over to it.
    if (block.type === "image" && key === "src") delete block.remoteApproved;
    // Remember that an author touched alt text. Replacement images may update
    // an automatically generated filename label, never a deliberate one.
    if (block.type === "image" && key === "alt") {
      delete block.__pnAutoAlt;
      block.__pnAltTouched = true;
    }
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
  // The paper is also the reading surface. Long text therefore renders with
  // the same inline Markdown/KaTeX treatment as an export until its block is
  // selected. The underlying textarea remains the sole source of truth and
  // is revealed in-place for direct editing, so there is no mirrored-editor
  // cursor or selection state to keep in sync.
  function canvasRichTextField(block, key, options) {
    const opts = options || {};
    const value = opts.value === undefined ? block[key] : opts.value;
    const field = canvasField(block, key, opts);
    return canvasRichPreviewField(block, field, value, opts);
  }
  function canvasRichPreviewField(block, field, value, options) {
    const opts = options || {};
    const preview = element("div", {
      class: "pn-canvas-rich-preview " + (opts.previewClass || ""),
      tabindex: "0",
      role: "button",
      "aria-label": opts.editLabel || tr("编辑内容", "Edit content"),
      html: richCanvasText(value, opts.placeholder || "", opts.singleLine)
    });
    const control = field.querySelector("textarea, input");
    // The editor owns the source string; the preview is only a reading view.
    // Refresh it on blur, when the reading surface becomes visible again,
    // without re-typesetting mathematical prose on every keystroke.
    const refreshPreview = () => {
      if (control) preview.innerHTML = richCanvasText(control.value, opts.placeholder || "", opts.singleLine);
    };
    if (control) control.addEventListener("blur", refreshPreview);
    const revealEditor = (event) => {
      if (event) event.preventDefault();
      selectBlock(block.id);
      root.requestAnimationFrame(() => {
        if (control) control.focus();
      });
    };
    preview.addEventListener("click", revealEditor);
    preview.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") revealEditor(event);
    });
    const wrapper = element("div", { class: "pn-canvas-rich-field " + (opts.richFieldClass || "") });
    wrapper.append(preview, field);
    return wrapper;
  }
  function richCanvasText(value, placeholder, singleLine) {
    const text = String(value || "");
    if (!text.trim()) return "<span class=\"pn-canvas-rich-placeholder\">" + escapeHtml(placeholder) + "</span>";
    if (singleLine) return inline(text.replace(/\n/g, " "));
    return paragraphs(text);
  }
  function isProofNoteDocument() {
    // Names are author-editable presentation text. Only a stable built-in
    // template identity may select the Proof Note renderer; otherwise a
    // custom template named “Proof Note” could override a Project's chrome.
    return Boolean(state && state.metadata
      && String(state.metadata.templateId || "").trim() === "proof-note"
      && state.metadata.documentType !== "Project");
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
      left: has("left") ? String(header.left || "") : String(metadata.name || readerTr("未命名文档", "Untitled document")),
      right: has("right") ? String(header.right || "") : "Project"
    };
  }
  function projectImportContext() {
    if (!state || !isProjectDocument()) return null;
    const metadata = state.metadata || {};
    const fields = metadata.proofMetadata && Array.isArray(metadata.proofMetadata.fields)
      ? metadata.proofMetadata.fields.slice() : ["author", "date"];
    return {
      runningHeader: projectRunningHeader(),
      proofMetadata: { fields },
      headerSubtitle: { visible: !(metadata.headerSubtitle && metadata.headerSubtitle.visible === false) }
    };
  }
  function isBlankProjectImportSource() {
    if (!isProjectDocument() || !state || !Array.isArray(state.blocks)) return false;
    // A freshly created Project has only its masthead and an empty
    // Introduction. Once a real block has content or structure, importing is
    // a general document-import operation rather than a Blank Project preset.
    return state.blocks.every((block) => {
      if (!block || typeof block !== "object") return false;
      if (block.type === "title" || block.type === "subtitle") return true;
      return block.type === "semantic"
        && block.kind === "introduction"
        && !String(block.content || "").trim()
        && !String(block.summary || "").trim();
    });
  }
  function prepareImportedProjectDocument(document, context, excludedDocumentId) {
    if (!document || !document.metadata) return document;
    // A Project has one canonical name across the library, running header,
    // page footer, and paper title. AI JSON supplies content; importing it
    // into a Blank Project must not leave any of those chrome surfaces empty.
    const title = Array.isArray(document.blocks) ? document.blocks.find((block) => block && block.type === "title") : null;
    const requestedName = cleanProjectName(title && title.content || document.metadata.name, tr("未命名文档", "Untitled document"));
    const name = uniqueLibraryDocumentName(requestedName, excludedDocumentId);
    document.metadata.name = name;
    document.metadata.documentType = "Project";
    const importedHeader = document.metadata.runningHeader && typeof document.metadata.runningHeader === "object"
      ? document.metadata.runningHeader : {};
    const inheritedRight = context && context.runningHeader ? context.runningHeader.right : "";
    document.metadata.runningHeader = {
      left: name,
      // A missing right label may inherit a Blank Project's display preset;
      // an explicit empty right label is author intent and must remain empty.
      right: Object.prototype.hasOwnProperty.call(importedHeader, "right")
        ? String(importedHeader.right || "")
        : String(inheritedRight || "").trim() || "Project"
    };
    // Visible fields and subtitle treatment are display preferences. Author,
    // date, status and source belong to this imported document and must never
    // be copied from the Project used to start the import.
    if (context) {
      document.metadata.proofMetadata = { fields: context.proofMetadata.fields.slice() };
      document.metadata.headerSubtitle = { visible: context.headerSubtitle.visible !== false };
    }
    if (title) title.content = name;
    // Imports are validated before this point, but a valid 2,000-block file
    // can still omit a title. Keep it valid rather than adding block 2,001
    // and relying on later normalisation to drop the tail.
    else if (document.blocks.length < Model.LIMITS.maxBlocks) document.blocks.unshift(Model.createBlock("title", { content: name }));
    return document;
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
  function cleanProjectName(value, fallback) {
    const name = String(value || "").replace(/\s+/g, " ").trim();
    return name || String(fallback || tr("未命名文档", "Untitled document")).replace(/\s+/g, " ").trim() || tr("未命名文档", "Untitled document");
  }
  function setProjectDocumentName(value, source) {
    if (!state || !isProjectDocument()) return;
    const name = cleanProjectName(value, state.metadata.name);
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
    changed({ structure: true, outline: true, inspector: true });
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
    // Older AI prompts frequently generated "1. Title" or "01. Title".
    // The renderer already supplies that number as a separate visual element,
    // so omit a clearly punctuated legacy marker only. Bare phrases such as
    // “20 Questions” and “IV Therapy” are legitimate titles, not numbers.
    return title.replace(/^\s*(?:(?:\d{1,2}|i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)\s*(?:[.)]|[：:])\s*)/i, "");
  }
  function semanticBodyVisible(block) {
    return !block || block.bodyVisible !== false;
  }
  function setSemanticBodyVisible(block, visible) {
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
    if (editorialNumberRevision !== editRevision || editorialNumberState !== state) {
      editorialSectionNumbers = new Map();
      let sequence = 0;
      (state && state.blocks || []).forEach((candidate) => {
        if (!isEditorialPrimary(candidate)) return;
        sequence += 1;
        editorialSectionNumbers.set(candidate.id, String(sequence).padStart(2, "0"));
      });
      editorialNumberRevision = editRevision;
      editorialNumberState = state;
    }
    const block = state && state.blocks && state.blocks[index];
    const cached = block && editorialSectionNumbers.get(block.id);
    if (cached) return cached;
    // A defensive fallback only for callers passing an index outside the
    // current state; normal render paths always use the precomputed map.
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
  function proofMetadataIsBlank(values) {
    return !["author", "date", "status", "source"].some((key) => String(values && values[key] || "").trim());
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
    // Existing imported documents may place their subtitle away from the
    // masthead. It is still the document's subtitle; never manufacture a
    // second one merely because the original is non-adjacent.
    return state.blocks.findIndex((block) => block.type === "subtitle");
  }
  function headerSubtitleVisible() {
    const display = state && state.metadata && state.metadata.headerSubtitle;
    return headerSubtitleIndex() >= 0 && !(display && display.visible === false);
  }
  function setHeaderSubtitleVisible(visible) {
    if (!state || !hasDocumentMetadataHeader()) return;
    const titleIndex = headerTitleIndex();
    if (visible && titleIndex >= 0 && headerSubtitleIndex() < 0) {
      if (!hasBlockCapacity(1)) return;
      // A display toggle must never invent prose (and certainly not an
      // English sentence in a document written in another language).
      state.blocks.splice(titleIndex + 1, 0, Model.createBlock("subtitle", { content: "" }));
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
    const showSource = Boolean(values.source.trim());
    if (!fields.length && !showSource) return null;
    // Proof Note deliberately retains its traditional empty metadata row;
    // Projects do not. The latter can be revealed through the masthead's
    // contextual controls when an author actually wants to fill it in.
    if (isProjectDocument() && proofMetadataIsBlank(values) && !isProofMetadataSelected()) return null;
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
    if (fields.length) metadata.appendChild(grid);
    if (!opts.embedded) {
      metadata.addEventListener("pointerdown", (event) => {
        selectProofMetadata({ openInspector: !event.target.closest("input, textarea, select") });
      });
      metadata.addEventListener("click", (event) => {
        if (!event.target.closest("input, textarea, select, button")) selectProofMetadata();
      });
      metadata.addEventListener("focusin", () => selectProofMetadata({ openInspector: false }));
    }
    if (showSource) {
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
    // A legal Project/Proof Note may deliberately omit a title block. It
    // still owns document metadata, which must remain visible and selectable
    // instead of disappearing because there is no masthead anchor.
    if (!headerRange && hasDocumentMetadataHeader() && headerTitleIndex() < 0) {
      const metadata = renderProofMetadata();
      if (metadata) els.canvas.appendChild(metadata);
    }
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
      body.appendChild(canvasRichTextField(block, "content", {
        fieldClass: "pn-canvas-paragraph-field",
        controlClass: "pn-canvas-paragraph-input",
        previewClass: "pn-canvas-paragraph-preview",
        placeholder: label("开始输入…", "Start writing…"),
        editLabel: label("编辑正文", "Edit paragraph")
      }));
      return;
    }
    if (block.type === "equation") {
      body.className = "pn-equation pn-canvas-equation";
      const field = canvasField(block, "content", { fieldClass: "pn-canvas-equation-field", controlClass: "pn-canvas-equation-input", placeholder: "\\\\[ … \\]", maxLength: Model.LIMITS.maxEquationLength });
      const preview = element("div", { class: "pn-equation-preview", "aria-live": "polite" });
      const refreshPreview = () => {
        const value = String(block.content || "").trim();
        preview.hidden = !value;
        preview.innerHTML = value ? math(value) : "";
      };
      let previewTimer = 0;
      const control = field.querySelector("textarea, input");
      control.addEventListener("input", () => {
        root.clearTimeout(previewTimer);
        previewTimer = root.setTimeout(refreshPreview, 180);
      });
      control.addEventListener("blur", () => { root.clearTimeout(previewTimer); refreshPreview(); });
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
      if (!isSemantic || semanticBodyVisible(block)) body.appendChild(canvasRichTextField(block, "content", {
        fieldClass: "pn-canvas-component-body",
        controlClass: "pn-canvas-component-body-input",
        previewClass: "pn-canvas-component-body-preview",
        placeholder: label("开始输入…", "Start writing…"),
        editLabel: label("编辑正文", "Edit content")
      }));
      if (isSemantic && (["result", "verification"].includes(block.kind) || semanticSummaryVisible(block))) {
        if (semanticSummaryVisible(block)) {
          body.appendChild(canvasRichTextField(block, "summary", {
            fieldClass: "pn-canvas-component-summary",
            controlClass: "pn-canvas-component-summary-input",
            previewClass: "pn-canvas-component-summary-preview",
            placeholder: label("添加备注…", "Add note…"),
            editLabel: label("编辑备注", "Edit note")
          }));
        } else {
          body.appendChild(button(label("＋ 添加备注", "+ Add note"), "pn-component-add-summary", () => showSemanticSummary(block)));
        }
      }
      return;
    }
    if (block.type === "code") {
      body.className = "pn-code pn-canvas-code";
      body.appendChild(element("span", { class: "pn-code-language" }, codeLanguageDisplay(block.language)));
      const codeField = canvasField(block, "content", { fieldClass: "pn-canvas-code-field", controlClass: "pn-canvas-code-input", rows: 6, placeholder: label("粘贴或输入代码", "Paste or write code") });
      body.appendChild(codeField);
      // The textarea remains the sole editor source, while this print-only
      // reader copy ensures Cmd+P never emits a focused form control.
      const printCode = element("pre", { class: "pn-canvas-code-print" }, block.content);
      codeField.querySelector("textarea, input").addEventListener("input", () => { printCode.textContent = block.content; });
      body.appendChild(printCode);
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
      quote.appendChild(canvasRichTextField(block, "content", {
        fieldClass: "pn-canvas-quote-field",
        controlClass: "pn-canvas-quote-input",
        previewClass: "pn-canvas-quote-preview",
        rows: 2,
        placeholder: label("引用文字", "Quote"),
        editLabel: label("编辑引文", "Edit citation")
      }));
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
    if (block.type === "semantic" && semanticBodyVisible(block)) {
      body.appendChild(canvasRichTextField(block, "content", {
        fieldClass: "pn-editorial-section-body",
        controlClass: "pn-editorial-section-body-input",
        previewClass: "pn-editorial-section-body-preview",
        placeholder: label("开始输入…", "Start writing…"),
        editLabel: label("编辑正文", "Edit content")
      }));
      if (block.summary) body.appendChild(canvasRichTextField(block, "summary", {
        fieldClass: "pn-editorial-section-summary",
        controlClass: "pn-editorial-section-summary-input",
        previewClass: "pn-editorial-section-summary-preview",
        placeholder: label("添加备注…", "Add note…"),
        editLabel: label("编辑备注", "Edit note")
      }));
    }
  }
  function buildEditorialSemantic(body, block) {
    const label = (zh, en) => tr(zh, en);
    const semanticLabel = semanticExportLabel(block);
    body.className = "pn-editorial-detail pn-editorial-" + block.kind;
    body.appendChild(element("div", { class: "pn-component-label" }, semanticLabel));
    body.appendChild(canvasField(block, "title", { multiline: false, fieldClass: "pn-editorial-detail-title", controlClass: "pn-editorial-detail-title-input", placeholder: label("标题", "Title"), change: { outline: true } }));
    if (semanticBodyVisible(block)) body.appendChild(canvasRichTextField(block, "content", {
      fieldClass: "pn-editorial-detail-body",
      controlClass: "pn-editorial-detail-body-input",
      previewClass: "pn-editorial-detail-body-preview",
      placeholder: label("开始输入…", "Start writing…"),
      editLabel: label("编辑正文", "Edit content")
    }));
    if (block.summary) body.appendChild(canvasRichTextField(block, "summary", {
      fieldClass: "pn-editorial-detail-summary",
      controlClass: "pn-editorial-detail-summary-input",
      previewClass: "pn-editorial-detail-summary-preview",
      placeholder: label("添加备注…", "Add note…"),
      editLabel: label("编辑备注", "Edit note")
    }));
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
    if (reachedCollectionLimit(Model.LIMITS.maxListItems - block.items.length, tr("列表最多可包含 1000 项。", "A list can contain at most 1,000 items."))) return false;
    if (!hasRenderCapacity(1)) return false;
    const nextIndex = Math.max(0, Math.min(block.items.length, index));
    block.items.splice(nextIndex, 0, initialValue || "");
    changed({ structure: true, inspector: true });
    focusCanvasControl(block.id, '.pn-canvas-list-input[data-item-index="' + nextIndex + '"]');
    return true;
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
        if (event.key === "Enter" && !event.shiftKey && !isComposingInput(event)) {
          event.preventDefault();
          // Do not split first and ask for capacity later: at the item limit
          // that sequence discarded everything right of the caret.
          if (block.items.length >= Model.LIMITS.maxListItems) {
            setStatus(tr("列表最多可包含 1000 项。", "A list can contain at most 1,000 items."), "warning");
            return;
          }
          const start = Number.isFinite(control.selectionStart) ? control.selectionStart : String(block.items[itemIndex] || "").length;
          const value = String(block.items[itemIndex] || "");
          block.items[itemIndex] = value.slice(0, start);
          if (!addListItem(block, itemIndex + 1, value.slice(start))) block.items[itemIndex] = value;
        } else if (event.key === "Backspace" && !control.value && control.selectionStart === 0) {
          event.preventDefault();
          removeListItem(block, itemIndex);
        }
      });
      const richField = canvasRichPreviewField(block, field, item, {
        richFieldClass: "pn-canvas-list-rich-field",
        previewClass: "pn-canvas-list-preview",
        singleLine: true,
        placeholder: tr("开始输入…", "Start writing…"),
        editLabel: tr("编辑列表项目", "Edit list item")
      });
      row.append(richField, button("×", "pn-collection-remove", () => removeListItem(block, itemIndex), tr("删除此项", "Remove item")));
      list.appendChild(row);
    });
    body.append(list, collectionTools([[tr("＋ 添加项目", "+ Add item"), "", () => addListItem(block, block.items.length, "")]]));
  }
  function dataItemDefault(type) {
    return type === "key-value" ? { label: "", value: "" } : { kicker: "", value: "", body: "" };
  }
  function addDataItem(block) {
    if (reachedCollectionLimit(Model.LIMITS.maxDataItems - block.items.length, tr("此内容块最多可包含 1000 项。", "This block can contain at most 1,000 items."))) return;
    if (!hasRenderCapacity(1)) return;
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
  function tableWouldExceedCellLimit(columns, rows) {
    return columns * rows > Model.LIMITS.maxTableCells;
  }
  function addTableRow(block) {
    if (reachedCollectionLimit(Model.LIMITS.maxTableRows - block.rows.length, tr("表格最多可包含 500 行。", "A table can contain at most 500 rows."))) return;
    if (tableWouldExceedCellLimit(tableColumnCount(block), block.rows.length + 1)) {
      setStatus(tr("表格最多可包含 " + Model.LIMITS.maxTableCells + " 个单元格。", "A table can contain at most " + Model.LIMITS.maxTableCells + " cells."), "warning");
      return;
    }
    if (!hasRenderCapacity(tableColumnCount(block))) return;
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
    if (tableWouldExceedCellLimit(tableColumnCount(block) + 1, block.rows.length)) {
      setStatus(tr("表格最多可包含 " + Model.LIMITS.maxTableCells + " 个单元格。", "A table can contain at most " + Model.LIMITS.maxTableCells + " cells."), "warning");
      return;
    }
    if (!hasRenderCapacity(Math.max(1, block.rows.length))) return;
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
    // Header is presentation only. Moving columns into rows changes content
    // and can push a valid table over its row limit, causing later normalise
    // paths to trim real cells. Keep the table shape completely untouched.
    block.header = Boolean(visible);
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
      const sourceDocumentId = currentDocumentId;
      const sourceGeneration = documentGeneration;
      const reader = new FileReader();
      reader.onload = async () => {
        const source = String(reader.result || "");
        // accept is a picker hint, not validation. Validate the actual data
        // URL before changing the block so Replace image can never destroy a
        // working image with an unsupported file.
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(source)) {
          setStatus(tr("仅支持 PNG、JPEG、GIF 或 WebP 图片。", "Only PNG, JPEG, GIF, and WebP images are supported."), "error");
          return;
        }
        const dimensions = await imageDimensionsWithinLimit(source);
        // A document switch while FileReader/Image decode was in flight must
        // not mutate a detached block or mark the newly active document dirty.
        if (sourceGeneration !== documentGeneration || sourceDocumentId !== currentDocumentId || !state || !state.blocks.includes(block)) return;
        if (!dimensions.valid) {
          setStatus(tr("图片像素尺寸过大或无法安全解码。", "Image dimensions are too large or could not be decoded safely."), "error");
          return;
        }
        const candidate = Model.normalizeDocument(state, { allowRemoteImages: true });
        const candidateBlock = candidate.blocks.find((item) => item.id === block.id);
        if (candidateBlock) candidateBlock.src = source;
        const portableCheck = portableDocumentCheck(candidate);
        if (!portableCheck.valid) {
          setStatus(portableCheck.message, "error");
          return;
        }
        block.src = source;
        delete block.remoteApproved;
        if (block.__pnAutoAlt === true || (!block.alt && block.__pnAltTouched !== true)) {
          block.alt = image.name.replace(/\.[^.]+$/, "");
          block.__pnAutoAlt = true;
        }
        changed({ structure: true, inspector: true });
      };
      reader.onerror = () => setStatus(tr("无法读取该图片；原图片未更改。", "Could not read that image; the existing image was not changed."), "error");
      reader.onabort = () => setStatus(tr("图片读取已取消；原图片未更改。", "Image reading was cancelled; the existing image was not changed."), "warning");
      reader.readAsDataURL(image);
    });
    const picker = element("div", { class: "pn-image-picker" });
    picker.append(choose, file);
    return picker;
  }
  function imageDimensionsWithinLimit(source) {
    return new Promise((resolve) => {
      const image = new root.Image();
      let settled = false;
      const finish = (valid) => {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        resolve({ valid });
      };
      const timeout = root.setTimeout(() => finish(false), 5000);
      image.onload = () => {
        root.clearTimeout(timeout);
        const width = Number(image.naturalWidth || image.width || 0);
        const height = Number(image.naturalHeight || image.height || 0);
        finish(width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS);
      };
      image.onerror = () => { root.clearTimeout(timeout); finish(false); };
      image.src = source;
    });
  }
  async function importedImagesWithinLimit(document) {
    const blocks = document && Array.isArray(document.blocks) ? document.blocks : [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block || block.type !== "image" || !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(String(block.src || ""))) continue;
      const result = await imageDimensionsWithinLimit(block.src);
      if (!result.valid) return { valid: false, index };
    }
    return { valid: true };
  }
  function portableDocumentPayload(document) {
    return Model.normalizeDocument(document, { allowRemoteImages: true });
  }
  function portableDocumentJson(document) {
    return JSON.stringify(portableDocumentPayload(document), null, 2);
  }
  function portableDocumentCheck(document) {
    try {
      const payload = portableDocumentPayload(document);
      const validation = Model.validateDocumentRaw(payload);
      const portable = JSON.stringify(payload, null, 2);
      if (validation.errors.length) {
        const first = validation.errors[0];
        return {
          valid: false, payload, portable, validation,
          message: tr("此备份不符合 Proofnote 的运行时限制，无法保证重新导入：", "This backup does not meet Proofnote's runtime limits and could not be re-imported: ") + (first.path ? first.path + " — " : "") + first.message
        };
      }
      if (utf8ByteLength(portable) > MAX_IMPORT_BYTES) {
        return {
          valid: false, payload, portable, validation,
          message: tr("此备份超过 25MB，无法保证重新导入；请移除部分嵌入图片后重试。", "This backup exceeds 25 MB and could not be re-imported; remove embedded images and try again.")
        };
      }
      return { valid: true, payload, portable, validation, message: "" };
    } catch (_) {
      return {
        valid: false, payload: null, portable: "", validation: { errors: [], warnings: [] },
        message: tr("无法安全序列化此备份；请先检查文档内容。", "This backup could not be serialized safely; check the document content first.")
      };
    }
  }
  function portableDocumentWithinLimit(document) {
    return portableDocumentCheck(document).valid;
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
    if (!hasBlockCapacity(1)) return;
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
    if (!hasBlockCapacity(1) || !hasRenderCapacity(blockRenderUnits(copy))) return;
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
    // Structural chapters already expose their subtree operations in the
    // Outline menu. Ordinary blocks need an equally real escape hatch: they
    // must never become permanent just because they do not appear in Outline.
    if (!structuralNode) {
      overflowMenu.appendChild(button(tr("复制内容块", "Duplicate block"), "pn-inspector-overflow-item", () => duplicateBlock(index)));
      overflowMenu.appendChild(button(tr("删除内容块…", "Delete block…"), "pn-inspector-overflow-item pn-inspector-overflow-danger", () => {
        openConfirm({
          title: tr("删除此内容块？", "Delete this block?"),
          message: tr("这项内容将从文档中移除。", "This content will be removed from the document."),
          confirmLabel: tr("删除内容块", "Delete block"),
          onConfirm: () => removeBlock(index)
        });
      }));
    }
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
      advanced.appendChild(inspectorToggle(label("显示正文", "Show body"), semanticBodyVisible(block), (visible) => setSemanticBodyVisible(block, visible)));
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
    const values = proofMetadataValues();
    if (isProofNoteDocument()) display.appendChild(inputField(tr("笔记编号", "Note number"), values.noteNumber, (value) => {
      state.metadata.noteNumber = value;
      changed({ chrome: true });
    }, { multiline: false, placeholder: tr("例如 057", "For example 057") }));
    display.appendChild(inputField(tr("来源", "Source"), values.source, (value) => {
      state.metadata.source = value;
      changed({ chrome: true });
    }, { multiline: true, rows: 1, autoGrow: true, placeholder: tr("可选来源", "Optional source") }));
    if (!active.size) els.inspector.appendChild(element("p", { class: "pn-inspector-note" }, tr("这组元数据已从纸面隐藏；勾选任意字段即可重新显示。来源仍可单独显示。", "This metadata group is hidden from the page. Select any field to restore it; Source can still appear on its own.")));
  }
  function buildImageInspector(panel, block) {
    const label = (zh, en) => tr(zh, en);
    panel.appendChild(inputField(label("图片 URL 或 data URL", "Image URL or data URL"), block.src, (value) => update(block, "src", value, { structure: true, inspector: true }), { placeholder: "https://…" }));
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
      case "title": return "<header class=\"pn-document-title\"><h1>" + (inline(block.content) || readerTr("未命名文档", "Untitled document")) + "</h1></header>";
      case "subtitle": return block.content.trim() ? "<p class=\"pn-document-subtitle\">" + inline(block.content) + "</p>" : "";
      case "heading": return isEditorialPrimary(block) ? renderEditorialPrimary(block, index, "content") : "<section class=\"pn-heading pn-heading-" + block.level + "\"><h" + (block.level + 1) + ">" + inline(block.content || readerTr("未命名章节", "Untitled heading")) + "</h" + (block.level + 1) + "></section>";
      case "paragraph": return paragraphs(block.content);
      case "equation": return block.content.trim() ? "<div class=\"pn-equation\">" + math(block.content) + "</div>" : "";
      case "code": return renderCode(block);
      case "table": return renderTable(block);
      case "image": return renderImage(block);
      case "quote": return block.content.trim() ? "<figure class=\"pn-quote\"><blockquote>“" + inline(block.content) + "”</blockquote>" + (block.citation.trim() ? "<figcaption>— " + inline(block.citation) + "</figcaption>" : "") + "</figure>" : "";
      case "divider": return "<hr class=\"pn-divider\">";
      case "page-break": return "<div class=\"pn-page-break\" aria-label=\"Page break\"></div>";
      case "callout": {
        const label = exportTr({ note: "说明", tip: "提示", warning: "注意", info: "信息" }[block.kind] || "说明", { note: "Note", tip: "Tip", warning: "Warning", info: "Info" }[block.kind] || "Note");
        return "<aside class=\"pn-callout pn-callout-" + escapeHtml(block.kind) + "\"><div class=\"pn-component-label\">" + escapeHtml(label) + "</div>" + (block.title.trim() ? "<h3>" + inline(block.title) + "</h3>" : "") + paragraphs(block.content) + "</aside>";
      }
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
    const rawSource = String(block && block.src || "").trim();
    // Editor approval is scoped to the author’s current session. A standalone
    // export must stay self-contained and cannot silently make every reader
    // contact a remote host just because the author once previewed an image.
    const source = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(rawSource) ? rawSource : "";
    if (!source) {
      const remote = /^https:\/\//i.test(rawSource);
      const message = remote
        ? exportTr("远程图片未嵌入导出文件。", "Remote image was not embedded in this export.")
        : exportTr("添加安全的 https 图片 URL，或选择本地图片。", "Add a safe https image URL or choose a local image.");
      return "<div class=\"pn-image-empty\">" + escapeHtml(message) + "</div>";
    }
    return "<figure class=\"pn-image\"><img referrerpolicy=\"no-referrer\" src=\"" + escapeHtml(source) + "\" alt=\"" + escapeHtml(block.alt) + "\">" + (block.caption.trim() ? "<figcaption>" + inline(block.caption) + "</figcaption>" : "") + "</figure>";
  }
  function semanticExportLabel(block) {
    if (String(block.label || "").trim()) return block.label;
    const semantic = OUTLINE_SEMANTIC_LABEL[block.kind];
    return semantic ? exportTr(semantic.zh, semantic.en) : (block.kind || "Block");
  }
  function renderEditorialPrimary(block, index, titleKey) {
    const title = editorialDisplayTitle(block, titleKey) || exportTr("未命名章节", "Untitled section");
    const body = block.type === "semantic" && semanticBodyVisible(block)
      ? paragraphs(block.content) + (String(block.summary || "").trim() ? "<p class=\"pn-editorial-section-summary\">" + inline(block.summary) + "</p>" : "")
      : "";
    return "<section class=\"pn-editorial-section pn-editorial-section-" + escapeHtml(block.kind || "heading") + "\"><div class=\"pn-editorial-section-head\"><span class=\"pn-editorial-section-number\">" + editorialSectionNumber(index) + "</span><h2>" + inline(title) + "</h2></div>" + body + "</section>";
  }
  function renderSemantic(block, index) {
    if (semanticAppearance(block) === "editorial") {
      if (isEditorialPrimary(block)) return renderEditorialPrimary(block, index, "title");
      const label = semanticExportLabel(block);
      return "<section class=\"pn-editorial-detail pn-editorial-" + escapeHtml(block.kind) + "\"><div class=\"pn-component-label\">" + escapeHtml(label) + "</div>" + (block.title.trim() ? "<h3>" + inline(block.title) + "</h3>" : "") + (semanticBodyVisible(block) ? paragraphs(block.content) : "") + (block.summary.trim() ? "<p class=\"pn-editorial-detail-summary\">" + inline(block.summary) + "</p>" : "") + "</section>";
    }
    const label = semanticExportLabel(block);
    return "<section class=\"pn-semantic pn-semantic-" + escapeHtml(block.kind) + "\"><div class=\"pn-component-label\">" + escapeHtml(label) + "</div>" + (block.title.trim() ? "<h3>" + inline(block.title) + "</h3>" : "") + (semanticBodyVisible(block) ? paragraphs(block.content) : "") + (block.summary.trim() ? "<p class=\"pn-semantic-summary\">" + inline(block.summary) + "</p>" : "") + "</section>";
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
    const item = (title, value, extraClass) => "<div class=\"pn-proof-metadata-item " + (extraClass || "") + "\"><dt>" + escapeHtml(title) + "</dt><dd>" + (String(value || "").trim() ? inline(value) : "&mdash;") + "</dd></div>";
    const source = values.source.trim() ? "<dl class=\"pn-proof-source\"><dt>" + escapeHtml(exportTr("来源", "Source")) + "</dt><dd>" + inline(values.source) + "</dd></dl>" : "";
    const labels = { author: exportTr("作者", "Author"), date: exportTr("日期", "Date"), status: exportTr("状态", "Status") };
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
  function slug(value) {
    const raw = String(value === undefined ? state && state.metadata && state.metadata.name : value || "").normalize("NFKC").trim();
    // Downloads support Unicode filenames. Remove only characters forbidden
    // by common filesystems so Chinese and other non-Latin document names do
    // not all collapse into the same generic export filename.
    return raw.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "").slice(0, 120) || "proofnote-document";
  }
  async function exportDocument() {
    if (!requireDocumentAction()) return;
    // A backup is only useful when the same Proofnote version can accept it
    // again. Size alone is insufficient: the model also owns aggregate-text,
    // table/render, and equation budgets that an authoring session can reach.
    const checked = portableDocumentCheck(state);
    if (!checked.valid) {
      setStatus(checked.message, "error");
      return;
    }
    const imageSafety = await importedImagesWithinLimit(checked.payload);
    if (!imageSafety.valid) {
      setStatus(tr("此备份包含无法安全重新导入的嵌入图片。", "This backup contains an embedded image that could not be safely re-imported."), "error");
      return;
    }
    download(slug() + ".proofnote.json", checked.portable);
    setStatus(tr("已导出 Document JSON", "Document JSON exported"), "saved");
  }
  async function exportTemplate() {
    if (!requireDocumentAction()) return;
    const selected = templateById(currentTemplateId());
    const template = Model.normalizeTemplate(selected || Model.makeTemplate(state, { name: state.metadata.name || tr("我的模板", "My template") }));
    const validation = Model.validateTemplateRaw(template);
    if (validation.errors.length) {
      const first = validation.errors[0];
      setStatus(tr("此模板不符合 Proofnote 的运行时限制，无法保证重新导入：", "This template does not meet Proofnote's runtime limits and could not be re-imported: ") + (first.path ? first.path + " — " : "") + first.message, "error");
      return;
    }
    const portable = JSON.stringify(template, null, 2);
    if (utf8ByteLength(portable) > MAX_IMPORT_BYTES) {
      setStatus(tr("此模板超过 25MB，无法保证重新导入。", "This template exceeds 25 MB and could not be re-imported."), "error");
      return;
    }
    const imageSafety = await importedImagesWithinLimit(template.document);
    if (!imageSafety.valid) {
      setStatus(tr("此模板包含无法安全重新导入的嵌入图片。", "This template contains an embedded image that could not be safely re-imported."), "error");
      return;
    }
    download(slug(template.template.name || "proofnote-template") + ".template.json", portable);
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
    if (!requireDocumentAction()) return;
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
  const EXPORT_CSS = `:root{--ink:#201f1d;--accent:#b68235;--paper:#fff;--soft:#fff3e4;--line:rgba(32,31,29,.17);--heading:"Cormorant Garamond",Georgia,serif;--body:"Lora",Georgia,serif}*{box-sizing:border-box}body{margin:0;background:#f3f2f2;color:var(--ink);font:17px/1.68 var(--body)}.pn-document{max-width:760px;margin:0 auto;padding:62px 30px 96px}.pn-document-title{margin:0 0 12px;padding-bottom:16px;border-bottom:1px solid var(--line)}.pn-document-title h1{margin:0;font:400 44px/1.1 var(--heading);letter-spacing:-.025em}.pn-document-subtitle{margin:0 0 28px;font:italic 21px/1.42 var(--heading);color:rgba(32,31,29,.7)}.pn-heading{margin:42px 0 16px;border-bottom:1px solid var(--line);padding-bottom:8px}.pn-heading h2,.pn-heading h3,.pn-heading h4{margin:0;font-family:var(--heading);font-weight:400}.pn-heading h2{font-size:30px}.pn-heading h3{font-size:24px}.pn-heading h4{font-size:20px}.pn-document p{margin:0 0 15px}.pn-equation{overflow-x:auto;margin:18px 0}.pn-code{position:relative;margin:18px 0;padding:27px 16px 16px;border:1px solid var(--line);background:#f7f6f4;overflow:auto;white-space:pre-wrap;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.pn-code-language{position:absolute;top:7px;left:14px;font:600 10px var(--heading);letter-spacing:.14em;color:rgba(32,31,29,.55)}.pn-table-wrap{overflow:auto;margin:18px 0}.pn-table{border-collapse:collapse;width:100%;font-size:14px}.pn-table th,.pn-table td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}.pn-table th{background:#f3f2f2;font-family:var(--heading);font-weight:600}.pn-image{margin:22px 0}.pn-image img{display:block;max-width:100%;height:auto}.pn-image figcaption,.pn-quote figcaption{margin-top:7px;font-size:13px;color:rgba(32,31,29,.62)}.pn-image-empty{margin:18px 0;padding:14px;border:1px dashed var(--line);font-size:13px;color:rgba(32,31,29,.6)}.pn-quote{margin:22px 0;padding:2px 0 2px 22px;border-left:3px solid var(--accent)}.pn-quote blockquote{margin:0;font:italic 22px/1.42 var(--heading)}.pn-divider{border:0;border-top:1px solid var(--line);margin:34px 0}.pn-page-break{break-before:page;page-break-before:always;height:0}.pn-callout,.pn-semantic{margin:20px 0;padding:18px 20px;border:1px solid #facb8d;background:var(--soft);break-inside:avoid}.pn-callout-warning{background:#fff7e8;border-color:#edc778}.pn-callout-info{background:#f5f7fb;border-color:#b7c6e3}.pn-component-label{margin-bottom:6px;font:600 10px var(--heading);letter-spacing:.15em;text-transform:uppercase;color:#5a3b0a}.pn-callout h3,.pn-semantic h3{margin:0 0 8px;font:600 22px/1.15 var(--heading)}.pn-semantic-summary{margin-bottom:0!important;font-style:italic;color:rgba(32,31,29,.72)}.pn-list{margin:16px 0;padding-left:24px}.pn-list li{margin-bottom:5px}.pn-key-value{margin:18px 0}.pn-key-value>div{display:grid;grid-template-columns:150px 1fr;gap:12px;margin-bottom:7px}.pn-key-value dt{font:600 10px var(--heading);letter-spacing:.12em;text-transform:uppercase;color:rgba(32,31,29,.55)}.pn-key-value dd{margin:0}.pn-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0}.pn-stat{padding:13px;border:1px solid var(--line);background:#f7f6f4}.pn-stat span{display:block;font:600 10px var(--heading);letter-spacing:.12em;text-transform:uppercase;color:rgba(32,31,29,.55)}.pn-stat strong{display:block;margin:5px 0;font:400 28px var(--heading)}.pn-stat p{margin:0!important;font-size:13px}@media print{body{background:#fff}.pn-document{max-width:none;padding:16mm 15mm}.pn-heading,.pn-semantic,.pn-callout,.pn-image{break-inside:avoid;page-break-inside:avoid}.pn-table-wrap,.pn-code{overflow:visible;break-inside:auto;page-break-inside:auto}.pn-table{break-inside:auto;page-break-inside:auto}.pn-table thead{display:table-header-group}.pn-table tr{break-inside:avoid;page-break-inside:avoid}.pn-page-break{display:block}}`;
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
    .pn-editorial-section{margin:0 0 28px}.pn-editorial-section-head{display:flex;align-items:baseline;gap:13.333px;margin-bottom:13.333px;padding-bottom:8px;border-bottom:1px solid var(--line);break-after:avoid-page;page-break-after:avoid}.pn-editorial-section-number{flex:none;font:600 12px/1 var(--heading);letter-spacing:.12em;font-feature-settings:'tnum';color:var(--accent)}.pn-editorial-section-head h2{margin:0;font:400 var(--pn-doc-section-1-size)/1.15 var(--heading);letter-spacing:-.015em}.pn-editorial-section p{margin:0 0 13.333px}.pn-editorial-section-head+p{break-before:avoid-page;page-break-before:avoid}.pn-editorial-section-summary,.pn-editorial-detail-summary{margin-top:5.333px!important;font-style:italic;color:rgba(32,31,29,.72)}
    .pn-editorial-detail{margin:0 0 16px}.pn-editorial-detail .pn-component-label{margin-bottom:4px;color:rgba(32,31,29,.55);break-after:avoid-page;page-break-after:avoid}.pn-editorial-detail h3{margin:0 0 4px;font:400 18.667px/1.2 var(--heading);break-after:avoid-page;page-break-after:avoid}.pn-editorial-detail h3+p{break-before:avoid-page;page-break-before:avoid}.pn-editorial-detail p{margin:0 0 13.333px}
    .pn-export-footer{display:flex;justify-content:space-between;margin-top:34.667px;padding-top:8px;border-top:1px solid var(--line);font:10px/1 var(--heading);letter-spacing:.1em;text-transform:uppercase;color:rgba(32,31,29,.45)}.pn-export-footer span:last-child{color:#8c6228}
    @media print{.pn-proofnote-document,.pn-project-document{padding-top:25mm;padding-bottom:23mm}.pn-proofnote-document .pn-export-running,.pn-project-document .pn-export-running{position:fixed;top:8mm;left:15mm;right:15mm}.pn-proofnote-document .pn-export-footer,.pn-project-document .pn-export-footer{position:fixed;bottom:8mm;left:15mm;right:15mm;margin:0;background:#fff}}
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
    @media print{.pn-project-document{max-width:none;padding:16mm 15mm}.pn-project-document .pn-table-wrap,.pn-project-document .pn-equation,.pn-project-document .pn-code{width:auto;margin-left:0;margin-right:0}}
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
    // Metadata is a single masthead element. Anchor it to the concrete title
    // or subtitle block selected by the header logic, never to every block of
    // the same type in an imported document.
    const metadataIndex = documentMetadata
      ? (subtitleVisible ? headerSubtitleIndex() : headerTitleIndex())
      : -1;
    const metadataWithoutTitle = documentMetadata && headerTitleIndex() < 0 ? proofMetadataHtml() : "";
    const blocks = state.blocks.map((block, index) => {
      const rendered = index === hiddenSubtitleIndex ? "" : renderBlock(block, index);
      return rendered + (index === metadataIndex ? proofMetadataHtml() : "");
    }).join("\n");
    if (!proofNote) {
      const header = project ? projectRunningHeader() : null;
      const hasRunningContent = header && [header.left, header.right].some((value) => String(value || "").trim());
      const running = hasRunningContent ? "<div class=\"pn-export-running pn-project-running\"><span class=\"pn-running-brand\">" + escapeHtml(header.left) + "</span><span class=\"pn-running-type\">" + escapeHtml(header.right) + "</span></div>" : "";
      const footer = project
        ? "<footer class=\"pn-export-footer pn-project-export-footer\"><span>" + escapeHtml(state.metadata.name || exportTr("未命名文档", "Untitled document")) + "</span><span>" + escapeHtml(header && header.right || "") + "</span></footer>"
        : "";
      return "<article class=\"pn-document" + (project ? " pn-project-document" : "") + "\">" + running + metadataWithoutTitle + blocks + footer + "</article>";
    }
    const type = escapeHtml(state.metadata.documentType || "Solution Note");
    const note = escapeHtml(state.metadata.noteNumber || "—");
    const status = escapeHtml(state.metadata.status || "");
    return "<article class=\"pn-document pn-proofnote-document\"><div class=\"pn-export-running pn-proofnote-running\"><span class=\"pn-running-brand\">Proofnote</span><span class=\"pn-running-type\">" + type + "</span></div>" + metadataWithoutTitle + blocks + "<footer class=\"pn-export-footer\"><span>" + escapeHtml(exportTr("笔记 ", "Note ")) + note + "</span><span>" + status + "</span></footer></article>";
  }
  function standaloneHtmlDocument(snapshot, editableSource) {
    // An editable export performs asynchronous safety/integrity work before
    // rendering. Freeze the reader-facing HTML to the exact same normalised
    // snapshot whose source is embedded, rather than allowing a keystroke in
    // between to produce mismatched presentation and editable content.
    const previousState = state;
    state = snapshot;
    let katexCss = "", fontsCss = "";
    try { katexCss = root.SOLUTION_NOTE_KATEX_EMBED ? decodeBase64(root.SOLUTION_NOTE_KATEX_EMBED.css) : ""; } catch (_) {}
    try { fontsCss = root.SOLUTION_NOTE_FONTS_EMBED ? decodeBase64(root.SOLUTION_NOTE_FONTS_EMBED.css) : ""; } catch (_) {}
    try {
      const title = escapeHtml(exportDocumentTitle());
      const language = exportDocumentLanguage();
      const languageAttribute = language ? " lang=\"" + escapeHtml(language) + "\"" : "";
      exportLanguageContext = language;
      let rendered = "";
      try { rendered = renderStandaloneDocument(); }
      finally { exportLanguageContext = ""; }
      return "<!doctype html><html" + languageAttribute + "><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title><style>" + katexCss.replace(/<\/style/gi, "<\\/style") + "</style><style>" + fontsCss.replace(/<\/style/gi, "<\\/style") + "</style><style>" + EXPORT_CSS + EXPORT_DOCUMENT_TYPOGRAPHY_CSS + EXPORT_PROOFNOTE_EDITORIAL_CSS + EXPORT_PROJECT_EDITORIAL_CSS + EXPORT_POLISH_CSS + EXPORT_CODE_SYNTAX_CSS + "</style></head><body>" + rendered + (editableSource || "") + "</body></html>";
    } finally {
      exportLanguageContext = "";
      state = previousState;
    }
  }
  function exportHtml() {
    if (!requireDocumentAction()) return;
    const html = standaloneHtmlDocument(state, "");
    download(slug() + ".html", html, "text/html");
  }
  function editableHtmlScriptEscape(value) {
    // The payload is JSON, not HTML. Escaping the five HTML-sensitive values
    // preserves JSON.parse() semantics while making `</script>` in document
    // prose incapable of terminating the inert source element.
    return String(value || "")
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }
  async function sha256Hex(value) {
    const crypto = root.crypto;
    if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== "function" || typeof root.TextEncoder !== "function") return "";
    const bytes = new root.TextEncoder().encode(String(value || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((part) => part.toString(16).padStart(2, "0")).join("");
  }
  function editableHtmlSourceMarkup(canonicalSource, sourceDigest, htmlDigest) {
    const escapedSource = editableHtmlScriptEscape(canonicalSource);
    return "<script id=\"" + EDITABLE_HTML_SOURCE_ID + "\" type=\"" + EDITABLE_HTML_SOURCE_TYPE + "\" data-proofnote-protocol=\"" + EDITABLE_HTML_FORMAT + "\" data-proofnote-protocol-version=\"" + EDITABLE_HTML_VERSION + "\" data-proofnote-json-bytes=\"" + utf8ByteLength(canonicalSource) + "\" data-proofnote-sha256=\"" + sourceDigest + "\" data-proofnote-html-sha256=\"" + htmlDigest + "\">" + escapedSource + "</script>";
  }
  function editableHtmlProtocolCss() {
    // Editable HTML deliberately has its own semantic DOM, but it keeps the
    // same reader-facing typography as a normal Proofnote export. The CSS is
    // presentation-only: importing always reconstructs styles from Proofnote
    // rather than retaining externally edited rules or classes.
    let katexCss = "", fontsCss = "";
    try { katexCss = root.SOLUTION_NOTE_KATEX_EMBED ? decodeBase64(root.SOLUTION_NOTE_KATEX_EMBED.css) : ""; } catch (_) {}
    try { fontsCss = root.SOLUTION_NOTE_FONTS_EMBED ? decodeBase64(root.SOLUTION_NOTE_FONTS_EMBED.css) : ""; } catch (_) {}
    return katexCss + fontsCss + EXPORT_CSS + EXPORT_DOCUMENT_TYPOGRAPHY_CSS
      + EXPORT_PROOFNOTE_EDITORIAL_CSS + EXPORT_PROJECT_EDITORIAL_CSS + EXPORT_POLISH_CSS + EXPORT_CODE_SYNTAX_CSS
      + ".pn-editable-document [data-pn-block-id]{margin:0 0 18px}.pn-editable-document [data-pn-rendered]{pointer-events:none}.pn-editable-document template{display:none}.pn-editable-document [data-pn-metadata]{display:none}.pn-editable-document [data-pn-blocks]>section:last-child{margin-bottom:0}.pn-editable-metadata{max-width:760px;margin:0 0 26px;padding:0 0 14px;border-bottom:1px solid var(--line)}.pn-editable-metadata.pn-editable-metadata-empty,.pn-editable-metadata-row.is-empty{display:none}.pn-editable-metadata dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;margin:0}.pn-editable-metadata dt{font:600 10px/1 var(--heading);letter-spacing:.12em;text-transform:uppercase;color:rgba(32,31,29,.54)}.pn-editable-metadata dd{margin:4px 0 0;min-height:1.2em;font:var(--pn-doc-meta-size)/1.45 var(--body)}";
  }
  function persistEditableHtmlLineage(documentId) {
    const protocol = root.ProofnoteEditableHtml;
    if (!state || !protocol || typeof protocol.protocolLineage !== "function" || protocol.protocolLineage(state) === documentId) return true;
    const compatibility = state.compatibility && typeof state.compatibility === "object" && !Array.isArray(state.compatibility)
      ? JSON.parse(JSON.stringify(state.compatibility)) : {};
    compatibility.proofnoteEditable = { documentId };
    state.compatibility = compatibility;
    changed();
    return true;
  }
  async function exportEditableHtml() {
    if (!requireDocumentAction()) return;
    const protocol = root.ProofnoteEditableHtml;
    if (!protocol || typeof protocol.build !== "function") {
      setStatus(tr("可编辑 HTML 协议尚未加载；请刷新后重试。", "The Editable HTML protocol has not loaded; refresh and try again."), "error");
      return;
    }
    try {
      const checked = portableDocumentCheck(state);
      if (!checked.valid) { setStatus(checked.message, "error"); return; }
      const imageSafety = await importedImagesWithinLimit(checked.payload);
      if (!imageSafety.valid) {
        setStatus(tr("此可编辑 HTML 包含无法安全重新导入的嵌入图片。", "This editable HTML contains an embedded image that could not be safely re-imported."), "error");
        return;
      }
      const exported = await protocol.build(checked.payload, {
        css: editableHtmlProtocolCss(),
        title: exportDocumentTitle(),
        language: exportDocumentLanguage(),
        codeHtml: (block) => highlightedCodeHtml(block.content, block.language)
      });
      // The first editable export mints stable lineage. Persist just that
      // identity before downloading so a later same-document import can be
      // safely recognised; do not overwrite in-session image approval state.
      if (protocol.protocolLineage(state) !== exported.documentId) {
        persistEditableHtmlLineage(exported.documentId);
        const saved = await saveActiveDocumentNow();
        if (!saveSucceeded(saved)) {
          setStatus(tr("无法保存可编辑 HTML 的文档身份；未导出。请先导出 JSON 备份。", "Proofnote could not save the editable HTML document identity, so nothing was exported. Export a JSON backup first."), "error");
          return;
        }
      }
      download(slug(exported.document.metadata && exported.document.metadata.name) + ".proofnote.html", exported.html, "text/html;charset=utf-8");
      setStatus(tr("已导出可编辑 HTML。正文、结构和支持的语义字段可回导；CSS、class 与渲染预览会由 Proofnote 重新生成。", "Editable HTML exported. Content, structure, and supported semantic fields can round-trip; CSS, classes, and rendered previews will be regenerated by Proofnote."), "saved");
    } catch (error) {
      const message = error && error.message ? String(error.message) : "";
      setStatus(message || tr("导出可编辑 HTML 时发生意外错误；没有生成文件。", "An unexpected error occurred while exporting editable HTML; no file was created."), "error");
    }
  }
  function exportDocumentTitle() {
    const titleBlock = state && state.blocks && state.blocks.find((block) => block && block.type === "title");
    return String(titleBlock && titleBlock.content || state && state.metadata && state.metadata.name || "Proofnote document").trim() || "Proofnote document";
  }
  function exportDocumentLanguage() {
    const specified = String(state && state.metadata && state.metadata.language || "").trim();
    // `lang` accepts BCP 47 tags. Ignore malformed imported metadata rather
    // than writing a misleading attribute into a standalone publication.
    if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(specified)) return specified;
    const text = (state && state.blocks || []).map((block) => {
      if (!block) return "";
      return [block.content, block.title, block.summary, block.label, block.citation]
        .concat(Array.isArray(block.items) ? block.items.map((item) => typeof item === "string" ? item : [item && item.label, item && item.value, item && item.kicker, item && item.body].join(" ")) : [])
        .join(" ");
    }).join(" ");
    if (/[\u3400-\u9fff]/.test(text)) return "zh-CN";
    // Do not label French, Spanish, German, or any other Latin-script
    // document as English merely because it contains ASCII letters. Authors
    // can supply `metadata.language` when a non-CJK BCP-47 tag matters.
    return "";
  }

  function editableHtmlDiagnostic(heading, message, help) {
    return {
      title: tr("无法导入可编辑 HTML", "Could not import editable HTML"),
      heading, message, help,
      text: [tr("无法导入可编辑 HTML", "Could not import editable HTML"), heading, message, help].filter(Boolean).join("\n")
    };
  }
  function htmlTagEnd(source, start) {
    let quote = "";
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === "\"" || character === "'") { quote = character; continue; }
      if (character === ">") return index;
    }
    return -1;
  }
  function strictScriptAttributes(source) {
    const attributes = Object.create(null);
    let offset = 0;
    while (offset < source.length) {
      while (/\s/.test(source[offset] || "")) offset += 1;
      if (offset >= source.length) return attributes;
      const nameMatch = source.slice(offset).match(/^([A-Za-z_:][A-Za-z0-9:._-]*)/);
      if (!nameMatch) return null;
      const name = nameMatch[1].toLowerCase();
      offset += name.length;
      while (/\s/.test(source[offset] || "")) offset += 1;
      if (source[offset] !== "=") return null;
      offset += 1;
      while (/\s/.test(source[offset] || "")) offset += 1;
      // The generated envelope has deliberately boring double-quoted ASCII
      // attributes. Rejecting HTML entities and unquoted forms makes the
      // scanner deterministic without ever creating a live DOM.
      if (source[offset] !== "\"") return null;
      offset += 1;
      const end = source.indexOf("\"", offset);
      if (end < 0) return null;
      if (Object.prototype.hasOwnProperty.call(attributes, name)) return null;
      attributes[name] = source.slice(offset, end);
      offset = end + 1;
    }
    return attributes;
  }
  function editableHtmlSourceElement(html) {
    const source = String(html || "");
    if (!/^\s*<!doctype\s+html(?:\s|>)/i.test(source)) {
      return { diagnostic: editableHtmlDiagnostic(tr("不是 Proofnote 可编辑 HTML", "Not a Proofnote editable HTML file"), tr("文件缺少 Proofnote 可编辑 HTML 所需的完整 HTML 文档标记。", "The file does not contain the complete HTML document marker required by Proofnote Editable HTML."), tr("请从 Proofnote 的“导出可编辑 HTML”操作重新导出；普通 HTML 不支持回导。", "Export it again with Proofnote’s Export editable HTML action; ordinary HTML is not importable.")) };
    }
    // Avoid making several full-string copies of a large arbitrary webpage
    // before we know it even has the exact carrier emitted by this protocol.
    // Fresh Proofnote Editable HTML always starts its inert carrier this way;
    // a differently formatted large script is intentionally unsupported.
    if (source.length > 4 * 1024 * 1024 && source.indexOf("<script id=\"" + EDITABLE_HTML_SOURCE_ID + "\"") < 0) {
      return { diagnostic: editableHtmlDiagnostic(tr("缺少唯一的 Proofnote 源数据", "Missing a unique Proofnote source"), tr("大型 HTML 文件没有 Proofnote 可编辑 HTML 1.0 的专属源数据容器。Proofnote 不会从页面文字或 DOM 猜测 blocks。", "This large HTML file has no dedicated Proofnote Editable HTML 1.0 source carrier. Proofnote never infers blocks from page text or the DOM."), tr("请使用未修改的“导出 Proofnote 可编辑 HTML”文件，或导入 .proofnote.json 备份。", "Use an unmodified Export Proofnote editable HTML file, or import a .proofnote.json backup.")) };
    }
    // Do not treat a marker written inside an HTML comment as a real source
    // element. Replacing comments with equal-length whitespace preserves
    // offsets into the original file without needing DOMParser or a live DOM.
    const scanned = source.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
    const lower = scanned.toLowerCase();
    const finalArticleClose = lower.lastIndexOf("</article>");
    const bodyClose = lower.lastIndexOf("</body>");
    const candidates = [];
    let offset = 0;
    while (offset < scanned.length) {
      const start = lower.indexOf("<script", offset);
      if (start < 0) break;
      const following = scanned[start + 7] || "";
      if (following && !/[\s/>]/.test(following)) { offset = start + 7; continue; }
      const tagEnd = htmlTagEnd(scanned, start + 7);
      if (tagEnd < 0) break;
      const attributes = strictScriptAttributes(scanned.slice(start + 7, tagEnd));
      const closeStart = lower.indexOf("</script", tagEnd + 1);
      const closeEnd = closeStart < 0 ? -1 : htmlTagEnd(scanned, closeStart + 2);
      if (attributes && attributes.id === EDITABLE_HTML_SOURCE_ID) {
        if (closeStart < 0 || closeEnd < 0 || !/^<\/script\s*>$/i.test(scanned.slice(closeStart, closeEnd + 1))) {
          return { diagnostic: editableHtmlDiagnostic(tr("可编辑源数据已截断", "Editable source is truncated"), tr("Proofnote 找到源数据标记，但其 script 容器没有正确结束。", "Proofnote found the source marker, but its script container does not end correctly."), tr("请重新导出该文件；不要手动修改嵌入的源数据。", "Export the file again and do not manually alter its embedded source.")) };
        }
        // The exporter appends its inert carrier immediately after the one
        // reader document and immediately before </body>. This avoids treating
        // a lookalike tag in arbitrary HTML content as a transport envelope.
        const carrierPositionValid = finalArticleClose >= 0
          && bodyClose > finalArticleClose
          && start > finalArticleClose
          && closeEnd < bodyClose
          && !source.slice(finalArticleClose + "</article>".length, start).trim()
          && !source.slice(closeEnd + 1, bodyClose).trim();
        if (!carrierPositionValid) {
          return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 源位置不匹配", "Editable HTML source placement does not match"), tr("Proofnote 源数据必须紧跟在导出的文档之后、并位于 body 结束标签之前。", "The Proofnote source must appear directly after the exported document and before the closing body tag."), tr("请使用未修改的“导出可编辑 HTML”文件。", "Use an unmodified file from Export editable HTML.")) };
        }
        candidates.push({ attributes, content: source.slice(tagEnd + 1, closeStart), tagStart: start, tagEnd });
      }
      offset = closeEnd >= 0 ? closeEnd + 1 : tagEnd + 1;
    }
    if (candidates.length !== 1) {
      // Presentation-only exports, including older standalone exports, have a
      // rendered DOM that can resemble a current Proofnote document, but they
      // never contain the source-only information needed for a faithful
      // editor document (a complete block mapping, authoring state, hidden
      // semantic content, and metadata). Rendered/KaTeX fragments are not a
      // complete recoverable source. Call this out rather than inviting a lossy DOM
      // reconstruction or making it look like an arbitrary webpage.
      const legacyProofnotePresentation = /<article\b[^>]*\bclass\s*=\s*(?:"[^"]*\bpn-document\b[^"]*"|'[^']*\bpn-document\b[^']*')/i.test(scanned)
        && /\bpn-(?:document-title|export-running|proofnote-document|project-document|editorial-section)\b/i.test(scanned);
      if (!candidates.length && legacyProofnotePresentation) {
        return { diagnostic: editableHtmlDiagnostic(tr("Proofnote 展示型 HTML 不支持回导", "Proofnote presentation HTML cannot be re-imported"), tr("检测到的是仅供阅读、打印或分享的 Proofnote 展示型 HTML（也包括早期导出）。它不包含完整、可验证的原始文档源（如 blocks 映射、作者状态、隐藏内容与元数据）；页面中即使有渲染或 KaTeX 片段，也不足以无损重建文档。", "This is a presentation-only Proofnote HTML file for reading, printing, or sharing, including earlier exports. It lacks a complete, verifiable original document source (such as a block mapping, authoring state, hidden content, and metadata); rendered or KaTeX fragments are not enough for lossless reconstruction."), tr("请从仍保留在 Proofnote 中的原文档使用“导出 Proofnote 可编辑 HTML”重新导出；若原文档不在本机，请使用 .proofnote.json 备份。", "Open the original document in Proofnote and export it again with Export Proofnote editable HTML; if the original is no longer local, use its .proofnote.json backup.")) };
      }
      return { diagnostic: editableHtmlDiagnostic(tr("缺少唯一的 Proofnote 源数据", "Missing a unique Proofnote source"), candidates.length
        ? tr("文件包含多个可编辑源数据容器；Proofnote 为避免选择错误内容而拒绝导入。", "The file contains multiple editable-source containers, so Proofnote refused to choose one.")
        : tr("文件没有 Proofnote 可编辑源数据。Proofnote 不会从页面文字或 DOM 猜测 blocks。", "The file has no Proofnote editable source. Proofnote never infers blocks from page text or the DOM."), tr("只接受由“导出可编辑 HTML”生成、且未被拆分或拼接的单一文件。", "Only one intact file generated by Export editable HTML is accepted.")) };
    }
    const expected = {
      id: EDITABLE_HTML_SOURCE_ID,
      type: EDITABLE_HTML_SOURCE_TYPE,
      "data-proofnote-protocol": EDITABLE_HTML_FORMAT,
      "data-proofnote-protocol-version": EDITABLE_HTML_VERSION
    };
    const attributes = candidates[0].attributes;
    const names = Object.keys(attributes).sort();
    const expectedNames = Object.keys(expected).concat(["data-proofnote-json-bytes", "data-proofnote-sha256", "data-proofnote-html-sha256"]).sort();
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index]) || Object.entries(expected).some(([name, value]) => attributes[name] !== value)) {
      return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 协议不匹配", "Editable HTML protocol does not match"), tr("源数据容器的类型、协议或属性不符合 Proofnote 可编辑 HTML 1.0。", "The source container type, protocol, or attributes do not match Proofnote Editable HTML 1.0."), tr("请使用同一版本 Proofnote 导出的完整文件；不要复制或重写其中的 source script。", "Use a complete file exported by a compatible Proofnote version; do not copy or rewrite its source script.")) };
    }
    if (!/^[0-9]+$/.test(attributes["data-proofnote-json-bytes"] || "") || !/^[a-f0-9]{64}$/.test(attributes["data-proofnote-sha256"] || "") || !/^[a-f0-9]{64}$/.test(attributes["data-proofnote-html-sha256"] || "")) {
      return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 完整性信息无效", "Editable HTML integrity data is invalid"), tr("源数据缺少有效的字节长度或 SHA-256 校验值。", "The embedded source is missing a valid byte length or SHA-256 check."), tr("请从 Proofnote 重新导出该文件。", "Export the file again from Proofnote.")) };
    }
    return { content: candidates[0].content, attributes, tagStart: candidates[0].tagStart, tagEnd: candidates[0].tagEnd };
  }
  function editableHtmlEnvelopeErrors(raw) {
    const errors = [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ path: "", message: tr("嵌入源必须是 JSON 对象。", "The embedded source must be a JSON object.") });
      return errors;
    }
    const allowed = new Set(["format", "version", "document"]);
    Object.keys(raw).forEach((key) => {
      if (!allowed.has(key)) errors.push({ path: key, message: tr("可编辑 HTML 源不允许未知字段。", "Editable HTML source does not allow unknown fields.") });
    });
    if (raw.format !== EDITABLE_HTML_FORMAT) errors.push({ path: "format", message: tr("应为 \"proofnote-editable-html\"。", "Expected \"proofnote-editable-html\".") });
    if (raw.version !== EDITABLE_HTML_VERSION) errors.push({ path: "version", message: tr("不支持此可编辑 HTML 版本；当前仅支持 1.0。", "This editable HTML version is not supported; only 1.0 is supported.") });
    if (!raw.document || typeof raw.document !== "object" || Array.isArray(raw.document)) errors.push({ path: "document", message: tr("必须包含一个 Proofnote Document 对象。", "A Proofnote Document object is required.") });
    else {
      if (raw.document.format !== Model.FORMAT) errors.push({ path: "document.format", message: tr("只接受 proofnote-document，不接受模板、Solution Note 或其他格式。", "Only proofnote-document is accepted; templates, Solution Notes, and other formats are not accepted.") });
      if (raw.document.version !== Model.VERSION) errors.push({ path: "document.version", message: tr("该 Proofnote Document 版本不受当前可编辑 HTML 协议支持。", "This Proofnote Document version is not supported by the current editable HTML protocol.") });
    }
    return errors;
  }
  // Editable HTML 1.0 was an integrity-sealed source carrier. Keep this
  // reader solely for people who already exported one: it can restore an
  // intact source, but it cannot reconcile hand-edited visible HTML. New
  // exports use the semantic v2 protocol below.
  async function inspectEditableHtmlV1Source(html) {
    const htmlSource = String(html || "");
    const sourceElement = editableHtmlSourceElement(htmlSource);
    if (sourceElement.diagnostic) return sourceElement;
    const embeddedSource = String(sourceElement.content || "");
    if (!embeddedSource || utf8ByteLength(embeddedSource) > MAX_EDITABLE_HTML_SOURCE_BYTES) {
      return { diagnostic: editableHtmlDiagnostic(tr("嵌入源数据超出上限", "Embedded source exceeds the limit"), tr("可编辑 HTML 的嵌入源数据为空或超过安全上限。", "The editable HTML’s embedded source is empty or exceeds the safe limit."), tr("请重新导出或改用 Proofnote JSON 备份。", "Export it again or use a Proofnote JSON backup.")) };
    }
    const inspected = inspectImportJson(embeddedSource);
    if (inspected.diagnostic) {
      return { diagnostic: Object.assign({}, inspected.diagnostic, {
        title: tr("无法导入可编辑 HTML", "Could not import editable HTML"),
        message: tr("嵌入的 Proofnote 源数据无法安全解析。", "The embedded Proofnote source could not be parsed safely.") + (inspected.diagnostic.message ? " " + inspected.diagnostic.message : "")
      }) };
    }
    const warnings = inspected.warnings || [];
    if (warnings.some((issue) => issue && issue.kind === "duplicate-json-key")) {
      return { diagnostic: editableHtmlDiagnostic(tr("嵌入源数据不唯一", "Embedded source is ambiguous"), tr("可编辑 HTML 的 JSON 含有重复键。为避免不同解析器选择不同值，Proofnote 拒绝导入。", "The editable HTML JSON contains duplicate keys. Proofnote refused it so parsers cannot choose different values."), tr("请从 Proofnote 重新导出该文件。", "Export the file again from Proofnote.")) };
    }
    const envelopeErrors = editableHtmlEnvelopeErrors(inspected.raw);
    if (envelopeErrors.length) return { envelopeErrors, warnings };
    const canonicalSource = JSON.stringify(inspected.raw);
    // The source script must be byte-for-byte in the encoding produced by
    // this protocol. JSON with equivalent semantics but different spacing or
    // escapes is still a hand-written carrier, not a Proofnote export.
    if (embeddedSource !== editableHtmlScriptEscape(canonicalSource)) {
      return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 源编码不匹配", "Editable HTML source encoding does not match"), tr("嵌入源不是 Proofnote 可编辑 HTML 1.0 要求的规范 JSON 编码。", "The embedded source is not the canonical JSON encoding required by Proofnote Editable HTML 1.0."), tr("请使用未修改的“导出可编辑 HTML”文件。", "Use an unmodified file from Export editable HTML.")) };
    }
    const declaredBytes = Number(sourceElement.attributes["data-proofnote-json-bytes"]);
    if (utf8ByteLength(canonicalSource) !== declaredBytes || utf8ByteLength(canonicalSource) > MAX_EDITABLE_HTML_SOURCE_BYTES) {
      return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 源数据长度不匹配", "Editable HTML source length does not match"), tr("嵌入源数据的实际 UTF-8 字节长度与文件声明不一致。", "The embedded source’s actual UTF-8 byte length does not match the file declaration."), tr("文件可能被修改或截断；请从 Proofnote 重新导出。", "The file may have been modified or truncated; export it again from Proofnote.")) };
    }
    const digest = await sha256Hex(canonicalSource);
    if (!digest) return { diagnostic: editableHtmlDiagnostic(tr("浏览器无法验证完整性", "Browser cannot verify integrity"), tr("当前浏览器缺少 SHA-256 校验能力，因此 Proofnote 不会导入可编辑 HTML。", "This browser lacks SHA-256 verification, so Proofnote will not import editable HTML."), tr("请使用最新浏览器后重试。", "Try again in a current browser.")) };
    if (digest !== sourceElement.attributes["data-proofnote-sha256"]) {
      return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 完整性校验失败", "Editable HTML integrity check failed"), tr("嵌入源数据与文件中的 SHA-256 校验值不一致。", "The embedded source does not match the SHA-256 check stored in the file."), tr("文件可能被意外修改。请从 Proofnote 重新导出，或改用 Proofnote JSON 备份。", "The file may have been modified. Export it again from Proofnote or use a Proofnote JSON backup.")) };
    }
    const htmlDigest = sourceElement.attributes["data-proofnote-html-sha256"];
    const hashAttribute = "data-proofnote-html-sha256=\"" + htmlDigest + "\"";
    const hashOffset = htmlSource.indexOf(hashAttribute, sourceElement.tagStart);
    if (hashOffset < sourceElement.tagStart || hashOffset > sourceElement.tagEnd) {
      return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 完整性封套不一致", "Editable HTML integrity envelope is inconsistent"), tr("完整文件校验字段不在唯一的 Proofnote 源数据容器中。", "The full-file integrity field is not inside the unique Proofnote source container."), tr("请使用未修改的“导出可编辑 HTML”文件。", "Use an unmodified file from Export editable HTML.")) };
    }
    const unsignedHtml = htmlSource.slice(0, hashOffset) + "data-proofnote-html-sha256=\"" + EDITABLE_HTML_HASH_PLACEHOLDER + "\"" + htmlSource.slice(hashOffset + hashAttribute.length);
    const computedHtmlDigest = await sha256Hex(unsignedHtml);
    if (!computedHtmlDigest) return { diagnostic: editableHtmlDiagnostic(tr("浏览器无法验证完整性", "Browser cannot verify integrity"), tr("当前浏览器缺少 SHA-256 校验能力，因此 Proofnote 不会导入可编辑 HTML。", "This browser lacks SHA-256 verification, so Proofnote will not import editable HTML."), tr("请使用最新浏览器后重试。", "Try again in a current browser.")) };
    if (computedHtmlDigest !== htmlDigest) {
      return { diagnostic: editableHtmlDiagnostic(tr("可编辑 HTML 文件已被修改", "Editable HTML file was modified"), tr("整份 HTML（包括可见页面）与 Proofnote 导出时的完整性校验不一致。为避免忽略外部 HTML 改动或导入错误内容，Proofnote 拒绝回导。", "The complete HTML file, including its visible page, does not match Proofnote’s export-time integrity check. Proofnote refused to re-import it rather than ignore external HTML edits or import the wrong content."), tr("请使用未修改的“导出可编辑 HTML”文件；若要编辑内容，请先在 Proofnote 中导入原文件，再在页面内编辑并重新导出。", "Use an unmodified Export editable HTML file. To edit content, import the original into Proofnote, edit it on the page, then export again.")) };
    }
    return { raw: inspected.raw.document, warnings, canonicalSource, protocolVersion: "1.0", status: "EXACT", replacementEligible: false };
  }
  function editableHtmlV2Candidate(source) {
    // Do not send an arbitrary web page through the v2 DOM compiler. A v2
    // carrier declares both its format and version in its inert head metadata;
    // malformed files that retain either marker still belong to that protocol
    // and receive its precise INVALID diagnostic rather than falling back to
    // an unsafe presentation parser.
    const text = String(source || "");
    return /<meta\b[^>]*\bname\s*=\s*(?:"proofnote-(?:format|version|magic)"|'proofnote-(?:format|version|magic)'|proofnote-(?:format|version|magic))[^>]*>/i.test(text)
      || /data-proofnote-protocol-version\s*=\s*(?:"2"|'2'|2)/i.test(text);
  }
  async function inspectEditableHtmlSource(html) {
    const protocol = root.ProofnoteEditableHtml;
    if (editableHtmlV2Candidate(html)) {
      if (!protocol || typeof protocol.inspect !== "function") {
        return { diagnostic: editableHtmlDiagnostic(tr("当前工作区缺少可编辑 HTML 协议", "This workspace is missing the Editable HTML protocol"), tr("Proofnote 无法加载可编辑 HTML 2 的语义恢复模块。当前文档没有被修改。", "Proofnote could not load the Editable HTML 2 semantic-recovery module. The current document was not changed."), tr("请刷新 Proofnote 后重试。", "Refresh Proofnote and try again.")) };
      }
      return protocol.inspect(String(html || ""), { currentDocument: state });
    }
    return inspectEditableHtmlV1Source(html);
  }
  function setEditableHtmlImportSummary(message) {
    if (!els.editableHtmlSummary) return;
    els.editableHtmlSummary.hidden = false;
    els.editableHtmlSummary.textContent = message;
  }
  function readImportFile() {
    const file = els.importFile.files && els.importFile.files[0];
    if (!file || editableHtmlImportInProgress) return;
    const editableHtml = importMode === "editable-html";
    const modeAtRead = importMode;
    // Invalidate an earlier verified candidate *before* every failure branch.
    // Otherwise picking an oversized file after A has verified could leave
    // Import/Replace armed for A while the UI appears to refer to B.
    const generation = ++importFileReadGeneration;
    pendingEditableHtml = null;
    els.importText.value = "";
    resetImportWarningConfirmation();
    els.importText.readOnly = true;
    els.importConfirm.disabled = true;
    els.importReplace.disabled = true;
    clearImportReport();
    const release = () => {
      if (generation !== importFileReadGeneration || els.modal.hidden || importMode !== modeAtRead) return false;
      els.importText.readOnly = editableHtml;
      els.importConfirm.disabled = editableHtml;
      els.importReplace.disabled = true;
      return true;
    };
    const maximumBytes = editableHtml ? MAX_EDITABLE_HTML_BYTES : MAX_IMPORT_BYTES;
    if (file.size > maximumBytes) {
      release();
      if (editableHtml) setEditableHtmlImportSummary(tr("可编辑 HTML 文件超过 64MB 安全上限；没有导入任何内容。", "Editable HTML file exceeds the 64 MB safety limit; nothing was imported."));
      showImportMessage(editableHtml
        ? tr("可编辑 HTML 文件超过 64MB 安全上限。", "Editable HTML file exceeds the 64 MB safety limit.")
        : tr("文件超过 25MB 导入上限。", "File exceeds the 25 MB import limit."), "error");
      els.importFile.value = "";
      return;
    }
    if (editableHtml) setEditableHtmlImportSummary(tr("正在读取并验证可编辑 HTML…", "Reading and verifying editable HTML…"));
    const reader = new FileReader();
    const active = () => generation === importFileReadGeneration && !els.modal.hidden && importMode === modeAtRead;
    reader.onload = async () => {
      try {
        if (!active()) return;
        const source = String(reader.result || "");
        if (!editableHtml) {
          if (!release()) return;
          els.importText.value = source;
          clearImportReport();
          return;
        }
        const inspected = await inspectEditableHtmlSource(source);
        if (!active()) return;
        if (inspected.diagnostic) {
          renderImportDiagnostics(inspected.diagnostic);
          setEditableHtmlImportSummary(tr("未找到可安全导入的 Proofnote 可编辑源。当前文档没有被修改。", "No safely importable Proofnote editable source was found. The current document was not changed."));
          return;
        }
        if (inspected.envelopeErrors && inspected.envelopeErrors.length) {
          renderSchemaDiagnostics(tr("无法导入可编辑 HTML", "Could not import editable HTML"), inspected.envelopeErrors, inspected.warnings || []);
          setEditableHtmlImportSummary(tr("可编辑 HTML 的源封套不符合协议。当前文档没有被修改。", "The editable HTML source envelope does not meet the protocol. The current document was not changed."));
          return;
        }
        const recoveredDocument = inspected.document || inspected.raw;
        if (!recoveredDocument || !recoveredDocument.metadata || !Array.isArray(recoveredDocument.blocks)) {
          renderImportDiagnostics(editableHtmlDiagnostic(tr("可编辑 HTML 缺少可恢复内容", "Editable HTML has no recoverable content"), tr("协议验证完成，但没有得到可安全导入的 Proofnote 文档。", "The protocol was verified, but it did not produce a safely importable Proofnote document."), tr("请从 Proofnote 重新导出该文件。", "Export the file again from Proofnote.")));
          setEditableHtmlImportSummary(tr("没有导入任何内容。", "No content was imported."));
          return;
        }
        // File-backed only: do not mirror a potentially 32 MB carrier into a
        // hidden textarea. `sourceKey` identifies this exact selection while
        // `htmlSource` is retained only for the just-in-time replacement
        // revalidation below.
        pendingEditableHtml = {
          raw: recoveredDocument,
          document: recoveredDocument,
          baseline: inspected.baseline || null,
          warnings: Array.isArray(inspected.warnings) ? inspected.warnings.map((warning) => typeof warning === "string" ? { path: "", message: warning } : warning).filter(Boolean) : [],
          sourceKey: source,
          htmlSource: source,
          filename: String(file.name || ""),
          protocolVersion: String(inspected.protocolVersion || inspected.envelope && inspected.envelope.version || "1.0"),
          status: String(inspected.status || "EXACT"),
          changes: inspected.changes || { edited: 0, inserted: 0, deleted: 0, moved: 0, visualOnly: false },
          documentId: String(inspected.documentId || inspected.envelope && inspected.envelope.documentId || ""),
          revisionId: String(inspected.revisionId || inspected.envelope && inspected.envelope.revisionId || ""),
          replacementEligible: inspected.replacementEligible === true
        };
        els.importText.value = "";
        els.importText.readOnly = true;
        syncEditableHtmlImportActions();
        const name = String(recoveredDocument.metadata && recoveredDocument.metadata.name || "").trim() || tr("未命名文档", "Untitled document");
        const count = recoveredDocument.blocks.length;
        const changes = pendingEditableHtml.changes;
        let statusSummary;
        if (pendingEditableHtml.protocolVersion !== "2") {
          statusSummary = tr("这是旧版 Proofnote Editable HTML。它只能导入为新文档，不能覆盖当前文档。", "This is legacy Proofnote Editable HTML. It can only be imported as a new document and cannot replace the current document.");
        } else if (pendingEditableHtml.status === "STALE") {
          statusSummary = tr("此文件来自当前文档的较早 revision；可导入为新文档，但不能覆盖当前文档。", "This file was exported from an older revision of the current document. It may be imported as a new document, but cannot replace the current document.");
        } else if (pendingEditableHtml.status === "RECOVERED" && changes.visualOnly) {
          statusSummary = tr("未检测到 Proofnote 内容改动；已忽略外部仅视觉改动。", "No ProofNote content changes detected; external visual-only changes were ignored.");
        } else if (pendingEditableHtml.status === "RECOVERED") {
          statusSummary = tr("已恢复外部语义改动：" + changes.edited + " 处编辑、" + changes.inserted + " 个新增内容块、" + changes.deleted + " 个删除内容块、" + changes.moved + " 个移动内容块。", "Recovered external semantic changes: " + changes.edited + " edited, " + changes.inserted + " inserted, " + changes.deleted + " deleted, and " + changes.moved + " moved block(s). ");
        } else {
          statusSummary = tr("协议、baseline 与语义字段已验证；未检测到外部内容改动。", "The protocol, baseline, and semantic fields were verified; no external content changes were detected.");
        }
        setEditableHtmlImportSummary("“" + name + "” · " + count + tr(" 个内容块。", " blocks. ") + statusSummary);
        clearImportReport();
      } catch (_) {
        if (!release()) return;
        if (editableHtml) setEditableHtmlImportSummary(tr("无法安全验证该可编辑 HTML；没有导入任何内容。", "Could not safely verify this editable HTML; nothing was imported."));
        showImportMessage(tr("读取或验证文件时发生意外错误；没有导入任何内容。", "An unexpected error occurred while reading or verifying the file; no content was imported."), "error");
      }
    };
    reader.onerror = () => {
      if (!release()) return;
      if (editableHtml) setEditableHtmlImportSummary(tr("无法读取该文件；没有导入任何内容。", "Could not read this file; nothing was imported."));
      showImportMessage(tr("无法读取该文件；没有导入任何内容。", "Could not read that file; no content was imported."), "error");
    };
    reader.onabort = () => {
      if (!release()) return;
      if (editableHtml) setEditableHtmlImportSummary(tr("文件读取已取消；没有导入任何内容。", "File reading was cancelled; nothing was imported."));
      showImportMessage(tr("文件读取已取消；没有导入任何内容。", "File reading was cancelled; no content was imported."), "warning");
    };
    reader.readAsText(file);
    // Permit selecting the same pathname again after an external edit.
    els.importFile.value = "";
  }
  function utf8ByteLength(value) {
    const text = String(value || "");
    if (typeof root.TextEncoder === "function") return new root.TextEncoder().encode(text).byteLength;
    // TextEncoder is available in supported browsers, but Blob keeps the
    // boundary correct for older WebViews too (notably for non-ASCII JSON).
    return new Blob([text]).size;
  }
  const STRICT_JSON_PARSE_OPTIONS = { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false };
  // A raw JSON escape can silently consume only b, f, n, r, or t. Known
  // commands are conclusive errors. Other lower-case command-shaped escapes
  // are surfaced as recoverable notices: `\\nsecond` might be a legitimate
  // newline, but it might equally be a malformed `\\nu`-style command. This
  // avoids an unbounded command allowlist without blocking `\\nSecond line`.
  const KNOWN_SILENT_JSON_LATEX_COMMANDS = new Set([
    "bar", "begin", "beta", "big", "bigg", "binom", "boldsymbol", "boxed", "breve",
    "fbox", "forall", "frac", "floor",
    "nabla", "ne", "neq", "newline", "not", "notin",
    "rangle", "rceil", "rfloor", "right", "rightarrow",
    "tan", "tau", "text", "textbf", "textcolor", "textit", "tfrac", "therefore", "theta", "tilde", "times", "tiny", "to", "top", "triangle"
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
    if (!els.importText || els.importText.hidden) return;
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
    const errors = [];
    const warnings = [];
    const addIssue = (target, issue) => {
      if (errors.length + warnings.length < MAX_IMPORT_DIAGNOSTIC_ISSUES) target.push(issue);
    };
    const matcher = /\\([bfnrt])(?=[A-Za-z])/g;
    let match;
    while ((match = matcher.exec(source))) {
      const offset = match.index;
      if (escapedBackslashAt(source, offset)) continue;
      const command = source.slice(offset + 1).match(/^[A-Za-z]+/)?.[0] || match[1];
      const location = parser.getLocation(source, offset);
      const path = diagnosticPath(location && location.path);
      const block = diagnosticOwningBlock(rawDocument, location && location.path);
      const legacyContent = isSolutionNoteLatexContent(rawDocument, location && location.path);
      // This diagnostic deliberately guards document prose and mathematics,
      // plus known Solution Note content fields. It never scans metadata or
      // legacy code snippets, where an escaped tab or regex token may be
      // intentional rather than damaged LaTeX.
      if ((!block && !legacyContent) || block && block.type === "code") continue;
      const lowerCaseCommand = /^[a-z]+$/.test(command);
      const knownCommand = KNOWN_SILENT_JSON_LATEX_COMMANDS.has(command.toLowerCase());
      const mathContext = rawMathContext(source, offset);
      const issue = {
        path, offset, length: command.length + 1,
        message: tr("\"\\" + command + "\" 看起来像 LaTeX 命令，但 JSON 已把 \\" + match[1] + " 解释为控制字符。请改用 \"\\u005c" + command + "\"。", "\"\\" + command + "\" looks like a LaTeX command, but JSON interpreted \\" + match[1] + " as a control escape. Use \"\\u005c" + command + "\" instead.")
      };
      // Equations and content inside an explicit inline/display-math region
      // are unambiguously mathematical. Retain the hard stop for known
      // commands everywhere else.
      if (knownCommand || (block && block.type === "equation" && command.length > 1) || mathContext) addIssue(errors, issue);
      // Without a delimiter, a lower-case word after a JSON control escape is
      // ambiguous. Keep it visible as a confirmation warning instead of
      // silently accepting a possible `\\nu`, `\\rho`, `\\bullet`, and so on.
      else if (lowerCaseCommand) addIssue(warnings, Object.assign({}, issue, {
        message: tr("\"\\" + command + "\" 可能是被 JSON 控制转义改变的 LaTeX 命令。若这是换行或制表符，可继续导入；若原意是反斜杠命令，请改用 \"\\u005c" + command + "\"。", "\"\\" + command + "\" may be a LaTeX command changed by a JSON control escape. Continue only if it is an intended newline/tab; otherwise use \"\\u005c" + command + "\".")
      }));
      if (errors.length + warnings.length >= MAX_IMPORT_DIAGNOSTIC_ISSUES) break;
    }
    return { errors, warnings };
  }
  function rawMathContext(source, offset) {
    // Examine only the current JSON string. Properly encoded inline delimiters
    // appear as `\\\\(` / `\\\\)` in source, so a raw control escape between
    // them cannot reasonably be an ordinary newline or tab.
    let start = Math.max(0, Number(offset) || 0);
    for (let index = start - 1; index >= 0; index -= 1) {
      if (source[index] === '"' && !escapedBackslashAt(source, index)) { start = index + 1; break; }
    }
    const before = source.slice(start, offset);
    const open = Math.max(before.lastIndexOf("\\\\("), before.lastIndexOf("\\\\["));
    const close = Math.max(before.lastIndexOf("\\\\)"), before.lastIndexOf("\\\\]"));
    return open >= 0 && open > close;
  }
  function diagnosticOwningBlock(rawDocument, path) {
    if (!rawDocument || !Array.isArray(path)) return null;
    const blocksAt = path.lastIndexOf("blocks");
    const index = blocksAt >= 0 ? path[blocksAt + 1] : -1;
    if (!Number.isInteger(index)) return null;
    let container = rawDocument;
    for (let cursor = 0; cursor < blocksAt; cursor += 1) {
      if (container == null) return null;
      container = container[path[cursor]];
    }
    return container && Array.isArray(container.blocks) ? container.blocks[index] || null : null;
  }
  function isSolutionNoteLatexContent(rawDocument, path) {
    if (!rawDocument || rawDocument.format !== "solution-note" || !Array.isArray(path) || !path.length) return false;
    if (path[0] === "optional") {
      const index = typeof path[2] === "number" ? path[2] : -1;
      const collection = rawDocument.optional && rawDocument.optional[path[1]];
      const entry = Array.isArray(collection) && index >= 0 ? collection[index] : null;
      return !(entry && entry.type === "code");
    }
    if (path[0] !== "core") return false;
    const section = path[1];
    if (["problem", "result", "whyItWorks"].includes(section)) return true;
    if (section !== "evidence") return false;
    // Evidence may hold legacy code blocks. Find the owning evidence entry
    // from the diagnostic path and leave its source untouched.
    const index = typeof path[2] === "number" ? path[2] : -1;
    const entry = rawDocument.core && Array.isArray(rawDocument.core.evidence) && index >= 0 ? rawDocument.core.evidence[index] : null;
    return !(entry && entry.type === "code");
  }
  function duplicateJsonKeyWarnings(parser, source) {
    const warnings = [];
    const tree = parser.parseTree(source, [], STRICT_JSON_PARSE_OPTIONS);
    // parseTree can represent arbitrary nested JSON. Walk it iteratively so a
    // hostile-but-syntactically-valid payload cannot exhaust the JavaScript
    // call stack before Proofnote can report its depth diagnostic.
    const pending = tree ? [tree] : [];
    let visited = 0;
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      visited += 1;
      if (visited > MAX_IMPORT_DIAGNOSTIC_NODES) {
        warnings.push({ path: "", message: tr("重复键检查在安全工作量上限处停止；请先缩小导入文件后再检查其余内容。", "Duplicate-key checking stopped at its safe work limit; reduce the import before checking the remaining content.") });
        break;
      }
      if (node.type === "object") {
        const seen = new Set();
        (node.children || []).forEach((property) => {
          const keyNode = property && property.children && property.children[0];
          const valueNode = property && property.children && property.children[1];
          const key = keyNode && String(keyNode.value || "");
          if (keyNode && seen.has(key)) {
            const location = parser.getLocation(source, keyNode.offset);
            warnings.push({ kind: "duplicate-json-key", path: diagnosticPath(location && location.path), offset: keyNode.offset, length: keyNode.length, message: tr("重复的 JSON 键；后一个值已被采用。", "Duplicate JSON key; the later value was used.") });
            if (warnings.length >= MAX_IMPORT_DIAGNOSTIC_ISSUES) return;
          }
          seen.add(key);
          if (valueNode) pending.push(valueNode);
        });
        continue;
      }
      (node.children || []).forEach((child) => { if (child) pending.push(child); });
    }
    return warnings;
  }
  function excessiveJsonNestingDiagnostic(source) {
    const parserSafeDepth = Math.max(256, Model.LIMITS.maxDepth * 4);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let offset = 0; offset < source.length; offset += 1) {
      const character = source[offset];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === "{" || character === "[") {
        depth += 1;
        if (depth <= parserSafeDepth) continue;
        const excerpt = importSourceExcerpt(source, offset);
        return {
          title: tr("无法导入文档", "Could not import document"),
          heading: tr("JSON 嵌套过深", "JSON is nested too deeply"),
          position: tr("第 " + excerpt.line + " 行，第 " + excerpt.column + " 列", "Line " + excerpt.line + " · Column " + excerpt.column),
          message: tr("该 JSON 超过了安全诊断深度，未继续解析以避免浏览器卡死。", "This JSON exceeds the safe diagnostic depth, so Proofnote stopped before it could exhaust the browser stack."),
          source, offset: excerpt.offset, length: 1, snippet: excerpt.text,
          help: tr("请将嵌套对象或数组拆分为更浅的结构。", "Split nested objects or arrays into a shallower structure."),
          text: tr("JSON 嵌套过深", "JSON is nested too deeply")
        };
      }
      if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
    }
    return null;
  }
  function inspectImportJson(source) {
    const parser = root.ProofnoteJsoncParser;
    if (!parser || typeof parser.parse !== "function") {
      return { diagnostic: { title: tr("无法导入文档", "Could not import document"), heading: tr("导入诊断未就绪", "Import diagnostics are unavailable"), message: tr("JSON 诊断组件未加载；请重新打开 Proofnote 后重试。", "The JSON diagnostics component did not load. Reopen Proofnote and try again."), text: tr("导入诊断未就绪", "Import diagnostics are unavailable") } };
    }
    const nestingDiagnostic = excessiveJsonNestingDiagnostic(source);
    if (nestingDiagnostic) return { diagnostic: nestingDiagnostic };
    const parseErrors = [];
    // jsonc-parser already produces the parsed value under our strict JSON
    // options. Retain it instead of asking the browser JSON parser to build a
    // second full object graph for the same import payload.
    const raw = parser.parse(source, parseErrors, STRICT_JSON_PARSE_OPTIONS);
    if (parseErrors.length) return { diagnostic: jsonSyntaxDetails(parser, source, parseErrors[0]) };
    if (raw === undefined) {
      return { diagnostic: { title: tr("无法导入文档", "Could not import document"), heading: tr("JSON 语法错误", "JSON syntax error"), message: tr("JSON 解析器发现了无法安全恢复的问题。", "The JSON parser found an error it could not recover safely."), text: tr("JSON 语法错误", "JSON syntax error") } };
    }
    const latexIssues = potentialLatexCorruptions(parser, source, raw);
    if (latexIssues.errors.length) {
      const first = latexIssues.errors[0];
      const excerpt = importSourceExcerpt(source, first.offset);
      return { diagnostic: {
        title: tr("导入需要修正", "Import needs a correction"), heading: tr("可能已损坏的 LaTeX", "Possible malformed LaTeX"),
        position: tr("第 " + excerpt.line + " 行，第 " + excerpt.column + " 列", "Line " + excerpt.line + " · Column " + excerpt.column),
        message: tr("JSON 可以解析，但数学命令可能已经被 JSON 转义悄悄改变。为避免丢失公式，Proofnote 没有导入该文档。", "The JSON parses, but a math command may have been silently changed by a JSON escape. Proofnote did not import the document to avoid losing the formula."),
        issues: latexIssues.errors, warnings: latexIssues.warnings, source, offset: first.offset, length: first.length, snippet: excerpt.text,
        help: tr("在原始 JSON 中，每个 LaTeX 反斜杠使用 \\u005c 表示。", "In raw JSON, write every LaTeX backslash as \\u005c."),
        text: [tr("可能已损坏的 LaTeX", "Possible malformed LaTeX"), first.path, first.message].join("\n")
      } };
    }
    return { raw, warnings: duplicateJsonKeyWarnings(parser, source).concat(latexIssues.warnings) };
  }
  function canNavigateImportSource() {
    // Editable HTML is deliberately file-only. Its canonical source is kept
    // hidden and read-only for integrity purposes, so diagnostic controls
    // must not pretend they can focus an editable source field.
    return importMode !== "editable-html" && Boolean(els.importText && !els.importText.hidden);
  }
  function renderImportIssues(report, issues, severity, allowNavigation) {
    if (!issues || !issues.length) return;
    const heading = element("h3", { class: "pn-import-diagnostic-list-title" }, severity === "warning" ? tr("可恢复提示", "Recoverable notices") : tr("需要修正", "Problems to fix"));
    const list = element("ol", { class: "pn-import-diagnostic-list" });
    issues.slice(0, 8).forEach((issue) => {
      const item = allowNavigation && Number.isFinite(issue.offset)
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
    const allowNavigation = canNavigateImportSource();
    if (details.snippet) {
      const snippet = element("pre", allowNavigation
        ? { class: "pn-import-diagnostic-snippet", tabindex: "0", title: tr("点击定位到错误", "Click to locate the problem") }
        : { class: "pn-import-diagnostic-snippet" }, details.snippet);
      if (allowNavigation) {
        snippet.addEventListener("click", () => focusImportOffset(details.offset, details.length));
        snippet.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); focusImportOffset(details.offset, details.length); } });
      }
      report.appendChild(snippet);
    }
    renderImportIssues(report, details.issues, "error", allowNavigation);
    renderImportIssues(report, details.warnings, "warning", allowNavigation);
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
  function editableHtmlProtocolLineage(document) {
    const protocol = root.ProofnoteEditableHtml;
    return protocol && typeof protocol.protocolLineage === "function" ? String(protocol.protocolLineage(document) || "") : "";
  }
  function forkEditableHtmlLineage(document) {
    const protocol = root.ProofnoteEditableHtml;
    if (!protocol || typeof protocol.ensureLineage !== "function") throw new Error("Editable HTML protocol unavailable");
    const copy = JSON.parse(JSON.stringify(document));
    if (copy.compatibility && typeof copy.compatibility === "object") delete copy.compatibility.proofnoteEditable;
    return protocol.ensureLineage(copy).document;
  }
  async function prepareEditableHtmlDocument(candidate, options) {
    const opts = options || {};
    const mode = opts.mode === "replace" ? "replace" : "new";
    const excludedDocumentId = opts.excludedDocumentId;
    if (!candidate || !(candidate.document || candidate.raw)) {
      showImportMessage(tr("请先选择并验证一个 Proofnote 可编辑 HTML 文件。", "Choose and verify a Proofnote editable HTML file first."), "error");
      return null;
    }
    if (mode === "replace" && !editableHtmlCanReplace(candidate)) {
      showImportMessage(tr("该文件不属于当前文档的同一可编辑 HTML 谱系，或当前文档已在导出后更新。为避免覆盖错误文档，只能导入为新文档。", "This file does not belong to the current document’s Editable HTML lineage, or the current document changed after export. To avoid overwriting the wrong document, it can only be imported as a new document."), "error");
      return null;
    }
    let warnings = Array.isArray(candidate.warnings) ? candidate.warnings.slice() : [];
    const sourceDocument = candidate.document || candidate.raw;
    const validation = Model.validateDocumentRaw(sourceDocument);
    if (validation.errors.length) {
      renderSchemaDiagnostics(tr("无法导入可编辑 HTML", "Could not import editable HTML"), validation.errors, warnings.concat(validation.warnings || []));
      return null;
    }
    warnings = warnings.concat(validation.warnings || []);
    // HTML imports never inherit trust from the browser session. In
    // particular, a previously approved remote image URL is imported as an
    // unapproved URL and cannot load without a fresh in-editor consent.
    let next = Model.normalizeDocument(sourceDocument, { allowRemoteImages: false });
    next.blocks.forEach((block) => { if (block && block.type === "image") delete block.remoteApproved; });
    // Import-as-new creates a separate local document. Reusing the same
    // protocol lineage would later make a file exported from either copy look
    // eligible to overwrite the other, so fork identity before persisting it.
    let identityForked = false;
    if (mode === "new" && editableHtmlProtocolLineage(next)) {
      next = forkEditableHtmlLineage(next);
      identityForked = true;
    }
    if (next.metadata.documentType === "Project") {
      const requestedName = String(next.metadata.name || "");
      prepareImportedProjectDocument(next, null, excludedDocumentId);
      if (next.metadata.name !== requestedName) {
        warnings.push({
          path: "metadata.name",
          message: tr("项目名称与现有文档冲突，已添加区分后缀。", "The Project name conflicts with an existing document, so a distinguishing suffix was added.")
        });
      }
    }
    const preparedValidation = Model.validateDocumentRaw(next);
    if (preparedValidation.errors.length) {
      renderSchemaDiagnostics(tr("无法导入可编辑 HTML", "Could not import editable HTML"), preparedValidation.errors, warnings.concat(preparedValidation.warnings || []));
      return null;
    }
    warnings = warnings.concat(preparedValidation.warnings || []);
    const portable = portableDocumentCheck(next);
    if (!portable.valid) {
      renderSchemaDiagnostics(tr("无法导入可编辑 HTML", "Could not import editable HTML"), [{
        path: "",
        message: portable.message
      }], warnings);
      return null;
    }
    const imageSafety = await importedImagesWithinLimit(next);
    if (!imageSafety.valid) {
      renderSchemaDiagnostics(tr("无法导入可编辑 HTML", "Could not import editable HTML"), [{
        path: "blocks[" + imageSafety.index + "].src",
        message: tr("嵌入图片的解码尺寸超过安全上限，或浏览器无法安全读取它。", "The embedded image exceeds the safe decoded-pixel limit or could not be decoded safely.")
      }], warnings);
      return null;
    }
    return { document: next, warnings, identityForked };
  }
  function editableHtmlImportIsCurrent(generation, sourceKey, targetId) {
    return Boolean(
      transitionIsCurrent(generation)
      && importMode === "editable-html"
      && !els.modal.hidden
      && pendingEditableHtml
      && pendingEditableHtml.sourceKey === sourceKey
      && (!targetId || currentDocumentId === targetId)
    );
  }
  async function importEditableHtmlAsNewDocument() {
    if (importMode !== "editable-html" || !pendingEditableHtml) {
      showImportMessage(tr("请先选择并验证一个 Proofnote 可编辑 HTML 文件。", "Choose and verify a Proofnote editable HTML file first."), "error");
      return;
    }
    const sourceKey = pendingEditableHtml.sourceKey;
    return enqueueDocumentTransition(async (generation) => {
      const prepared = await prepareEditableHtmlDocument(pendingEditableHtml, { mode: "new" });
      if (!prepared || !editableHtmlImportIsCurrent(generation, sourceKey)) return;
      if (!confirmImportWarnings(prepared.warnings, tr("导入可编辑 HTML 需要确认", "Editable HTML import needs confirmation"))) return;
      const saved = await saveActiveDocumentNow();
      if (!saveSucceeded(saved)) {
        showImportMessage(tr("当前文档无法保存；请先导出备份。", "The current document could not be saved; export a backup first."), "error");
        return;
      }
      if (!editableHtmlImportIsCurrent(generation, sourceKey)) return;
      setEditableHtmlImportBusy(true);
      setEditableHtmlImportSummary(tr("正在创建新文档；请稍候。", "Creating a new document; please wait."));
      try {
        const created = await Store.createDocument(prepared.document, { makeCurrent: false, projectId: projectCreationContextId() });
        if (!created || !created.record || created.backend === "failed") {
          showImportMessage(tr("可编辑 HTML 无法保存到此设备。", "The editable HTML could not be saved on this device."), "error");
          return;
        }
        if (!editableHtmlImportIsCurrent(generation, sourceKey)) return;
        const finalSaved = await saveActiveDocumentNow();
        if (!saveSucceeded(finalSaved)) {
          showImportMessage(tr("导入期间产生的当前文档编辑无法保存；导入文件已保存为新文档，但尚未打开。请先导出当前文档备份。", "Edits to the current document made during import could not be saved. The imported file was saved as a new document but was not opened. Export the current document first."), "error");
          return;
        }
        if (!editableHtmlImportIsCurrent(generation, sourceKey)) return;
        setEditableHtmlImportBusy(false);
        closeImport({ cancelTransition: false });
        if (!await selectAndActivateDocument(created.record, generation, { status: false })) return;
        const importedAsNew = prepared.identityForked
          ? tr("已从可编辑 HTML 导入为新文档；已建立独立身份，今后不会与来源文档互相覆盖。", "Editable HTML imported as a new document with an independent identity; future exports cannot overwrite the source document.")
          : tr("已从可编辑 HTML 导入为新文档", "Editable HTML imported as a new document");
        setStatus(prepared.warnings.length ? importedAsNew + tr("另有 " + prepared.warnings.length + " 条可恢复提示。", " It also has " + prepared.warnings.length + " recoverable notice(s).") : importedAsNew, prepared.warnings.length ? "warning" : "saved");
      } finally {
        setEditableHtmlImportBusy(false);
      }
    });
  }
  function requestEditableHtmlReplacement() {
    if (importMode !== "editable-html" || !pendingEditableHtml) {
      showImportMessage(tr("请先选择并验证一个 Proofnote 可编辑 HTML 文件。", "Choose and verify a Proofnote editable HTML file first."), "error");
      return;
    }
    if (!editableHtmlCanReplace(pendingEditableHtml)) {
      showImportMessage(tr("该文件只能导入为新文档，不能覆盖当前文档。", "This file can only be imported as a new document and cannot replace the current document."), "error");
      return;
    }
    const sourceKey = pendingEditableHtml.sourceKey;
    return enqueueDocumentTransition(async (generation) => {
      const targetId = currentDocumentId;
      const prepared = await prepareEditableHtmlDocument(pendingEditableHtml, { mode: "replace", excludedDocumentId: targetId });
      if (!prepared || !transitionIsCurrent(generation) || !pendingEditableHtml || pendingEditableHtml.sourceKey !== sourceKey) return;
      if (!confirmImportWarnings(prepared.warnings, tr("覆盖前需要确认可恢复提示", "Recoverable notices need confirmation before replacement"))) return;
      if (!targetId || targetId !== currentDocumentId || !Number.isSafeInteger(documentRevisions.get(targetId))) {
        showImportMessage(tr("当前文档没有可安全替换的本地身份；请先导出备份或重新打开文档。", "The current document has no safely replaceable local identity. Export a backup or reopen the document first."), "error");
        return;
      }
      const currentName = documentName(documents.find((record) => record && record.id === targetId) || { document: state });
      openConfirm({
        title: tr("覆盖当前文档？", "Replace the current document?"),
        message: tr("将用已验证的可编辑 HTML 内容替换“" + currentName + "”。Proofnote 会先在文档库创建一个恢复副本，然后原子地替换当前文档；如果保存、备份或并发校验失败，当前文档不会被修改。", "The verified editable HTML will replace “" + currentName + "”. Proofnote will first create a recovery copy in the document library, then atomically replace the current document. If saving, backup creation, or the concurrent-write check fails, the current document will not be changed."),
        confirmLabel: tr("保存恢复副本并覆盖", "Save recovery copy and replace"),
        onConfirm: () => performEditableHtmlReplacement({ sourceKey, targetId })
      });
    });
  }
  async function performEditableHtmlReplacement(candidate) {
    if (!candidate || !pendingEditableHtml || pendingEditableHtml.sourceKey !== candidate.sourceKey || currentDocumentId !== candidate.targetId) return;
    setEditableHtmlImportBusy(true);
    setEditableHtmlImportSummary(tr("正在创建恢复副本并覆盖当前文档；请稍候。", "Creating a recovery copy and replacing the current document; please wait."));
    let replacementCommitted = false;
    try {
      const outcome = await enqueueDocumentTransition(async (generation) => {
        if (!editableHtmlImportIsCurrent(generation, candidate.sourceKey, candidate.targetId)) return null;
        const saved = await saveActiveDocumentNow();
        if (!saveSucceeded(saved)) {
          showImportMessage(tr("当前文档无法保存；未执行覆盖。请先导出备份。", "The current document could not be saved, so it was not replaced. Export a backup first."), "error");
          return null;
        }
        if (!editableHtmlImportIsCurrent(generation, candidate.sourceKey, candidate.targetId)) return null;
        // Re-read semantic HTML against the document *after* the final flush.
        // A stale file must never become a replacement merely because it was
        // verified before the user continued editing in the confirmation UI.
        const protocol = root.ProofnoteEditableHtml;
        const inspected = protocol && typeof protocol.inspect === "function"
          ? await protocol.inspect(pendingEditableHtml.htmlSource, { currentDocument: state }) : null;
        if (!inspected || inspected.diagnostic) {
          if (inspected && inspected.diagnostic) renderImportDiagnostics(inspected.diagnostic);
          else showImportMessage(tr("可编辑 HTML 协议无法重新验证；未执行覆盖。", "The Editable HTML protocol could not be revalidated, so no replacement was performed."), "error");
          return null;
        }
        const refreshedCandidate = Object.assign({}, pendingEditableHtml, {
          raw: inspected.document || inspected.raw,
          document: inspected.document || inspected.raw,
          baseline: inspected.baseline || null,
          warnings: Array.isArray(inspected.warnings) ? inspected.warnings.map((warning) => typeof warning === "string" ? { path: "", message: warning } : warning).filter(Boolean) : [],
          status: inspected.status || "EXACT",
          changes: inspected.changes || pendingEditableHtml.changes,
          documentId: inspected.documentId || "",
          revisionId: inspected.revisionId || "",
          protocolVersion: String(inspected.envelope && inspected.envelope.version || "2"),
          replacementEligible: inspected.replacementEligible === true
        });
        if (!editableHtmlCanReplace(refreshedCandidate)) {
          showImportMessage(tr("当前文档已在该 HTML 导出后变化，或文件属于其他文档谱系；未执行覆盖。你仍可把它导入为新文档。", "The current document changed after this HTML export, or the file belongs to another document lineage; no replacement was performed. You can still import it as a new document."), "error");
          return null;
        }
        const prepared = await prepareEditableHtmlDocument(refreshedCandidate, { mode: "replace", excludedDocumentId: candidate.targetId });
        if (!prepared || !editableHtmlImportIsCurrent(generation, candidate.sourceKey, candidate.targetId)) return null;
        const expectedRevision = documentRevisions.get(candidate.targetId);
        if (!Number.isSafeInteger(expectedRevision)) {
          showImportMessage(tr("当前文档版本无法安全确认；未执行覆盖。", "The current document revision could not be verified safely, so it was not replaced."), "error");
          return null;
        }
        const refreshed = await refreshDocuments();
        if (!saveSucceeded(refreshed)) {
          showImportMessage(tr("无法确认当前文档库；未执行覆盖。", "Proofnote could not verify the current document library, so no replacement was performed."), "error");
          return null;
        }
        // Refresh can discover a historical duplicate lineage or lose a
        // repair race to another tab. Re-evaluate the complete replacement
        // gate after that refresh, not only before it, so an unresolved
        // collision can never slip through to the destructive CAS below.
        if (!editableHtmlCanReplace(refreshedCandidate)) {
          showImportMessage(tr("Proofnote 发现此可编辑 HTML 谱系仍由多个本地文档共享；为避免跨文档覆盖，未执行覆盖。请导入为新文档，或稍后重新打开文档库后再试。", "Proofnote found that this Editable HTML lineage is still shared by multiple local documents. To avoid a cross-document replacement, no overwrite was performed. Import it as a new document or reopen the library and try again later."), "error");
          return null;
        }
        if (!editableHtmlImportIsCurrent(generation, candidate.sourceKey, candidate.targetId)) return null;
        const currentRecord = documents.find((record) => record && record.id === candidate.targetId);
        const backupName = uniqueLibraryDocumentName(documentName(currentRecord || { document: state }) + tr(" — HTML 导入前恢复副本", " — before HTML import"));
        const backup = await Store.duplicateDocument(candidate.targetId, backupName, {
          makeCurrent: false,
          // The recovery copy is a distinct local document.  It preserves
          // content, but receives its own editable-HTML identity so a future
          // export cannot be mistaken for a replacement of the live record.
          transformDocument: (document) => editableHtmlProtocolLineage(document) ? forkEditableHtmlLineage(document) : document
        });
        if (!backup || !backup.record || backup.backend === "failed") {
          showImportMessage(tr("无法先创建恢复副本；当前文档没有被覆盖。", "Proofnote could not create a recovery copy, so the current document was not replaced."), "error");
          return null;
        }
        if (!editableHtmlImportIsCurrent(generation, candidate.sourceKey, candidate.targetId)) return null;
        const replaced = await Store.replaceDocument(candidate.targetId, prepared.document, expectedRevision, { makeCurrent: true });
        if (!replaced || !replaced.record || !saveSucceeded(replaced.backend)) {
          if (replaced && replaced.backend === "conflict") {
            await refreshDocuments();
            showImportMessage(tr("另一标签页刚刚更新了当前文档；Proofnote 没有覆盖它。恢复副本已保留，请先打开最新版本后重试。", "Another tab just updated the current document, so Proofnote did not overwrite it. The recovery copy was kept; open the latest version and try again."), "error");
          } else {
            showImportMessage(tr("覆盖保存失败；当前文档没有被修改，恢复副本已保留。", "Replacement failed; the current document was not changed and the recovery copy was kept."), "error");
          }
          return null;
        }
        if (!editableHtmlImportIsCurrent(generation, candidate.sourceKey, candidate.targetId)) return null;
        return { generation, expectedRevision, record: replaced.record, warnings: prepared.warnings };
      });
      if (!outcome || !outcome.record || !transitionIsCurrent(outcome.generation)) return;
      replacementCommitted = true;
      documentRevisions.set(candidate.targetId, Number.isSafeInteger(outcome.record.revision) ? outcome.record.revision : outcome.expectedRevision + 1);
      setEditableHtmlImportBusy(false);
      closeImport({ cancelTransition: false });
      await activateDocument(outcome.record, { status: false });
      const warnings = outcome.warnings || [];
      setStatus(warnings.length ? tr("当前文档已由可编辑 HTML 覆盖；恢复副本已创建，且有 " + warnings.length + " 条可恢复提示。", "The current document was replaced from editable HTML; a recovery copy was created, with " + warnings.length + " recoverable notice(s).") : tr("当前文档已由可编辑 HTML 覆盖；恢复副本已创建。", "The current document was replaced from editable HTML; a recovery copy was created."), warnings.length ? "warning" : "saved");
    } catch (_) {
      if (replacementCommitted) {
        setStatus(tr("当前文档已覆盖，但工作区无法立即刷新；请重新打开该文档。", "The current document was replaced, but the workspace could not refresh immediately; reopen the document."), "warning");
      } else {
        showImportMessage(tr("覆盖过程中发生意外错误；当前文档没有被覆盖。", "An unexpected error occurred during replacement; the current document was not replaced."), "error");
      }
    } finally {
      setEditableHtmlImportBusy(false);
    }
  }
  async function importFromDialog() {
    if (importMode === "editable-html") return importEditableHtmlAsNewDocument();
    if (utf8ByteLength(els.importText.value) > MAX_IMPORT_BYTES) {
      showImportMessage(tr("JSON 文本超过 25MB 导入上限。", "JSON text exceeds the 25 MB import limit."), "error");
      return;
    }
    return enqueueDocumentTransition(async (generation) => {
    // An import never replaces the active library record. Only a freshly
    // created Blank Project contributes its display preset to the new record;
    // importing from an established Project must not silently inherit document
    // metadata or otherwise change the imported document's own identity.
    const importProjectContext = !projectLandingIsOpen() && isBlankProjectImportSource() ? projectImportContext() : null;
    const inspected = inspectImportJson(els.importText.value);
    if (inspected.diagnostic) { renderImportDiagnostics(inspected.diagnostic); return; }
    const raw = inspected.raw;
    let next, warnings = inspected.warnings || [];
    let identityForked = false;
    if (importMode === "template" && (!raw || raw.format !== Model.TEMPLATE_FORMAT)) {
      renderSchemaDiagnostics(tr("无法导入模板", "Could not import template"), [{
        path: "format",
        message: tr("这里仅接受 Proofnote 模板文件（proofnote-template）。当前文档没有被修改。", "This action accepts only a Proofnote template (proofnote-template). The current document was not changed.")
      }], warnings);
      return;
    }
    if (raw && raw.format === "solution-note") {
      const legacyValidation = LegacyBoundary.validateSolutionNote(raw);
      if (legacyValidation.errors.length) { renderSchemaDiagnostics(tr("无法导入 Solution Note", "Could not import Solution Note"), legacyValidation.errors, warnings.concat(legacyValidation.warnings || [])); return; }
      warnings = warnings.concat(legacyValidation.warnings || []);
      next = Model.migrateSolutionNote(raw);
      // Legacy validation establishes the old format's shape. The migrated
      // object still has to satisfy every current document resource/render
      // budget before it can reach the editor; otherwise Solution Note would
      // remain a bypass around the modern import boundary.
      const migratedValidation = Model.validateDocumentRaw(next);
      if (migratedValidation.errors.length) {
        renderSchemaDiagnostics(tr("无法导入 Solution Note", "Could not import Solution Note"), migratedValidation.errors, warnings.concat(migratedValidation.warnings || []));
        return;
      }
      warnings = warnings.concat(migratedValidation.warnings || []);
      next = Model.normalizeDocument(next);
    } else if (raw && raw.format === Model.TEMPLATE_FORMAT) {
      const validation = Model.validateTemplateRaw(raw);
      if (validation.errors.length) { renderSchemaDiagnostics(tr("无法导入模板", "Could not import template"), validation.errors, warnings.concat(validation.warnings || [])); return; }
      warnings = warnings.concat(validation.warnings || []);
      if (!confirmImportWarnings(warnings, tr("导入模板需要确认", "Template import needs confirmation"))) return;
      let template = Model.normalizeTemplate(raw);
      // Import is additive. The store uses IndexedDB `add()` rather than a
      // preflight list+put, so another tab cannot slip an overwrite between
      // our duplicate check and the eventual write.
      let imported = await Store.importTemplateIfAbsent(template);
      if (imported === "exists") {
        const importedInfo = { name: template.template.name, description: template.template.description };
        do {
          template = Model.makeTemplate(template.document, importedInfo);
          imported = await Store.importTemplateIfAbsent(template);
        } while (imported === "exists");
        warnings.push({
          path: "template.id",
          message: tr("模板 ID 已存在；已作为新模板导入。", "Template ID already exists; imported as a new template.")
        });
      }
      if (imported !== "added") { showImportMessage(tr("模板无法保存到此设备；请释放存储空间后重试。", "Template could not be saved on this device; free storage and try again."), "error"); return; }
      await refreshTemplates();
      closeImport();
      setStatus(warnings.length ? tr("模板已保存；有 " + warnings.length + " 条可恢复提示。", "Template saved with " + warnings.length + " recoverable notice(s).") : tr("模板已保存到此设备。", "Template saved on this device."), warnings.length ? "warning" : "saved");
      return;
    } else {
      const validation = Model.validateDocumentRaw(raw);
      if (validation.errors.length) { renderSchemaDiagnostics(tr("无法导入文档", "Could not import document"), validation.errors, warnings.concat(validation.warnings || [])); return; }
      warnings = warnings.concat(validation.warnings || []);
      next = Model.normalizeDocument(raw);
    }
    const saved = await saveActiveDocumentNow();
    if (!saveSucceeded(saved)) { showImportMessage(tr("当前文档无法保存；请先导出备份。", "The current document could not be saved; export a backup first."), "error"); return; }
    // A portable JSON backup can contain the v2 replacement lineage too.
    // JSON's "import as new" path must have the same isolation guarantee as
    // editable HTML: it creates a distinct local document, never another
    // handle that can later replace the source record.
    if (editableHtmlProtocolLineage(next)) {
      next = forkEditableHtmlLineage(next);
      identityForked = true;
    }
    if (importProjectContext) {
      next.metadata.documentType = "Project";
      prepareImportedProjectDocument(next, importProjectContext);
    } else if (next.metadata.documentType === "Project") {
      prepareImportedProjectDocument(next, null);
    }
    // Project chrome may add a missing title. Revalidate its final shape
    // before normalisation/storage, otherwise a valid 2,000-block source can
    // become 2,001 blocks and lose its tail in a later safe clone.
    const preparedValidation = Model.validateDocumentRaw(next);
    if (preparedValidation.errors.length) {
      renderSchemaDiagnostics(tr("无法导入文档", "Could not import document"), preparedValidation.errors, warnings.concat(preparedValidation.warnings || []));
      return;
    }
    warnings = warnings.concat(preparedValidation.warnings || []);
    if (!portableDocumentWithinLimit(next)) {
      renderSchemaDiagnostics(tr("无法导入文档", "Could not import document"), [{
        path: "",
        message: tr("该文档格式化为可移植 Proofnote 备份后会超过 25MB，无法保证以后重新导入。", "This document would exceed 25 MB after portable Proofnote serialization and could not be safely re-imported later.")
      }], warnings);
      return;
    }
    const imageSafety = await importedImagesWithinLimit(next);
    if (!imageSafety.valid) {
      renderSchemaDiagnostics(tr("无法导入文档", "Could not import document"), [{
        path: "blocks[" + imageSafety.index + "].src",
        message: tr("嵌入图片的解码尺寸超过安全上限，或浏览器无法安全读取它。", "The embedded image exceeds the safe decoded-pixel limit or could not be decoded safely.")
      }], warnings);
      return;
    }
    if (!confirmImportWarnings(warnings, tr("导入文档需要确认", "Document import needs confirmation"))) return;
    if (!transitionIsCurrent(generation)) return;
    const created = await Store.createDocument(next, { makeCurrent: false, projectId: projectCreationContextId() });
    if (!created || !created.record || created.backend === "failed") { showImportMessage(tr("导入文档无法保存到此设备。", "The imported document could not be saved on this device."), "error"); return; }
    const finalSaved = await saveActiveDocumentNow();
    if (!saveSucceeded(finalSaved)) { showImportMessage(tr("导入期间产生的当前文档编辑无法保存；导入文件已保存为新文档，但尚未打开。请先导出当前文档备份。", "Edits to the current document made during import could not be saved. The imported file was saved as a new document but was not opened. Export the current document first."), "error"); return; }
    if (!transitionIsCurrent(generation)) return;
    closeImport({ cancelTransition: false });
    if (!await selectAndActivateDocument(created.record, generation, { status: false })) return;
    const importedAsNew = identityForked
      ? tr("已导入为新文档；已建立独立身份，今后不会与来源文档互相覆盖。", "Imported as a new document with an independent identity; future exports cannot overwrite the source document.")
      : tr("已导入为新文档", "Imported as a new document");
    setStatus(warnings.length ? importedAsNew + tr("另有 " + warnings.length + " 条可恢复提示。", " It also has " + warnings.length + " recoverable notice(s).") : importedAsNew, warnings.length ? "warning" : "saved");
    });
  }
  async function initialise() {
    mount();
    applySidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    collapsedOutlineIds = new Set();
    try { setUtilityOpen(root.localStorage.getItem("proofnote-document:utility-open") === "1"); } catch (_) { setUtilityOpen(false); }
    setDetailOpen(false);
    try { setSidebarTab(root.localStorage.getItem("proofnote-document:sidebar-tab") || "outline"); } catch (_) { setSidebarTab("outline"); }
    const proofTemplate = Model.builtInTemplates().find((template) => template.template.id === "proof-note");
    const defaultSeed = () => Model.normalizeDocument(proofTemplate.document);
    let startupLegacyWarning = "";
    // Do not parse or migrate the retired one-document store until the modern
    // library has proved it needs a seed. Existing libraries must never pay
    // for, or be influenced by, optional legacy state.
    const seed = () => {
      let legacy = null;
      try { legacy = JSON.parse(root.localStorage.getItem("solution-note-generator:v1") || "null"); }
      catch (_) { startupLegacyWarning = tr("旧版 Solution Note 无法读取；已创建新的 Proofnote 文档。", "The legacy Solution Note could not be read; a new Proofnote document was created."); return defaultSeed(); }
      if (!legacy) return defaultSeed();
      const validation = LegacyBoundary.validateSolutionNote(legacy);
      if (validation.errors.length) {
        startupLegacyWarning = tr("旧版 Solution Note 未通过安全检查；已创建新的 Proofnote 文档。", "The legacy Solution Note did not pass the safety check; a new Proofnote document was created.");
        return defaultSeed();
      }
      return Model.normalizeDocument(Model.migrateSolutionNote(legacy));
    };
    const library = await Store.initialiseDocumentLibrary(seed);
    persistenceAvailable = Boolean(library && library.record && library.backend !== "failed");
    currentDocumentId = library && library.record ? library.record.id : "";
    if (library && library.record) documentRevisions.set(library.record.id, Number.isSafeInteger(library.record.revision) ? library.record.revision : 0);
    restoreOutlineCollapseState(currentDocumentId, true);
    state = library && library.record && library.record.document
      ? Model.normalizeDocument(library.record.document, { allowRemoteImages: true })
      : seed();
    hasUnsavedChanges = false;
    const libraryBackend = await refreshDocuments();
    // Templates are secondary to the document library. Initialise the library
    // first so a transient template read can never determine a fresh session's
    // storage backend or hide the author's document records.
    await refreshTemplates();
    renderAll();
    if (!persistenceAvailable || libraryBackend === "failed") {
      persistenceAvailable = false;
      setStatus(tr("本地存储不可用；当前内容尚未保存。请先导出备份。", "Local storage is unavailable; this document is not saved. Export a backup first."), "error");
      return;
    }
    const lineageRepairNotice = editableHtmlLineageRepairNotice;
    editableHtmlLineageRepairNotice = null;
    if (startupLegacyWarning) setStatus(startupLegacyWarning, "warning");
    else if (lineageRepairNotice && lineageRepairNotice.repaired) {
      const suffix = lineageRepairNotice.unresolved
        ? tr("；仍有 " + lineageRepairNotice.unresolved + " 个冲突副本暂时禁止覆盖。", "; " + lineageRepairNotice.unresolved + " shared copy/copies remain protected from replacement for now.")
        : "";
      setStatus(tr("Proofnote 已为 " + lineageRepairNotice.repaired + " 个旧文档副本建立独立的可编辑 HTML 身份，防止跨文档覆盖。", "Proofnote gave " + lineageRepairNotice.repaired + " legacy document copy/copies an independent Editable HTML identity to prevent cross-document replacement.") + suffix, "warning");
    } else if (lineageRepairNotice && lineageRepairNotice.unresolved) {
      setStatus(tr("Proofnote 发现旧文档共享可编辑 HTML 身份；为避免跨文档覆盖，相关文档暂时禁止覆盖。请稍后重新打开文档库。", "Proofnote found legacy documents sharing an Editable HTML identity. To avoid cross-document replacement, affected documents are temporarily protected from replacement; reopen the library later."), "warning");
    }
    else setPersistenceStatus(library.backend === "localStorage" ? tr("已保存（本地存储）", "Saved locally") : tr("已保存到此设备", "Saved on this device"));
  }
  initialise().catch((error) => { console.error("Proofnote Document editor could not start", error); });
})(window, document);
