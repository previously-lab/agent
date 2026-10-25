"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";
import type { NativeTurnIdentity } from "./native-html";
import { useNativePersona, useNativeSourceScope } from "./native-source-scope";

export function useNativeTurnIdentity(
  turnId: string,
  options: { slotId?: string; provisionalTurnId?: string } = {},
): NativeTurnIdentity {
  const locale = useLocale();
  const searchParams = useSearchParams();
  const ownerPersona = useNativePersona();
  const persona = ownerPersona ?? searchParams?.get("persona") ?? "user";
  const contextId = useNativeSourceScope();
  const slotId = options.slotId ?? turnId;
  const provisionalTurnId = options.provisionalTurnId === slotId && options.provisionalTurnId !== turnId
    ? options.provisionalTurnId
    : undefined;
  return useMemo(
    () => ({ persona, contextId, turnId, slotId, provisionalTurnId, locale }),
    [persona, contextId, turnId, slotId, provisionalTurnId, locale],
  );
}
