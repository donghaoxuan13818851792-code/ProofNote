# Proof Note editorial rendering QA

**Source visual truth**

- `/Users/donghaoxuan/Desktop/Screenshot 2026-09-14 at 09.50.01.png` — the
  original Proofnote document surface; browser frame excluded from comparison.
- `v0.1.0:index.html` — original `renderHeader()` and `sectionHead()` document
  rules used as the implementation source for the running header, metadata,
  title, summary, and numbered section rhythm.

**Implementation evidence**

- `http://127.0.0.1:4173/` — in-app browser capture on 2026-09-14, desktop
  viewport `1113 × 749` CSS pixels, standard Proof Note document, no block
  selected. The browser-rendered capture showed `PROOFNOTE / SOLUTION NOTE`,
  title, italic summary, metadata row, and numbered `Problem` / `Result`
  sections without card surfaces.
- The source screenshot is `2940 × 1912` pixels and includes browser chrome;
  comparison used the document-paper region and normalized for those frame and
  density differences rather than comparing the surrounding app shell.

**State and interaction checks**

- Proof Note template on the single editable paper canvas.
- No hover or selection chrome shown, so the canvas can be compared to an
  exported document surface.
- Local service running at `127.0.0.1:4173`; browser console had no errors.
- Semantic blocks can use an Inspector-only `Editorial` or `Card` presentation;
  the Proof Note template defaults to Editorial.

**Findings**

No actionable P0, P1, or P2 visual differences remain for the requested
editorial-document direction.

- [P3] Empty metadata uses an em dash until the author, date, or status is
  supplied. This is intentional: it preserves the old metadata grid without
  inventing user content in a new document.
- [P3] The navigation width shown in the capture was user-resized. The paper
  proportionally scales to the remaining space by design and returns to its
  normal measure when the divider is reset.

**Required fidelity surfaces**

- **Fonts and typography:** Cormorant Garamond governs running labels, title,
  summary, headings, and metadata labels; Lora governs body text. The original
  title, summary, body, label, and section scale is shared by canvas and HTML
  export.
- **Spacing and layout rhythm:** Restored title → summary → rule → metadata;
  restored numbered section rules and compact continuous flow. The document is
  not composed of large semantic cards.
- **Colours and tokens:** White paper and restrained ink dominate; the warm
  accent is confined to running labels, section numbers, and status.
- **Image quality and asset fidelity:** No image assets are present in the
  target state; no substitute imagery or generated visual assets were added.
- **Copy and app text:** The running header is template-controlled (`Proofnote`
  and `Solution Note`) rather than a global generic-document watermark.

**Comparison history**

1. The prior state mixed restored editorial type with beige semantic cards.
2. Replaced Proof Note’s default semantic-card path with editorial sections,
   reintroduced the original running header and metadata grid, and kept Card as
   an explicit optional presentation.
3. Rechecked the live canvas at the local URL. The visible document follows the
   intended publication-style hierarchy; no P0/P1/P2 fixes remain.

**Implementation checklist**

- [x] Reuse original Proofnote document proportions and section-rule language.
- [x] Keep the flexible block model beneath the Proof Note renderer.
- [x] Keep cards optional rather than default for Proof Note semantic blocks.
- [x] Verify direct-edit canvas, export path wiring, browser console, and test
  suite.

final result: passed
