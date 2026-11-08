"use client";

import { memo, useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { ContentBlockV1 } from "@/lib/chat/dialogue-contract";
import { DocumentLink } from "@/components/documents/document-navigation";
import { ConversationTurn } from "./conversation-turn";
import { ImagePolaroid } from "./conversation-images";
import { composeDialogueMarkdown } from "./dialogue-markdown";
import { DialogueMarkdown } from "./markdown";
import { DialogueArtifact } from "./native-artifact";
import type { NativeRenderMode } from "./native-html";
import { formatDocumentLink, parseDocumentLink } from "@/lib/documents/document-link";
import { MessageActions } from "./message-actions";
import { findImageMarkers } from "@/lib/chat/image-markers";
import type { DialoguePublicationSeat } from "./dialogue-stream-rows";

export const DialogueContent = memo(function DialogueContent({ blocks, mode, artifactBodies }: {
  blocks: readonly ContentBlockV1[];
  mode: NativeRenderMode;
  /** Exact bytes admitted on the same authenticated public child stream. */
  artifactBodies?: ReadonlyMap<string, string>;
}) {
  const prefix = useId();
  const figures = useRef(new Map<string, HTMLElement>());
  const [selected, setSelected] = useState<string>();
  const { content, slots } = useMemo(() => composeDialogueMarkdown(blocks), [blocks]);
  const images = useMemo(() => blocks.flatMap(block => block.kind === "image_ref" ? [block.image] : []), [blocks]);
  const imageMarkers = useMemo(() => findImageMarkers(content,
    images.flatMap(image => image.ordinal ? [{ id: image.assetId, ordinal: image.ordinal }] : [])), [content, images]);
  const focus = useCallback((id: string) => {
    setSelected(id);
    const figure = figures.current.get(id);
    figure?.focus({ preventScroll: true });
    figure?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  const children = useMemo(() => {
    const nodes = new Map<string, ReactNode>();
    const photos = new Set<string>();
    for (const match of imageMarkers) {
      nodes.set(`image:${match.start}`, <a href={`#${prefix}-${match.id}`} className="conversation-image-reference"
        data-image-reference={match.id} onClick={event => { event.preventDefault(); focus(match.id); }}>
        {content.slice(match.start, match.end)}
      </a>);
    }
    for (const block of blocks) {
      if (block.kind === "artifact_ref") nodes.set(block.blockId, <DialogueArtifact artifact={block.artifact} mode={mode} source={artifactBodies?.get(block.artifact.artifactId)} />);
      if (block.kind === "image_ref" && !photos.has(block.image.assetId)) {
        photos.add(block.image.assetId);
        const id = block.image.assetId;
        nodes.set(block.blockId, <div className="dialogue-photo" data-rich-block="image" id={`${prefix}-${id}`} tabIndex={-1}
          ref={node => { if (node) figures.current.set(id, node); else figures.current.delete(id); }}>
          <ImagePolaroid image={block.image} selected={selected === id} onSelect={() => focus(id)} />
        </div>);
      }
      if (block.kind === "citation_ref") nodes.set(block.blockId,
        <p className="dialogue-citation"><DocumentLink href={formatDocumentLink(parseDocumentLink(block.ref) ?? { ref: block.ref }) ?? ""}>{block.label ?? block.ref}</DocumentLink></p>);
    }
    return nodes;
  }, [blocks, mode, artifactBodies, imageMarkers, content, prefix, focus, selected]);
  return <div className="conversation-prose"><DialogueMarkdown content={content} slots={slots} imageMarkers={imageMarkers}>{children}</DialogueMarkdown></div>;
});

export const DialogueUtterance = memo(function DialogueUtterance({ publications, inReplyTo, onRegenerate }: {
  publications: readonly DialoguePublicationSeat[];
  inReplyTo?: string;
  onRegenerate?: () => void;
}) {
  const t = useTranslations("chat.dialogue");
  const text = publications.map(({ utterance }) =>
    utterance.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : []).join("\n\n")).filter(Boolean).join("\n\n");
  const blocks = publications.flatMap(({ utterance }) => utterance.blocks);
  const first = publications[0]?.utterance;
  if (!first) return null;
  return <div className="dialogue-publication" data-dialogue-reply={first.inputIds.join(":")}>
    <ConversationTurn role="assistant" metadata={inReplyTo ? t("inReplyTo", { text: inReplyTo }) : undefined}>
      <div className="dialogue-continuous-reply">
        {publications.map(({ utterance, artifactBodies }) => <div className="dialogue-publication" key={utterance.utteranceId}
          data-public-utterance={utterance.utteranceId} data-public-seq={utterance.publicSeq}>
          <DialogueContent blocks={utterance.blocks} mode="interactive" artifactBodies={artifactBodies} />
        </div>)}
      </div>
      {blocks.length > 0 && <MessageActions content={text} response={JSON.stringify(blocks, null, 2)} onRegenerate={onRegenerate} />}
    </ConversationTurn>
  </div>;
});
