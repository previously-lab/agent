"use client";

import { Children, cloneElement, createContext, isValidElement, memo, useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import type { Components, ExtraProps } from "react-markdown";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { CodeBlock } from "./code-block";
import { MermaidBlock } from "./mermaid-block";
import { MarkdownBlockquote, extractText } from "@/components/markdown/admonition";
import { remarkCodeFilename } from "@/lib/markdown/remark-code-filename";
import { remarkDocRefs } from "@/lib/markdown/remark-doc-refs";
import { remarkNativeSections } from "@/lib/markdown/remark-native-sections";
import { parseNativeSections, type NativeSection } from "@/lib/markdown/native-sections";
import { repairStreamingMarkdown } from "@/lib/markdown/streaming-display";
import { documentUrlTransform } from "@/lib/markdown/document-url-transform";
import { DocumentLink } from "@/components/documents/document-navigation";
import { parseDocumentLink } from "@/lib/documents/document-link";
import { cn } from "@/lib/utils";
import {
  NativeHtmlBlock,
  type NativeRenderMode,
  type NativeTurnIdentity,
} from "./native-html";
import { useNativeTurnIdentity } from "./native-identity";

export interface DocRefContextValue {
  status: ReadonlyMap<string, boolean>;
  onOpen: (ref: string) => void;
}

export const DocRefContext = createContext<DocRefContextValue | null>(null);
export const DocRefProvider = DocRefContext.Provider;

interface StreamingContextValue {
  active: boolean;
  tailStart: number | null;
  inertLinkOffset: number | null;
}

const StreamingContext = createContext<StreamingContextValue>({
  active: false,
  tailStart: null,
  inertLinkOffset: null,
});

interface NativeRenderContextValue {
  mode: NativeRenderMode;
  identity: NativeTurnIdentity;
  ordinalOffset: number;
  onRetry?: () => void;
}

const NativeRenderContext = createContext<NativeRenderContextValue | null>(null);

interface DocRefElementProps {
  children?: React.ReactNode;
  "data-ref"?: string;
}

function DocRef({ children, ...props }: DocRefElementProps): React.JSX.Element {
  const ctx = useContext(DocRefContext);
  const ref = props["data-ref"];
  if (!ctx || !ref || !ctx.status.has(ref)) return <>{children}</>;
  if (ctx.status.get(ref)) {
    return (
      <button type="button" className="doc-ref" data-ref={ref} onClick={() => ctx.onOpen(ref)}>
        {children}
      </button>
    );
  }
  return (
    <span className="doc-ref doc-ref--dead" data-ref={ref}>
      {children}
    </span>
  );
}

function parseFilename(meta: unknown): string | undefined {
  if (typeof meta !== "string" || !meta.trim()) return undefined;
  const match = /(?:^|\s)(?:filename=)?["']?([\w./-]+\.[A-Za-z0-9]+)["']?/.exec(meta);
  return match?.[1];
}

type MarkdownCodeProps = React.JSX.IntrinsicElements["code"] & ExtraProps & {
  block?: boolean;
};

function MarkdownCode({ className, children, node, block = false, ...props }: MarkdownCodeProps): React.JSX.Element {
  const streaming = useContext(StreamingContext);
  const isStreaming = streaming.active && (
    streaming.tailStart === null || (node?.position?.start.offset ?? 0) >= streaming.tailStart
  );
  const match = /language-([^\s]+)/.exec(className ?? "");
  if (!block && !match) {
    return <code className={className} {...props}>{children}</code>;
  }

  const code = extractText(children).replace(/\n$/, "");
  const language = match?.[1];
  if (language === "mermaid") {
    return isStreaming ? (
      <CodeBlock language="mermaid" code={code} isStreaming />
    ) : (
      <MermaidBlock code={code} />
    );
  }
  return (
    <CodeBlock
      language={language}
      code={code}
      filename={parseFilename(node?.data?.meta)}
      isStreaming={isStreaming}
    >
      {children}
    </CodeBlock>
  );
}

function MarkdownPre({ children }: React.JSX.IntrinsicElements["pre"] & ExtraProps): React.JSX.Element {
  return (
    <>
      {Children.map(children, (child) =>
        isValidElement<{ block?: boolean }>(child)
          ? cloneElement(child, { block: true })
          : child,
      )}
    </>
  );
}

function MarkdownListItem({ node: _node, ...props }: React.JSX.IntrinsicElements["li"] & ExtraProps): React.JSX.Element {
  return <li {...props} />;
}

function MarkdownUl({ node: _node, ...props }: React.JSX.IntrinsicElements["ul"] & ExtraProps): React.JSX.Element {
  return <ul {...props} />;
}

function MarkdownOl({ node: _node, ...props }: React.JSX.IntrinsicElements["ol"] & ExtraProps): React.JSX.Element {
  return <ol {...props} />;
}

function MarkdownLink({ node, href, children, ...props }: React.JSX.IntrinsicElements["a"] & ExtraProps): React.JSX.Element {
  const streaming = useContext(StreamingContext);
  if (streaming.inertLinkOffset !== null && node?.position?.start.offset === streaming.inertLinkOffset) {
    return <span>{children}</span>;
  }
  if (parseDocumentLink(href)) {
    return (
      <DocumentLink href={href!} className="doc-ref doc-ref--semantic" title={props.title}>
        {children}
      </DocumentLink>
    );
  }
  if (typeof href === "string" && /^previously:/i.test(href)) {
    return <span className="doc-ref doc-ref--dead" title={props.title}>{children}</span>;
  }
  if (!href) return <span title={props.title}>{children}</span>;
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...props}
    >
      {children}
    </a>
  );
}

