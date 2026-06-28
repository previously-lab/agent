import { FileText } from "lucide-react";

interface ReadFileRendererProps {
  input?: unknown;
  output?: unknown;
}

export function ReadFileRenderer({ input, output }: ReadFileRendererProps) {
  const path = (input as { path?: string })?.path ?? "unknown";
  const content = typeof output === "string" ? output : "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-mono text-muted-foreground">{path}</span>
      </div>
      {content && (
        <pre className="text-xs text-muted-foreground font-mono max-h-32 overflow-auto bg-muted/30 rounded p-2 whitespace-pre-wrap">
          {content.slice(0, 500)}
        </pre>
      )}
    </div>
  );
}
