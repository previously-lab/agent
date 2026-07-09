export {
  getActiveSlice,
  createSlice,
  closeSlice,
  getSlicePath,
  sliceIdToRelPath,
  sliceIdToFilePath,
  getIndexPath,
  getTagIndexPath,
  serializeSlice,
  parseSlice,
  serializeIndex,
  serializeTagIndex,
  appendTurn,
  readSliceIndex,
  readTagIndex,
  readSliceBody,
  toIndexEntry,
  updateMonthlyIndex,
  updateTagIndex,
  setActiveSlice,
  clearActiveSlice,
  tryLoadTodaySlice,
  saveSliceSnapshot,
  ensureIndexEntries,
} from "./manager";

export {
  TIME_SILENCE_THRESHOLD_MS,
  checkTimeSilence,
} from "./slicer";

export type {
  SliceStatus,
  SlicingSignal,
  EmotionalTone,
  Turn,
  SliceFrontmatter,
  TimeSlice,
  SliceIndexEntry,
  MonthlyIndex,
  TagIndex,
} from "./types";
