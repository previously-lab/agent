# scripts/archive

One-off migration and repair scripts from earlier iterations, kept for
reference only. None of these are wired into `package.json`, CI, or the
app — do not run them against current data without reading them first.

Caveats:

- Several scripts hardcode stale paths. `fix-agent-memory.mjs` points at a
  different repo checkout; `update-demo-metadata.mjs` and
  `fix-rotated-metadata.mjs` reference `memory/demo/personal_14/...` trees
  that no longer exist (demo data moved to `benchmark-data/`).
- `migrate-slices-to-time.mjs`, `shift-all-dates.mjs`,
  `shift-demo-dates.mjs`, and `apply-enrichment.mjs` were single-use
  migrations whose transforms have already been applied.
- `convert-worldmemarena.mjs` (originally `benchmark-data/convert.mjs`) was
  the one-off WorldMemArena → slice converter; its input data lives in the
  gitignored `benchmark-data/` dir, and its `__dirname`-relative paths still
  point there. `smoke-search.mjs` was the one-off DeepSeek web-search smoke
  test referenced from `src/lib/search/flash-search.ts`.
- `migrate-strands-to-docs.mjs` (archived 2026-10-12, review ruling #9 /
  D-06): one-shot migration `episodic/strands/<名>.md` → `docs/topic/<名>.md`
  from the v0.15 doc generation. The `docs/topic` target was later ruled to
  NOT be established, so the migration never ran and never will. Reference
  only; still runnable against an old-layout root (`MEMORY_ROOT=… node
  scripts/archive/migrate-strands-to-docs.mjs --apply`) if that ruling is
  ever revisited. Its test lives at `tests/lib/docs/migrate-strands-to-docs.test.ts`.
- `batch-convert.mjs` (archived 2026-10-12, review ruling #9 / D-06): the
  old-head benchmark generator (WorldMemArena `personal_*.json` → episodic
  slice trees under `benchmark-data/`). Single-use; the benchmark data it
  produced already exists. Its default `--raw`/`--out` dirs are
  `__dirname`-relative (`../benchmark-data`), so after the move into
  `scripts/archive/` the defaults resolve one level short — pass both flags
  explicitly if it is ever re-run.
