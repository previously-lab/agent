"use client";

import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Maximize2, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { imageAttachmentUrl, type ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { findImageMarkers, imageMarkerText } from "@/lib/chat/image-markers";
import { useNativePersona } from "./native-source-scope";
import type { DraftImage } from "@/lib/chat/image-attachment-draft";
import "./conversation-images.css";

function boundedPhotoAspect(width?: number, height?: number) {
  const intrinsicRatio = width && height ? width / height : 4 / 3;
  return Math.min(16 / 9, Math.max(3 / 4, intrinsicRatio));
}

export function ImagePolaroid({ image, selected, animate = false, onSelect, onRemove, figureRef }: {
  image: Readonly<ImageAttachmentSnapshot>;
  selected?: boolean;
  animate?: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
  figureRef?: (node: HTMLElement | null) => void;
}) {
  const t = useTranslations("chat.input");
  const previewT = useTranslations("chat.richView");
  const persona = useNativePersona() ?? "user";
  const [attempt, setAttempt] = useState(0);
  const decodeTicket = useRef(0);
  const originalSrc = imageAttachmentUrl(image.ref, persona);
  const src = originalSrc + (attempt ? `&previewAttempt=${attempt}` : "");
  const [decoded, setDecoded] = useState<{ src: string; status: "loading" | "ready" | "error" }>({ src, status: "loading" });
  // A new protected ref/persona must earn its own decoded status. An old
  // image's late decode can never expose an unready replacement source.
  const preview = decoded.src === src ? decoded.status : "loading";
  // The media seat stays readable for malformed or extreme dimensions; the
  // image itself is always contained and the dialog exposes the full original.
  const ratio = boundedPhotoAspect(image.width, image.height);
  return (
    <Dialog>
      <figure ref={figureRef} tabIndex={-1} className="conversation-polaroid" data-image-asset={image.assetId}
        data-image-ordinal={image.ordinal} data-image-selected={selected || undefined} data-image-arrival={animate && preview === "ready" || undefined}
        data-preview-state={preview}
        style={{ "--photo-aspect": ratio, "--photo-tilt": `${((image.ordinal ?? 1) % 3 - 1) * 1.2}deg` } as CSSProperties}>
        <div className="conversation-photo-media" data-photo-media aria-busy={preview === "loading" || undefined}>
          <DialogTrigger className="conversation-photo-open" disabled={preview !== "ready"} aria-label={previewT("openNamedImage", { name: image.name })} title={previewT("openImage")}>
            {/* The protected attachment endpoint owns image bytes and MIME checks. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={src} src={src} alt={image.name} width={image.width} height={image.height} loading={animate ? "eager" : "lazy"}
              onLoad={async event => {
                const element = event.currentTarget;
                const ticket = ++decodeTicket.current;
                try { await element.decode(); if (decodeTicket.current === ticket) setDecoded({ src, status: "ready" }); }
                catch { if (decodeTicket.current === ticket) setDecoded({ src, status: "error" }); }
              }} onError={() => { decodeTicket.current++; setDecoded({ src, status: "error" }); }} />
            <span className="conversation-photo-open-badge" aria-hidden="true"><Maximize2 /><span>{previewT("openImage")}</span></span>
          </DialogTrigger>
          {preview !== "ready" && <div className="conversation-photo-status" role="status">
            <span>{t(preview === "error" ? "images.previewFailed" : "images.previewLoading")}</span>
            {preview === "error" && <button type="button" onClick={() => { decodeTicket.current++; setAttempt(current => current + 1); }}>{t("images.previewRetry")}</button>}
          </div>}
        </div>
        <figcaption>
          <button type="button" className="conversation-photo-label" title={image.name} onClick={onSelect}>
            {image.ordinal ? imageMarkerText(image.ordinal) : image.name}
          </button>
          {image.ordinal && <span className="truncate" title={image.name}>{image.name}</span>}
          {onRemove && <button type="button" className="conversation-photo-remove" onClick={onRemove} aria-label={t("removeAttachment", { name: image.name })}>×</button>}
        </figcaption>
      </figure>
      <DialogContent className="conversation-photo-preview sm:max-w-5xl" showCloseButton={false}>
        <div className="conversation-photo-preview-heading">
          <DialogTitle className="conversation-photo-preview-title" title={image.name}>{image.name}</DialogTitle>
          <DialogClose className="conversation-photo-preview-close" aria-label={previewT("close")}><X aria-hidden="true" /></DialogClose>
        </div>
        <div className="conversation-photo-preview-stage">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={originalSrc} alt={image.name} width={image.width} height={image.height} />
        </div>
        <a className="conversation-photo-original" href={originalSrc} target="_blank" rel="noreferrer">
          {previewT("openOriginalImage")}
        </a>
      </DialogContent>
    </Dialog>
  );
}

/** Upload and failure use the same media seat as the eventual photograph. */
export function DraftImagePlaceholder({ image, onRetry, onRemove }: {
  image: DraftImage; onRetry: () => void; onRemove: () => void;
}) {
  const t = useTranslations("chat.input");
  return <figure className="conversation-polaroid conversation-photo-placeholder" data-upload-id={image.localClientId} data-upload-state={image.status}
    style={{ "--photo-aspect": boundedPhotoAspect(image.width, image.height),
      "--photo-tilt": `${(image.ordinal % 3 - 1) * 1.2}deg` } as CSSProperties}>
    <div className="conversation-photo-media" data-photo-media aria-busy={image.status !== "error" || undefined}>
      <div className="conversation-photo-status" role="status">
        <span>{t(image.status === "error" ? image.error === "original-too-large" ? "images.originalTooLarge" : image.error === "too-large" ? "images.tooLarge" : "images.failed" : image.status === "preparing" ? "images.preparing" : "images.uploading")}</span>
        {image.status === "error" && <button type="button" onClick={onRetry}>{t("images.retry")}</button>}
      </div>
    </div>
    <figcaption>
      <span>{imageMarkerText(image.ordinal)}</span><span className="truncate" title={image.file.name}>{image.file.name}</span>
      <button className="conversation-photo-remove" type="button" onClick={onRemove} aria-label={t("removeAttachment", { name: image.file.name })}>×</button>
    </figcaption>
    {image.error && <span className="sr-only">{image.error === "original-too-large" ? t("images.originalTooLarge") : image.error === "too-large" ? t("images.tooLarge") : image.error}</span>}
  </figure>;
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
