/*
 * Proofnote Editable HTML v2
 *
 * This is a deliberately narrow interchange protocol, not a general-purpose
 * HTML importer.  A v2 file contains two separate representations:
 *
 *   1. an immutable, integrity-checked baseline Proofnote document; and
 *   2. a semantic HTML projection with stable `data-pn-*` relationships.
 *
 * The baseline makes an untouched export exact.  When the page itself has
 * changed, the semantic projection is reconciled back into Proofnote blocks.
 * CSS, classes, layout wrappers, and rendered KaTeX are deliberately derived
 * output: they are never part of the document protocol and are discarded on
 * the next export.  Conversely, an ambiguous block/field relationship is an
 * error; this module never guesses which visible HTML should win.
 *
 * Public API (loaded after document-model.js and document-renderer.js):
 *
 *   await ProofnoteEditableHtml.build(document, options)
 *   await ProofnoteEditableHtml.inspect(html, { currentDocument })
 *   ProofnoteEditableHtml.reconcile(domDocument, baselineDocument)
 *   ProofnoteEditableHtml.ensureLineage(document)
 *   await ProofnoteEditableHtml.revisionIdForDocument(document)
 *
 * `build()` accepts optional `{ css, title, language, codeHtml, notice }`.
 * It works with no options so the protocol can be unit-tested independently
 * from the editor presentation layer.
 */
