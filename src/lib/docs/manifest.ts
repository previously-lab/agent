/**
 * Docs manifest — the single source for the /docs nav, routing, and static
 * params. Markdown bodies live in `content/docs/{locale}/{slug}.md`; this file
 * owns their ordering, section grouping, and localized titles (the markdown
 * itself carries no frontmatter).
 */

export type Locale = "en" | "zh";

export type DocSection = {
  id: string;
  title: Record<Locale, string>;
};

export type DocPage = {
  slug: string;
  section: string;
  title: Record<Locale, string>;
};

export const DOC_SECTIONS: DocSection[] = [
  { id: "overview", title: { en: "Overview", zh: "概览" } },
  { id: "concepts", title: { en: "Concepts", zh: "核心概念" } },
  { id: "guides", title: { en: "Guides", zh: "指南" } },
  { id: "reference", title: { en: "Reference", zh: "参考" } },
];

export const DOC_PAGES: DocPage[] = [
  { slug: "introduction", section: "overview", title: { en: "Introduction", zh: "简介" } },
  { slug: "why", section: "overview", title: { en: "Why Previously", zh: "为什么是 Previously" } },
  { slug: "timeline", section: "concepts", title: { en: "The Timeline", zh: "时间线" } },
  { slug: "slices", section: "concepts", title: { en: "Slices", zh: "切片（Slice）" } },
  { slug: "strands", section: "concepts", title: { en: "Strands", zh: "线索（Strand）" } },
  { slug: "memory-model", section: "concepts", title: { en: "Memory Model", zh: "记忆模型" } },
  { slug: "recall", section: "concepts", title: { en: "Recall", zh: "回忆（Recall）" } },
  { slug: "getting-started", section: "guides", title: { en: "Getting Started", zh: "快速上手" } },
  { slug: "deployment", section: "guides", title: { en: "Deployment", zh: "部署" } },
  { slug: "configuration", section: "reference", title: { en: "Configuration", zh: "配置" } },
  { slug: "architecture", section: "reference", title: { en: "Architecture", zh: "架构" } },
  { slug: "faq", section: "reference", title: { en: "FAQ", zh: "常见问题" } },
];

export const DEFAULT_DOC_SLUG = "introduction";

export function getDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((p) => p.slug === slug);
}

export type DocNavGroup = { section: DocSection; pages: DocPage[] };

export function getDocsNav(): DocNavGroup[] {
  return DOC_SECTIONS.map((section) => ({
    section,
    pages: DOC_PAGES.filter((p) => p.section === section.id),
  })).filter((group) => group.pages.length > 0);
}
