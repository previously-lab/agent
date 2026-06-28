"use client";

import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  MessageSquare,
  Brain,
  Target,
  Archive,
  Settings,
  ChevronLeft,
  ChevronRight,
  Menu,
} from "lucide-react";
import { NavItem } from "./nav-item";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/missions", label: "Missions", icon: Target },
  { href: "/archive", label: "Archive", icon: Archive },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Close mobile sidebar on navigation
  const handleNav = () => {
    if (isMobile) setMobileOpen(false);
  };

  if (!mounted) return null;

  const sidebarContent = (
    <div
      className={cn(
        "flex flex-col h-full border-r border-border bg-sidebar transition-all duration-200",
        collapsed && !isMobile ? "w-[3rem]" : "w-60"
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center h-12 px-3 border-b border-border",
          collapsed && !isMobile ? "justify-center" : "justify-between"
        )}
      >
        {(!collapsed || isMobile) && (
          <span className="font-semibold text-sm">Aftrbrez</span>
        )}
        {!isMobile && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 flex items-center justify-center transition-colors"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => (
          <div key={item.href} onClick={handleNav}>
            <NavItem
              href={item.href}
              label={item.label}
              icon={item.icon}
              collapsed={collapsed && !isMobile}
            />
          </div>
        ))}
      </nav>
    </div>
  );

  // Mobile: render as overlay
  if (isMobile) {
    return (
      <>
        <button
          onClick={() => setMobileOpen(true)}
          className="fixed top-2 left-2 z-50 h-8 w-8 rounded-full bg-background border border-border flex items-center justify-center shadow-sm md:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
        {mobileOpen && (
          <div className="fixed inset-0 z-40 flex">
            <div
              className="fixed inset-0 bg-black/50"
              onClick={() => setMobileOpen(false)}
            />
            <div className="relative z-50">{sidebarContent}</div>
          </div>
        )}
      </>
    );
  }

  // Desktop: always visible
  return sidebarContent;
}
