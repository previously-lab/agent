"use client";

import { cn } from "@/lib/utils";
import { FileText, FileCode } from "lucide-react";

function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function getFileIcon(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const codeExts = new Set([
    "ts", "tsx", "js", "jsx", "json", "css", "html", "md", "py",
    "rs", "go", "java", "rb", "yml", "yaml", "toml", "sh",
  ]);
  if (ext && codeExts.has(ext)) {
    return <FileCode className="h-3.5 w-3.5 shrink-0 mr-1" />;
  }
  return <FileText className="h-3.5 w-3.5 shrink-0 mr-1" />;
}

export function FileNamePill({
  filePath,
  error = false,
}: {
  filePath: string;
  error?: boolean;
}) {
  const fileName = getFileName(filePath);
  const icon = getFileIcon(fileName);

  return (
    <span
      className={cn(
        "inline-flex max-w-[220px] items-center rounded border px-1.5 py-0.5 font-mono text-[12px] leading-tight",
        error
          ? "border-red-500/30 bg-red-500/10 text-red-400"
          : "border-border/80 bg-muted/60 text-muted-foreground",
      )}
    >
      {icon}
      <span className="truncate">{fileName}</span>
    </span>
  );
}
