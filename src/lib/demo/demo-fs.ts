/**
 * Demo-mode remote filesystem — reads benchmark persona data from a public
 * GitHub repository via raw.githubusercontent.com. No token required.
 *
 * Mirrors the local-fs.ts interface so tool executors can dispatch to it
 * transparently when DEMO_MODE is on.
 *
 *   Reads:  fetch raw URL → parse/return
 *   Lists:  consult cached manifest.json tree (no remote directory listing API)
 *   Writes: accepted but never persisted (demo is read-only)
 */

const BENCHMARK_BASE =
  process.env.BENCHMARK_BASE_URL ??
  "https://raw.githubusercontent.com/previously-lab/benchmark-data/main";

/** Currently selected persona id — set by the demo controller. */
let currentPersona = "personal_14";

export function setDemoPersona(personaId: string) {
  currentPersona = personaId;
}

export function getDemoPersona(): string {
  return currentPersona;
}

// ─── Manifest cache ──────────────────────────────────────────────────────

interface ManifestPersona {
  name: string;
  description: string;
  topics: string[];
  sliceCount: number;
  dateRange: string[];
  tree: Record<string, unknown>;
}

interface Manifest {
  version: number;
  personas: Record<string, ManifestPersona>;
}

let manifestPromise: Promise<Manifest> | null = null;
let manifestTtl = 0;

async function fetchManifest(): Promise<Manifest> {
  const now = Date.now();
  if (manifestPromise && now < manifestTtl) return manifestPromise;

  manifestTtl = now + 3_600_000; // 1 hour
  manifestPromise = fetch(`${BENCHMARK_BASE}/manifest.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
      return res.json() as Promise<Manifest>;
    })
    .catch((err) => {
      manifestPromise = null;
      manifestTtl = 0;
      throw err;
    });

  return manifestPromise;
}

// ─── File-level API (mirrors local-fs.ts) ────────────────────────────────

/**
 * Strip the `memory/` prefix and resolve to a remote URL.
 *
 *   memory/episodic/slices/2022/01/_index.json
 *   → {base}/personal_14/episodic/slices/2022/01/_index.json
 *
 *   memory/user/profile.md
 *   → {base}/personal_14/user/profile.md
 */
function buildRemoteUrl(path: string): string {
  // Normalise: strip memory/ prefix, replace with persona path
  const relative = path.replace(/^memory\//, "");
  return `${BENCHMARK_BASE}/${currentPersona}/${relative}`;
}

export async function readFileDemo(path: string): Promise<string> {
  const url = buildRemoteUrl(path);
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`File not found: "${path}"`);
    throw new Error(`Failed to read "${path}": HTTP ${res.status}`);
  }
  return res.text();
}

export async function listFilesDemo(
  path: string
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  const manifest = await fetchManifest();
  const persona = manifest.personas[currentPersona];
  if (!persona || !persona.tree) {
    throw new Error(`Persona "${currentPersona}" not found in manifest`);
  }

  // Navigate the manifest tree to the requested path
  // Path is like: memory/episodic/slices/2022/01
  const relative = path.replace(/^memory\//, "").replace(/\/$/, "");
  const segments = relative.split("/").filter(Boolean);

  // Walk into persona tree
  let node: unknown = persona.tree;
  for (const seg of segments) {
    if (node && typeof node === "object" && seg in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return []; // path doesn't exist in manifest
    }
  }

  const entries: Array<{ name: string; type: "file" | "dir"; path: string }> = [];
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "_files" && Array.isArray(value)) {
        for (const f of value as string[]) {
          entries.push({ name: f, type: "file" as const, path: `${path}/${f}` });
        }
      } else if (typeof value === "object" && value !== null) {
        entries.push({ name: key, type: "dir" as const, path: `${path}/${key}` });
      }
    }
  }

  return entries;
}

export async function writeFileDemo(
  path: string,
  _content: string
): Promise<{ path: string; created: boolean }> {
  // Demo mode is strictly read-only — accept writes but never persist.
  return { path, created: false };
}

// ─── Persona listing ──────────────────────────────────────────────────────

export async function listDemoPersonas(): Promise<ManifestPersona[]> {
  const manifest = await fetchManifest();
  return Object.entries(manifest.personas).map(([id, p]) => ({
    ...p,
    name: p.name,
    description: p.description,
    topics: p.topics,
    sliceCount: p.sliceCount,
    dateRange: p.dateRange,
    tree: p.tree,
  }));
}