interface NativeMarkdownElementProps {
  node?: ExtraProps["node"];
  "data-native-source"?: string;
  "data-native-version"?: string;
  "data-native-ordinal"?: string;
  "data-native-explicit-id"?: string;
  "data-native-closed"?: string;
  "data-native-close-ended"?: string;
}

function NativeMarkdownIsland({
  node,
  "data-native-source": source = "",
  "data-native-version": version = "",
  "data-native-ordinal": rawOrdinal = "0",
  "data-native-explicit-id": explicitId = "",
  "data-native-closed": rawClosed = "false",
  "data-native-close-ended": rawCloseEnded = "true",
}: NativeMarkdownElementProps): React.JSX.Element | null {
  const context = useContext(NativeRenderContext);
  const streaming = useContext(StreamingContext);
  if (!context) return null;
  const ordinal = context.ordinalOffset + Number(rawOrdinal);
  const blockId = explicitId ? `native-${ordinal}-${explicitId}` : `native-${ordinal}`;
  const closed = rawClosed === "true" && (!streaming.active || rawCloseEnded === "true");
  const tail = streaming.active && (
    streaming.tailStart === null || (node?.position?.start.offset ?? 0) >= streaming.tailStart
  );
  return (
    <NativeHtmlBlock
      source={source}
      version={version}
      blockId={blockId}
      ordinal={ordinal}
      closed={closed}
      isStreaming={tail && !closed}
      mode={context.mode}
      identity={context.identity}
      onRetry={context.onRetry}
    />
  );
}

const MARKDOWN_COMPONENTS: Components = {
  code: MarkdownCode,
  pre: MarkdownPre,
  table({ node: _node, children }) {
    return <div className="typeset-scroll" tabIndex={0}><Table>{children}</Table></div>;
  },
  thead({ node: _node, children }) {
    return <TableHeader>{children}</TableHeader>;
  },
  tbody({ node: _node, children }) {
    return <TableBody>{children}</TableBody>;
  },
  tr({ node: _node, children }) {
    return <TableRow>{children}</TableRow>;
  },
  th({ node: _node, children, align, className, ...props }) {
    return (
      <TableHead
        align={align}
        className={cn(align === "center" ? "text-center" : align === "right" ? "text-right" : undefined, className)}
        {...props}
      >
        {children}
      </TableHead>
    );
  },
  td({ node: _node, children, align, className, ...props }) {
    return (
      <TableCell
        align={align}
        className={cn(align === "center" ? "text-center" : align === "right" ? "text-right" : undefined, className)}
        {...props}
      >
        {children}
      </TableCell>
    );
  },
  a: MarkdownLink,
  li: MarkdownListItem,
  ul: MarkdownUl,
  ol: MarkdownOl,
  img({ node: _node, alt, ...props }) {
    return <img alt={alt ?? ""} loading="lazy" decoding="async" {...props} />;
  },
  blockquote({ node: _node, children, ...props }) {
    return <MarkdownBlockquote {...props}>{children}</MarkdownBlockquote>;
  },
  hr() {
    return <Separator />;
  },
  "doc-ref": DocRef,
  "native-html": NativeMarkdownIsland,
} as Components;

type RemarkPluginList = NonNullable<React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;

