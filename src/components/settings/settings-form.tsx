"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Rocket, RefreshCw, CheckCircle2, Circle } from "lucide-react";
import { RepoHub } from "./repo-hub";
import { Button } from "@/components/ui/button";
import { deploy } from "@/lib/deploy/actions";

export function SettingsForm() {
  const t = useTranslations("settings.form");
  const [mounted, setMounted] = useState(false);
  const [model, setModel] = useState("deepseek-chat");
  const [thinking, setThinking] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState("");
  const [checkingVersion, setCheckingVersion] = useState(false);
  const [versionMsg, setVersionMsg] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setMounted(true);
    setModel(localStorage.getItem("PREVIOUSLY_MODEL") ?? "deepseek-chat");
    setThinking(localStorage.getItem("PREVIOUSLY_THINKING") !== "false");
    setRepoOwner(localStorage.getItem("GITHUB_REPO_OWNER") ?? "");
    setRepoName(localStorage.getItem("GITHUB_REPO_NAME") ?? "");
  }, []);

  const handleModelChange = (m: string) => {
    setModel(m);
    localStorage.setItem("PREVIOUSLY_MODEL", m);
  };

  const handleThinkingChange = (v: boolean) => {
    setThinking(v);
    localStorage.setItem("PREVIOUSLY_THINKING", String(v));
  };

  const handleDeploy = async () => {
    setDeploying(true);
    setDeployMsg("");
    try {
      const data = await deploy();
      setDeployMsg(data.message);
    } catch {
      setDeployMsg(t("deployFailed"));
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
        setVersionMsg(t("versionAvailable", { version: upstream.version, current }));
      } else {
        setVersionMsg(t("versionUpToDate", { version: current }));
      }
    } catch {
      setVersionMsg(t("versionCheckFailed"));
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
        <h3 className="text-sm font-medium mb-3">{t("apiStatus")}</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">DeepSeek</span>
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> {t("connected")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">GitHub</span>
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Circle className="h-4 w-4" /> {t("notConfigured")}
            </span>
          </div>
        </div>
      </section>

      {/* Model Selector */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">{t("modelSection")}</h3>
        <select
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}
          className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="deepseek-chat">{t("modelChat")}</option>
          <option value="deepseek-reasoner">{t("modelReasoner")}</option>
        </select>

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
          <div>
            <span className="text-sm">{t("thinkingLabel")}</span>
            <p className="text-xs text-muted-foreground">{t("thinkingDesc")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={thinking}
            onClick={() => handleThinkingChange(!thinking)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              thinking ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                thinking ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </section>

      {/* Repo Hub */}
      <section className="rounded-lg border border-border p-4">
        <RepoHub />
      </section>

      {/* Manual Repo Config */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">{t("repoConfig")}</h3>
        <div className="space-y-3">
          <input
            type="text"
            value={repoOwner}
            onChange={(e) => setRepoOwner(e.target.value)}
            placeholder={t("ownerPlaceholder")}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="text"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder={t("repoPlaceholder")}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button onClick={handleSave} disabled={!repoOwner || !repoName} className="w-full">
            {saved ? t("saved") : t("save")}
          </Button>
        </div>
      </section>

      {/* Deploy */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">{t("deployment")}</h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t.rich("deployDesc", {
            code: (chunks) => <code className="bg-muted px-1 rounded">{chunks}</code>,
          })}
        </p>
        <Button onClick={handleDeploy} disabled={deploying} variant="outline" className="w-full">
          <Rocket className="h-4 w-4 mr-2" />
          {deploying ? t("deploying") : t("deploy")}
        </Button>
        {deployMsg && <p className="text-xs text-muted-foreground mt-2">{deployMsg}</p>}
      </section>

      {/* Version Check */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">{t("version")}</h3>
        <Button onClick={handleVersionCheck} disabled={checkingVersion} variant="outline" className="w-full">
          <RefreshCw className={`h-4 w-4 mr-2 ${checkingVersion ? "animate-spin" : ""}`} />
          {checkingVersion ? t("checkingUpdates") : t("checkUpdates")}
        </Button>
        {versionMsg && <p className="text-xs text-muted-foreground mt-2">{versionMsg}</p>}
      </section>
    </div>
  );
}
