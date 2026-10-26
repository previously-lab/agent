/** Desk-specific bilingual chrome. The paper's own furniture remains fixed
 *  English; shared chat actions use the locale message catalogs. */

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
  addWholeDocument: string;
  addSelectedPassage: string;
  selectionTooLong: string;
  relatedHeading: string;
  relatedNotFound: string;
  relatedUnavailable: string;
  locationNotFound: string;
  locationAmbiguous: string;
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
  addWholeDocument: "Reference document",
  addSelectedPassage: "Reference selection",
  selectionTooLong: "Select a shorter passage (up to 1,200 characters).",
  relatedHeading: "Related documents",
  relatedNotFound: "Not found",
  relatedUnavailable: "Unavailable to open",
  locationNotFound: "The requested source passage could not be found.",
  locationAmbiguous: "The requested turn is shared by both speakers; choose its speaker.",
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
  addWholeDocument: "引用文档",
  addSelectedPassage: "引用选段",
  selectionTooLong: "请选择更短的段落（最多 1,200 个字符）。",
  relatedHeading: "相关文档",
  relatedNotFound: "未找到",
  relatedUnavailable: "暂时无法打开",
  locationNotFound: "无法在这份记录中找到指定的原文位置。",
  locationAmbiguous: "这个回合同时属于双方，请指定说话人以准确定位。",
};

export function deskCurrentTexts(locale: string): DeskCurrentTexts {
  return locale.toLowerCase().startsWith("zh") ? ZH : EN;
}
