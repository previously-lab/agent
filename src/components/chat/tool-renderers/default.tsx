interface DefaultRendererProps {
  toolName: string;
  input?: unknown;
}

export function DefaultRenderer({ toolName, input }: DefaultRendererProps) {
  const inputStr = typeof input === "string" ? input : JSON.stringify(input);
  const truncated = inputStr.slice(0, 80);

  return (
    <div className="text-xs text-muted-foreground">
      <span className="font-medium">{toolName}</span>
      {truncated && <span className="ml-1 font-mono opacity-70">{truncated}{inputStr.length > 80 ? "..." : ""}</span>}
    </div>
  );
}
