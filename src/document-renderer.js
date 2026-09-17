/* Shared, reader-facing rendering primitives for the Document Editor.
 *
 * This module deliberately owns the small Markdown and KaTeX surface used by
 * the canvas and standalone export. The editor must never reach through the
 * retired Solution Note test surface (`__snTest`) for publication rendering.
 */
(function (root) {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function safeHref(value) {
    const href = String(value || "").trim();
    return /^(https?:|mailto:)/i.test(href) ? href : "#";
  }

  function math(value, displayMode, messages) {
    const source = String(value || "").trim();
    if (!source) return "";
    const wording = messages || {};
    if (!root.katex || typeof root.katex.renderToString !== "function") {
      return '<span class="math-error" title="' + escapeHtml(wording.missing || "KaTeX not loaded") + '">' + escapeHtml(source) + "</span>";
    }
    try {
      return root.katex.renderToString(source, {
        displayMode: Boolean(displayMode),
        throwOnError: true,
        strict: "warn",
        trust: false,
        output: "htmlAndMathml"
      });
    } catch (error) {
      return '<span class="math-error" title="' + escapeHtml(error && error.message || wording.invalid || "LaTeX syntax error") + '">' + escapeHtml(source) + "</span>";
    }
  }

  function inline(value, messages) {
    if (!value) return "";
    const maths = [];
    const codes = [];
    const tokenized = String(value)
      // Inline code is literal: preserve examples such as `**not bold**`
      // before the lightweight Markdown substitutions below.
      .replace(/`([^`\n]+)`/g, (_, source) => {
        const token = "\uE100" + codes.length + "\uE101";
        codes.push("<code>" + escapeHtml(source) + "</code>");
        return token;
      })
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
        const token = "\uE000" + maths.length + "\uE001";
        maths.push(math(tex, true, messages));
        return token;
      })
      .replace(/\\\(([\s\S]+?)\\\)([.,;:!?])?/g, (_, tex, punctuation) => {
        const token = "\uE000" + maths.length + "\uE001";
        const rendered = math(tex, false, messages);
        maths.push(punctuation ? '<span style="white-space:nowrap">' + rendered + escapeHtml(punctuation) + "</span>" : rendered);
        return token;
      });
    let html = escapeHtml(tokenized);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => '<a href="' + safeHref(href) + '">' + label + "</a>");
    html = html.replace(/_\{([^}]*)\}/g, "<sub>$1</sub>");
    html = html.replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>");
    html = html.replace(/\uE000(\d+)\uE001/g, (_, index) => maths[Number(index)] || "");
    return html.replace(/\uE100(\d+)\uE101/g, (_, index) => codes[Number(index)] || "");
  }

  root.ProofnoteRenderer = Object.freeze({ escapeHtml, safeHref, math, inline });
})(window);
