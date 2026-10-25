import { PanelLeft, X, Package } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { LucideIcon } from "lucide-react"

export type NavItem = { id: string; label: string; icon: LucideIcon }

/*
 * Layout pattern taken from satnaing/shadcn-admin
 * (src/components/layout/app-sidebar.tsx):
 *   SidebarHeader  -> brand / team switcher area
 *   SidebarContent -> navigation groups from a data array
 *   SidebarFooter  -> user area
 * Adaptations for this project, documented in the final report:
 * - No TanStack Router, so navigation is a view state, not routes.
 * - Persistence is localStorage (opname-sidebar-collapsed), not the
 *   shadcn-admin sidebar cookie, because the project spec requires it.
 * - Widths are 240px expanded / 64px collapsed per project spec,
 *   close to shadcn-admin's 16rem / 3rem icon mode.
 * - Mobile uses a fixed drawer + backdrop in App, the same overlay
 *   idea as shadcn-admin's mobile Sheet sidebar, without copying
 *   the full ui/sidebar.tsx Sheet/Tooltip/context implementation.
 */
export function AppSidebar({
  items,
  view,
  onSelect,
  collapsed,
  onToggleCollapse,
  onCloseMobile,
  userName,
  userRole,
  className,
}: {
  items: NavItem[]
  view: string
  onSelect: (id: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
  onCloseMobile?: () => void
  userName: string
  userRole: string
  className?: string
}) {
  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r bg-card text-card-foreground",
        className
      )}
    >
      {/* SidebarHeader */}
      <div className={collapsed ? "flex flex-col items-center gap-2 px-2 py-3" : "flex items-center gap-2 px-3 py-3"}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Package className="size-5" />
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Apname</p>
            <p className="truncate text-xs text-muted-foreground">Opname Per Rak</p>
          </div>
        )}
        <div className={collapsed ? "flex shrink-0 gap-1" : "ml-auto flex shrink-0 gap-1"}>
          <Button
            variant="ghost"
            size="icon"
            title={collapsed ? "Perluas sidebar" : "Ciutkan sidebar"}
            aria-label={collapsed ? "Perluas sidebar" : "Ciutkan sidebar"}
            onClick={onToggleCollapse}
            className="hidden md:inline-flex"
          >
            <PanelLeft className="size-4" />
          </Button>
          {onCloseMobile && (
            <Button variant="ghost" size="icon" aria-label="Tutup menu" onClick={onCloseMobile} className="md:hidden">
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <Separator />
      {/* SidebarContent: one navigation group, data-driven */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {!collapsed && (
          <p className="px-2 pt-1 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Menu Utama
          </p>
        )}
        {items.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <Button
              key={item.id}
              variant={active ? "default" : "ghost"}
              title={item.label}
              aria-label={item.label}
              onClick={() => onSelect(item.id)}
              className={cn("w-full justify-start gap-2", collapsed && "justify-center px-0")}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Button>
          )
        })}
      </nav>
      <Separator />
      {/* SidebarFooter */}
      <div className="p-3">
        {collapsed ? (
          <Badge variant="secondary" title={`${userName} • ${userRole}`} className="w-full justify-center">
            {userName.slice(0, 1).toUpperCase()}
          </Badge>
        ) : (
          <div className="space-y-1">
            <p className="truncate text-sm font-medium">{userName}</p>
            <Badge variant="secondary">{userRole}</Badge>
          </div>
        )}
      </div>
    </aside>
  )
}