(function (root) {
  "use strict";

  const Model = root.ProofnoteDocument;
  const Renderer = root.ProofnoteRenderer;
  const FORMAT = "proofnote-editable-html";
  const VERSION = "2";
  const MAGIC = "proofnote-editable-html-v2";
  const SOURCE_ID = "proofnote-editable-source";
  const SOURCE_TYPE = "application/vnd.proofnote.editable-html+json";
  const HASH_PLACEHOLDER = "0".repeat(64);
  const MAX_HTML_BYTES = 64 * 1024 * 1024;
  const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
  const MAX_PROTOCOL_NODES = 50000;
  const MAX_PROTOCOL_DEPTH = 96;
  // Rendered previews are deliberately outside the semantic protocol. A
  // sufficiently elaborate KaTeX expression can legitimately render many
  // more DOM nodes than its source field, so count those nodes separately.
  // The independent cap still prevents a presentation-only payload from
  // turning import into unbounded DOM work.
  const MAX_DERIVED_PREVIEW_NODES = 250000;
  const MAX_DERIVED_PREVIEW_DEPTH = 256;
  const MAX_METADATA_TEMPLATE_BYTES = 1024 * 1024;
  const MAX_METADATA_JSON_DEPTH = 64;
  const MAX_METADATA_JSON_KEYS = 10000;
  const LINEAGE_KEY = "proofnoteEditable";
  const LINEAGE_ID_PATTERN = /^pn_doc_[A-Za-z0-9_-]{16,128}$/;
  const EXTERNAL_ID_PATTERN = /^ext_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

  const BLOCK_TYPES = new Set(Model && Model.BLOCK_TYPES || []);
  const SEMANTIC_KINDS = new Set(Model && Model.SEMANTIC_KINDS || []);
  const CALLOUT_KINDS = new Set(Model && Model.CALLOUT_KINDS || []);
  const BLOCK_FIELDS = Object.freeze({
    title: ["content"], subtitle: ["content"], heading: ["content"],
    paragraph: ["content"], equation: ["content"], code: ["content"],
    image: ["src", "alt", "caption"], quote: ["content", "citation"],
    divider: [], "page-break": [], callout: ["title", "content"],
    semantic: ["title", "label", "content", "summary"], list: [],
    table: [], "key-value": [], stats: []
  });
  const ALLOWED_DATA_ATTRIBUTES = new Set([
    "data-pn-document", "data-pn-blocks", "data-pn-metadata",
    "data-pn-block-id", "data-pn-type", "data-pn-field", "data-pn-format",
    "data-pn-metadata-fields", "data-pn-meta-field",
    "data-pn-level", "data-pn-language", "data-pn-header", "data-pn-kind",
    "data-pn-appearance", "data-pn-body-visible", "data-pn-ordered",
    "data-pn-table-columns", "data-pn-table-rows", "data-pn-column",
    "data-pn-row", "data-pn-cell", "data-pn-items", "data-pn-item",
    "data-pn-item-field", "data-pn-paragraph", "data-pn-token",
    "data-pn-href", "data-pn-math-mode", "data-pn-latex", "data-pn-rendered"
  ]);
  const FORBIDDEN_ELEMENTS = new Set([
    "base", "iframe", "frame", "frameset", "object", "embed", "applet",
    "portal", "form", "input", "button", "select", "textarea",
    "audio", "video", "source", "track"
  ]);
  // These are layout-only containers when they carry no protocol field of
  // their own. Allowing them means an external editor can add or remove
  // wrappers for layout without changing semantic text.
  const RICH_TRANSPARENT_ELEMENTS = new Set(["span", "div", "section", "article", "figure", "main", "header", "footer", "aside", "nav"]);
  const RICH_SEMANTIC_ELEMENTS = new Set(["strong", "b", "em", "i", "code", "a", "sub", "sup", "br", "p"]);
  const VISIBLE_METADATA_FIELDS = Object.freeze(["name", "author", "date", "status", "source", "language", "noteNumber"]);
  // These values express local/session trust, not portable document meaning.
  // They must not affect an editable-export revision: build() intentionally
  // strips them, and an otherwise untouched editor document must therefore
  // remain eligible to replace itself after export.
  const SESSION_ONLY_BLOCK_FIELDS = Object.freeze({ image: ["remoteApproved"] });
  // These timestamps are maintained by the document store. They remain in
  // the baseline for normal exports, but an external HTML editor must not be
  // able to rewrite document history through the editable metadata template.
  const SYSTEM_METADATA_FIELDS = Object.freeze(["createdAt", "updatedAt"]);

  function fail(code, message, help, extra) {
    return Object.assign({ code, title: "Proofnote Editable HTML", message, help: help || "" }, extra || {});
  }
  function invalid(code, message, help, extra) {
    return { status: "INVALID", diagnostic: fail(code, message, help, extra), replacementEligible: false };
  }
  function string(value) { return typeof value === "string" ? value : ""; }
  function hasOwn(object, key) { return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key); }
  function escapeHtml(value) {
    return Renderer && typeof Renderer.escapeHtml === "function"
      ? Renderer.escapeHtml(value)
      : string(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function utf8ByteLength(value) {
    if (typeof root.TextEncoder === "function") return new root.TextEncoder().encode(String(value || "")).length;
    return unescape(encodeURIComponent(String(value || ""))).length;
  }
  function scriptEscape(value) {
    return String(value || "")
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }
  // Template text is parsed as HTML, unlike the inert JSON source script.
  // HTML escaping keeps a closing template tag from terminating the field
  // while DOM textContent restores the exact canonical string on import.
  function templateEscape(value) { return escapeHtml(value); }
  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function stableStringify(value) {
    const seen = new WeakSet();
    const visit = (item) => {
      if (item === null || typeof item !== "object") return JSON.stringify(item);
      if (seen.has(item)) throw new TypeError("Cyclic value is not a portable Proofnote document.");
      seen.add(item);
      let source;
      if (Array.isArray(item)) source = "[" + item.map(visit).join(",") + "]";
      else source = "{" + Object.keys(item).sort().map((key) => JSON.stringify(key) + ":" + visit(item[key])).join(",") + "}";
      seen.delete(item);
      return source;
    };
    return visit(value);
  }
  async function sha256Hex(value) {
    const crypto = root.crypto;
    if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== "function" || typeof root.TextEncoder !== "function") return "";
    const digest = await crypto.subtle.digest("SHA-256", new root.TextEncoder().encode(String(value || "")));
    return Array.from(new Uint8Array(digest)).map((part) => part.toString(16).padStart(2, "0")).join("");
  }
  function randomDocumentId() {
    const crypto = root.crypto;
    if (crypto && typeof crypto.randomUUID === "function") return "pn_doc_" + crypto.randomUUID().replace(/-/g, "");
    if (crypto && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return "pn_doc_" + Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return "pn_doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 18);
  }
  function protocolLineage(document) {
    const compatibility = document && document.compatibility;
    const line = compatibility && compatibility[LINEAGE_KEY];
    return line && typeof line === "object" && LINEAGE_ID_PATTERN.test(string(line.documentId)) ? string(line.documentId) : "";
  }
  function normalizePortable(document) {
    if (!Model || typeof Model.normalizeDocument !== "function") throw new Error("ProofnoteDocument is required before editable-html-protocol.js.");
    const validation = Model.validateDocumentRaw ? Model.validateDocumentRaw(document) : { errors: [] };
    if (validation && validation.errors && validation.errors.length) {
      const first = validation.errors[0];
      throw new Error((first.path ? first.path + ": " : "") + first.message);
    }
    const normalized = Model.normalizeDocument(document, { allowRemoteImages: false });
    stripSessionOnlyBlockFields(normalized);
    return normalized;
  }
  function stripSessionOnlyBlockFields(document) {
    if (!document || !Array.isArray(document.blocks)) return document;
    document.blocks.forEach((block) => {
      if (!block || typeof block !== "object") return;
      const fields = SESSION_ONLY_BLOCK_FIELDS[block.type];
      if (fields) fields.forEach((field) => { delete block[field]; });
    });
    return document;
  }
  function ensureLineage(document, requestedId) {
    const normalized = normalizePortable(document);
    const existing = protocolLineage(normalized);
    const documentId = LINEAGE_ID_PATTERN.test(string(requestedId)) ? string(requestedId) : (existing || randomDocumentId());
    const compatibility = normalized.compatibility && typeof normalized.compatibility === "object" && !Array.isArray(normalized.compatibility)
      ? cloneJson(normalized.compatibility) : {};
    compatibility[LINEAGE_KEY] = { documentId };
    normalized.compatibility = compatibility;
    return { document: normalized, documentId };
  }
  function semanticRevisionProjection(document) {
    const copied = cloneJson(document);
    if (copied.metadata) {
      delete copied.metadata.createdAt;
      delete copied.metadata.updatedAt;
    }
    if (copied.compatibility && copied.compatibility[LINEAGE_KEY]) {
      const line = copied.compatibility[LINEAGE_KEY];
      copied.compatibility[LINEAGE_KEY] = { documentId: string(line && line.documentId) };
    }
    return stripSessionOnlyBlockFields(copied);
  }
  async function revisionIdForDocument(document) {
    const digest = await sha256Hex(stableStringify(semanticRevisionProjection(document)));
    return digest ? "rev_" + digest : "";
  }
  function titleForDocument(document, fallback) {
    const title = (document.blocks || []).find((block) => block && block.type === "title");
    return string(fallback || (title && title.content) || document.metadata && document.metadata.name || "Proofnote document").replace(/<[^>]*>/g, "").trim() || "Proofnote document";
  }
  function languageForDocument(document, fallback) {
    return string(fallback || document.metadata && document.metadata.language || "").trim();
  }
  function boolAttribute(value) { return value ? "true" : "false"; }
  function parseBoolean(value, path) {
    if (value === "true") return true;
    if (value === "false") return false;
    throw fail("invalid-boolean", path + " must be exactly true or false.");
  }
  function attr(value) { return escapeHtml(String(value == null ? "" : value)); }

  // JSON.parse intentionally accepts duplicate object keys with a last-write
  // wins result. That is unsuitable for the editable metadata template: an
  // external change must have one unambiguous semantic meaning. This small,
  // strict scanner runs before JSON.parse and only exists to detect duplicate
  // decoded keys (including escaped spellings such as "a" / "\\u0061").
  // JSON.parse remains the authoritative syntax/value validator afterwards.
  function duplicateJsonObjectKey(source) {
    const text = String(source || "");
    if (utf8ByteLength(text) > MAX_METADATA_TEMPLATE_BYTES) {
      throw fail("metadata-too-large", "The structured Proofnote metadata template exceeds the 1 MB safety limit.");
    }
    let index = 0;
    let keyCount = 0;
    let duplicate = "";
    const whitespace = () => { while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1; };
    const expect = (value) => {
      whitespace();
      if (text[index] !== value) return false;
      index += 1;
      return true;
    };
    const readString = () => {
      whitespace();
      if (text[index] !== "\"") return null;
      const start = index;
      index += 1;
      while (index < text.length) {
        const character = text[index++];
        if (character === "\"") {
          try { return JSON.parse(text.slice(start, index)); }
          catch (_) { return null; }
        }
        if (character === "\\") {
          if (index >= text.length) return null;
          const escape = text[index++];
          if (escape === "u") {
            if (index + 4 > text.length) return null;
            index += 4;
          }
        } else if (character < " ") {
          return null;
        }
      }
      return null;
    };
    const readPrimitive = () => {
      whitespace();
      const start = index;
      while (index < text.length && !/[\t\n\r ,\]\}:]/.test(text[index])) index += 1;
      if (start === index) return false;
      try { JSON.parse(text.slice(start, index)); return true; }
      catch (_) { return false; }
    };
    const readValue = (depth) => {
      if (depth > MAX_METADATA_JSON_DEPTH) {
        throw fail("metadata-too-deep", "The structured Proofnote metadata template is nested too deeply.");
      }
      whitespace();
      const character = text[index];
      if (character === "{") return readObject(depth + 1);
      if (character === "[") return readArray(depth + 1);
      if (character === "\"") return readString() !== null;
      return readPrimitive();
    };
    const readObject = (depth) => {
      if (!expect("{")) return false;
      const keys = new Set();
      whitespace();
      if (text[index] === "}") { index += 1; return true; }
      while (index < text.length) {
        const key = readString();
        if (key === null || !expect(":")) return false;
        keyCount += 1;
        if (keyCount > MAX_METADATA_JSON_KEYS) {
          throw fail("metadata-too-complex", "The structured Proofnote metadata template contains too many object keys.");
        }
        if (keys.has(key)) { duplicate = key; return false; }
        keys.add(key);
        if (!readValue(depth)) return false;
        whitespace();
        if (text[index] === "}") { index += 1; return true; }
        if (text[index] !== ",") return false;
        index += 1;
      }
      return false;
    };
    const readArray = (depth) => {
      if (!expect("[")) return false;
      whitespace();
      if (text[index] === "]") { index += 1; return true; }
      while (index < text.length) {
        if (!readValue(depth)) return false;
        whitespace();
        if (text[index] === "]") { index += 1; return true; }
        if (text[index] !== ",") return false;
        index += 1;
      }
      return false;
    };
    const valid = readValue(0);
    whitespace();
    return valid && index === text.length ? duplicate : duplicate || "";
  }

  /* ---------------------------------------------------------------------- */
  /* Reversible, constrained inline grammar                                */
  /* ---------------------------------------------------------------------- */

  function mergeText(nodes) {
    const merged = [];
    (nodes || []).forEach((node) => {
      if (!node) return;
      if (node.type === "text" && !node.value) return;
      const previous = merged[merged.length - 1];
      if (node.type === "text" && previous && previous.type === "text") previous.value += node.value;
      else merged.push(node);
    });
    return merged;
  }
  function between(source, start, open, close) {
    if (!source.startsWith(open, start)) return null;
    const end = source.indexOf(close, start + open.length);
    return end < 0 ? null : { value: source.slice(start + open.length, end), end: end + close.length };
  }
  function richAstFromSource(value) {
    const source = string(value);
    const nodes = [];
    let text = "";
    const flush = () => { if (text) { nodes.push({ type: "text", value: text }); text = ""; } };
    let index = 0;
    while (index < source.length) {
      let match;
      if ((match = between(source, index, "\\[", "\\]"))) {
        flush(); nodes.push({ type: "math", mode: "display", value: match.value }); index = match.end; continue;
      }
      if ((match = between(source, index, "\\(", "\\)"))) {
        flush(); nodes.push({ type: "math", mode: "inline", value: match.value }); index = match.end; continue;
      }
      if (source[index] === "`") {
        const end = source.indexOf("`", index + 1);
        if (end >= 0 && source.slice(index + 1, end).indexOf("\n") < 0) {
          flush(); nodes.push({ type: "code", value: source.slice(index + 1, end) }); index = end + 1; continue;
        }
      }
      if (source.startsWith("**", index)) {
        const end = source.indexOf("**", index + 2);
        if (end >= 0) {
          flush(); nodes.push({ type: "strong", children: richAstFromSource(source.slice(index + 2, end)) }); index = end + 2; continue;
        }
      }
      if (source[index] === "*") {
        const end = source.indexOf("*", index + 1);
        if (end >= 0) {
          flush(); nodes.push({ type: "em", children: richAstFromSource(source.slice(index + 1, end)) }); index = end + 1; continue;
        }
      }
      if (source[index] === "[") {
        const closeLabel = source.indexOf("](", index + 1);
        if (closeLabel >= 0) {
          const closeHref = source.indexOf(")", closeLabel + 2);
          if (closeHref >= 0) {
            flush(); nodes.push({ type: "link", href: source.slice(closeLabel + 2, closeHref), children: richAstFromSource(source.slice(index + 1, closeLabel)) }); index = closeHref + 1; continue;
          }
        }
      }
      if (source.startsWith("_{", index) || source.startsWith("^{", index)) {
        const kind = source[index] === "_" ? "sub" : "sup";
        const end = source.indexOf("}", index + 2);
        if (end >= 0) {
          flush(); nodes.push({ type: kind, children: richAstFromSource(source.slice(index + 2, end)) }); index = end + 1; continue;
        }
      }
      text += source[index]; index += 1;
    }
    flush();
    return mergeText(nodes);
  }
  function richAstToSource(nodes) {
    return (nodes || []).map((node) => {
      switch (node.type) {
        case "text": return string(node.value);
        case "code": return "`" + string(node.value) + "`";
        case "math": return node.mode === "display" ? "\\[" + string(node.value) + "\\]" : "\\(" + string(node.value) + "\\)";
        case "strong": return "**" + richAstToSource(node.children) + "**";
        case "em": return "*" + richAstToSource(node.children) + "*";
        case "link": return "[" + richAstToSource(node.children) + "](" + string(node.href) + ")";
        case "sub": return "_{" + richAstToSource(node.children) + "}";
        case "sup": return "^{" + richAstToSource(node.children) + "}";
        default: throw fail("unsupported-inline-token", "Unsupported Proofnote inline token.");
      }
    }).join("");
  }
  function renderRichAst(nodes, options) {
    const renderMath = options && options.math || ((value, display) => Renderer && Renderer.math ? Renderer.math(value, display) : escapeHtml(value));
    return (nodes || []).map((node) => {
      switch (node.type) {
        case "text": return "<span data-pn-token=\"text\">" + escapeHtml(node.value) + "</span>";
        case "code": return "<code data-pn-token=\"code\">" + escapeHtml(node.value) + "</code>";
        case "math": return "<span data-pn-token=\"math\" data-pn-math-mode=\"" + node.mode + "\"><template data-pn-latex>" + templateEscape(node.value) + "</template><span data-pn-rendered>" + renderMath(node.value, node.mode === "display") + "</span></span>";
        case "strong": return "<strong data-pn-token=\"strong\">" + renderRichAst(node.children, options) + "</strong>";
        case "em": return "<em data-pn-token=\"em\">" + renderRichAst(node.children, options) + "</em>";
        case "link": {
          const href = string(node.href);
          const safe = Renderer && Renderer.safeHref ? Renderer.safeHref(href) : (/^(https?:|mailto:)/i.test(href) ? href : "#");
          return "<a data-pn-token=\"link\" data-pn-href=\"" + attr(href) + "\" href=\"" + attr(safe) + "\">" + renderRichAst(node.children, options) + "</a>";
        }
        case "sub": return "<sub data-pn-token=\"sub\">" + renderRichAst(node.children, options) + "</sub>";
        case "sup": return "<sup data-pn-token=\"sup\">" + renderRichAst(node.children, options) + "</sup>";
        default: return "";
      }
    }).join("");
  }
  function renderRichValue(value, options) { return renderRichAst(richAstFromSource(value), options); }
  function ownedDescendants(node, selector) {
    return Array.from(node.querySelectorAll(selector)).filter((candidate) => {
      let current = candidate.parentElement;
      while (current && current !== node) {
        if (current.hasAttribute && current.hasAttribute("data-pn-block-id")) return false;
        current = current.parentElement;
      }
      return true;
    });
  }
  function singleOwned(node, selector, code, message) {
    const matches = ownedDescendants(node, selector);
    if (matches.length !== 1) throw fail(code || "ambiguous-field", message || "A Proofnote field must appear exactly once.");
    return matches[0];
  }
  function textOnlyTemplateContent(template, code, message) {
    const content = template && (template.content || template);
    if (!content || Array.from(content.childNodes || []).some((node) => node.nodeType !== 3)) {
      throw fail(code || "invalid-template-content", message || "A Proofnote source template must contain plain text only.");
    }
    return content.textContent || "";
  }
  function childNodesToRichAst(node) {
    const output = [];
    const visit = (child) => {
      if (child.nodeType === 3) { output.push({ type: "text", value: child.nodeValue || "" }); return; }
      if (child.nodeType !== 1) return;
      const tag = child.tagName.toLowerCase();
      if (child.hasAttribute("data-pn-rendered")) return;
      if (child.hasAttribute("data-pn-block-id") || child.hasAttribute("data-pn-field")) throw fail("cross-block-field", "A field cannot contain another Proofnote block or field.");
      if (tag === "template") throw fail("unexpected-template", "A raw Proofnote template appeared outside its required semantic field.");
      if (tag === "span" && child.getAttribute("data-pn-token") === "math") {
        const mode = child.getAttribute("data-pn-math-mode");
        if (mode !== "inline" && mode !== "display") throw fail("invalid-math-mode", "A Proofnote math token has an invalid display mode.");
        const latexMarkers = ownedDescendants(child, "[data-pn-latex]");
        if (latexMarkers.length !== 1 || latexMarkers[0].tagName.toLowerCase() !== "template") {
          throw fail("ambiguous-latex", "A Proofnote math token must contain exactly one LaTeX source template.");
        }
        const latex = latexMarkers[0];
        output.push({ type: "math", mode, value: textOnlyTemplateContent(latex, "invalid-latex-source", "A Proofnote LaTeX source template must contain plain text only.") });
        return;
      }
      if (tag === "span" && child.hasAttribute("data-pn-token") && child.getAttribute("data-pn-token") !== "text") throw fail("invalid-inline-token", "An inline Proofnote token is invalid or unsupported.");
      if (RICH_TRANSPARENT_ELEMENTS.has(tag)) {
        Array.from(child.childNodes).forEach(visit); return;
      }
      if (tag === "br") { output.push({ type: "text", value: "\n" }); return; }
      if (!RICH_SEMANTIC_ELEMENTS.has(tag)) throw fail("unsupported-rich-markup", "A content field contains unsupported semantic HTML (" + tag + ").");
      if (tag === "p") { Array.from(child.childNodes).forEach(visit); return; }
      if (tag === "code") { output.push({ type: "code", value: child.textContent || "" }); return; }
      if (tag === "strong" || tag === "b") { output.push({ type: "strong", children: childNodesToRichAst(child) }); return; }
      if (tag === "em" || tag === "i") { output.push({ type: "em", children: childNodesToRichAst(child) }); return; }
      if (tag === "sub" || tag === "sup") { output.push({ type: tag, children: childNodesToRichAst(child) }); return; }
      if (tag === "a") {
        const href = child.hasAttribute("data-pn-href") ? child.getAttribute("data-pn-href") : child.getAttribute("href");
        if (href == null || /^\s*(?:javascript:|data:)/i.test(href)) throw fail("unsafe-link", "A Proofnote link must not use a script or data URL.");
        output.push({ type: "link", href: String(href), children: childNodesToRichAst(child) }); return;
      }
      throw fail("unsupported-rich-markup", "A content field contains unsupported semantic HTML.");
    };
    Array.from(node.childNodes).forEach(visit);
    return mergeText(output);
  }
  function astEquivalent(left, right) { return stableStringify(left) === stableStringify(right); }
  function richFieldValue(field, baselineValue) {
    const observed = childNodesToRichAst(field);
    const baseline = richAstFromSource(baselineValue);
    return astEquivalent(observed, baseline) ? string(baselineValue) : richAstToSource(observed);
  }
  function richFieldObservation(field, baselineValue) {
    const observed = childNodesToRichAst(field);
    const baseline = richAstFromSource(baselineValue);
    return {
      changed: !astEquivalent(observed, baseline),
      value: astEquivalent(observed, baseline) ? string(baselineValue) : richAstToSource(observed),
      ast: observed
    };
  }
  // A marked structural host is allowed to gain harmless layout wrappers, but
  // it may not gain unmarked text or structural elements that the parser
  // would otherwise skip. That makes browser HTML repair and AI rewrites
  // fail closed instead of silently losing content.
  function validateMarkedHost(host, markerSelector, wrapperElements, code, message) {
    const visit = (parent) => {
      Array.from(parent.childNodes || []).forEach((child) => {
        if (child.nodeType === 3) {
          if (/\S/.test(child.nodeValue || "")) throw fail(code, message);
          return;
        }
        if (child.nodeType !== 1) return;
        if (child.matches && child.matches(markerSelector)) return;
        const hasProtocolAttribute = Array.from(child.attributes || []).some((attribute) => attribute.name.toLowerCase().startsWith("data-pn-"));
        if (hasProtocolAttribute || !wrapperElements.has(child.tagName.toLowerCase())) throw fail(code, message);
        visit(child);
      });
    };
    visit(host);
  }
  function richParagraphValue(field, baselineValue) {
    const paragraphs = ownedDescendants(field, "p[data-pn-paragraph]");
    if (!paragraphs.length) throw fail("missing-paragraph", "A paragraph field must contain at least one uniquely marked paragraph.");
    validateMarkedHost(field, "p[data-pn-paragraph]", RICH_TRANSPARENT_ELEMENTS, "orphan-paragraph-content", "A rich paragraphs field contains unmarked content outside its explicit paragraph boundaries.");
    const observed = paragraphs.map(childNodesToRichAst);
    const baselineParts = string(baselineValue).split(/\n\s*\n/).map(richAstFromSource);
    if (observed.length === baselineParts.length && observed.every((part, index) => astEquivalent(part, baselineParts[index]))) return string(baselineValue);
    return observed.map(richAstToSource).join("\n\n");
  }

  /* ---------------------------------------------------------------------- */
  /* Semantic HTML renderer                                                 */
  /* ---------------------------------------------------------------------- */

  function rawTemplate(field, value, format) {
    return "<template data-pn-field=\"" + attr(field) + "\"" + (format ? " data-pn-format=\"" + attr(format) + "\"" : "") + ">" + templateEscape(value) + "</template>";
  }
  function paragraphField(value, options) {
    const parts = string(value).split(/\n\s*\n/);
    return "<div data-pn-field=\"content\" data-pn-format=\"paragraphs\">" + parts.map((part) => "<p data-pn-paragraph>" + renderRichValue(part, options) + "</p>").join("") + "</div>";
  }
  function blockShell(block, additional, body) {
    return "<section data-pn-block-id=\"" + attr(block.id) + "\" data-pn-type=\"" + attr(block.type) + "\"" + (additional || "") + ">" + body + "</section>";
  }
  function renderEditableBlock(block, options) {
    switch (block.type) {
      case "title": return blockShell(block, "", "<header class=\"pn-document-title\"><h1 data-pn-field=\"content\">" + renderRichValue(block.content, options) + "</h1></header>");
      case "subtitle": return blockShell(block, "", "<p class=\"pn-document-subtitle\" data-pn-field=\"content\">" + renderRichValue(block.content, options) + "</p>");
      case "heading": return blockShell(block, " data-pn-level=\"" + block.level + "\"", "<section class=\"pn-heading pn-heading-" + block.level + "\"><h" + (block.level + 1) + " data-pn-field=\"content\">" + renderRichValue(block.content, options) + "</h" + (block.level + 1) + "></section>");
      case "paragraph": return blockShell(block, "", paragraphField(block.content, options));
      case "equation": return blockShell(block, "", rawTemplate("content", block.content, "latex") + "<div class=\"pn-equation\" data-pn-rendered>" + (Renderer && Renderer.math ? Renderer.math(block.content, true) : escapeHtml(block.content)) + "</div>");
      case "code": {
        // Syntax highlighting is presentation-only. The canonical code value
        // stays the textContent of this field, so Prism spans/classes can be
        // regenerated without entering the Proofnote document model.
        const code = options && typeof options.codeHtml === "function" ? options.codeHtml(block) : escapeHtml(block.content);
        return blockShell(block, " data-pn-language=\"" + attr(block.language || "text") + "\"", "<pre class=\"pn-code\"><code data-pn-field=\"content\" data-pn-format=\"raw\">" + code + "</code></pre>");
      }
      case "table": {
        // Header-off is a semantic display setting, not an instruction to
        // throw away column names. Keep their marked carrier in a hidden
        // table group so the importer can still reconcile the structure
        // without showing a phantom header row.
        const columnCells = block.columns.map((column) => (block.header !== false ? "<th" : "<td") + " data-pn-column>" + renderRichValue(column, options) + (block.header !== false ? "</th>" : "</td>")).join("");
        const columns = block.header !== false
          ? "<thead data-pn-table-columns><tr>" + columnCells + "</tr></thead>"
          : "<tbody data-pn-table-columns hidden aria-hidden=\"true\"><tr>" + columnCells + "</tr></tbody>";
        const rows = "<tbody data-pn-table-rows>" + block.rows.map((row) => "<tr data-pn-row>" + block.columns.map((_, index) => "<td data-pn-cell>" + renderRichValue(row[index] || "", options) + "</td>").join("") + "</tr>").join("") + "</tbody>";
        return blockShell(block, " data-pn-header=\"" + boolAttribute(block.header !== false) + "\"", "<div class=\"pn-table-wrap\"><table class=\"pn-table\">" + columns + rows + "</table></div>");
      }
      case "image": {
        const source = string(block.src);
        const preview = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(source) ? "<img data-pn-rendered src=\"" + attr(source) + "\" alt=\"\">" : "<div data-pn-rendered></div>";
        return blockShell(block, "", "<figure class=\"pn-image\">" + rawTemplate("src", source, "url") + rawTemplate("alt", block.alt, "text") + preview + "<figcaption data-pn-field=\"caption\">" + renderRichValue(block.caption, options) + "</figcaption></figure>");
      }
      case "quote": return blockShell(block, "", "<figure class=\"pn-quote\"><blockquote data-pn-field=\"content\">" + renderRichValue(block.content, options) + "</blockquote><figcaption data-pn-field=\"citation\">" + renderRichValue(block.citation, options) + "</figcaption></figure>");
      case "divider": return blockShell(block, "", "<hr class=\"pn-divider\">");
      case "page-break": return blockShell(block, "", "<hr class=\"pn-page-break\" aria-label=\"Page break\">");
      case "callout": return blockShell(block, " data-pn-kind=\"" + attr(block.kind) + "\"", "<aside class=\"pn-callout pn-callout-" + attr(block.kind) + "\"><h3 data-pn-field=\"title\">" + renderRichValue(block.title, options) + "</h3>" + paragraphField(block.content, options) + "</aside>");
      case "semantic": {
        const appearance = block.appearance === "editorial" || block.appearance === "card" ? block.appearance : "auto";
        return blockShell(block, " data-pn-kind=\"" + attr(block.kind) + "\" data-pn-appearance=\"" + appearance + "\" data-pn-body-visible=\"" + boolAttribute(block.bodyVisible !== false) + "\"", "<div class=\"pn-semantic pn-semantic-" + attr(block.kind) + "\"><h3 data-pn-field=\"title\">" + renderRichValue(block.title, options) + "</h3><div data-pn-field=\"label\">" + renderRichValue(block.label, options) + "</div>" + paragraphField(block.content, options) + "<p data-pn-field=\"summary\">" + renderRichValue(block.summary, options) + "</p></div>");
      }
      case "list": {
        const tag = block.ordered === true ? "ol" : "ul";
        return blockShell(block, " data-pn-ordered=\"" + boolAttribute(block.ordered === true) + "\"", "<" + tag + " class=\"pn-list\" data-pn-items>" + block.items.map((item) => "<li data-pn-item>" + renderRichValue(item, options) + "</li>").join("") + "</" + tag + ">");
      }
      case "key-value": return blockShell(block, "", "<dl class=\"pn-key-value\" data-pn-items>" + block.items.map((item) => "<div data-pn-item><dt data-pn-item-field=\"label\">" + renderRichValue(item.label, options) + "</dt><dd data-pn-item-field=\"value\">" + renderRichValue(item.value, options) + "</dd></div>").join("") + "</dl>");
      case "stats": return blockShell(block, "", "<div class=\"pn-stats\" data-pn-items>" + block.items.map((item) => "<section class=\"pn-stat\" data-pn-item><span data-pn-item-field=\"kicker\">" + renderRichValue(item.kicker, options) + "</span><strong data-pn-item-field=\"value\">" + renderRichValue(item.value, options) + "</strong><p data-pn-item-field=\"body\">" + renderRichValue(item.body, options) + "</p></section>").join("") + "</div>");
      default: throw new Error("Unsupported Proofnote block type: " + block.type);
    }
  }
  function renderVisibleMetadata(document, options) {
    const metadata = document.metadata || {};
    const labels = {
      name: "Document name", author: "Author", date: "Date", status: "Status",
      source: "Source", language: "Language", noteNumber: "Note number"
    };
    const fields = VISIBLE_METADATA_FIELDS.map((field) => ({ field, empty: !string(metadata[field]).trim() }));
    const sectionClass = "pn-editable-metadata" + (fields.every((entry) => entry.empty) ? " pn-editable-metadata-empty" : "");
    return "<section class=\"" + sectionClass + "\" data-pn-metadata-fields><dl>"
      + fields.map(({ field, empty }) => "<div class=\"pn-editable-metadata-row" + (empty ? " is-empty" : "") + "\"><dt>" + labels[field] + "</dt><dd data-pn-meta-field=\"" + field + "\">"
        + renderRichValue(metadata[field], options) + "</dd></div>").join("")
      + "</dl></section>";
  }
  function defaultCss() {
    return "body{margin:0;background:#f3f2f2;color:#201f1d;font:17px/1.68 Georgia,serif}.pn-editable-document{max-width:760px;margin:0 auto;padding:56px 30px;background:#fff}.pn-editable-document [data-pn-block-id]{margin:0 0 20px}.pn-editable-document h1,.pn-editable-document h2,.pn-editable-document h3{font-family:Georgia,serif;font-weight:400}.pn-editable-document [data-pn-rendered]{pointer-events:none}.pn-editable-document template{display:none}.pn-editable-document table{border-collapse:collapse;width:100%}.pn-editable-document th,.pn-editable-document td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}.pn-editable-document pre{overflow:auto;padding:16px;background:#f7f6f4}.pn-editable-document aside{padding:16px;border:1px solid #edc778;background:#fff7e8}.pn-editable-document [data-pn-metadata]{display:none}.pn-editable-metadata{margin:0 0 24px;padding:12px 0;border-bottom:1px solid #ddd;color:#5b5752;font-size:13px}.pn-editable-metadata.pn-editable-metadata-empty,.pn-editable-metadata-row.is-empty{display:none}.pn-editable-metadata dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px;margin:0}.pn-editable-metadata dt{font:600 10px/1 Georgia,serif;letter-spacing:.1em;text-transform:uppercase;color:#8a837a}.pn-editable-metadata dd{margin:4px 0 0;min-height:1.2em}";
  }
  function agentNotice(options) {
    const supplied = string(options && options.notice);
    if (supplied) return supplied;
    return [
      "PROOFNOTE EDITABLE HTML — AI AGENT INSTRUCTIONS",
      "",
      "This file contains editable document content and Proofnote protocol metadata.",
      "",
      "CORE RULE",
      "Edit semantic values; preserve semantic identity.",
      "",
      "YOU MAY:",
      "- Edit user-facing text and semantic content.",
      "- Edit the text inside explicit LaTeX source fields.",
      "- Edit supported semantic properties such as heading level, callout type, and table contents or structure.",
      "- Move or delete complete Proofnote blocks.",
      "- Add supported blocks with a unique ext_ block ID.",
      "- Change CSS, classes, or harmless presentation wrappers. These visual-only changes may be ignored when the file is re-imported.",
      "",
      "DO NOT:",
      "- Remove, rename, duplicate, or rewrite the Proofnote magic marker.",
      "- Modify proofnote-* protocol metadata or the embedded proofnote-editable-source baseline.",
      "- Change existing data-pn-block-id values; do not remove or rename data-pn-* protocol attributes.",
      "- Duplicate semantic fields or block IDs, move semantic fields across blocks, or replace explicit LaTeX source fields with rendered KaTeX markup.",
      "- Change a data-pn-* marker (including data-pn-format or data-pn-latex when present) while editing its value.",
      "- Do not \"clean up\", simplify, deduplicate, or reformat Proofnote infrastructure.",
      "",
      "IMPORTANT:",
      "Edit the content of semantic fields, not the protocol markers that identify them.",
      "If unsure whether something is Proofnote infrastructure, leave all proofnote-* and data-pn-* metadata unchanged.",
      "Breaking these relationships can make the document impossible to re-import. Proofnote rejects ambiguous or damaged protocol data rather than guessing and risking content loss."
    ].join("\n");
  }
  function sourceMarkup(source, sourceHash) {
    return "<script id=\"" + SOURCE_ID + "\" type=\"" + SOURCE_TYPE + "\" data-proofnote-protocol=\"" + FORMAT + "\" data-proofnote-protocol-version=\"" + VERSION + "\" data-proofnote-source-bytes=\"" + utf8ByteLength(source) + "\" data-proofnote-source-sha256=\"" + sourceHash + "\">" + source + "</script>";
  }
  function htmlDocument(document, envelope, source, sourceHash, htmlHash, options) {
    const css = string(options && (options.css || options.styles)) || defaultCss();
    const language = languageForDocument(document, options && options.language);
    const htmlLanguage = language ? " lang=\"" + attr(language) + "\"" : "";
    const title = titleForDocument(document, options && options.title);
    const metadata = templateEscape(JSON.stringify(document.metadata || {}));
    const visibleMetadata = renderVisibleMetadata(document, options);
    const blocks = document.blocks.map((block) => renderEditableBlock(block, options)).join("\n");
    const documentType = string(document.metadata && document.metadata.documentType);
    const presentationClass = documentType === "Project" ? " pn-project-document"
      : (documentType === "Solution Note" ? " pn-proofnote-document" : "");
    const safeCss = css.split("</style").join("<\\/style");
    const notice = agentNotice(options).replace(/-->/g, "—>");
    return "<!doctype html><html" + htmlLanguage + "><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"proofnote-format\" content=\"editable-html\"><meta name=\"proofnote-version\" content=\"" + VERSION + "\"><!--\n" + notice + "\n--><meta name=\"proofnote-magic\" content=\"" + MAGIC + "\"><meta name=\"proofnote-document-id\" content=\"" + attr(envelope.documentId) + "\"><meta name=\"proofnote-revision-id\" content=\"" + attr(envelope.revisionId) + "\"><meta name=\"proofnote-html-sha256\" content=\"" + htmlHash + "\"><title>" + escapeHtml(title) + "</title><style>" + safeCss + "</style></head><body><article class=\"pn-document pn-editable-document" + presentationClass + "\" data-pn-document=\"" + MAGIC + "\"><template data-pn-metadata>" + metadata + "</template>" + visibleMetadata + "<main data-pn-blocks>" + blocks + "</main></article>" + sourceMarkup(source, sourceHash) + "</body></html>";
  }
  async function build(document, options) {
    let lined;
    try { lined = ensureLineage(document); }
    catch (error) { throw fail("invalid-document", "Proofnote could not create an editable HTML export: " + (error && error.message || "invalid document")); }
    const revisionId = await revisionIdForDocument(lined.document);
    if (!revisionId) throw fail("missing-crypto", "This browser cannot create the SHA-256 checks required for Proofnote Editable HTML.");
    const envelope = { format: FORMAT, version: VERSION, documentId: lined.documentId, revisionId, document: lined.document };
    const source = scriptEscape(JSON.stringify(envelope));
    const sourceHash = await sha256Hex(source);
    if (!sourceHash) throw fail("missing-crypto", "This browser cannot create the SHA-256 checks required for Proofnote Editable HTML.");
    const provisional = htmlDocument(lined.document, envelope, source, sourceHash, HASH_PLACEHOLDER, options || {});
    const wholeHash = await sha256Hex(provisional);
    if (!wholeHash) throw fail("missing-crypto", "This browser cannot create the SHA-256 checks required for Proofnote Editable HTML.");
    const marker = "name=\"proofnote-html-sha256\" content=\"" + HASH_PLACEHOLDER + "\"";
    const html = provisional.replace(marker, "name=\"proofnote-html-sha256\" content=\"" + wholeHash + "\"");
    if (html === provisional || utf8ByteLength(html) > MAX_HTML_BYTES) throw fail("export-size", "The editable HTML exceeds Proofnote’s safe export size.");
    return { html, document: lined.document, envelope, documentId: lined.documentId, revisionId, sourceHash, wholeHash };
  }

  /* ---------------------------------------------------------------------- */
  /* Safe carrier inspection and reconciliation                             */
  /* ---------------------------------------------------------------------- */

  function closestBlock(node, stopAt) {
    let current = node && node.parentElement;
    while (current && current !== stopAt) {
      if (current.hasAttribute && current.hasAttribute("data-pn-block-id")) return current;
      current = current.parentElement;
    }
    return null;
  }
  function allProtocolAttributesAreKnown(document) {
    const elements = Array.from(document.querySelectorAll("*"));
    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      const derived = Boolean(element.closest && element.closest("[data-pn-rendered]"));
      // KaTeX's htmlAndMathml output contains MathML and may contain SVG.
      // It is strictly derived output and is never read into Proofnote, so
      // accept those two inert rendering elements only inside an explicit
      // derived-preview subtree. The same tags elsewhere remain unsupported.
      if (FORBIDDEN_ELEMENTS.has(tag) || ((tag === "svg" || tag === "math") && !derived)) {
        throw fail("forbidden-element", "Editable HTML contains unsupported active element <" + tag + ">.");
      }
      for (const attribute of Array.from(element.attributes || [])) {
        const name = attribute.name.toLowerCase();
        if (/^on/i.test(name)) throw fail("event-handler", "Editable HTML must not contain inline event handlers.");
        if (name.startsWith("data-pn-") && !ALLOWED_DATA_ATTRIBUTES.has(name)) throw fail("unknown-protocol-attribute", "Unknown Proofnote protocol attribute " + name + " makes the document ambiguous.");
      }
      if (element.tagName.toLowerCase() === "meta" && /^refresh$/i.test(element.getAttribute("http-equiv") || "")) throw fail("meta-refresh", "Editable HTML must not contain a refresh redirect.");
    }
  }
  function derivedPreviewOwner(element) {
    return element && element.closest ? element.closest("[data-pn-rendered]") : null;
  }
  function checkDomComplexity(document) {
    const elements = Array.from(document.querySelectorAll("*"));
    let protocolNodes = 0;
    let derivedNodes = 0;
    for (const element of elements) {
      const preview = derivedPreviewOwner(element);
      if (preview) {
        derivedNodes += 1;
        if (derivedNodes > MAX_DERIVED_PREVIEW_NODES) {
          throw fail("derived-preview-too-complex", "Rendered Proofnote previews contain too many DOM nodes to import safely.");
        }
        let previewDepth = 0;
        let parent = element.parentElement;
        while (parent && parent !== preview) {
          previewDepth += 1;
          if (previewDepth > MAX_DERIVED_PREVIEW_DEPTH) {
            throw fail("derived-preview-too-deep", "Rendered Proofnote previews are nested too deeply to import safely.");
          }
          parent = parent.parentElement;
        }
        continue;
      }
      protocolNodes += 1;
      if (protocolNodes > MAX_PROTOCOL_NODES) {
        throw fail("html-too-complex", "Editable HTML contains too many semantic DOM nodes to import safely.");
      }
      let depth = 0;
      let parent = element.parentElement;
      while (parent) {
        depth += 1;
        if (depth > MAX_PROTOCOL_DEPTH) {
          throw fail("html-too-deep", "Editable HTML nesting exceeds the supported limit.");
        }
        parent = parent.parentElement;
      }
    }
  }
  function domForHtml(html) {
    if (!root.DOMParser) throw fail("missing-dom-parser", "This browser cannot parse Proofnote Editable HTML safely.");
    const source = String(html || "");
    if (utf8ByteLength(source) > MAX_HTML_BYTES) throw fail("html-too-large", "Editable HTML exceeds the 64 MB safety limit.");
    if (!/^\s*<!doctype\s+html(?:\s|>)/i.test(source)) throw fail("not-editable-html", "This is not a complete Proofnote Editable HTML document.");
    const document = new root.DOMParser().parseFromString(source, "text/html");
    const parserError = document.querySelector("parsererror");
    if (parserError) throw fail("html-parse-error", "Editable HTML could not be parsed.");
    checkDomComplexity(document);
    return document;
  }
  function unique(document, selector, code, message) {
    const matches = Array.from(document.querySelectorAll(selector));
    if (matches.length !== 1) throw fail(code, message);
    return matches[0];
  }
  function protocolMeta(document, name) {
    const meta = unique(document, "meta[name=\"" + name + "\"]", "ambiguous-protocol-meta", "Proofnote protocol metadata " + name + " must appear exactly once.");
    return meta.getAttribute("content") || "";
  }
  function sourceCarrier(document) {
    const scripts = Array.from(document.querySelectorAll("script"));
    if (!scripts.length) {
      const presentational = Boolean(document.querySelector(".pn-document, .pn-project-document, .pn-proofnote-document"));
      throw fail(presentational ? "presentation-only" : "not-editable-html", presentational
        ? "This is Proofnote presentation HTML, not a Proofnote Editable HTML v2 file."
        : "This file has no Proofnote Editable HTML source carrier.");
    }
    if (scripts.length !== 1) throw fail("unexpected-script", "Editable HTML may contain exactly one inert Proofnote source carrier and no executable scripts.");
    const script = scripts[0];
    const expected = {
      id: SOURCE_ID, type: SOURCE_TYPE,
      "data-proofnote-protocol": FORMAT,
      "data-proofnote-protocol-version": VERSION
    };
    Object.entries(expected).forEach(([name, value]) => {
      if ((name === "id" ? script.id : script.getAttribute(name)) !== value) throw fail("invalid-source-carrier", "The Proofnote source carrier does not match Editable HTML v2.");
    });
    const source = script.textContent || "";
    if (!source || utf8ByteLength(source) > MAX_SOURCE_BYTES) throw fail("source-too-large", "The embedded Proofnote source is empty or exceeds the safe limit.");
    const bytes = script.getAttribute("data-proofnote-source-bytes") || "";
    const sourceHash = script.getAttribute("data-proofnote-source-sha256") || "";
    if (!/^\d+$/.test(bytes) || Number(bytes) !== utf8ByteLength(source) || !/^[a-f0-9]{64}$/i.test(sourceHash)) throw fail("invalid-source-integrity", "The embedded Proofnote source has invalid integrity metadata.");
    return { script, source, sourceHash: sourceHash.toLowerCase() };
  }
  async function baselineFromHtml(html) {
    const document = domForHtml(html);
    const carrier = sourceCarrier(document);
    // DOMParser is inert. Once the document has proved it is a v2 carrier,
    // enforce the complete active-element/attribute policy before reading any
    // semantic projection. Keeping this after carrier recognition lets old
    // presentation-only Proofnote HTML receive its useful unsupported-format
    // diagnostic even when its derived KaTeX contains MathML/SVG.
    allProtocolAttributesAreKnown(document);
    const actualSourceHash = await sha256Hex(carrier.source);
    if (!actualSourceHash) throw fail("missing-crypto", "This browser cannot verify Proofnote Editable HTML integrity.");
    if (actualSourceHash !== carrier.sourceHash) throw fail("source-integrity-failed", "The embedded Proofnote source has been changed, truncated, or corrupted.");
    let envelope;
    try { envelope = JSON.parse(carrier.source); }
    catch (_) { throw fail("invalid-source-json", "The embedded Proofnote source is not valid JSON."); }
    if (scriptEscape(JSON.stringify(envelope)) !== carrier.source) throw fail("noncanonical-source", "The embedded Proofnote source is not in Proofnote’s canonical v2 encoding.");
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || envelope.format !== FORMAT || envelope.version !== VERSION
      || !LINEAGE_ID_PATTERN.test(string(envelope.documentId)) || !/^rev_[a-f0-9]{64}$/.test(string(envelope.revisionId))
      || !envelope.document || typeof envelope.document !== "object" || Array.isArray(envelope.document)) {
      throw fail("invalid-envelope", "The embedded Proofnote v2 envelope is incomplete or unsupported.");
    }
    const validation = Model.validateDocumentRaw(envelope.document);
    if (validation.errors.length) throw fail("invalid-baseline-document", "The embedded baseline Proofnote document is invalid: " + (validation.errors[0].path ? validation.errors[0].path + " — " : "") + validation.errors[0].message);
    const baseline = normalizePortable(envelope.document);
    if (protocolLineage(baseline) !== envelope.documentId) throw fail("lineage-mismatch", "The editable HTML document identity does not match its canonical Proofnote baseline.");
    const expectedRevision = await revisionIdForDocument(baseline);
    if (!expectedRevision || expectedRevision !== envelope.revisionId) throw fail("revision-mismatch", "The editable HTML baseline revision does not match its semantic document.");
    const head = {
      format: protocolMeta(document, "proofnote-format"), version: protocolMeta(document, "proofnote-version"),
      magic: protocolMeta(document, "proofnote-magic"), documentId: protocolMeta(document, "proofnote-document-id"),
      revisionId: protocolMeta(document, "proofnote-revision-id"), htmlHash: protocolMeta(document, "proofnote-html-sha256")
    };
    if (head.format !== "editable-html" || head.version !== VERSION || head.magic !== MAGIC || head.documentId !== envelope.documentId || head.revisionId !== envelope.revisionId || !/^[a-f0-9]{64}$/i.test(head.htmlHash)) throw fail("head-envelope-mismatch", "The visible Proofnote v2 identity metadata does not match the embedded baseline.");
    const marker = "name=\"proofnote-html-sha256\" content=\"" + head.htmlHash + "\"";
    const matches = String(html).split(marker).length - 1;
    // The whole-document hash is an exact-export fast path, not the trust
    // boundary (the immutable source carrier is that boundary). An external
    // editor may reorder meta attributes, change quote style, or even put the
    // marker text in a CSS comment while making only presentational changes.
    // Those cases must safely fall through to semantic reconciliation rather
    // than reject an otherwise unambiguous editable document.
    let exactHtml = false;
    if (matches === 1) {
      const unsigned = String(html).replace(marker, "name=\"proofnote-html-sha256\" content=\"" + HASH_PLACEHOLDER + "\"");
      const actualHtmlHash = await sha256Hex(unsigned);
      if (!actualHtmlHash) throw fail("missing-crypto", "This browser cannot verify Proofnote Editable HTML integrity.");
      exactHtml = actualHtmlHash === head.htmlHash.toLowerCase();
    }
    return { document, baseline, envelope, exactHtml, htmlHash: head.htmlHash.toLowerCase() };
  }

  function validateBlockFieldNames(block, type) {
    const all = ownedDescendants(block, "[data-pn-field]");
    const allowed = new Set(BLOCK_FIELDS[type] || []);
    all.forEach((node) => { if (!allowed.has(node.getAttribute("data-pn-field"))) throw fail("unknown-block-field", "A block contains an unsupported Proofnote field."); });
  }
  function validateBlockFieldFormats(block, type) {
    const expectedFormats = {
      paragraph: { content: "paragraphs" },
      equation: { content: "latex" },
      code: { content: "raw" },
      image: { src: "url", alt: "text" },
      callout: { content: "paragraphs" },
      semantic: { content: "paragraphs" }
    }[type] || {};
    ownedDescendants(block, "[data-pn-field]").forEach((field) => {
      const name = field.getAttribute("data-pn-field");
      const expected = expectedFormats[name];
      const actual = field.getAttribute("data-pn-format");
      if (expected ? actual !== expected : actual !== null) {
        throw fail("invalid-field-format", "A Proofnote field has an unsupported source format.");
      }
    });
  }
  function directField(block, name) {
    const field = singleOwned(block, "[data-pn-field=\"" + name + "\"]", "ambiguous-field", "Block " + block.getAttribute("data-pn-block-id") + " must have exactly one " + name + " field.");
    validateBlockFieldNames(block, block.getAttribute("data-pn-type"));
    return field;
  }
  function rawFieldValue(field, expectedFormat) {
    if (field.tagName.toLowerCase() !== "template") throw fail("invalid-raw-field", "A raw Proofnote field must use a template element.");
    if (expectedFormat && field.getAttribute("data-pn-format") !== expectedFormat) throw fail("invalid-raw-field", "A raw Proofnote field has an unexpected format.");
    // Raw templates carry canonical source (LaTeX, image URLs, and alt
    // strings), not a second HTML editing language. If markup were accepted
    // here it could be silently flattened by textContent, which violates the
    // protocol's no-guessing rule.
    return textOnlyTemplateContent(field, "invalid-raw-field", "A raw Proofnote field must contain plain text only.");
  }
  function parseItemField(item, fieldName, baselineValue) {
    const fields = ownedDescendants(item, "[data-pn-item-field=\"" + fieldName + "\"]");
    if (fields.length !== 1) throw fail("ambiguous-item-field", "A structured item must have exactly one " + fieldName + " field.");
    return richFieldValue(fields[0], baselineValue);
  }
  function parseTable(block, baseline) {
    const columnsHost = singleOwned(block, "[data-pn-table-columns]", "ambiguous-table-columns", "A table must have exactly one columns container.");
    const rowsHost = singleOwned(block, "[data-pn-table-rows]", "ambiguous-table-rows", "A table must have exactly one rows container.");
    const tableColumnWrappers = new Set(Array.from(RICH_TRANSPARENT_ELEMENTS).concat(["tr"]));
    validateMarkedHost(columnsHost, "[data-pn-column]", tableColumnWrappers, "orphan-table-content", "A table columns container contains unmarked structural content.");
    validateMarkedHost(rowsHost, "[data-pn-row]", RICH_TRANSPARENT_ELEMENTS, "orphan-table-content", "A table rows container contains unmarked structural content.");
    const columns = ownedDescendants(columnsHost, "[data-pn-column]");
    if (!columns.length) throw fail("missing-table-columns", "A table must contain at least one uniquely identified column.");
    const rows = ownedDescendants(rowsHost, "[data-pn-row]");
    if (!rows.length) throw fail("missing-table-rows", "A table must contain at least one uniquely identified row.");
    ownedDescendants(block, "[data-pn-column]").forEach((column) => {
      if (!columnsHost.contains(column)) throw fail("orphan-table-field", "A table column is outside its unique columns container.");
    });
    ownedDescendants(block, "[data-pn-row]").forEach((row) => {
      if (!rowsHost.contains(row)) throw fail("orphan-table-field", "A table row is outside its unique rows container.");
    });
    ownedDescendants(block, "[data-pn-cell]").forEach((cell) => {
      if (!rows.some((row) => row.contains(cell))) throw fail("orphan-table-field", "A table cell is outside its unique row.");
    });
    const baselineColumns = baseline && baseline.columns || [];
    const parsedColumns = columns.map((column, index) => richFieldValue(column, baselineColumns[index] || ""));
    const parsedRows = rows.map((row, rowIndex) => {
      validateMarkedHost(row, "[data-pn-cell]", RICH_TRANSPARENT_ELEMENTS, "orphan-table-content", "A table row contains unmarked structural content.");
      const cells = ownedDescendants(row, "[data-pn-cell]");
      if (cells.length !== parsedColumns.length) throw fail("ambiguous-table-row", "Every table row must have exactly one cell for each column.");
      return cells.map((cell, cellIndex) => richFieldValue(cell, baseline && baseline.rows && baseline.rows[rowIndex] && baseline.rows[rowIndex][cellIndex] || ""));
    });
    return { header: parseBoolean(block.getAttribute("data-pn-header"), "table header"), columns: parsedColumns, rows: parsedRows };
  }
  function parseStructuredItems(block, baseline, kind) {
    const host = singleOwned(block, "[data-pn-items]", "ambiguous-items", "A structured block must have exactly one items container.");
    validateMarkedHost(host, "[data-pn-item]", RICH_TRANSPARENT_ELEMENTS, "orphan-structured-content", "A structured items container contains unmarked content.");
    const items = ownedDescendants(host, "[data-pn-item]");
    if (!items.length) throw fail("missing-items", "A structured block must contain at least one uniquely identified item.");
    if (kind === "list") {
      if (ownedDescendants(block, "[data-pn-item-field]").length) {
        throw fail("unexpected-item-field", "List items must not contain named structured-item fields.");
      }
      return items.map((item, index) => richFieldValue(item, baseline && baseline.items && baseline.items[index] || ""));
    }
    const fields = kind === "key-value" ? ["label", "value"] : ["kicker", "value", "body"];
    return items.map((item, index) => {
      validateMarkedHost(item, "[data-pn-item-field]", RICH_TRANSPARENT_ELEMENTS, "orphan-structured-content", "A structured item contains unmarked content.");
      ownedDescendants(item, "[data-pn-item-field]").forEach((field) => {
        if (!fields.includes(field.getAttribute("data-pn-item-field"))) throw fail("unknown-item-field", "A structured item contains an unsupported Proofnote field.");
      });
      return fields.reduce((value, field) => {
        value[field] = parseItemField(item, field, baseline && baseline.items && baseline.items[index] && baseline.items[index][field] || "");
        return value;
      }, {});
    });
  }
  function parseBlock(block, baseline) {
    const type = block.getAttribute("data-pn-type") || "";
    if (!BLOCK_TYPES.has(type)) throw fail("unknown-block-type", "Unknown Proofnote block type " + type + ".");
    validateBlockFieldNames(block, type);
    validateBlockFieldFormats(block, type);
    const has = (name) => block.hasAttribute(name);
    const descendants = (selector) => ownedDescendants(block, selector);
    if (type !== "heading" && has("data-pn-level")) throw fail("wrong-block-attribute", "Only headings may carry a Proofnote heading level.");
    if (type !== "code" && has("data-pn-language")) throw fail("wrong-block-attribute", "Only code blocks may carry a Proofnote language.");
    if (type !== "table" && (has("data-pn-header") || descendants("[data-pn-table-columns], [data-pn-table-rows], [data-pn-column], [data-pn-row], [data-pn-cell]").length)) throw fail("wrong-block-attribute", "Table protocol fields may only appear in a table block.");
    if (!["callout", "semantic"].includes(type) && has("data-pn-kind")) throw fail("wrong-block-attribute", "Only callout and semantic blocks may carry a Proofnote kind.");
    if (type !== "semantic" && (has("data-pn-appearance") || has("data-pn-body-visible"))) throw fail("wrong-block-attribute", "Semantic presentation fields may only appear in a semantic block.");
    if (type !== "list" && has("data-pn-ordered")) throw fail("wrong-block-attribute", "Only list blocks may carry ordered-list state.");
    if (!["list", "key-value", "stats"].includes(type) && descendants("[data-pn-items], [data-pn-item], [data-pn-item-field]").length) throw fail("wrong-block-attribute", "Structured-item protocol fields may only appear in a list, key-value, or stats block.");
    const raw = { type };
    if (baseline) raw.id = baseline.id;
    switch (type) {
      case "title": case "subtitle": case "heading": case "quote":
        raw.content = richFieldValue(directField(block, "content"), baseline && baseline.content || "");
        if (type === "heading") {
          const level = Number(block.getAttribute("data-pn-level"));
          if (![1, 2, 3].includes(level)) throw fail("invalid-heading-level", "A heading level must be 1, 2, or 3.");
          raw.level = level;
        }
        if (type === "quote") raw.citation = richFieldValue(directField(block, "citation"), baseline && baseline.citation || "");
        break;
      case "paragraph": raw.content = richParagraphValue(directField(block, "content"), baseline && baseline.content || ""); break;
      case "equation": raw.content = rawFieldValue(directField(block, "content"), "latex"); break;
      case "code":
        raw.language = string(block.getAttribute("data-pn-language") || "text");
        // `codeHtml` may contain a renderer's ordinary highlighting spans;
        // textContent deliberately recovers only the raw portable source.
        raw.content = directField(block, "content").textContent || "";
        break;
      case "table": Object.assign(raw, parseTable(block, baseline)); break;
      case "image":
        raw.src = rawFieldValue(directField(block, "src"), "url");
        raw.alt = rawFieldValue(directField(block, "alt"), "text");
        raw.caption = richFieldValue(directField(block, "caption"), baseline && baseline.caption || "");
        break;
      case "divider": case "page-break": break;
      case "callout":
        raw.kind = string(block.getAttribute("data-pn-kind"));
        if (!CALLOUT_KINDS.has(raw.kind)) throw fail("invalid-callout-kind", "A callout kind is unsupported.");
        raw.title = richFieldValue(directField(block, "title"), baseline && baseline.title || "");
        raw.content = richParagraphValue(directField(block, "content"), baseline && baseline.content || "");
        break;
      case "semantic": {
        raw.kind = string(block.getAttribute("data-pn-kind"));
        if (!SEMANTIC_KINDS.has(raw.kind)) throw fail("invalid-semantic-kind", "A semantic block kind is unsupported.");
        const appearance = string(block.getAttribute("data-pn-appearance"));
        if (appearance === "editorial" || appearance === "card") raw.appearance = appearance;
        else if (appearance !== "auto") throw fail("invalid-semantic-appearance", "A semantic block presentation is unsupported.");
        raw.bodyVisible = parseBoolean(block.getAttribute("data-pn-body-visible"), "semantic body visibility");
        ["title", "label", "summary"].forEach((field) => { raw[field] = richFieldValue(directField(block, field), baseline && baseline[field] || ""); });
        raw.content = richParagraphValue(directField(block, "content"), baseline && baseline.content || "");
        break;
      }
      case "list":
        raw.ordered = parseBoolean(block.getAttribute("data-pn-ordered"), "list ordered");
        raw.items = parseStructuredItems(block, baseline, "list");
        break;
      case "key-value": raw.items = parseStructuredItems(block, baseline, "key-value"); break;
      case "stats": raw.items = parseStructuredItems(block, baseline, "stats"); break;
      default: throw fail("unknown-block-type", "Unknown Proofnote block type.");
    }
    return raw;
  }
  function parseMetadata(rootElement, baseline) {
    const template = unique(rootElement, "template[data-pn-metadata]", "ambiguous-metadata", "Editable HTML must contain exactly one structured Proofnote metadata template.");
    if (closestBlock(template, rootElement) || template.closest("[data-pn-metadata-fields]")) {
      throw fail("metadata-invalid-placement", "The structured Proofnote metadata template must remain outside content blocks and visible metadata fields.");
    }
    const metadataSource = textOnlyTemplateContent(template, "invalid-metadata", "The structured Proofnote metadata template must contain JSON text only.");
    const duplicateKey = duplicateJsonObjectKey(metadataSource);
    if (duplicateKey) {
      throw fail("duplicate-metadata-key", "The structured Proofnote metadata template contains the duplicate JSON key \"" + duplicateKey + "\".");
    }
    let metadata;
    try { metadata = JSON.parse(metadataSource); }
    catch (_) { throw fail("invalid-metadata", "The structured Proofnote metadata template is not valid JSON."); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw fail("invalid-metadata", "The structured Proofnote metadata template must contain an object.");
    VISIBLE_METADATA_FIELDS.forEach((name) => {
      if (metadata[name] !== undefined && typeof metadata[name] !== "string") {
        throw fail("invalid-metadata", "Structured Proofnote metadata field " + name + " must be a string.");
      }
    });
    const fieldsHost = unique(rootElement, "[data-pn-metadata-fields]", "ambiguous-metadata-fields", "Editable HTML must contain exactly one visible Proofnote metadata fields container.");
    const visible = ownedDescendants(fieldsHost, "[data-pn-meta-field]");
    if (visible.length !== VISIBLE_METADATA_FIELDS.length) throw fail("ambiguous-metadata-field", "Every supported visible Proofnote metadata field must appear exactly once.");
    const seen = new Set();
    const baselineMetadata = baseline && baseline.metadata || {};
    visible.forEach((field) => {
      if (closestBlock(field, rootElement)) throw fail("metadata-inside-block", "Visible Proofnote metadata must not be nested inside a content block.");
      const name = string(field.getAttribute("data-pn-meta-field"));
      if (!VISIBLE_METADATA_FIELDS.includes(name)) throw fail("unknown-metadata-field", "Unknown visible Proofnote metadata field " + name + ".");
      if (seen.has(name)) throw fail("ambiguous-metadata-field", "Visible Proofnote metadata field " + name + " appears more than once.");
      seen.add(name);
      const visual = richFieldObservation(field, baselineMetadata[name] || "");
      const templateValue = string(metadata[name]);
      const templateChanged = templateValue !== string(baselineMetadata[name]);
      if (visual.changed && templateChanged && visual.value !== templateValue) {
        throw fail("metadata-conflict", "Visible metadata field " + name + " conflicts with the structured metadata template.");
      }
      if (visual.changed) metadata[name] = visual.value;
    });
    if (Array.from(rootElement.querySelectorAll("[data-pn-meta-field]")).some((field) => !fieldsHost.contains(field))) {
      throw fail("metadata-outside-container", "A visible Proofnote metadata field appears outside the unique metadata container.");
    }
    const ignoredSystemMetadata = [];
    SYSTEM_METADATA_FIELDS.forEach((name) => {
      const baselineHasValue = hasOwn(baselineMetadata, name);
      const candidateHasValue = hasOwn(metadata, name);
      const baselineValue = baselineMetadata[name];
      if (candidateHasValue !== baselineHasValue || (candidateHasValue && stableStringify(metadata[name]) !== stableStringify(baselineValue))) {
        ignoredSystemMetadata.push(name);
      }
      if (baselineHasValue) metadata[name] = baselineValue;
      else delete metadata[name];
    });
    return { metadata, ignoredSystemMetadata };
  }
  function changeSummary(baseline, candidate) {
    const before = baseline.blocks || [], after = candidate.blocks || [];
    const beforeById = new Map(before.map((block, index) => [block.id, { block, index }]));
    const afterById = new Map(after.filter((block) => block.id).map((block, index) => [block.id, { block, index }]));
    let edited = 0, moved = 0;
    beforeById.forEach(({ block, index }, id) => {
      const next = afterById.get(id);
      if (!next) return;
      const beforeBlock = cloneJson(block), afterBlock = cloneJson(next.block);
      delete beforeBlock.preset; delete afterBlock.preset;
      if (stableStringify(beforeBlock) !== stableStringify(afterBlock)) edited += 1;
      if (index !== next.index) moved += 1;
    });
    const deleted = before.filter((block) => !afterById.has(block.id)).length;
    const inserted = after.filter((block) => !beforeById.has(block.id)).length;
    const deletionRatio = before.length ? deleted / before.length : 0;
    return {
      edited, inserted, deleted, moved, visualOnly: false,
      deletionRatio,
      // A large deletion can be a deliberate external edit, but it is also a
      // common sign that an HTML tool dropped part of the semantic projection.
      // It remains recoverable; the editor can use this explicit signal to
      // require a deliberate confirmation before replacement/import.
      highDeletion: before.length >= 2 && deletionRatio >= 0.5
    };
  }
  function validateDerivedPreviews(rootElement) {
    Array.from(rootElement.querySelectorAll("[data-pn-rendered]")).forEach((preview) => {
      const rootCarriesExtraProtocol = Array.from(preview.attributes || []).some((attribute) => attribute.name.toLowerCase().startsWith("data-pn-") && attribute.name.toLowerCase() !== "data-pn-rendered");
      const nestedProtocol = Array.from(preview.querySelectorAll("*")).some((node) => Array.from(node.attributes || []).some((attribute) => attribute.name.toLowerCase().startsWith("data-pn-")));
      if (rootCarriesExtraProtocol || nestedProtocol) {
        throw fail("derived-preview-protocol-content", "A derived preview must not contain Proofnote semantic fields or blocks.");
      }
      const owner = closestBlock(preview, rootElement);
      const metadataMath = Boolean(preview.closest && preview.closest("[data-pn-metadata-fields]") && preview.closest("[data-pn-token=\"math\"]"));
      if (metadataMath) return;
      if (!owner) throw fail("orphan-derived-preview", "A derived preview must belong to exactly one Proofnote block.");
      const type = owner.getAttribute("data-pn-type");
      const inlineMath = Boolean(preview.closest && preview.closest("[data-pn-token=\"math\"]"));
      if (!inlineMath && type !== "equation" && type !== "image") {
        throw fail("orphan-derived-preview", "Derived previews are only valid for equations, images, or explicit inline math.");
      }
    });
  }
  function closestProtocolAncestor(node, selector, boundary) {
    let current = node && node.parentElement;
    while (current && current !== boundary) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }
  function validateProtocolPlacement(rootElement, blocksRoot) {
    const blockNodes = Array.from(rootElement.querySelectorAll("[data-pn-block-id]"));
    blockNodes.forEach((block) => {
      if (!blocksRoot.contains(block)) throw fail("block-outside-container", "A Proofnote block appears outside the unique blocks container.");
      if (!block.hasAttribute("data-pn-type")) throw fail("missing-block-type", "Every Proofnote block must have an explicit type.");
    });
    Array.from(rootElement.querySelectorAll("[data-pn-type]")).forEach((node) => {
      if (!node.hasAttribute("data-pn-block-id")) throw fail("orphan-block-type", "A Proofnote block type must belong to an explicit block ID.");
    });
    const blockAttributes = [
      "data-pn-field", "data-pn-format", "data-pn-table-columns", "data-pn-table-rows",
      "data-pn-column", "data-pn-row", "data-pn-cell", "data-pn-items",
      "data-pn-item", "data-pn-item-field", "data-pn-paragraph",
      "data-pn-token", "data-pn-latex", "data-pn-rendered"
    ].map((name) => "[" + name + "]").join(",");
    Array.from(rootElement.querySelectorAll(blockAttributes)).forEach((node) => {
      const inMetadata = Boolean(node.closest && node.closest("[data-pn-metadata-fields]"));
      if (inMetadata) {
        if (node.hasAttribute("data-pn-token") || node.hasAttribute("data-pn-latex") || node.hasAttribute("data-pn-rendered")) return;
        throw fail("metadata-protocol-field", "Only inline Proofnote rendering tokens may appear inside visible metadata.");
      }
      const owner = closestBlock(node, rootElement);
      if (!owner || !blocksRoot.contains(node) || !blocksRoot.contains(owner)) {
        throw fail("orphan-protocol-field", "A Proofnote semantic field is outside the unique block relationship.");
      }
    });
    const blockOnlyAttributes = [
      "data-pn-level", "data-pn-language", "data-pn-header", "data-pn-kind",
      "data-pn-appearance", "data-pn-body-visible", "data-pn-ordered"
    ].map((name) => "[" + name + "]").join(",");
    Array.from(rootElement.querySelectorAll(blockOnlyAttributes)).forEach((node) => {
      if (!node.hasAttribute("data-pn-block-id")) throw fail("orphan-block-attribute", "A Proofnote block attribute must be attached to its block root.");
    });
    Array.from(rootElement.querySelectorAll("[data-pn-format]")).forEach((field) => {
      if (!field.hasAttribute("data-pn-field")) {
        throw fail("orphan-field-format", "A Proofnote source format must belong directly to an explicit semantic field.");
      }
    });

    // A structured-item marker outside its one items host used to be ignored
    // by the per-block parser. Reject it rather than silently dropping a
    // relationship an external editor may have tried to express.
    Array.from(rootElement.querySelectorAll("[data-pn-items]")).forEach((host) => {
      const owner = closestBlock(host, rootElement);
      if (!owner || !["list", "key-value", "stats"].includes(owner.getAttribute("data-pn-type"))) {
        throw fail("orphan-structured-items", "A structured items container must belong to a list, key-value, or stats block.");
      }
      if (closestProtocolAncestor(host, "[data-pn-item]", rootElement)) {
        throw fail("nested-structured-items", "A structured items container cannot be nested inside another item.");
      }
    });
    Array.from(rootElement.querySelectorAll("[data-pn-item]")).forEach((item) => {
      const host = closestProtocolAncestor(item, "[data-pn-items]", rootElement);
      const owner = closestBlock(item, rootElement);
      if (!host || !owner || closestBlock(host, rootElement) !== owner) {
        throw fail("orphan-structured-item", "A structured item must belong to exactly one items container in its own block.");
      }
      if (closestProtocolAncestor(item, "[data-pn-item]", rootElement)) {
        throw fail("nested-structured-item", "A structured item cannot be nested inside another item.");
      }
    });
    Array.from(rootElement.querySelectorAll("[data-pn-item-field]")).forEach((field) => {
      const item = closestProtocolAncestor(field, "[data-pn-item]", rootElement);
      const host = item && closestProtocolAncestor(item, "[data-pn-items]", rootElement);
      const owner = closestBlock(field, rootElement);
      if (!item || !host || !owner || closestBlock(item, rootElement) !== owner || closestBlock(host, rootElement) !== owner) {
        throw fail("orphan-structured-item-field", "A structured item field must belong to exactly one item in its own items container.");
      }
    });

    // Paragraph boundaries are semantic only for the rich multi-paragraph
    // content fields rendered by paragraph, callout, and semantic blocks.
    Array.from(rootElement.querySelectorAll("[data-pn-paragraph]")).forEach((paragraph) => {
      const field = closestProtocolAncestor(paragraph, "[data-pn-field]", rootElement);
      const owner = closestBlock(paragraph, rootElement);
      if (!field || !owner || closestBlock(field, rootElement) !== owner
        || paragraph.tagName.toLowerCase() !== "p" || field.getAttribute("data-pn-field") !== "content" || field.getAttribute("data-pn-format") !== "paragraphs") {
        throw fail("orphan-paragraph", "A Proofnote paragraph marker must belong to one rich paragraphs content field.");
      }
    });

    // Inline protocol tokens need an explicit rich carrier. A token placed
    // elsewhere in the same block is not a harmless wrapper: the parser
    // would otherwise never visit it and silently lose intent.
    const inlineCarrier = (node) => {
      const carrier = closestProtocolAncestor(node, "[data-pn-field], [data-pn-meta-field], [data-pn-item], [data-pn-item-field], [data-pn-column], [data-pn-cell]", rootElement);
      if (!carrier) return null;
      if (carrier.hasAttribute("data-pn-field")) {
        if (carrier.tagName.toLowerCase() === "template" || carrier.getAttribute("data-pn-format") === "raw") return null;
      }
      if (carrier.hasAttribute("data-pn-item")) {
        const owner = closestBlock(carrier, rootElement);
        if (!owner || owner.getAttribute("data-pn-type") !== "list") return null;
      }
      return carrier;
    };
    Array.from(rootElement.querySelectorAll("[data-pn-token]")).forEach((token) => {
      if (!inlineCarrier(token)) throw fail("orphan-inline-token", "A Proofnote inline token must belong to a rich semantic field.");
    });
    Array.from(rootElement.querySelectorAll("[data-pn-href]")).forEach((link) => {
      if (link.tagName.toLowerCase() !== "a" || link.getAttribute("data-pn-token") !== "link") {
        throw fail("wrong-inline-attribute", "A Proofnote link target must belong to an explicit link token.");
      }
    });
    Array.from(rootElement.querySelectorAll("[data-pn-math-mode]")).forEach((math) => {
      if (math.getAttribute("data-pn-token") !== "math" || !["inline", "display"].includes(math.getAttribute("data-pn-math-mode"))) {
        throw fail("wrong-inline-attribute", "A Proofnote math display mode must belong to an explicit inline or display math token.");
      }
    });
    Array.from(rootElement.querySelectorAll("[data-pn-token=\"math\"]")).forEach((math) => {
      const markers = ownedDescendants(math, "[data-pn-latex]");
      if (markers.length !== 1 || markers[0].tagName.toLowerCase() !== "template") {
        throw fail("ambiguous-latex", "A Proofnote math token must contain exactly one LaTeX source template.");
      }
    });
    Array.from(rootElement.querySelectorAll("[data-pn-latex]")).forEach((latex) => {
      const math = closestProtocolAncestor(latex, "[data-pn-token=\"math\"]", rootElement);
      if (!math || !inlineCarrier(math) || latex.tagName.toLowerCase() !== "template") {
        throw fail("orphan-latex", "A Proofnote LaTeX source must belong to an explicit inline math token.");
      }
    });
  }
  function reconcile(document, baseline) {
    if (!document || !baseline) throw fail("missing-reconciliation-input", "Proofnote needs both semantic HTML and its baseline document to reconcile changes.");
    if (document.querySelectorAll("[data-pn-document]").length !== 1) throw fail("ambiguous-document-root", "Editable HTML must contain exactly one Proofnote document root.");
    if (document.querySelectorAll("[data-pn-blocks]").length !== 1) throw fail("ambiguous-block-container", "Editable HTML must contain exactly one Proofnote blocks container.");
    if (document.querySelectorAll("[data-pn-metadata-fields]").length !== 1) throw fail("ambiguous-metadata-fields", "Editable HTML must contain exactly one visible Proofnote metadata fields container.");
    const rootElement = unique(document, "article[data-pn-document=\"" + MAGIC + "\"]", "ambiguous-document-root", "Editable HTML must contain exactly one Proofnote v2 document root.");
    const blocksRoot = unique(rootElement, "[data-pn-blocks]", "ambiguous-block-container", "Editable HTML must contain exactly one Proofnote blocks container.");
    const externalProtocol = Array.from(document.querySelectorAll("*")).filter((node) => {
      const carriesProtocol = Array.from(node.attributes || []).some((attribute) => attribute.name.toLowerCase().startsWith("data-pn-"));
      return carriesProtocol && !rootElement.contains(node);
    });
    if (externalProtocol.length) throw fail("protocol-outside-root", "A Proofnote block or field appears outside the unique document root.");
    validateProtocolPlacement(rootElement, blocksRoot);
    validateDerivedPreviews(rootElement);
    // Do not use ownedDescendants here: it intentionally hides descendants
    // of another block for field parsing, whereas a nested block is itself a
    // protocol conflict and must never be mistaken for a deleted sibling.
    const blockNodes = Array.from(blocksRoot.querySelectorAll("[data-pn-block-id]"));
    if (!blockNodes.length) throw fail("missing-blocks", "Editable HTML must contain at least one uniquely identified Proofnote block.");
    const baselineById = new Map((baseline.blocks || []).map((block) => [block.id, block]));
    const seen = new Set();
    const parsed = [];
    blockNodes.forEach((node) => {
      if (closestBlock(node, blocksRoot)) throw fail("nested-block", "Proofnote blocks must not be nested inside other blocks.");
      const id = string(node.getAttribute("data-pn-block-id"));
      const type = string(node.getAttribute("data-pn-type"));
      if (!id || seen.has(id)) throw fail("duplicate-block-id", "Every Proofnote block ID must be unique.");
      seen.add(id);
      const original = baselineById.get(id);
      if (!original && !EXTERNAL_ID_PATTERN.test(id)) throw fail("unknown-block-id", "A new block must use a unique ext_ block ID; existing blocks must retain their exported IDs.");
      if (original && original.type !== type) throw fail("block-type-conflict", "An existing Proofnote block cannot change type in place. Delete it and create a new ext_ block instead.");
      const raw = parseBlock(node, original || null);
      if (!original) delete raw.id;
      parsed.push(raw);
    });
    const metadataResult = parseMetadata(rootElement, baseline);
    const candidate = cloneJson(baseline);
    candidate.metadata = metadataResult.metadata;
    candidate.blocks = parsed;
    candidate.compatibility = cloneJson(baseline.compatibility || {});
    candidate.compatibility[LINEAGE_KEY] = { documentId: protocolLineage(baseline) };
    const validation = Model.validateDocumentRaw(candidate);
    if (validation.errors.length) {
      const first = validation.errors[0];
      throw fail("reconciled-document-invalid", "Reconciled Proofnote content is invalid: " + (first.path ? first.path + " — " : "") + first.message);
    }
    // The one expected normaliser warning is an ext_ transport block that
    // intentionally has no canonical ID yet. Every other warning means the
    // visible HTML expressed a value Proofnote would silently coerce or drop;
    // that is precisely the situation where this protocol must refuse to
    // guess rather than manufacture a document.
    const ambiguousWarning = (validation.warnings || []).find((issue) => {
      const match = /^blocks\[(\d+)\]\.id$/.exec(string(issue.path));
      return !(match && !parsed[Number(match[1])].id);
    });
    if (ambiguousWarning) {
      throw fail("reconciled-document-ambiguous", "Reconciled Proofnote content would be changed by normalisation: " + (ambiguousWarning.path ? ambiguousWarning.path + " — " : "") + ambiguousWarning.message);
    }
    const normalized = normalizePortable(candidate);
    const canonicalBaseline = normalizePortable(baseline);
    // External block IDs are intentionally transport-only. The model mints
    // stable internal IDs only after every relationship has been validated.
    const summary = changeSummary(canonicalBaseline, normalized);
    summary.systemOnly = metadataResult.ignoredSystemMetadata.length > 0;
    summary.ignoredSystemMetadata = metadataResult.ignoredSystemMetadata;
    return { document: normalized, raw: candidate, changes: summary };
  }
  async function inspect(html, options) {
    try {
      const baselineInfo = await baselineFromHtml(html);
      const baseline = baselineInfo.baseline;
      const current = options && options.currentDocument;
      let status = baselineInfo.exactHtml ? "EXACT" : "RECOVERED";
      let result = { document: baseline, raw: baseline, changes: { edited: 0, inserted: 0, deleted: 0, moved: 0, visualOnly: false, deletionRatio: 0, highDeletion: false, systemOnly: false, ignoredSystemMetadata: [] } };
      if (!baselineInfo.exactHtml) {
        result = reconcile(baselineInfo.document, baseline);
        const baselineRevision = await revisionIdForDocument(baseline);
        const candidateRevision = await revisionIdForDocument(result.document);
        result.changes.visualOnly = baselineRevision === candidateRevision && !result.changes.systemOnly;
      }
      const output = {
        status, document: result.document, raw: result.raw, baseline,
        envelope: baselineInfo.envelope, documentId: baselineInfo.envelope.documentId,
        revisionId: baselineInfo.envelope.revisionId, changes: result.changes,
        wholeHtmlChanged: !baselineInfo.exactHtml, replacementEligible: false,
        warnings: []
      };
      if (result.changes.systemOnly) output.warnings.push("Changes to Proofnote system timestamps were ignored; created and updated times remain from the embedded baseline.");
      if (status === "RECOVERED" && result.changes.visualOnly) output.warnings.push("No ProofNote content changes detected; external visual-only changes were ignored.");
      if (result.changes.highDeletion) output.warnings.push("This editable HTML removes " + result.changes.deleted + " of " + (baseline.blocks || []).length + " baseline blocks. Review the recovered document before continuing.");
      if (current) {
        const currentLineage = protocolLineage(current);
        if (currentLineage && currentLineage === output.documentId) {
          const currentRevision = await revisionIdForDocument(current);
          if (currentRevision && currentRevision === output.revisionId) {
            output.replacementEligible = true;
          } else {
            output.status = "STALE";
            output.replacementEligible = false;
            output.warnings.push("The current Proofnote document has changed since this editable HTML baseline. Import it as a new document instead of overwriting.");
          }
        } else {
          output.warnings.push("This editable HTML belongs to a different Proofnote document lineage, so it can only be imported as a new document.");
        }
      }
      return output;
    } catch (error) {
      if (error && error.code) return invalid(error.code, error.message || "Editable HTML could not be imported.", error.help || "");
      return invalid("editable-html-error", "Editable HTML could not be imported safely: " + (error && error.message || "unknown error"));
    }
  }

  const api = Object.freeze({
    constants: Object.freeze({ FORMAT, VERSION, MAGIC, SOURCE_ID, SOURCE_TYPE, HASH_PLACEHOLDER, MAX_HTML_BYTES, MAX_SOURCE_BYTES }),
    build, inspect, reconcile, ensureLineage, protocolLineage, revisionIdForDocument,
    stableStringify, richAstFromSource, richAstToSource
  });
  root.ProofnoteEditableHtml = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
