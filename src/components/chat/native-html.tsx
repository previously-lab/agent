"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Code2, ExternalLink, Maximize2, Minimize2, RotateCcw, X } from "lucide-react";
import {
  NATIVE_BRIDGE_CHANNEL,
  validateNativeFrameMessage,
  type NativeThemeTokens,
} from "@/lib/chat/native-bridge";
import { requestNativeDraftAppend } from "@/lib/chat/native-draft";
import {
  getNativeStateStore,
  nativeStateScope,
  parseNativeSnapshot,
  type NativeStateIdentity,
} from "@/lib/chat/native-state";
import {
  buildNativeDocument,
  DEFAULT_NATIVE_THEME,
  readNativeTheme,
} from "@/lib/markdown/native-document";
import "./native-html.css";

export type NativeRenderMode = "interactive" | "paper";
export type NativeTurnIdentity = Omit<NativeStateIdentity, "blockId" | "sourceVersion"> & {
  locale: string;
  slotId: string;
  provisionalTurnId?: string;
};

interface NativeHtmlBlockProps {
  source: string;
  version: string;
  blockId: string;
  ordinal: number;
  closed: boolean;
  isStreaming: boolean;
  mode: NativeRenderMode;
  identity: NativeTurnIdentity;
  onRetry?: () => void;
}

const MAX_NATIVE_SOURCE_CHARS = 262_144;

function NativePreparing({ label }: { label?: string }): React.JSX.Element {
  const t = useTranslations("chat.native");
  return (
    <div className="native-preparing" role="status">
      <span className="native-preparing-line" />
      <span className="native-preparing-line native-preparing-line--short" />
      <span className="native-preparing-label">{label ?? t("generating")}</span>
    </div>
  );
}

function NativeSource({ source, labelledBy }: { source: string; labelledBy: string }): React.JSX.Element {
  return (
    <pre id={labelledBy} className="native-source" tabIndex={0}>
      <code>{source}</code>
    </pre>
  );
}

