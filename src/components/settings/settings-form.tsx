"use client";

import { useState, useEffect } from "react";

export function SettingsForm() {
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setRepoOwner(localStorage.getItem("GITHUB_REPO_OWNER") ?? "");
    setRepoName(localStorage.getItem("GITHUB_REPO_NAME") ?? "");
  }, []);

  const handleSave = () => {
    localStorage.setItem("GITHUB_REPO_OWNER", repoOwner);
    localStorage.setItem("GITHUB_REPO_NAME", repoName);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!mounted) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-border p-4 animate-pulse">
          <div className="h-4 w-24 bg-muted rounded mb-2" />
          <div className="h-3 w-48 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* API Key status */}
      <div className="rounded-lg border border-border p-4">
        <label className="text-sm font-medium">Anthropic API Key</label>
        <p className="text-xs text-muted-foreground mt-1">
          Set via <code className="bg-muted px-1 rounded">ANTHROPIC_API_KEY</code> environment variable.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${hasApiKey ? "bg-green-500" : "bg-yellow-500"}`}
          />
          <span className="text-sm text-muted-foreground">
            {hasApiKey ? "Configured" : "Not configured"}
          </span>
        </div>
      </div>

      {/* GitHub repo */}
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium" htmlFor="repoOwner">
            GitHub Repository Owner
          </label>
          <input
            id="repoOwner"
            type="text"
            value={repoOwner}
            onChange={(e) => setRepoOwner(e.target.value)}
            placeholder="e.g. LikeDreamwalker"
            className="mt-1 w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor="repoName">
            GitHub Repository Name
          </label>
          <input
            id="repoName"
            type="text"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="e.g. Aftrbrez"
            className="mt-1 w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={!repoOwner || !repoName}
        className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saved ? "Saved ✓" : "Save Settings"}
      </button>
    </div>
  );
}
