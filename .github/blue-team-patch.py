from pathlib import Path

editor = Path("src/document-editor.js")
s = editor.read_text()


def insert_once_within(fn_marker, next_fn_marker, target, insertion, sentinel):
    global s
    start = s.index(fn_marker)
    end = s.index(next_fn_marker, start)
    segment = s[start:end]
    if sentinel in segment:
        return
    if target not in segment:
        raise SystemExit("target not found in " + fn_marker)
    segment = segment.replace(target, insertion + target, 1)
    s = s[:start] + segment + s[end:]


# Flush again immediately before each document activation/transition. This
# catches edits made while the awaited storage operation itself was in flight.
insert_once_within(
    "  async function createNewProject() {",
    "\n  function chooseNewDocument()",
    "    closeNewProject();\n",
    '    const finalSaved = await saveActiveDocumentNow();\n'
    '    if (finalSaved === "failed") { setStatus(tr("新建期间产生的编辑无法保存；新项目已创建但尚未打开，请先导出当前文档备份。", "Edits made while creating the project could not be saved; the project was created but not opened. Export the current document first."), "error"); return; }\n',
    "const finalSaved = await saveActiveDocumentNow();"
)
insert_once_within(
    "  async function useSelectedTemplate(templateId) {",
    "\n  async function openLibraryDocument(id) {",
    "    selectedTemplateId = template.template.id;\n",
    '    const finalSaved = await saveActiveDocumentNow();\n'
    '    if (finalSaved === "failed") { setStatus(tr("创建期间产生的编辑无法保存；新文档已创建但尚未打开，请先导出当前文档备份。", "Edits made while creating the document could not be saved; the new document was created but not opened. Export the current document first."), "error"); return; }\n',
    "const finalSaved = await saveActiveDocumentNow();"
)
insert_once_within(
    "  async function openLibraryDocument(id) {",
    "\n  async function finishDocumentRename(id, name) {",
    "    await activateDocument(opened.record);\n",
    '    const finalSaved = await saveActiveDocumentNow();\n'
    '    if (finalSaved === "failed") { setStatus(tr("切换期间产生的编辑无法保存；请导出当前文档备份后重试。", "Edits made during the switch could not be saved; export the current document and try again."), "error"); return; }\n',
    "const finalSaved = await saveActiveDocumentNow();"
)
insert_once_within(
    "  async function duplicateLibraryDocument(id) {",
    "\n  async function openRemainingDocumentAfterDeletion() {",
    "    await activateDocument(duplicate.record, { status: false });\n",
    '    const finalSaved = await saveActiveDocumentNow();\n'
    '    if (finalSaved === "failed") { setStatus(tr("复制期间产生的编辑无法保存；副本已创建但尚未打开，请先导出当前文档备份。", "Edits made during duplication could not be saved; the copy was created but not opened. Export the current document first."), "error"); return; }\n',
    "const finalSaved = await saveActiveDocumentNow();"
)

# Import has an earlier closeImport() in the template branch. Anchor on the
# document creation result so the extra flush lands only in the document path.
import_start = s.index("  async function importFromDialog() {")
import_end = s.index("\n  async function initialise() {", import_start)
import_segment = s[import_start:import_end]
if "const finalSaved = await saveActiveDocumentNow();" not in import_segment:
    old = '''    const created = await Store.createDocument(next);
    if (!created || !created.record || created.backend === "failed") { showImportMessage(tr("导入文档无法保存到此设备。", "The imported document could not be saved on this device."), "error"); return; }
    closeImport();
'''
    new = '''    const created = await Store.createDocument(next);
    if (!created || !created.record || created.backend === "failed") { showImportMessage(tr("导入文档无法保存到此设备。", "The imported document could not be saved on this device."), "error"); return; }
    const finalSaved = await saveActiveDocumentNow();
    if (finalSaved === "failed") { showImportMessage(tr("导入期间产生的当前文档编辑无法保存；导入文件已保存为新文档，但尚未打开。请先导出当前文档备份。", "Edits to the current document made during import could not be saved. The imported file was saved as a new document but was not opened. Export the current document first."), "error"); return; }
    closeImport();
'''
    if old not in import_segment:
        raise SystemExit("document import activation anchor not found")
    s = s[:import_start] + import_segment.replace(old, new, 1) + s[import_end:]

# Reconcile a current-document rename into the live state instead of replacing
# the entire state with the older persisted snapshot. This preserves body edits
# made while the asynchronous rename was in flight.
rename_start = s.index("  async function finishDocumentRename(id, name) {")
rename_end = s.index("\n  async function duplicateLibraryDocument(id) {", rename_start)
rename_segment = s[rename_start:rename_end]
if "const persisted = Model.normalizeDocument(renamed.record.document" not in rename_segment:
    old = '''    if (id === currentDocumentId) {
      state = Model.normalizeDocument(renamed.record.document, { allowRemoteImages: true });
      editRevision = 0;
      hasUnsavedChanges = false;
      renderAll();
      root.requestAnimationFrame(syncCanvasScale);
    }
'''
    new = '''    if (id === currentDocumentId) {
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
      if (reconciled === "failed") {
        setStatus(tr("重命名已写入，但并发编辑无法保存；请立即导出备份。", "Rename was written, but concurrent edits could not be saved; export a backup now."), "error");
        return;
      }
      renderAll();
      root.requestAnimationFrame(syncCanvasScale);
    }
'''
    if old not in rename_segment:
        raise SystemExit("current rename reconciliation block not found")
    s = s[:rename_start] + rename_segment.replace(old, new, 1) + s[rename_end:]

