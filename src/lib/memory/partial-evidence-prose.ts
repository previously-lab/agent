interface ProseRange { start: number; text: string }

const privateHeading = /^(?:(?:internal|private|agent[- ]only|assistant[- ]only|scratchpad)\b|(?:working|agent|researcher) notes?\b|(?:内部|私有|私密)(?:备注|笔记|记录|指令)|模型思考|原始对话|原文记录|(?:conversation transcript|raw conversation|turn \d+)\b|(?:references|source links|navigation|related cases)\s*$|参考链接|相关档案)/i;
const transcriptLine = /^\s*(?:user|assistant|system|tool|用户|助手)[：:]/i;
const citationTail = /(?:[ \t]*(?:\[\[[^\]\r\n]+\]\]|\[[^\]\r\n]*\]\([^()\r\n]+\)|\(ref:\s*[^()\r\n]+\)))+[ \t]*[.。]?[ \t]*$/i;
const navigationLine = /previously:|\[\[|\]\(|(?:^|[\s(:：])(?:records|memory)\/|^\s*(?:[-*]|\d+\.)?\s*\[(?:ref:|cited slice)/i;
const machineText = /^(?:SOURCE NAVIGATION ONLY|TURN NAVIGATION ONLY|CASE PIECES —|ARCHIVED —|CURRENT UNDERSTANDING|CURRENT-VIEW HISTORY|PRESERVED HISTORICAL INDEX|HISTORICAL SOURCE|FRESHNESS WARNING|ERROR:|—— 尾部 ——|---\s*$)|(?:^\s*[{[]\s*"|PREVIOUSLY_(?:CASE|THINKING)_READ|^\s*(?:as-of|evidence|scopeId|toolCallId|recordLeads|cardTargets):)/im;

/** Every yielded block remains a contiguous substring of the host-returned text. */
function publicRanges(raw: string): ProseRange[] {
  if (raw.length > 96_000) return [];
  const blocks: ProseRange[] = [];
  let start = -1, end = 0, offset = 0;
  let hiddenDepth = 0;
  let fence = "";
  let comment = false;
  const flush = () => {
    if (start < 0) return;
    const slice = raw.slice(start, end);
    const text = slice.trim();
    if (text) blocks.push({ start: start + slice.length - slice.trimStart().length, text });
    start = -1;
  };
  for (const line of raw.split(/(?<=\n)/)) {
    const lineStart = offset;
    offset += line.length;
    const content = line.trim();
    if (fence) {
      if (content.length >= fence.length && [...content].every(char => char === fence[0])) fence = "";
      continue;
    }
    if (comment || content.includes("<!--")) {
      flush();
      comment = line.lastIndexOf("<!--") > line.lastIndexOf("-->") ||
        (comment && !line.includes("-->"));
      continue;
    }
    const marker = /^(```+|~{3,})/.exec(content);
    if (marker) { flush(); fence = marker[1]!; continue; }
    // Arbitrary HTML may span headings or paragraphs; its boundaries are not Markdown.
    if (/<\/?[a-z][\w:-]*(?=[\s/>])|<![A-Z]/i.test(content)) return [];
    const heading = /^(#{1,6})\s+(.+)$/.exec(content);
    if (heading && heading[1]!.length <= hiddenDepth) hiddenDepth = 0;
    if (hiddenDepth) continue;
    const label = (heading?.[2] ?? content).replace(/^\*{1,2}/, "");
    const privateLabel = (heading || /^[^:：]{1,50}[:：]/.test(label)) && privateHeading.test(label);
    if (privateLabel || transcriptLine.test(content)) {
      flush();
      hiddenDepth = heading?.[1]!.length ?? 1;
      continue;
    }
    if (machineText.test(content) || /^\s*>/.test(line)) { flush(); continue; }
    const citation = citationTail.exec(line.trimEnd());
    if (citation) {
      const prefix = line.slice(0, citation.index).trimEnd();
      // A standalone navigation bullet or an inline link in the middle of the assertion has no attributable answer.
      if (/[.!?。！？]$/.test(prefix) && !navigationLine.test(prefix)) {
        if (start < 0) start = lineStart;
        end = lineStart + prefix.length;
      }
      flush();
      continue;
    }
    if (navigationLine.test(content)) { flush(); continue; }
    if (start < 0) start = lineStart;
    end = offset;
  }
  flush();
  return blocks;
}

export function partialEvidenceProse(raw: string): string[] {
  return publicRanges(raw).map(range => range.text);
}

/** Search windows may have lost a private heading. Check the same literal offsets in the complete document. */
export function permitsPartialSearchExcerpt(body: string, excerpt: string): boolean {
  if (!excerpt || body.length > 96_000) return false;
  const at = body.indexOf(excerpt);
  if (at < 0 || body.lastIndexOf(excerpt) !== at) return false;
  const full = publicRanges(body);
  const cropped = publicRanges(excerpt);
  return cropped.length > 0 && cropped.every(range => {
    const start = at + range.start;
    const end = start + range.text.length;
    return full.some(allowed => allowed.start <= start && end <= allowed.start + allowed.text.length);
  });
}
