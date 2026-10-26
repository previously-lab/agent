/** The current-view chrome's bilingual strings — a LOCAL module: the shared
 *  messages JSON is owned by another lane and stays untouched. Only the new
 *  chrome strings live here; the paper's own furniture remains fixed
 *  English (the v0.28 ruling — the document's surroundings are not
 *  translated). */

export interface DeskCurrentTexts {
  readingViews: string;
  viewCurrent: string;
  viewOriginal: string;
  viewHistory: string;
  asOf(date: string): string;
  asOfMissing: string;
  indexChanged: string;
  freshnessUnknown: string;
  sourcesHeading: string;
  evidenceMissing: string;
  unavailable: string;
  sourceLabel(index: number): string;
  sourceAriaLabel(index: number, ref: string): string;
}

const EN: DeskCurrentTexts = {
  readingViews: "Reading views",
  viewCurrent: "Current",
  viewOriginal: "Original",
  viewHistory: "Earlier",
  asOf: (date) => `Understanding as of ${date}; later changes may not be included.`,
  asOfMissing: "Understanding with no as-of date; later changes may not be included.",
  indexChanged: "The original index changed after this understanding was written.",
  freshnessUnknown: "No comparison with later case changes was recorded.",
  sourcesHeading: "Evidence sources",
  evidenceMissing: "No evidence sources were recorded for this understanding.",
  unavailable: "The current understanding could not be read; the original is shown.",
  sourceLabel: (index) => `Source ${index}`,
  sourceAriaLabel: (index, ref) => `Open source ${index}: ${ref}`,
};

const ZH: DeskCurrentTexts = {
  readingViews: "阅读视图",
  viewCurrent: "当前",
  viewOriginal: "原稿",
  viewHistory: "早前",
  asOf: (date) => `截至 ${date} 的认识，此后的变动可能未包含。`,
  asOfMissing: "未记录日期的认识，此后的变动可能未包含。",
  indexChanged: "这份认识写就后，原稿已有变动。",
  freshnessUnknown: "未记录与此后档案变动的比对。",
  sourcesHeading: "依据来源",
  evidenceMissing: "这份认识未记录依据来源。",
  unavailable: "当前认识读取失败，现展示原稿。",
  sourceLabel: (index) => `来源 ${index}`,
  sourceAriaLabel: (index, ref) => `打开来源 ${index}：${ref}`,
};

export function deskCurrentTexts(locale: string): DeskCurrentTexts {
  return locale.toLowerCase().startsWith("zh") ? ZH : EN;
}
