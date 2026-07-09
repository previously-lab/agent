"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2, Lock, CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RepoEntry {
  id: string;
  owner: string;
  repo: string;
  url: string;
  source: "vercel" | "manual";
  addedAt: string;
}

export function RepoHub() {
  const t = useTranslations("settings.repo");
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);
  const [vercelRepo, setVercelRepo] = useState<RepoEntry | null>(null);

  useEffect(() => {
    setMounted(true);
    // Load from localStorage
    const saved = localStorage.getItem("PREVIOUSLY_REPOS");
    const manual: RepoEntry[] = saved ? JSON.parse(saved) : [];
    setRepos(manual);

    // Check for Vercel-injected repo
    const owner = process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER;
    const slug = process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG;
    if (owner && slug) {
      setVercelRepo({
        id: `vercel-${owner}-${slug}`,
        owner,
        repo: slug,
        url: `https://github.com/${owner}/${slug}`,
        source: "vercel",
        addedAt: "",
      });
    }
  }, []);

  const handleAdd = async () => {
    setError("");
    const parsed = parseInput(urlInput.trim());
    if (!parsed) {
      setError(t("invalidUrl"));
      return;
    }

    setAdding(true);
    try {
      // Client-side: just add it (server validation happens via API)
      const entry: RepoEntry = {
        id: `${parsed.owner}-${parsed.repo}-${Date.now()}`,
        owner: parsed.owner,
        repo: parsed.repo,
        url: `https://github.com/${parsed.owner}/${parsed.repo}`,
        source: "manual",
        addedAt: new Date().toISOString(),
      };

      const updated = [...repos, entry];
      setRepos(updated);
      localStorage.setItem("PREVIOUSLY_REPOS", JSON.stringify(updated));
      setUrlInput("");
    } catch {
      setError(t("addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = (id: string) => {
    const updated = repos.filter((r) => r.id !== id);
    setRepos(updated);
    localStorage.setItem("PREVIOUSLY_REPOS", JSON.stringify(updated));
  };

  if (!mounted) {
    return <div className="animate-pulse space-y-4"><div className="h-10 bg-muted rounded" /><div className="h-10 bg-muted rounded" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-3">{t("heading")}</h3>

        {/* Vercel Pinned Repo */}
        {vercelRepo && (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 mb-2">
            <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{vercelRepo.owner}/{vercelRepo.repo}</div>
              <div className="text-xs text-muted-foreground">{t("vercelSource")}</div>
            </div>
            <a href={vercelRepo.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        )}

        {/* Manual Repos */}
        {repos.length === 0 && !vercelRepo && (
          <p className="text-sm text-muted-foreground py-2">{t("empty")}</p>
        )}

        {repos.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border p-3 mb-2">
            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{r.owner}/{r.repo}</div>
              <div className="text-xs text-muted-foreground">{t("addedDate", { date: new Date(r.addedAt).toLocaleDateString() })}</div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => handleRemove(r.id)} className="h-8 w-8 text-muted-foreground hover:text-destructive" title={t("removeTooltip")}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Add Repo Form */}
      <div className="border-t border-border pt-4">
        <h4 className="text-sm font-medium mb-2">{t("addHeading")}</h4>
        <div className="flex gap-2">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={t("addPlaceholder")}
            className="flex-1 px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button onClick={handleAdd} disabled={adding || !urlInput.trim()} size="sm">
            <Plus className="h-4 w-4 mr-1" />
            {t("addButton")}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive mt-1.5">{error}</p>}
        <p className="text-xs text-muted-foreground mt-1.5">
          {t("addHelp")}
        </p>
      </div>
    </div>
  );
}

function parseInput(input: string): { owner: string; repo: string } | null {
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, "") };
  const shortMatch = input.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}
