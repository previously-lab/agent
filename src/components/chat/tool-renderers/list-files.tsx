import { FolderOpen } from "lucide-react";

interface ListFilesRendererProps {
  input?: unknown;
  output?: unknown;
}

export function ListFilesRenderer({ input, output }: ListFilesRendererProps) {
  const path = (input as { path?: string })?.path ?? "unknown";
  const items = Array.isArray(output) ? output as Array<{ name: string; type: string }> : [];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-mono text-muted-foreground">{path}</span>
        <span className="text-xs text-muted-foreground">({items.length} items)</span>
      </div>
      {items.length > 0 && (
        <div className="ml-6 text-xs text-muted-foreground space-y-0.5">
          {items.slice(0, 10).map((item, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span>{item.type === "dir" ? "📁" : "📄"}</span>
              <span className="font-mono">{item.name}</span>
            </div>
          ))}
          {items.length > 10 && (
            <div className="text-muted-foreground/70">...and {items.length - 10} more</div>
          )}
        </div>
      )}
    </div>
  );
}
