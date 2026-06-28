interface ModelPillProps {
  model: string;
  reasoningEffort?: string;
}

export function ModelPill({ model, reasoningEffort }: ModelPillProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground border border-border/50">
      <span className="font-medium">{model}</span>
      {reasoningEffort && (
        <>
          <span className="opacity-40">·</span>
          <span>{reasoningEffort}</span>
        </>
      )}
    </span>
  );
}
