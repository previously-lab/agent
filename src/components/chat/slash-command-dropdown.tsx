"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { matchSkills } from "@/lib/skills/registry";
import type { SkillConfig } from "@/lib/skills/types";

interface SlashCommandDropdownProps {
  query: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function SlashCommandDropdown({
  query,
  onSelect,
  onClose,
}: SlashCommandDropdownProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [matches, setMatches] = useState<SkillConfig[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.startsWith("/")) {
      const searchTerm = query;
      setMatches(matchSkills(searchTerm));
      setSelectedIndex(0);
    } else {
      setMatches([]);
    }
  }, [query]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % matches.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + matches.length) % matches.length);
          break;
        case "Enter":
          e.preventDefault();
          if (matches[selectedIndex]) {
            onSelect(matches[selectedIndex].command);
          }
          break;
        case "Escape":
          onClose();
          break;
      }
    },
    [matches, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (matches.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-72 rounded-lg border border-border bg-popover shadow-lg overflow-hidden z-50"
    >
      <div className="p-1">
        {matches.map((skill, i) => (
          <button
            key={skill.command}
            type="button"
            onClick={() => onSelect(skill.command)}
            className={`w-full flex items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
              i === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/50"
            }`}
          >
            <span className="font-mono text-xs text-muted-foreground mt-0.5 shrink-0">
              {skill.command}
            </span>
            <span className="text-muted-foreground truncate">
              {skill.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
