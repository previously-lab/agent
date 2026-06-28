"use client";

import { useState, useEffect } from "react";
import { Rocket, RefreshCw, CheckCircle2, Circle } from "lucide-react";
import { RepoHub } from "./repo-hub";
import { Button } from "@/components/ui/button";

export function SettingsForm() {
  const [mounted, setMounted] = useState(false);
  const [model, setModel] = useState("deepseek-chat");
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState("");
  const [checkingVersion, setCheckingVersion] = useState(false);
  const [versionMsg, setVersionMsg] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setMounted(true);
    setModel(localStorage.getItem("AFTRBREZ_MODEL") ?? "deepseek-chat");
    setRepoOwner(localStorage.getItem("GITHUB_REPO_OWNER") ?? "");
    setRepoName(localStorage.getItem("GITHUB_REPO_NAME") ?? "");
  }, []);

  const handleModelChange = (m: string) => {
    setModel(m);
    localStorage.setItem("AFTRBREZ_MODEL", m);
  };

  const handleDeploy = async () => {
    setDeploying(true);
    setDeployMsg("");
    try {
      const res = await fetch("/api/deploy", { method: "POST" });
      const data = await res.json();
      setDeployMsg(data.message);
    } catch {
      setDeployMsg("Deploy failed. Make sure the repo is connected and git is available.");
    } finally {
      setDeploying(false);
    }
  };

  const handleVersionCheck = async () => {
    setCheckingVersion(true);
    setVersionMsg("");
    try {
      const res = await fetch("https://raw.githubusercontent.com/LikeDreamwalker/Aftrbrez/main/package.json");
      const upstream = await res.json();
      const current = "0.1.0"; // from package.json
      if (upstream.version !== current) {
        setVersionMsg(`v${upstream.version} available (current: v${current}). Use \`git merge upstream/main\` to update.`);
      } else {
        setVersionMsg(`Up to date (v${current}).`);
      }
    } catch {
      setVersionMsg("Could not check for updates. Are you online?");
    } finally {
      setCheckingVersion(false);
    }
  };

  const handleSave = () => {
    localStorage.setItem("GITHUB_REPO_OWNER", repoOwner);
    localStorage.setItem("GITHUB_REPO_NAME", repoName);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!mounted) {
    return <div className="animate-pulse space-y-6"><div className="h-20 bg-muted rounded" /><div className="h-40 bg-muted rounded" /></div>;
  }

  return (
    <div className="space-y-8">
      {/* API Key Status */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">API Status</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">DeepSeek</span>
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> Connected
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">GitHub</span>
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Circle className="h-4 w-4" /> Not configured
            </span>
          </div>
        </div>
      </section>

      {/* Model Selector */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">Model</h3>
        <select
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}
          className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="deepseek-chat">DeepSeek Chat (default)</option>
          <option value="deepseek-reasoner">DeepSeek Reasoner</option>
        </select>
      </section>

      {/* Repo Hub */}
      <section className="rounded-lg border border-border p-4">
        <RepoHub />
      </section>

      {/* Manual Repo Config */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">Repository Config</h3>
        <div className="space-y-3">
          <input
            type="text"
            value={repoOwner}
            onChange={(e) => setRepoOwner(e.target.value)}
            placeholder="GitHub Owner (e.g. LikeDreamwalker)"
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="text"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="GitHub Repo Name (e.g. Aftrbrez)"
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button onClick={handleSave} disabled={!repoOwner || !repoName} className="w-full">
            {saved ? "Saved ✓" : "Save"}
          </Button>
        </div>
      </section>

      {/* Deploy */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">Deployment</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Deploys are triggered by commits with <code className="bg-muted px-1 rounded">[deploy]</code> in the message.
        </p>
        <Button onClick={handleDeploy} disabled={deploying} variant="outline" className="w-full">
          <Rocket className="h-4 w-4 mr-2" />
          {deploying ? "Deploying..." : "Deploy"}
        </Button>
        {deployMsg && <p className="text-xs text-muted-foreground mt-2">{deployMsg}</p>}
      </section>

      {/* Version Check */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">Version</h3>
        <Button onClick={handleVersionCheck} disabled={checkingVersion} variant="outline" className="w-full">
          <RefreshCw className={`h-4 w-4 mr-2 ${checkingVersion ? "animate-spin" : ""}`} />
          {checkingVersion ? "Checking..." : "Check for Updates"}
        </Button>
        {versionMsg && <p className="text-xs text-muted-foreground mt-2">{versionMsg}</p>}
      </section>
    </div>
  );
}
