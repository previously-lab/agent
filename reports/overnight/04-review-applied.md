# Review Findings — Applied vs Deferred

Branch: `chore/overnight-cleanup`. Source reviews: `review-correctness.md`, `review-security.md`, `review-conventions.md`.

Bar for applying: clearly correct, low-risk, improves correctness/security/convention-adherence
**without** changing product behavior or scope. Anything ambiguous, risky, or requiring a product
decision was deferred.

**Result: 7 applied · 14 deferred.** `npx tsc --noEmit` → exit 0 (clean).

---

## Applied (7)

### Correctness M1 — `readRecentSummaries` fed Flash the oldest slices, not the recent ones
`src/lib/episodic/maintenance.ts` — the monthly index is stored ascending (oldest → newest), and the
inner loop pushed until `limit`, so it collected the oldest N closed slices of a month and dropped
the recent ones. Changed the inner loop to iterate `[...index].reverse()` (newest-first). Deterministic
correctness fix, no signature/behavior change beyond ordering. Directly fixes silent recall degradation
on any month with >15 closed slices (the demo persona, and any long-lived month).

### Correctness L1 — `RecallPhase` elapsed timer double-divided seconds
`src/components/chat/recall-phase.tsx` — `elapsed` is already whole seconds; `${elapsed / 1000}s`
rendered e.g. `0.003s`. Changed to `${elapsed}s`, matching `thinking.tsx`. One-line, obviously correct.

### Security L2 — `readIndex` tool accepted an unbounded, non-integer `year`
`src/app/api/chat/route.ts` — `year: z.number()` → `year: z.number().int().min(2000).max(2100)`,
mirroring the already-bounded `month`. Constrains an LLM-supplied path segment. No legitimate value
is rejected.

### Security M2 — `/api/episodic/flush` did no schema validation on the body
`src/app/api/episodic/flush/route.ts` — replaced the hand-rolled `sliceId`/`turns` checks with a zod
schema: `sliceId` (1–64 chars), `turns[]` non-empty with `role: enum(["user","agent"])`,
`content: string().max(100_000)`, `timestamp: string().max(64)`; returns 400 on parse failure. `zod`
is already a project dependency (used for tool schemas). Legitimate payloads are unaffected; only
malformed/typed-wrong bodies are now rejected.
*Scope note:* I applied the type/shape validation only. I did **not** add the report's suggested
`## Turn` content-escaping or a strict ISO/`sliceId` regex — those alter how legitimate content is
persisted/parsed and belong with the auth work (see deferred H2).

### Security L1 — internal error details returned to unauthenticated clients
`src/app/api/episodic/flush/route.ts` (500 body) and `src/app/api/chat/route.ts` (env-config error) —
both now log the detail server-side (`console.error`) and return a generic message
(`"Internal error"` / `"Server configuration error"`) instead of `error.message`. Removes a recon aid.

### Conventions H1 — `src/components/chat/CLAUDE.md` misdescribed the component tree
`src/components/chat/CLAUDE.md` — regenerated the Overview, Component Tree, Message Part Flow, File Map,
and Design Decisions from the current directory. Removed five phantom files (`model-pill.tsx`,
`summary-bar.tsx`, `slash-command-dropdown.tsx`, `dashed-separator.tsx`, `time-slice-recovery.tsx`);
added the five that own the real structure (`chat-page.tsx`, `chat-section.tsx`, `memory-section.tsx`,
`hero-section.tsx`, `date-group-header.tsx`); updated the ASCII tree to the real
`ChatPage → hero / MemorySection / ChatSection → ChatMessage` split. Doc-only. The doc now honestly
notes the message footer is gated on an `onRegenerate` prop that is not currently threaded (see
deferred Conventions M1).

### Conventions L2 — routine `console.log` tracing in a per-row server action
`src/lib/episodic/actions.ts` — dropped the three informational `console.log`s in `getSliceContent`
(sliceId→path, byte count, parsed turn/char counts) that fire on every timeline row mount. Kept the
`console.error` on failure. Matches the surrounding module's warn/error-only logging density.
*Not applied:* the report also flagged `[Episodic]/[Flash]/[M3]` traces in `route.ts`. Gating those
behind a debug flag is a larger, judgement-heavy edit across the streaming handler — deferred with M3.

