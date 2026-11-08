"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useNativeExecutionLease, useNativeReadingCopy } from "./native-reading-context";
import { createNativeFlushTracker } from "./native-execution";
import {
  NATIVE_BRIDGE_CHANNEL,
  validateNativeFrameMessage,
  type NativeStylesSnapshot,
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
  readNativeStyles,
  subscribeNativeStyles,
} from "@/lib/markdown/native-document";
import "./native-html.css";
import { buildNativeContainer } from "@/lib/markdown/native-container";
import { readingFlushers } from "./native-reading-flush";
import { RichContentFrame } from "./rich-content-view";
export { flushNativeReading } from "./native-reading-flush";

/** Execution is independent of the surface: reader uses paper colors while
 * its active copy executes; paper is reserved for static/print presentation. */
export type NativeRenderMode = "interactive" | "reader" | "paper";
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
  /** Actual or estimated browser geometry from a host-resolved artifact. */
  estimatedHeight?: number;
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
  measuredHeight,
  estimatedHeight,
  onMeasure,
  ownsExecution,
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
  measuredHeight?: number;
  estimatedHeight?: number;
  onMeasure: (height: number) => void;
  ownsExecution: () => boolean;
}): React.JSX.Element {
  const t = useTranslations("chat.native");
  const store = getNativeStateStore();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef(scope);
  const initialScopesRef = useRef({ scope, migrateFromScope });
  const themeRef = useRef<NativeThemeTokens>(DEFAULT_NATIVE_THEME);
  const stylesRef = useRef<NativeStylesSnapshot | undefined>(undefined);
  const stylesIdRef = useRef<string | undefined>(undefined);
  const localeRef = useRef(locale);
  const fallbackRef = useRef(t("empty"));
  const frameTitleRef = useRef(t(interactive ? "frameTitle" : "staticFrameTitle", { index: ordinal + 1 }));
  const suggestionRef = useRef(onSuggestion);
  suggestionRef.current = onSuggestion;
  const measureRef = useRef(onMeasure);
  measureRef.current = onMeasure;
  const ownsRef = useRef(ownsExecution);
  ownsRef.current = ownsExecution;
  const readyRef = useRef(false);
  const blockedRef = useRef(false);
  const loadCountRef = useRef(0);
  const flushSequenceRef = useRef(0);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [height, setHeight] = useState(measuredHeight ?? estimatedHeight ?? (surface === "paper" ? 288 : 192));
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
      themeRef.current = readNativeTheme(surface, shellRef.current ?? undefined);
      stylesRef.current = readNativeStyles();
      stylesIdRef.current = stylesRef.current.id;
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      setToken(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    } catch {
      setFailed("unavailable");
    }
  }, [interactive, surface, store]);

  const srcDoc = useMemo(() => {
    if (!token || initialStateJson === undefined) return null;
    return buildNativeContainer({ token, interactive, title: frameTitleRef.current, document: buildNativeDocument({
      source,
      token,
      theme: themeRef.current,
      styles: stylesRef.current,
      locale: localeRef.current,
      interactive,
      initialStateJson,
      fallback: fallbackRef.current,
    }) });
  }, [token, source, interactive, initialStateJson]);

  useEffect(() => {
    if (!token || !interactive) return;
    const waitingForState = createNativeFlushTracker();
    const postTheme = (): void => {
      if (blockedRef.current || !ownsRef.current()) return;
      iframeRef.current?.contentWindow?.postMessage({
        channel: NATIVE_BRIDGE_CHANNEL,
        token,
        type: "theme",
        theme: readNativeTheme(surface, shellRef.current ?? undefined),
      }, "*");
    };
    const postStyles = (): void => {
      if (blockedRef.current || !readyRef.current || !ownsRef.current()) return;
      try {
        const styles = readNativeStyles();
        if (styles.id === stylesIdRef.current) return;
        stylesIdRef.current = styles.id;
        iframeRef.current?.contentWindow?.postMessage({ channel: NATIVE_BRIDGE_CHANNEL, token, type: "styles", styles }, "*");
      } catch { setFailed("unavailable"); }
    };
    const onMessage = (event: MessageEvent): void => {
      if (blockedRef.current || !ownsRef.current()) return;
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
        postStyles();
      } else if (message.type === "resize") {
        setHeight((current) => current === message.height ? current : message.height);
        measureRef.current(message.height);
        shellRef.current?.dispatchEvent(new Event("previously:native-resize", { bubbles: true }));
      } else if (message.type === "state") {
        const snapshot = parseNativeSnapshot(message.json);
        if (snapshot) {
          store.write(scopeRef.current, snapshot);
          waitingForState.acknowledge(message.requestId);
        }
      } else if (message.type === "followup") {
        suggestionRef.current(message.prompt);
      } else if (message.type === "error") {
        if (message.message === "navigation") {
          blockedRef.current = true;
          readyRef.current = false;
          setReady(false);
        }
        setFailed(message.message || "error");
      }
    };
    window.addEventListener("message", onMessage);
    const observer = new MutationObserver(postTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    const paper = shellRef.current?.closest(".desk-paper");
    if (paper) observer.observe(paper, { attributes: true, attributeFilter: ["class", "style"] });
    const unsubscribeStyles = subscribeNativeStyles(() => { postStyles(); postTheme(); });
    const shell = shellRef.current;
    if (shell) readingFlushers.set(shell, () => new Promise<void>((resolve) => {
      if (!readyRef.current || blockedRef.current || !ownsRef.current()) { resolve(); return; }
      const requestId = `flush-${++flushSequenceRef.current}`;
      const finish = () => { window.clearTimeout(timer); waitingForState.forget(requestId); resolve(); };
      const timer = window.setTimeout(finish, 120);
      waitingForState.wait(requestId, finish);
      iframeRef.current?.contentWindow?.postMessage({ channel: NATIVE_BRIDGE_CHANNEL, token, type: "flush", requestId }, "*");
    }));
    return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
      unsubscribeStyles();
      if (shell) readingFlushers.delete(shell);
      waitingForState.dispose();
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
        ref={shellRef}
        className="native-frame-shell"
        data-ready={ready || undefined}
        data-native-mode={surface}
        data-native-execution={interactive ? "active" : "static"}
        style={{ "--native-frame-height": `${measuredHeight ?? height}px` } as React.CSSProperties}
      >
        {srcDoc && !removeFailedFrame ? (
          <iframe
            ref={iframeRef}
            title={t(interactive ? "frameTitle" : "staticFrameTitle", { index: ordinal + 1 })}
            className="native-frame"
            sandbox={interactive ? "allow-scripts allow-forms" : ""}
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
    estimatedHeight,
  } = props;
  const t = useTranslations("chat.native");
  const [suggestion, setSuggestion] = useState<{ scope: string; text: string } | null>(null);
  const acceptedSuggestionRef = useRef<{ scope: string; text: string } | null>(null);
  const reading = useNativeReadingCopy();
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
  const eligible = closed && source.length <= MAX_NATIVE_SOURCE_CHARS &&
    mode !== "paper" && reading.active;
  const lease = useNativeExecutionLease(scope, eligible, reading.priority, migrateFromScope);
  const interactive = lease.active;
  const surface = mode === "interactive" ? "chat" : "paper";
  const measure = reading.layout?.measure;
  const onMeasure = useCallback((height: number) => measure?.(frameKey, height), [measure, frameKey]);
  const measuredHeight = reading.layout?.heights.get(frameKey);
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
        <button type="button" onClick={() => onRetry ? onRetry() : requestNativeDraftAppend(t("retryDraft"))}>
          {t("retry")}
        </button>
      </div>
    );
  }

  if (source.length > MAX_NATIVE_SOURCE_CHARS) {
    return (
      <div className="native-incomplete" data-native-oversized={blockId}>
        <p>{t("tooLarge")}</p>
      </div>
    );
  }

  const frame = <NativeFrame
        key={`${frameKey}:${interactive ? "active" : "static"}`}
        source={source}
        version={version}
        blockId={blockId}
        ordinal={ordinal}
        scope={scope}
        migrateFromScope={migrateFromScope}
        interactive={interactive}
        surface={surface}
        locale={identity.locale}
        onSuggestion={receiveSuggestion}
        measuredHeight={measuredHeight}
        estimatedHeight={estimatedHeight}
        onMeasure={onMeasure}
        ownsExecution={lease.owns}
      />;
  return (
    <div
      className={`native-html${surface === "paper" ? " native-html--paper" : ""}`}
      data-rich-block="html"
      data-native-block={blockId}
      data-native-turn={identity.turnId}
      data-native-scope={scope}
      data-native-render-mode={mode}
      style={reading.layout?.pageHeight ? { "--native-page-height": `${reading.layout.pageHeight}px` } as React.CSSProperties : undefined}
    >
      {surface === "chat" ? <RichContentFrame kind="html">{frame}</RichContentFrame> : frame}
      {interactive && pendingSuggestion ? (
        <div className="native-suggestion" data-native-suggestion>
          <span>{pendingSuggestion}</span>
          <button type="button" onClick={acceptSuggestion}>{t("acceptSuggestion")}</button>
        </div>
      ) : null}
    </div>
  );
}
