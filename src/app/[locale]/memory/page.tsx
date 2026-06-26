import { setRequestLocale } from "next-intl/server";
import { listFiles } from "@/lib/tools/listFiles";
import { FileList } from "@/components/memory/file-list";

export default async function MemoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const repo = process.env.GITHUB_REPO_NAME ?? "";
  const owner = process.env.GITHUB_REPO_OWNER ?? "";

  let files: Array<{ name: string; type: "file" | "dir"; path: string }> = [];
  let error: string | null = null;

  if (repo && owner) {
    try {
      files = await listFiles("memory", repo, owner);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load files";
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Memory</h1>
          <p className="text-muted-foreground text-sm">Browse your knowledge base.</p>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      <FileList files={files} directory="memory" />
    </div>
  );
}