# Fix a small user-facing typo while touching the import path.
s = s.replace("樁板无法保存到此设备；请释放存储空间后重试。", "模板无法保存到此设备；请释放存储空间后重试。")
editor.write_text(s)

store = Path("src/document-store.js")
s = store.read_text()
save_start = s.index("    async saveDocument(id, document) {")
save_end = s.index("\n    async renameDocument(id, name) {", save_start)
save_segment = s[save_start:save_end]
if 'if (!id || !existing) return "failed";' not in save_segment:
    new_save = '''    async saveDocument(id, document) {
      return useStorageSession(async () => {
        if (!id) return "failed";
        const library = await readIndexedLibrary();
        const existing = library.records.find((record) => record.id === id);
        // saveDocument updates an established local identity. Creation belongs
        // exclusively to createDocument; otherwise a stale tab can recreate a
        // record that was intentionally deleted elsewhere.
        if (!existing) return "failed";
        const record = recordFor(document, existing);
        record.id = id;
        record.lastOpenedAt = existing.lastOpenedAt || record.lastOpenedAt;
        // Saving a background record must not silently switch the current
        // document. The open/create operations own current-document changes.
        await writeIndexedLibrary({ put: [record], currentId: library.currentId || record.id });
        return "indexeddb";
      }, () => {
        if (!id) return "failed";
        const library = fallbackLibrary(null);
        const index = library.records.findIndex((record) => record.id === id);
        if (index < 0) return "failed";
        const record = recordFor(document, library.records[index]);
        record.id = id;
        library.records[index] = record;
        if (library.currentId === record.id) library.current = record;
        return persistFallbackLibrary(library) ? "localStorage" : "failed";
      }, "failed");
    },
'''
    s = s[:save_start] + new_save + s[save_end:]
store.write_text(s)

blue = Path("tests/blue-team.js")
t = blue.read_text()
if "store-save-cannot-resurrect-deleted-local-identity" not in t:
    anchor = "  const indexedDB = new IDBFactory();\n"
    regression = '''  const staleFallbackStore = loadStore({ localStorage: memoryStorage() });
  const staleFallbackCreated = await staleFallbackStore.createDocument(documentWith([], { name: "Disposable fallback" }));
  await staleFallbackStore.deleteDocument(staleFallbackCreated.record.id);
  const staleFallbackSave = await staleFallbackStore.saveDocument(staleFallbackCreated.record.id, documentWith([], { name: "Should stay deleted" }));
  const staleFallbackRecords = await staleFallbackStore.listDocuments();
  check(
    "store-save-cannot-resurrect-deleted-local-identity",
    staleFallbackSave === "failed" && !staleFallbackRecords.some((record) => record.id === staleFallbackCreated.record.id)
  );

'''
    if anchor not in t:
        raise SystemExit("blue-team IndexedDB anchor not found")
    t = t.replace(anchor, regression + anchor, 1)
blue.write_text(t)

tests = Path("tests/document-editor.js")
t = tests.read_text()
# The implementation changed from replacing the full live Project state to
# reconciling only canonical name/chrome fields. Keep the existing behavioral
# assertion and update its implementation sentinel accordingly.
t = t.replace(
    'editorSource.includes("state = Model.normalizeDocument(renamed.record.document, { allowRemoteImages: true })")',
    'editorSource.includes("const persisted = Model.normalizeDocument(renamed.record.document, { allowRemoteImages: true })") && editorSource.includes("const reconciled = await saveActiveDocumentNow()")'
)

# Add a non-stateful ordering regression. The existing editor test is a long
# shared-DOM scenario, so mutating the active document again here makes later
# tests depend on whichever document happened to be selected. Slice the source
# instead and assert the important ordering around every transition.
if "editor-document-transitions-final-flush-before-activation" not in t:
    anchor = "    // Duplicating a different library row still activates the new copy. Make\n"
    regression = '''    const functionSlice = (startMarker, endMarker) => {
      const start = editorSource.indexOf(startMarker);
      const end = editorSource.indexOf(endMarker, start + startMarker.length);
      return start >= 0 && end > start ? editorSource.slice(start, end) : "";
    };
    const openTransitionSource = functionSlice("async function openLibraryDocument", "async function finishDocumentRename");
    const duplicateTransitionSource = functionSlice("async function duplicateLibraryDocument", "async function openRemainingDocumentAfterDeletion");
    const createTransitionSource = functionSlice("async function createNewProject", "function chooseNewDocument");
    const templateTransitionSource = functionSlice("async function useSelectedTemplate", "async function openLibraryDocument");
    const orderedFinalFlush = (source, awaitedOperation, activation) => {
      const operationIndex = source.indexOf(awaitedOperation);
      const flushIndex = source.lastIndexOf("const finalSaved = await saveActiveDocumentNow();");
      const activationIndex = source.indexOf(activation);
      return operationIndex >= 0 && flushIndex > operationIndex && activationIndex > flushIndex;
    };
    check(
      "editor-document-transitions-final-flush-before-activation",
      orderedFinalFlush(openTransitionSource, "await Store.openDocument", "await activateDocument")
        && orderedFinalFlush(duplicateTransitionSource, "await Store.duplicateDocument", "await activateDocument")
        && orderedFinalFlush(createTransitionSource, "await Store.createDocument", "await activateDocument")
        && orderedFinalFlush(templateTransitionSource, "await Store.createDocument", "await activateDocument"),
      "document transitions must flush edits that arrive while storage operations are in flight"
    );

'''
    if anchor not in t:
        raise SystemExit("transition regression anchor not found")
    t = t.replace(anchor, regression + anchor, 1)
tests.write_text(t)
