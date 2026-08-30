// 3.1.0-rc.1 stress-test corpus — 5 realistic end-to-end cases (user-provided).
//
// Reuse these whenever bumping versions: each case covers one failure class
// that users actually hit in the wild:
//
//   1. fully valid pure math            -> must import cleanly, zero warnings
//   2. raw LaTeX backslash in JSON      -> must be BLOCKED: JSON_INVALID_ESCAPE
//                                          + LATEX_BACKSLASH_NOT_ENCODED,
//                                          suggestion must name the FULL command
//                                          (e.g. \sqrt, not \s)
//   3. code backslash (regex \d+)       -> must import cleanly; code backslashes
//                                          use ordinary JSON escaping, never
//                                          the \u005C LaTeX convention
//   4. valid JSON, invalid schema enums -> must import WITH 2 warnings
//                                          (meta.status, core.result.type),
//                                          values preserved, NOT auto-modified
//   5. trailing comma                   -> must be BLOCKED: JSON_TRAILING_COMMA,
//                                          and NOT misdiagnosed as a LaTeX issue
//
// Stored as String.raw template literals so every backslash in the fixtures is
// literal — the text here is byte-for-byte what the importer would receive.
"use strict";

const CASES = [
  {
    name: "stress-1-valid-pure-math",
    text: String.raw`{
  "format": "solution-note",
  "version": "1.0",
  "meta": {
    "title": "A Simple Quadratic Identity",
    "summary": "For every real number \u005C(x\u005C), the quantity \u005C((x-1)^2\u005C) is nonnegative.",
    "author": "Jason Dong",
    "status": "Solved"
  },
  "core": {
    "problem": "Prove that \u005C(x^2-2x+1\u005Cge0\u005C) for every \u005C(x\u005Cin\u005Cmathbb{R}\u005C).",
    "result": {
      "type": "Theorem",
      "statement": "\u005C[\nx^2-2x+1=(x-1)^2\u005Cge0.\n\u005C]",
      "explanation": "The expression is a perfect square and therefore cannot be negative over the real numbers."
    },
    "whyItWorks": [
      {
        "title": "Complete the square",
        "body": "The polynomial factors exactly as \u005C((x-1)^2\u005C)."
      },
      {
        "title": "Squares are nonnegative",
        "body": "For every real \u005C(y\u005C), one has \u005C(y^2\u005Cge0\u005C)."
      }
    ],
    "evidence": "Equality occurs exactly when \u005C(x=1\u005C)."
  }
}`
  },
  {
    name: "stress-2-raw-sqrt-backslash",
    text: String.raw`{
  "format": "solution-note",
  "version": "1.0",
  "meta": {
    "title": "Square Root Encoding Test",
    "summary": "The positive solution is \sqrt{2}.",
    "author": "Jason Dong",
    "status": "Solved"
  },
  "core": {
    "problem": "Solve \u005C(x^2=2\u005C) for positive \u005C(x\u005C).",
    "result": {
      "type": "Formula",
      "statement": "\u005C(x=\u005Csqrt{2}\u005C)",
      "explanation": "The positive square root gives the required solution."
    },
    "whyItWorks": [
      {
        "title": "Squaring",
        "body": "\u005C((\u005Csqrt{2})^2=2\u005C)."
      }
    ],
    "evidence": "Direct substitution verifies the result."
  }
}`
  },
  {
    name: "stress-3-code-backslash-regex",
    text: String.raw`{
  "format": "solution-note",
  "version": "1.0",
  "meta": {
    "title": "Digit Extraction with a Regular Expression",
    "summary": "A regular expression can extract consecutive decimal digits from a text string.",
    "author": "Jason Dong",
    "status": "Computational"
  },
  "core": {
    "problem": "Extract every maximal sequence of decimal digits from a string.",
    "result": {
      "type": "Algorithmic Result",
      "statement": "The regular-expression pattern represented in Python as r\"\\d+\" matches one or more consecutive decimal digits.",
      "explanation": "The pattern uses the regular-expression digit class followed by the one-or-more quantifier."
    },
    "whyItWorks": [
      {
        "title": "Digit class",
        "body": "The regex token used by the implementation matches decimal digits."
      },
      {
        "title": "Repeated matching",
        "body": "The plus quantifier groups consecutive matching digits into maximal runs."
      }
    ],
    "evidence": "Applied to the text \"abc12def345\", the expected matches are \"12\" and \"345\".",
    "reproduce": {
      "sourceCode": "import re\n\ndef extract_digits(text):\n    return re.findall(r\"\\d+\", text)",
      "verificationScript": "assert extract_digits(\"abc12def345\") == [\"12\", \"345\"]\nprint(\"verification passed\")",
      "discussion": "The backslash in the regular expression is source-code content and is escaped using ordinary JSON escaping rather than the LaTeX Unicode convention."
    }
  }
}`
  },
  {
    name: "stress-4-invalid-enums",
    text: String.raw`{
  "format": "solution-note",
  "version": "1.0",
  "meta": {
    "title": "Enum Validation Test",
    "summary": "This note is valid JSON but intentionally contains unsupported schema enum values.",
    "author": "Jason Dong",
    "status": "Completed"
  },
  "core": {
    "problem": "Test whether valid JSON with unsupported enum values is imported with warnings.",
    "result": {
      "type": "Proof",
      "statement": "\u005C(2+2=4\u005C)",
      "explanation": "The mathematical content is not important for this schema test."
    },
    "whyItWorks": [
      {
        "title": "Valid JSON",
        "body": "The complete object is syntactically valid JSON."
      }
    ],
    "evidence": "The test targets schema enum handling rather than JSON parsing."
  }
}`
  },
  {
    name: "stress-5-trailing-comma",
    text: String.raw`{
  "format": "solution-note",
  "version": "1.0",
  "meta": {
    "title": "Mixed Syntax Failure",
    "summary": "For \u005C(n\u005Cge1\u005C), the identity is valid.",
    "author": "Jason Dong",
    "status": "Solved",
  },
  "core": {
    "problem": "Test parser behavior when a trailing comma occurs before a closing brace.",
    "result": {
      "type": "Theorem",
      "statement": "\u005C[\n\u005Csum_{k=1}^{n}1=n.\n\u005C]",
      "explanation": "There are exactly \u005C(n\u005C) summands."
    },
    "whyItWorks": [
      {
        "title": "Counting",
        "body": "The sum contains \u005C(n\u005C) copies of \u005C(1\u005C)."
      }
    ],
    "evidence": "For \u005C(n=4\u005C), the sum is \u005C(1+1+1+1=4\u005C)."
  }
}`
  }
];

module.exports = CASES;
