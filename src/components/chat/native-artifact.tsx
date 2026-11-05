"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import type { DialogueArtifactRef } from "@/lib/chat/dialogue-contract";
import { MarkdownRenderer } from "./markdown";
import { NativeHtmlBlock, type NativeRenderMode } from "./native-html";
import { useNativeTurnIdentity } from "./native-identity";
import { useNativeReadingCopy } from "./native-reading-context";
import "./dialogue-manuscript.css";

export async function readDialogueArtifact(expected: DialogueArtifactRef, persona: string, signal: AbortSignal, request = fetch): Promise<string> {
  const params = new URLSearchParams({ persona });
  const response = await request(`/api/chat/dialogue/artifacts/${encodeURIComponent(expected.artifactId)}?${params}`, {
    signal, cache: "no-store", credentials: "same-origin", redirect: "error",
  });
  if (!response.ok) throw new Error("Artifact unavailable");
  const { artifact, body } = await response.json() as { artifact?: DialogueArtifactRef; body?: unknown };
  if (!artifact || artifact.artifactId !== expected.artifactId || artifact.sourceOwnerId !== expected.sourceOwnerId ||
      artifact.revision !== expected.revision || artifact.sha256 !== expected.sha256 || artifact.kind !== expected.kind ||
      artifact.mediaType !== expected.mediaType || artifact.byteSize !== expected.byteSize || typeof body !== "string") {
    throw new Error("Artifact identity changed");
  }
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength !== expected.byteSize) throw new Error("Artifact size changed");
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== expected.sha256) throw new Error("Artifact bytes changed");
  }
  return body;
}

export function DialogueArtifact({ artifact, mode }: {
  artifact: DialogueArtifactRef;
  mode: NativeRenderMode;
}) {
  const t = useTranslations("chat.dialogue");
  const { artifactId, sourceOwnerId, sha256, height: estimatedHeight, byteSize, mediaType, revision, kind } = artifact;
  // An utterance id, record index, or DOM position is never an artifact owner.
  const identity = useNativeTurnIdentity(sourceOwnerId);
  const pageHeight = useNativeReadingCopy().layout?.pageHeight;
  const key = JSON.stringify([identity.contextId, identity.persona, artifactId, sourceOwnerId, revision, sha256, kind]);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; attempt: number; source: string | null }>();
  const result = loaded?.key === key && loaded.attempt === attempt ? loaded : undefined;
  const height = typeof estimatedHeight === "number" && Number.isFinite(estimatedHeight) && estimatedHeight > 0
    ? Math.min(estimatedHeight, 1600) : undefined;

  useEffect(() => {
    const controller = new AbortController();
    // Resolve the original bytes without composing Markdown around them. The
    // same source owner, block id and version also restore the same widget.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    void readDialogueArtifact({ artifactId, sourceOwnerId, revision, sha256, kind, mediaType, byteSize }, identity.persona, signal).then(
      source => { if (!controller.signal.aborted) setLoaded({ key, attempt, source }); },
      () => { if (!controller.signal.aborted) setLoaded({ key, attempt, source: null }); },
    );
    return () => controller.abort();
  }, [artifactId, sourceOwnerId, revision, sha256, kind, mediaType, byteSize, identity.persona, key, attempt]);

  const state = !result ? "pending" : result.source === null ? "unavailable" : "ready";
  return <div className="dialogue-artifact" data-artifact-ref={artifactId} data-artifact-state={state} data-artifact-surface={mode}
    aria-busy={state === "pending" || undefined} style={{
      ...(height ? { "--dialogue-artifact-height": `${height}px` } : {}),
      ...(pageHeight ? { "--native-page-height": `${pageHeight}px` } : {}),
    } as CSSProperties}>
    {result?.source != null ? (kind === "native_html" ? <NativeHtmlBlock source={result.source} version={sha256} blockId={artifactId}
        ordinal={0} closed isStreaming={false} mode={mode} identity={identity} estimatedHeight={height} />
        : <MarkdownRenderer content={result.source} />) : <div className="dialogue-artifact-seat">
      <span>{t(result ? "artifactUnavailable" : "artifactLoading")}</span>
      {result && <button type="button" onClick={() => setAttempt(current => current + 1)}>{t("retry")}</button>}
    </div>}
  </div>;
}
