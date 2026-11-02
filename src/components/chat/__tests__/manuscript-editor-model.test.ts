import { describe, expect, it } from "vitest";
import { atomicDeletion, createManuscriptHistory, manuscriptAtoms, manuscriptSelection, replaceManuscriptRange,
  type ManuscriptSelection, type ManuscriptSnapshot } from "../manuscript-editor-model";

const bindings = [{ id: "local-one", assetId: `img_${"a".repeat(32)}`, ordinal: 1 }];
const range = (start: number, end = start): ManuscriptSelection => ({ start, end, direction: start === end ? "none" : "forward" });
const snapshot = (text: string, at = text.length): ManuscriptSnapshot => ({ text, selection: range(at) });

describe("atomic manuscript model", () => {
  it("resolves only uploaded, unambiguous identities and leaves unknown/forged text alone", () => {
    const text = "before 〔图1〕 〔图2〕 〔图01〕 〔图3〕 after";
    expect(manuscriptAtoms(text, [...bindings, { id: "pending", ordinal: 2 }, { id: "forged", ordinal: 3, assetId: "drafts/anything" }]))
      .toEqual([{ ...bindings[0], start: 7, end: 11 }]);
    expect(manuscriptAtoms(text, [...bindings, { ...bindings[0], assetId: `img_${"b".repeat(32)}` }])).toEqual([]);
  });

  it.each([true, false])("deletes an adjacent whole badge without eating prose (backward=%s)", backward => {
    const text = "left〔图1〕right";
    const deletion = atomicDeletion(text, range(backward ? 8 : 4), bindings, backward);
    expect(deletion).toEqual({ start: 4, end: 8, direction: "none" });
    expect(replaceManuscriptRange({ text, selection: deletion! }, "", bindings)).toEqual(snapshot("leftright", 4));
    expect(bindings).toHaveLength(1); // prose edits have no attachment mutation channel
  });

  it("expands a partial selection to the badge boundary, preserving unselected letters", () => {
    expect(replaceManuscriptRange({ text: "left〔图1〕right", selection: range(6, 9) }, "X", bindings))
      .toEqual(snapshot("leftXight", 5));
    expect(manuscriptSelection("a〔图1〕b", range(2), manuscriptAtoms("a〔图1〕b", bindings))).toEqual(range(1));
  });

  it("does not intercept ordinary grapheme deletion or unknown markers", () => {
    expect(atomicDeletion("words", range(3), bindings, true)).toBeNull();
    expect(atomicDeletion("〔图2〕", range(4), bindings, true)).toBeNull();
  });

  it("inserts a photo marker after selected prose and normalizes only line endings", () => {
    expect(replaceManuscriptRange({ text: "keep this sentence", selection: range(0, 9) }, "〔图1〕", bindings, true))
      .toEqual(snapshot("keep this〔图1〕 sentence", 13));
    expect(replaceManuscriptRange(snapshot(""), "<script>literal</script>\r\nline", bindings).text)
      .toBe("<script>literal</script>\nline");
  });

  it("undo/redo includes the entire atomic operation and its prior selection", () => {
    const history = createManuscriptHistory(snapshot("left〔图1〕right", 8));
    const deleted = atomicDeletion(history.get().text, history.get().selection, bindings, true)!;
    history.commit(replaceManuscriptRange({ ...history.get(), selection: deleted }, "", bindings));
    expect(history.undo()).toEqual(snapshot("left〔图1〕right", 8));
    expect(history.redo()).toEqual(snapshot("leftright", 4));
  });

  it("acceptance clears old history without discarding the new draft or its caret", () => {
    const history = createManuscriptHistory(snapshot("submitted"));
    history.commit(snapshot("new draft", 3));
    history.reset(history.get());
    expect(history.undo()).toBeNull();
    expect(history.get()).toEqual(snapshot("new draft", 3));
    history.commit(snapshot("new draft!"));
    expect(history.undo()?.text).toBe("new draft");
    expect(history.undo()).toBeNull();
  });

  it("scope replacement clears undo and redo, with independent snapshot objects", () => {
    const history = createManuscriptHistory(snapshot("persona A"));
    history.commit(snapshot("A draft")); history.undo();
    history.reset(snapshot("persona B"));
    expect(history.redo()).toBeNull(); expect(history.undo()).toBeNull();
    const copy = history.get(); copy.selection.start = 0;
    expect(history.get().selection.start).toBe(9);
  });

  it("bounds the history and drops redo when a new edit branches", () => {
    const history = createManuscriptHistory(snapshot("0"), 2);
    for (const text of ["1", "2", "3"]) history.commit(snapshot(text));
    expect(history.undo()?.text).toBe("2"); expect(history.undo()?.text).toBe("1"); expect(history.undo()).toBeNull();
    history.commit(snapshot("branch")); expect(history.redo()).toBeNull();
  });
});
