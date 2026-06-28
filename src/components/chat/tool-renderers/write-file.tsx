import { FilePlus } from "lucide-react";

interface WriteFileRendererProps {
  input?: unknown;
  output?: unknown;
}

export function WriteFileRenderer({ input, output }: WriteFileRendererProps) {
  const path = (input as { path?: string })?.path ?? "unknown";
  const result = output as { path?: string; created?: boolean } | undefined;
  const isNew = result?.created ?? false;

  return (
    <div className="flex items-center gap-2">
      <FilePlus className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-xs font-mono text-muted-foreground">{path}</span>
      <span className={`text-xs px-1.5 py-0.5 rounded ${isNew ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"}`}>
        {isNew ? "Created" : "Updated"}
      </span>
    </div>
  );
}
