import { createContext, memo, useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import type { Components } from "react-markdown";
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
import { cn } from "@/lib/utils";

/** Liveness + open action for in-paper reference links (v0.22 §7). The desk
 *  provides one per open document; without a provider every `doc-ref` node
 *  renders as its plain text, so the chat pipeline is untouched. */
export interface DocRefContextValue {
  /** Normalized ref → alive. Refs not yet verified are absent (plain text). */
  status: ReadonlyMap<string, boolean>;
  onOpen: (ref: string) => void;
}

export const DocRefContext = createContext<DocRefContextValue | null>(null);
export const DocRefProvider = DocRefContext.Provider;

interface DocRefElementProps {
  children?: React.ReactNode;
  "data-ref"?: string;
}

/** Renderer for the custom <doc-ref> hast element. Pending refs render as
 *  plain text so the verify pass never flashes a dead style on live ones. */
function DocRef({ children, ...props }: DocRefElementProps) {
  const ctx = useContext(DocRefContext);
  const ref = props["data-ref"];
  if (!ctx || !ref || !ctx.status.has(ref)) return <>{children}</>;
  if (ctx.status.get(ref)) {
    return (
      <button
        type="button"
        className="doc-ref"
        data-ref={ref}
        onClick={() => ctx.onOpen(ref)}
      >
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

/** Parse a fence meta string (```ts:app/page.tsx or ```ts filename="x.ts"). */
function parseFilename(meta: unknown): string | undefined {
  if (typeof meta !== "string" || !meta.trim()) return undefined;
  const m = /(?:^|\s)(?:filename=)?["']?([\w./-]+\.[A-Za-z0-9]+)["']?/.exec(meta);
  return m?.[1];
}

/** Factory for streaming-safe components. */
function createComponents(isStreaming: boolean): Components {
  let liCounter = 0;

  const listItem = (children: React.ReactNode) => {
    const index = liCounter++;
    return (
      <li
        style={
          isStreaming
            ? ({ "--stagger-index": index } as React.CSSProperties)
            : undefined
        }
      >
        {children}
      </li>
    );
  };

  return {
    /* ── Code (inline + block) ──────────────────────────────────── */
    code({ className, children, node, ...props }) {
      const match = /language-(\w+)/.exec(className ?? "");
      const codeStr = extractText(children).replace(/\n$/, "");

      if (!match) {
        return (
          <code {...props}>
            {children}
          </code>
        );
      }

      const lang = match[1];

      // Mermaid diagrams render once the fence is complete; mid-stream the
      // partial source would just fail to parse, so show it as code instead.
      if (lang === "mermaid") {
        return isStreaming ? (
          <CodeBlock language="mermaid" code={codeStr} isStreaming />
        ) : (
          <MermaidBlock code={codeStr} />
        );
      }

      return (
        <CodeBlock
          language={lang}
          code={codeStr}
          filename={parseFilename(node?.data?.meta)}
          isStreaming={isStreaming}
        >
          {children}
        </CodeBlock>
      );
    },

    pre({ children }) {
      return <>{children}</>;
    },

    /* ── Tables → shadcn Table ──────────────────────────────────── */
    table({ children }) {
      return (
        <div className="typeset-scroll">
          <Table>{children}</Table>
        </div>
      );
    },
    thead({ children }) {
      return <TableHeader>{children}</TableHeader>;
    },
    tbody({ children }) {
      return <TableBody>{children}</TableBody>;
    },
    tr({ children }) {
      return <TableRow>{children}</TableRow>;
    },
    th({ children }) {
      return <TableHead>{children}</TableHead>;
    },
    td({ children }) {
      return <TableCell>{children}</TableCell>;
    },

    /* ── Links ──────────────────────────────────────────────────── */
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },

    /* ── Lists ──────────────────────────────────────────────────── */
    li({ children }) {
      return listItem(children);
    },
    ul({ children }) {
      liCounter = 0;
      return <ul>{children}</ul>;
    },
    ol({ children }) {
      liCounter = 0;
      return <ol>{children}</ol>;
    },

    /* ── Blockquote (incl. GitHub-style alerts) ─────────────────── */
    blockquote({ children }) {
      return <MarkdownBlockquote>{children}</MarkdownBlockquote>;
    },

    /* ── Horizontal rule → shadcn Separator ─────────────────────── */
    hr() {
      return <Separator />;
    },

    /* ── In-paper reference links (inert without a DocRefProvider) ── */
    "doc-ref": DocRef,
  } as Components;
}

interface MarkdownRendererProps {
  content: string;
  /** When true, block-level children animate in as they arrive. */
  isStreaming?: boolean;
}

/**
 * Memoized react-markdown renderer.
 *
 * Uses typeset CSS (typeset.css) for all typography rhythm — heading
 * sizes, paragraph spacing, list indentation, inline code, etc. — and
 * shadcn/ui components (Table, Separator) for structural elements.
 * Math ($…$/$$…$$) renders via KaTeX; ```mermaid fences render as diagrams.
 *
 * Stable components are created once with streaming always enabled, so
 * react-markdown never rebuilds the component tree when `isStreaming`
 * toggles (which would cause DOM churn → layout shift → sibling animations
 * to replay). The stagger CSS property is harmless when the
 * `.streaming-content` class is absent — the keyframes never run.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
}: MarkdownRendererProps) {
  const comps = useMemo(() => createComponents(true), []);

  return (
    <div
      className={cn(
        "typeset typeset-chat max-w-none break-words",
        isStreaming && "streaming-content",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCodeFilename, remarkDocRefs]}
        rehypePlugins={[rehypeHighlight, rehypeKatex, rehypeSlug]}
        components={comps}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
