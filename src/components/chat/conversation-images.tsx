"use client";

import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { imageAttachmentUrl, type ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { findImageMarkers, imageMarkerText } from "@/lib/chat/image-markers";
import { useNativePersona } from "./native-source-scope";
import "./conversation-images.css";

export function ImagePolaroid({ image, selected, animate = false, onSelect, onRemove, figureRef }: {
  image: Readonly<ImageAttachmentSnapshot>;
  selected?: boolean;
  animate?: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
  figureRef?: (node: HTMLElement | null) => void;
}) {
  const t = useTranslations("chat.input");
  const persona = useNativePersona() ?? "user";
  return (
    <figure ref={figureRef} tabIndex={-1} className="conversation-polaroid" data-image-asset={image.assetId}
      data-image-ordinal={image.ordinal} data-image-selected={selected || undefined} data-image-arrival={animate || undefined}
      style={{ "--photo-tilt": `${((image.ordinal ?? 1) % 3 - 1) * 1.2}deg` } as CSSProperties}>
      <a href={imageAttachmentUrl(image.ref, persona)} target="_blank" rel="noreferrer" aria-label={t("images.open", { name: image.name })}>
        {/* The protected attachment endpoint owns image bytes and MIME checks. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageAttachmentUrl(image.ref, persona)} alt={image.name} loading="lazy" />
      </a>
      <figcaption>
        <button type="button" className="conversation-photo-label" onClick={onSelect}>
          {image.ordinal ? imageMarkerText(image.ordinal) : image.name}
        </button>
        {image.ordinal && <span className="truncate" title={image.name}>{image.name}</span>}
        {onRemove && <button type="button" className="conversation-photo-remove" onClick={onRemove} aria-label={t("removeAttachment", { name: image.name })}>×</button>}
      </figcaption>
    </figure>
  );
}

/** Saved and live user paragraphs resolve exactly the same bounded snapshot.
 * Removing a marker changes prose only; unreferenced photos remain readable. */
export function ConversationImageBody({ content, images, children }: {
  content: string;
  images: readonly ImageAttachmentSnapshot[];
  children?: ReactNode;
}) {
  const t = useTranslations("chat.input");
  const prefix = useId();
  const figures = useRef(new Map<string, HTMLElement>());
  const [selected, setSelected] = useState<string>();
  const matches = findImageMarkers(content, images.flatMap(image => image.ordinal ? [{ id: image.assetId, ordinal: image.ordinal }] : []));
  const cited = new Set(matches.map(match => match.id));
  const focus = (id: string) => {
    setSelected(id);
    const figure = figures.current.get(id);
    figure?.focus({ preventScroll: true });
    figure?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    nodes.push(content.slice(cursor, match.start));
    nodes.push(<a key={match.start} href={`#${prefix}-${match.id}`} className="conversation-image-reference"
      data-image-reference={match.id} onClick={(event) => { event.preventDefault(); focus(match.id); }}>{content.slice(match.start, match.end)}</a>);
    cursor = match.end;
  }
  nodes.push(content.slice(cursor));
  const gallery = (photos: readonly ImageAttachmentSnapshot[], appendix = false) => photos.length > 0 && (
    <section className={appendix ? "conversation-image-annex" : "conversation-image-shelf"} aria-label={t(appendix ? "images.unreferenced" : "images.attached")}>
      {appendix && <p className="conversation-image-annex-label">{t("images.unreferenced")}</p>}
      <div className="conversation-image-stack" data-image-stack>
        {photos.map((image, index) => (
          <div key={image.assetId} id={`${prefix}-${image.assetId}`} className="conversation-photo-seat"
            data-photo-front={selected === image.assetId || (!selected && index === photos.length - 1) || undefined}
            style={{ "--photo-offset": index } as CSSProperties}>
            <ImagePolaroid image={image} selected={selected === image.assetId} onSelect={() => focus(image.assetId)}
              figureRef={(node) => { if (node) figures.current.set(image.assetId, node); else figures.current.delete(image.assetId); }} />
          </div>
        ))}
      </div>
      {photos.length > 1 && <div className="conversation-photo-index" role="group" aria-label={t("images.attached")}>
        {photos.map(image => <button key={image.assetId} type="button" title={image.name}
          aria-label={`${image.ordinal ? imageMarkerText(image.ordinal) : ""} ${image.name}`}
          aria-pressed={selected === image.assetId} onClick={() => focus(image.assetId)}>{image.ordinal ? imageMarkerText(image.ordinal) : image.name}</button>)}
      </div>}
    </section>
  );
  return (
    <div className="conversation-image-body">
      {gallery(images.filter(image => cited.has(image.assetId)))}
      {children ?? <div className="conversation-prose conversation-prose--literal">{nodes}</div>}
      {gallery(images.filter(image => !cited.has(image.assetId)), true)}
    </div>
  );
}
