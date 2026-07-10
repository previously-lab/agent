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
  toIndexEntry,
  updateMonthlyIndex,
  updateStrands,
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
  StrandIndex,
} from "./types";
