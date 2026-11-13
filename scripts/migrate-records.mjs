/**
 * Copy retired episodic slices into the canonical records tree.
 *
 * Usage: node scripts/migrate-records.mjs --root <repository-root> [--apply]
 * The default is dry-run. Conflicting slices are reported and blocked as a
 * whole; the script never merges core metadata or agent processing markers.
 */
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const LEGACY_ROOT = "memory/episodic/slices";
const RECORDS_ROOT = "memory/records";
const PART_RE = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})$/;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function filesUnder(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(root, rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error(`Unsupported non-regular file: ${path.join(root, rel)}`);
  }
  return files.sort();
}

async function legacySlices(root) {
  const base = path.join(root, LEGACY_ROOT);
  if (!(await exists(base))) return [];
  const files = await filesUnder(base);
  const slices = new Map();
  for (const file of files) {
    const match = PART_RE.exec(file.split("/").slice(0, 4).join("/"));
    if (!match) continue;
    const id = `${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
    const entries = slices.get(id) ?? [];
    entries.push(file);
    slices.set(id, entries);
  }
  return [...slices.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function destinationRelative(file) {
  return file.split("/").slice(4).join("/").replace(/^timeline\//, "");
}

async function inspectSlice(root, id, legacyFiles) {
  const legacyDirectory = `${LEGACY_ROOT}/${id.replaceAll("-", "/")}`;
  const recordsDirectory = `${RECORDS_ROOT}/${id.replaceAll("-", "/")}`;
  const destinations = new Map();
  const files = [];
  let conflict = false;
  let identical = 0;
  for (const legacyFile of legacyFiles) {
    const relative = destinationRelative(legacyFile);
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`Unsafe migration path: ${legacyFile}`);
    }
    const source = path.join(root, legacyDirectory, legacyFile.split("/").slice(4).join("/"));
    const destination = path.join(root, recordsDirectory, relative);
    const sourceRelative = legacyFile.split("/").slice(4).join("/");
    if (destinations.has(relative)) {
      conflict = true;
      files.push({ file: relative, action: "conflict", reason: "multiple legacy files map to this destination" });
      continue;
    }
    destinations.set(relative, destination);
    if (!(await exists(destination))) {
      files.push({ file: relative, action: "copy", source: sourceRelative });
      continue;
    }
    const [sourceBytes, destinationBytes] = await Promise.all([
      fs.readFile(source),
      fs.readFile(destination),
    ]);
    if (sourceBytes.equals(destinationBytes)) {
      identical += 1;
      files.push({ file: relative, action: "identical", source: sourceRelative });
    } else {
      conflict = true;
      files.push({
        file: relative,
        action: "conflict",
        source: sourceRelative,
        reason: "destination differs; automatic merging is unsafe, especially for core metadata and agent processing markers",
      });
    }
  }
  return {
    id,
    status: conflict ? "overlap-conflict" : identical > 0 ? "overlap-identical" : "legacy-only",
    blocked: conflict,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    copies: files.filter((entry) => entry.action === "copy").length,
    identical,
  };
}

async function copySlice(root, id, report) {
  const recordsDirectory = path.join(root, RECORDS_ROOT, id.replaceAll("-", "/"));
  for (const entry of report.files) {
    if (entry.action !== "copy") continue;
    const legacyFile = `${LEGACY_ROOT}/${id.replaceAll("-", "/")}/${entry.source}`;
    const source = path.join(root, legacyFile);
    const destination = path.join(recordsDirectory, entry.file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

const rootArgument = argument("root");
if (!rootArgument) {
  console.error("Refusing to guess a repository root. Pass --root <repository-root>; dry-run is the default.");
  process.exitCode = 1;
} else {
  const root = path.resolve(rootArgument);
  const apply = process.argv.includes("--apply");
  try {
    const slices = [];
    for (const [id, files] of await legacySlices(root)) {
      slices.push(await inspectSlice(root, id, files));
    }
    if (apply) {
      for (const report of slices) {
        if (!report.blocked) await copySlice(root, report.id, report);
      }
    }
    const summary = {
      legacyOnly: slices.filter((slice) => slice.status === "legacy-only").length,
      overlapIdentical: slices.filter((slice) => slice.status === "overlap-identical").length,
      overlapConflict: slices.filter((slice) => slice.status === "overlap-conflict").length,
    };
    console.log(JSON.stringify({ dryRun: !apply, root, summary, slices }, null, 2));
    if (summary.overlapConflict > 0) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
