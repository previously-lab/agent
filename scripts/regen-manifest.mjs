/** Regenerate manifest.json for benchmark-data repo. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "..", "benchmark-data");

const personas = fs.readdirSync(OUT)
  .filter((e) => e.startsWith("personal_") && fs.statSync(path.join(OUT, e)).isDirectory())
  .sort();

const manifest = { version: 1, personas: {} };

for (const p of personas) {
  const tree = {};
  function scanTree(dirPath, node) {
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        node[e.name] = {};
        scanTree(path.join(dirPath, e.name), node[e.name]);
      } else if (e.isFile() && !e.name.startsWith(".")) {
        if (!node._files) node._files = [];
        node._files.push(e.name);
      }
    }
  }
  scanTree(path.join(OUT, p), tree);

  let name = p, sliceCount = 0, dateRange = [];
  const strandsPath = path.join(OUT, p, "episodic", "strands.json");
  let topics = [];
  if (fs.existsSync(strandsPath)) {
    const strands = JSON.parse(fs.readFileSync(strandsPath, "utf-8"));
    topics = Object.keys(strands).slice(0, 12);
    const allPaths = Object.values(strands).flat();
    for (const rp of allPaths) {
      const parts = rp.split("/");
      if (parts.length >= 2) {
        const mKey = parts[0] + "-" + parts[1];
        if (!dateRange[0] || mKey < dateRange[0]) dateRange[0] = mKey;
        if (!dateRange[1] || mKey > dateRange[1]) dateRange[1] = mKey;
      }
    }
    sliceCount = new Set(allPaths).size;
  }

  const profilePath = path.join(OUT, p, "user", "profile.md");
  let blurb = "";
  if (fs.existsSync(profilePath)) {
    const raw = fs.readFileSync(profilePath, "utf-8");
    const fmMatch = raw.match(/---\n([\s\S]*?)---/);
    if (fmMatch) {
      const nm = fmMatch[1].match(/name:\s*(.+)/);
      if (nm) name = nm[1].trim();
    }
    // Extract narrative blurb: prefer quality-report overallNotes, fallback to profile body
    const qrPath = path.join(OUT, p, "quality-report.json");
    if (fs.existsSync(qrPath)) {
      try {
        const qr = JSON.parse(fs.readFileSync(qrPath, "utf-8"));
        if (qr.overallNotes) {
          blurb = qr.overallNotes.slice(0, 280).replace(/\n/g, " ").trim();
          if (qr.overallNotes.length > 280) blurb += "…";
        }
      } catch { /* fall through */ }
    }
    if (!blurb) {
      let body = raw.split("---").slice(2).join("---").trim();
      body = body.replace(/^Hello,?\s*I'd like to share my personal information[^.]*\.\s*/i, "");
      blurb = body.slice(0, 250).replace(/\n/g, " ").trim();
      if (body.length > 250) blurb += "…";
    }
  }

  manifest.personas[p] = {
    name,
    description: sliceCount + " sessions across " + (dateRange[0] || "?") + " → " + (dateRange[1] || "?"),
    blurb,
    topics,
    sliceCount,
    dateRange,
    tree,
  };
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("manifest.json updated: " + Object.keys(manifest.personas).length + " personas");
