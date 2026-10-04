export {
  getActiveSlice,
  createSlice,
  closeSlice,
  getSlicePath,
  sliceIdToRelPath,
  sliceIdToFilePath,
  getIndexPath,
  getStrandsPath,
  serializeSlice,
  parseSlice,
  serializeIndex,
  serializeStrands,
  appendTurn,
  readSliceIndex,
  readStrands,
  readSliceBody,
  loadSlice,
  toIndexEntry,
  updateMonthlyIndex,
  updateStrands,
  setActiveSlice,
  clearActiveSlice,
  tryLoadTodaySlice,
  saveSliceSnapshot,
  ensureIndexEntries,
  sliceIdToAgentPath,
  writeAgentTimeline,
  readAgentTimeline,
  sliceIdToPreviouslyPath,
  readPreviously,
  writePreviously,
  findMostRecentPreviously,
  ensurePreviously,
  emptyPreviouslyTemplate,
  CURRENT_PREVIOUSLY_PATH,
  readCurrentPreviously,
  writeCurrentPreviously,
} from "./manager";
export {
  RECORDS_ROOT,
  LEGACY_SLICES_ROOT,
  sliceDir,
  slicePartPath,
  slicePartPathCandidates,
  legacySlicePartPath,
  recordsIndexPath,
  legacyIndexPath,
  indexPathCandidates,
  readSlicePart,
  readSlicePartResolved,
} from "./paths";
export type { SlicePart } from "./paths";
// NOTE: sliceIdToLegacyFilePath was removed in v0.5 — old flat-file format
//       support dropped. Use sliceIdToFilePath instead.
// NOTE: sliceIdToTimelineDir was removed in v0.19 R2 — the records layout is
//       flat (no timeline/ level). Use sliceDir / slicePartPath from ./paths.
//
// NOTE: maintenance.ts v1 types (SliceMetadata, applyMetadataUpdates) were
//       removed in v0.5.1. Card maintenance / updater passes were removed in
//       v0.8 — card writes are mutation-tool based (card-session.ts), owned
//       by the Previously Agent end to end.

export {
  analyzeTurn,
  shouldRunCardEvolution,
} from "./flash/turn-analyzer";
export type {
  TurnAnalysis,
  SemanticHint,
  ClosedMarking,
  AnalyzeTurnInput,
} from "./flash/turn-analyzer";

// ─── v0.19: the projection writers are retired (R3) — the global timeline,
// the strand-consolidator, the backfill pass, the timeline weave, and the
// markdown projection (render.ts) are gone. What remains of the timeline/
// directory: store.ts (the live per-slice header read), paginate.ts,
// enumerate.ts, types. ───────────────────────────────────────────────────
export { sliceEntryFromDisk } from "./timeline/store";
export type { TimelineSliceEntry } from "./timeline/types";

export {
  createBatch,
  flushBatch,
} from "./io-helpers";
export type { WriteBatch } from "./io-helpers";

export {
  checkSliceAge,
  checkIdleGap,
  sliceCloseClass,
  SLICE_CLOSE_CLASS,
} from "./slicer";
export type { SliceCloseClass } from "./slicer";

export {
  normalizeStrandKey,
  findMatchingStrand,
  weaveTag,
  applyStrandMerges,
  pruneStrands,
  slicePathToMs,
} from "./strands";
export {
  deterministicSliceMark,
} from "./slice-mark";
export type {
  SliceMark,
} from "./slice-mark";
export type {
  PruneOptions,
} from "./strands";

export {
  STRANDS_DIR,
  TOPIC_DIR,
  getStrandFilePath,
  getTopicDocPath,
  serializeStrandEntity,
  parseStrandEntity,
  readStrandEntity,
  readTopicDoc,
  strandEntityToTopicDoc,
  topicDocToStrandEntity,
  listStrandEntityNames,
  resolveStrandEntityName,
} from "./strand-files";
export type {
  StrandEntity,
} from "./strand-files";

export type {
  SliceStatus,
  SlicingSignal,
  EmotionalTone,
  Turn,
  SliceFrontmatter,
  TimeSlice,
  SliceIndexEntry,
  MonthlyIndex,
  StrandIndex,
} from "./types";