const REMARK_PLUGINS: RemarkPluginList = [remarkGfm, remarkMath, remarkCodeFilename, remarkDocRefs];
const REHYPE_PLUGINS = [rehypeHighlight, rehypeKatex, rehypeSlug];

function unfinishedLinkOffset(source: string, repaired: string): number | null {
  if (source === repaired || !repaired.startsWith(source) || !repaired.slice(source.length).includes(")")) return null;
  const lineStart = Math.max(source.lastIndexOf("\n"), source.lastIndexOf("\r")) + 1;
  const match = /\[[^\]\r\n]*\]\([^\)\r\n]*$/.exec(source.slice(lineStart));
  return match ? lineStart + match.index : null;
}

const MarkdownDocument = memo(function MarkdownDocument({
  content,
  isStreaming,
  inertLinkOffset,
}: {
  content: string;
  isStreaming: boolean;
  inertLinkOffset: number | null;
}): React.JSX.Element {
  return (
    <StreamingContext.Provider value={{ active: isStreaming, tailStart: null, inertLinkOffset }}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        urlTransform={documentUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </StreamingContext.Provider>
  );
});

function NativeMarkdownDocument({
  content,
  rawContent,
  sections,
  isStreaming,
  inertLinkOffset,
  mode,
  turnId,
  slotId,
  provisionalTurnId,
  ordinalOffset,
  onRetry,
}: {
  content: string;
  rawContent: string;
  sections: NativeSection[];
  isStreaming: boolean;
  inertLinkOffset: number | null;
  mode: NativeRenderMode;
  turnId: string;
  slotId?: string;
  provisionalTurnId?: string;
  ordinalOffset: number;
  onRetry?: () => void;
}): React.JSX.Element {
  const identity = useNativeTurnIdentity(turnId, { slotId, provisionalTurnId });
  const remarkPlugins = useMemo<RemarkPluginList>(
    () => [...REMARK_PLUGINS, [remarkNativeSections, { source: rawContent, sections }]],
    [rawContent, sections],
  );
  const tailStart = sections.length === 0
    ? null
    : sections.slice(0, -1).reduce((offset, section) => offset + section.raw.length, 0);
  return (
    <NativeRenderContext.Provider value={{ mode, identity, ordinalOffset, onRetry }}>
      <StreamingContext.Provider value={{ active: isStreaming, tailStart, inertLinkOffset }}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={REHYPE_PLUGINS}
          components={MARKDOWN_COMPONENTS}
        urlTransform={documentUrlTransform}
        >
          {content}
        </ReactMarkdown>
      </StreamingContext.Provider>
    </NativeRenderContext.Provider>
  );
}

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
  nativeMode?: NativeRenderMode;
  nativeTurnId?: string;
  nativeSlotId?: string;
  nativeProvisionalTurnId?: string;
  nativeOrdinalOffset?: number;
  onNativeRetry?: () => void;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
  nativeMode,
  nativeTurnId,
  nativeSlotId,
  nativeProvisionalTurnId,
  nativeOrdinalOffset = 0,
  onNativeRetry,
}: MarkdownRendererProps): React.JSX.Element {
  const nativeEnabled = Boolean(nativeMode && nativeTurnId);
  const sections = useMemo(
    () => nativeEnabled ? parseNativeSections(content) : [],
    [content, nativeEnabled],
  );
  const displayContent = isStreaming ? repairStreamingMarkdown(content) : content;
  const inertLinkOffset = isStreaming ? unfinishedLinkOffset(content, displayContent) : null;

  return (
    <div
      className={cn(
        "typeset typeset-chat max-w-none break-words",
        isStreaming && "streaming-content",
      )}
    >
      {nativeEnabled && nativeMode && nativeTurnId ? (
        <NativeMarkdownDocument
          content={displayContent}
          rawContent={content}
          sections={sections}
          isStreaming={isStreaming}
          inertLinkOffset={inertLinkOffset}
          mode={nativeMode}
          turnId={nativeTurnId}
          slotId={nativeSlotId}
          provisionalTurnId={nativeProvisionalTurnId}
          ordinalOffset={nativeOrdinalOffset}
          onRetry={onNativeRetry}
        />
      ) : (
        <MarkdownDocument
          content={displayContent}
          isStreaming={isStreaming}
          inertLinkOffset={inertLinkOffset}
        />
      )}
      {nativeEnabled && isStreaming ? <span className="stream-caret" aria-hidden /> : null}
    </div>
  );
});