function NativeFrame({
  source,
  version,
  blockId,
  ordinal,
  scope,
  migrateFromScope,
  interactive,
  surface,
  locale,
  onSuggestion,
}: {
  source: string;
  version: string;
  blockId: string;
  ordinal: number;
  scope: string;
  migrateFromScope?: string;
  interactive: boolean;
  surface: "chat" | "paper";
  locale: string;
  onSuggestion: (prompt: string) => void;
}): React.JSX.Element {
  const t = useTranslations("chat.native");
  const store = getNativeStateStore();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const scopeRef = useRef(scope);
  const initialScopesRef = useRef({ scope, migrateFromScope });
  const themeRef = useRef<NativeThemeTokens>(DEFAULT_NATIVE_THEME);
  const localeRef = useRef(locale);
  const fallbackRef = useRef(t("empty"));
  const suggestionRef = useRef(onSuggestion);
  suggestionRef.current = onSuggestion;
  const readyRef = useRef(false);
  const blockedRef = useRef(false);
  const loadCountRef = useRef(0);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [height, setHeight] = useState(surface === "paper" ? 288 : 192);
  const [initialStateJson, setInitialStateJson] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (scopeRef.current === scope) return;
    if (migrateFromScope && migrateFromScope === scopeRef.current) {
      store.migrate(migrateFromScope, scope);
    }
    scopeRef.current = scope;
  }, [scope, migrateFromScope, store]);

  useEffect(() => {
    const initial = initialScopesRef.current;
    if (interactive) {
      if (initial.migrateFromScope && initial.migrateFromScope !== initial.scope) {
        store.migrate(initial.migrateFromScope, initial.scope);
      }
      const snapshot = store.read(initial.scope);
      setInitialStateJson(snapshot ? JSON.stringify(snapshot) : null);
    } else {
      setInitialStateJson(null);
    }
    try {
      themeRef.current = readNativeTheme(surface);
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      setToken(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    } catch {
      setFailed("unavailable");
    }
  }, [interactive, surface, store]);

  const srcDoc = useMemo(() => {
    if (!token || initialStateJson === undefined) return null;
    return buildNativeDocument({
      source,
      token,
      theme: themeRef.current,
      locale: localeRef.current,
      interactive,
      initialStateJson,
      fallback: fallbackRef.current,
    });
  }, [token, source, interactive, initialStateJson]);

  useEffect(() => {
    if (!token || !interactive) return;
    const postTheme = (): void => {
      if (blockedRef.current) return;
      iframeRef.current?.contentWindow?.postMessage({
        channel: NATIVE_BRIDGE_CHANNEL,
        token,
        type: "theme",
        theme: readNativeTheme(surface),
      }, "*");
    };
    const onMessage = (event: MessageEvent): void => {
      if (blockedRef.current) return;
      const message = validateNativeFrameMessage(
        event.data,
        event.source,
        iframeRef.current?.contentWindow,
        token,
      );
      if (!message) return;
      if (message.type === "ready") {
        readyRef.current = true;
        setReady(true);
        postTheme();
      } else if (message.type === "resize") {
        setHeight((current) => current === message.height ? current : message.height);
      } else if (message.type === "state") {
        const snapshot = parseNativeSnapshot(message.json);
        if (snapshot) store.write(scopeRef.current, snapshot);
      } else if (message.type === "followup") {
        suggestionRef.current(message.prompt);
      } else if (message.type === "error") {
        setFailed(message.message || "error");
      }
    };
    window.addEventListener("message", onMessage);
    const observer = new MutationObserver(postTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
    };
  }, [token, interactive, surface, store]);

  useEffect(() => {
    if (!token || ready) return;
    const timer = window.setTimeout(() => {
      if (readyRef.current) return;
      blockedRef.current = true;
      setFailed((current) => current ?? "timeout");
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [token, ready]);

  const failureLabel = failed === "navigation"
    ? t("navigationError")
    : failed && !["load", "timeout", "unavailable"].includes(failed)
      ? t("scriptError")
      : failed
        ? t("loadError")
        : null;

  const removeFailedFrame = failed === "navigation" || failed === "timeout" || failed === "load" || failed === "unavailable";

  return (
    <div className="native-frame-region">
      <div
        className="native-frame-shell"
        data-ready={ready || undefined}
        data-native-mode={surface}
        style={{ "--native-frame-height": `${height}px` } as React.CSSProperties}
      >
        {srcDoc && !removeFailedFrame ? (
          <iframe
            ref={iframeRef}
            title={t(surface === "paper" ? "staticFrameTitle" : "frameTitle", { index: ordinal + 1 })}
            className="native-frame"
            sandbox={interactive ? "allow-scripts" : ""}
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            data-native-frame={blockId}
            data-native-version={version}
            onLoad={() => {
              loadCountRef.current += 1;
              if (loadCountRef.current > 1) {
                blockedRef.current = true;
                readyRef.current = false;
                setReady(false);
                setFailed("navigation");
                return;
              }
              if (!interactive) {
                readyRef.current = true;
                setReady(true);
              }
            }}
            onError={() => setFailed((current) => current ?? "load")}
          />
        ) : null}
        {!ready ? <NativePreparing label={failureLabel ?? undefined} /> : null}
      </div>
      {failed && ready ? (
        <p className="native-error" role="status">
          {failureLabel}
        </p>
      ) : null}
    </div>
  );
}

function NativeDialog({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="native-dialog" aria-label={title} onClose={onClose}>
      <button type="button" className="native-dialog-close" aria-label={closeLabel} onClick={() => ref.current?.close()}>
        <X aria-hidden />
      </button>
      {children}
    </dialog>
  );
}

export function NativeHtmlBlock(props: NativeHtmlBlockProps): React.JSX.Element {
  const {
    source,
    version,
    blockId,
    ordinal,
    closed,
    isStreaming,
    mode,
    identity,
    onRetry,
  } = props;
  const t = useTranslations("chat.native");
  const sourceId = useId();
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<{ scope: string; text: string } | null>(null);
  const acceptedSuggestionRef = useRef<{ scope: string; text: string } | null>(null);
  const store = getNativeStateStore();
  const scope = nativeStateScope({ ...identity, blockId, sourceVersion: version });
  const confirmedAlias = identity.provisionalTurnId === identity.slotId && identity.turnId !== identity.slotId;
  const frameTurnId = confirmedAlias ? identity.slotId : identity.turnId;
  const frameKey = nativeStateScope({ ...identity, turnId: frameTurnId, blockId, sourceVersion: version });
  const migrateFromScope = confirmedAlias
    ? nativeStateScope({
        ...identity,
        turnId: identity.provisionalTurnId ?? identity.slotId,
        blockId,
        sourceVersion: version,
      })
    : undefined;
  const interactive = mode === "interactive";
  const pendingSuggestion = suggestion?.scope === scope ? suggestion.text : null;

  const receiveSuggestion = (prompt: string): void => {
    const text = prompt.trim();
    if (!text) return;
    setSuggestion((current) => {
      if (acceptedSuggestionRef.current?.scope === scope && acceptedSuggestionRef.current.text === text) return current;
      if (current?.scope === scope && current.text === text) return current;
      return { scope, text };
    });
  };

  const acceptSuggestion = (): void => {
    if (!pendingSuggestion) return;
    acceptedSuggestionRef.current = { scope, text: pendingSuggestion };
    requestNativeDraftAppend(pendingSuggestion);
    setSuggestion(null);
  };

  if (!closed) {
    if (isStreaming) return <NativePreparing />;
    return (
      <div className="native-incomplete" data-native-incomplete={blockId}>
        <p>{t("incomplete")}</p>
        <div className="native-controls">
          <button type="button" aria-expanded={showSource} aria-controls={sourceId} onClick={() => setShowSource((value) => !value)}>
            <Code2 aria-hidden />{t("source")}
          </button>
          <button
            type="button"
            onClick={() => onRetry ? onRetry() : requestNativeDraftAppend(t("retryDraft"))}
          >
            <RotateCcw aria-hidden />{t("retry")}
          </button>
        </div>
        {showSource ? <NativeSource source={source} labelledBy={sourceId} /> : null}
      </div>
    );
  }

  if (source.length > MAX_NATIVE_SOURCE_CHARS) {
    return (
      <div className="native-incomplete" data-native-oversized={blockId}>
        <p>{t("tooLarge")}</p>
        <button type="button" aria-expanded={showSource} aria-controls={sourceId} onClick={() => setShowSource((value) => !value)}>
          <Code2 aria-hidden />{t("source")}
        </button>
        {showSource ? <NativeSource source={source} labelledBy={sourceId} /> : null}
      </div>
    );
  }

  return (
    <div
      className={`native-html${expanded ? " native-html--expanded" : ""}${interactive ? "" : " native-html--paper"}`}
      data-native-block={blockId}
      data-native-turn={identity.turnId}
    >
      <NativeFrame
        key={`${frameKey}:${interactive ? "interactive" : "paper"}:${resetVersion}`}
        source={source}
        version={version}
        blockId={blockId}
        ordinal={ordinal}
        scope={scope}
        migrateFromScope={migrateFromScope}
        interactive={interactive}
        surface={interactive ? "chat" : "paper"}
        locale={identity.locale}
        onSuggestion={receiveSuggestion}
      />
      <div className="native-controls" role="group" aria-label={t("controls")}>
        <button type="button" aria-expanded={showSource} aria-controls={sourceId} onClick={() => setShowSource((value) => !value)}>
          <Code2 aria-hidden />{t("source")}
        </button>
        {interactive ? (
          <>
            <button type="button" aria-pressed={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
              {expanded ? t("collapse") : t("expand")}
            </button>
            <button
              type="button"
              onClick={() => {
                store.clear(scope);
                if (migrateFromScope) store.clear(migrateFromScope);
                acceptedSuggestionRef.current = null;
                setSuggestion(null);
                setResetVersion((value) => value + 1);
              }}
            >
              <RotateCcw aria-hidden />{t("reset")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setDialogOpen(true)}>
            <ExternalLink aria-hidden />{t("openInteractive")}
          </button>
        )}
      </div>
      {pendingSuggestion ? (
        <div className="native-suggestion" data-native-suggestion>
          <span>{pendingSuggestion}</span>
          <button type="button" onClick={acceptSuggestion}>{t("acceptSuggestion")}</button>
        </div>
      ) : null}
      {showSource ? <NativeSource source={source} labelledBy={sourceId} /> : null}
      {!interactive && dialogOpen ? (
        <NativeDialog
          title={t("dialogTitle", { index: ordinal + 1 })}
          closeLabel={t("closeInteractive")}
          onClose={() => setDialogOpen(false)}
        >
          <NativeHtmlBlock {...props} mode="interactive" />
        </NativeDialog>
      ) : null}
    </div>
  );
}
