# Escaping & security model

## LaTeX backslashes in JSON (`\u005C`)

In the Solution Note interchange format, **no literal LaTeX backslash ever
appears in the JSON source**. Every math backslash is written as the JSON
Unicode escape `\u005C`:

```json
"body": "For \u005C(n \u005Cge 1\u005C), we have \u005C(F_n>0\u005C)."
```

`JSON.parse` turns each `\u005C` into a single `\`, so KaTeX receives correct
TeX. This is what makes the format paste-safe (no raw backslashes to break JSON
parsing) and lets the validator give precise, actionable diagnostics.

**Code fields are the exception.** In `reproduce.sourceCode` /
`verificationScript` / `data`, backslashes are source-code content and use
ordinary JSON escaping:

```json
"sourceCode": "import re\npattern = r\"\\d+\""
```

Never write `\u005Cd+` in a code field.

## HTML escaping

All user text is escaped before it is placed anywhere in the DOM or in the
exported document. `escapeHtml` escapes:

```
&  → &amp;
<  → &lt;
>  → &gt;
"  → &quot;
'  → &#39;
```

Attribute contexts (e.g. `title="..."`) are covered because quotes are escaped.

## Markdown links (`safeHref`)

Markdown `[label](url)` links are rendered only after passing through
`safeHref`, which allows only `http:`, `https:` and `mailto:`:

```
[x](javascript:alert(1))   → <a href="#">x</a>
[x](https://ok.com?a=1)    → <a href="https://ok.com?a=1">x</a>
```

Executable schemes (`javascript:`, `data:`, `vbscript:`, …) collapse to `#`,
case-insensitively.

## KaTeX

KaTeX is invoked with `trust: false` and `throwOnError: true`; user text is
never interpreted as KaTeX options or HTML.

## Prototype pollution

Imported JSON is stripped of `__proto__`, `prototype` and `constructor` keys
(`stripUnsafeKeys`) before any merge (`deepMergeKnown`), at every entry point.

## Content blocks

Imported content-block arrays are coerced by type whitelist
(`normalizeBlock`): unknown types become empty paragraphs, every field is
type-checked, and rendered output goes through the escaping rules above.
