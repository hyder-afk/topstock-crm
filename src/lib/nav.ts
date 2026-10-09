import type { LucideIcon } from "lucide-react";
import { ChartNoAxesColumn, Columns3, Ellipsis, House, ListChecks, Package, UsersRound } from "lucide-react";

// The dock's sections, in order (Master Plan 4: 7 on desktop, 5 on phones; Tasks and Analytics live under More on phones).
export const sections = [
  { id: "home", href: "/", icon: House, phone: true },
  { id: "leads", href: "/leads", icon: UsersRound, phone: true },
  { id: "pipeline", href: "/pipeline", icon: Columns3, phone: true },
  { id: "inventory", href: "/inventory", icon: Package, phone: true },
  { id: "tasks", href: "/tasks", icon: ListChecks, phone: false },
  { id: "analytics", href: "/analytics", icon: ChartNoAxesColumn, phone: false },
  { id: "more", href: "/more", icon: Ellipsis, phone: true },
] as const satisfies readonly { id: string; href: string; icon: LucideIcon; phone: boolean }[];

export type SectionId = (typeof sections)[number]["id"];

// The section a path belongs to ("/leads/123" belongs to Leads).
export function sectionForPath(pathname: string): SectionId {
  const match = sections.find((s) => s.href !== "/" && (pathname === s.href || pathname.startsWith(`${s.href}/`)));
  return match?.id ?? "home";
}