---

## Deferred (14) — need a decision, carry behavior/scope risk, or are larger refactors

### Requires a product/architecture decision
- **Security H1 — API routes are completely unauthenticated.** The fix (middleware + shared
  secret/session, or documented reliance on Vercel deployment protection) is an architecture decision
  with new env vars and a login story. Highest-impact finding; must be a deliberate human choice.
- **Security H2 — unauthenticated `/api/episodic/flush` allows stored prompt injection / repo-write
  abuse.** Same auth gate as H1; also wants session-ownership binding for the slice. Decision-gated.
- **Security M1 — mutable memory/profile/episodic content spliced into the system prompt with no
  provenance fence.** The fix reshapes the prompt (fenced `<user_data>`/`<recalled_memory>` blocks +
  a standing DIRECTIVE). That changes model inputs → product behavior; needs prompt-design sign-off.
- **Correctness L4 — image attachments silently dropped on submit.** Either build multimodal `parts`
  or disable the attachment UI — a feature decision, not a mechanical fix.
- **Conventions M1 — message footer (Copy/Regenerate) unreachable.** Threading `regenerate` through
  and adding `group` hover *adds* a user-facing feature. Product behavior change; out of scope.
- **Conventions M2 — `loadedSliceIds` sent but never read by the server.** Either implement recall
  de-dup or delete the plumbing — intent decision. (The wire contract is documented as-is in the
  refreshed CLAUDE.md.)
- **Conventions L1 — `/api/episodic/flush` has no HTTP caller.** Fix is "wire the `beforeunload`
  `sendBeacon` or delete the route" — a durability-vs-removal decision.

### Behavior-risk / needs careful logic (not "clearly low-risk")
- **Correctness M2 — `getMoreSlices` only scans one month in production**, so timeline "load more"
  stalls at the month boundary. Genuine bug, but the fix (bounded month-walking + a correct `hasMore`)
  is non-trivial pagination logic with real regression surface. Deferred for a focused change + test.
- **Correctness M3 — hydration mismatch in timeline date grouping** (local-`Date` group keys during
  SSR). Fix means gating grouping on a `mounted` flag or fixed-timezone formatting — changes what SSR
  emits and can introduce layout shift. Needs deliberate handling, not a drive-by edit.
- **Correctness L2 — `isNewSlice` content-based guard can drop a user turn.** Fix requires returning
  an explicit "created this request" boolean from the housekeeping branch — a small state refactor in
  the hot chat path; deferred to avoid an untested change there.
- **Correctness L3 — module-level `activeSlice` races across concurrent requests.** Needs per-slice
  write serialization or an `onFinish` identity re-check. Concurrency change; risky without focused
  testing. (Bounded by single-user usage.)

### Larger refactors (quality, not correctness/security)
- **Conventions M3 — heavy non-streaming logic inlined in the chat route.** Moving
  `buildTimelineEpisodicContext`/`formatRelativeTime`/`buildDynamicSystemPrompt` into `lib/` is a
  multi-file refactor of a 450-line handler; high regression surface for a structural cleanup.
- **Conventions M4 — hardcoded mixed zh/en strings, no `useTranslations`.** Large i18n effort
  (explicitly deferred to `03-i18n.md` by the review itself). Out of scope here.
- **Conventions L3 / L4 — `MemorySection` passthrough wrapper and duplicated client setting keys.**
  Both are reasonable tidy-ups but restructure the tree / introduce a new shared module; deferred as
  scope creep beyond "clearly correct, no behavior change." (L4 pairs naturally with a settings-config
  extraction.)

---

## Verification

- `npx tsc --noEmit` → **exit 0**, no errors introduced.
- All edits are within the reviewed files; no `src/` behavior changed beyond the applied fixes above.
</content>
