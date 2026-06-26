"use client";

import { useState } from "react";
import { setRequestLocale } from "next-intl/server";

// This is a Client Component for form interactivity.
// Settings are stored in localStorage since this is a personal tool.

export default function SettingsPage() {
  const [repoOwner, setRepoOwner] = useState(
    () => (typeof window !== "undefined" && localStorage.getItem("GITHUB_REPO_OWNER")) || ""
  );
  const [repoName, setRepoName] = useState(
    () => (typeof window !== "undefined" && localStorage.getItem("GITHUB_REPO_NAME")) || ""
  );
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    localStorage.setItem("GITHUB_REPO_OWNER", repoOwner);
    localStorage.setItem("GITHUB_REPO_NAME", repoName);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Settings</h1>
      <p className="text-muted-foreground text-sm mb-8">
        Configure your GitHub repository connection.
      </p>

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

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={!repoOwner || !repoName}
          className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saved ? "Saved ✓" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
