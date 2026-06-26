import { setRequestLocale } from "next-intl/server";
import { listFiles } from "@/lib/tools/listFiles";
import { Activity, Brain, Target, Archive } from "lucide-react";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  let memoryCount = 0;
  let taskCount = 0;
  let sessionCount = 0;
  let recentFiles: Array<{ name: string; path: string; dir: string }> = [];

  const repo = process.env.GITHUB_REPO_NAME ?? "";
  const owner = process.env.GITHUB_REPO_OWNER ?? "";

  if (repo && owner) {
    try {
      const [memoryFiles, taskFiles, sessionFiles] = await Promise.all([
        listFiles("memory", repo, owner).catch(() => []),
        listFiles("tasks", repo, owner).catch(() => []),
        listFiles("sessions", repo, owner).catch(() => []),
      ]);
      memoryCount = memoryFiles.length;
      taskCount = taskFiles.length;
      sessionCount = sessionFiles.length;

      recentFiles = [
        ...memoryFiles.slice(0, 3).map((f) => ({ ...f, dir: "memory" })),
        ...taskFiles.slice(0, 3).map((f) => ({ ...f, dir: "tasks" })),
        ...sessionFiles.slice(0, 3).map((f) => ({ ...f, dir: "sessions" })),
      ].slice(0, 6);
    } catch {
      // GitHub not configured — show empty state
    }
  }

  const hasData = memoryCount > 0 || taskCount > 0 || sessionCount > 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Command Center</h1>
      <p className="text-muted-foreground mb-8 text-sm">
        Overview of your AI commander platform.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatCard icon={Brain} label="Memories" count={memoryCount} href="/memory" />
        <StatCard icon={Target} label="Missions" count={taskCount} href="/missions" />
        <StatCard icon={Archive} label="Sessions" count={sessionCount} href="/archive" />
      </div>

      {hasData ? (
        <div>
          <h2 className="text-lg font-semibold mb-3">Recent Activity</h2>
          <div className="space-y-2">
            {recentFiles.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-3 rounded-md border border-border px-4 py-2 text-sm"
              >
                <span className="text-xs text-muted-foreground w-16 uppercase">{file.dir}</span>
                <span className="flex-1">{file.name}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
          <Activity className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
          <h3 className="font-medium mb-1">No activity yet</h3>
          <p className="text-sm text-muted-foreground">
            Open Chat to start commanding your agents. Files in memory/, tasks/, and sessions/ will appear here.
          </p>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  count,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  href: string;
}) {
  return (
    <a
      href={href}
      className="flex items-center gap-4 rounded-lg border border-border p-4 hover:bg-accent transition-colors"
    >
      <Icon className="h-8 w-8 text-muted-foreground" />
      <div>
        <div className="text-2xl font-bold">{count}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </a>
  );
}
