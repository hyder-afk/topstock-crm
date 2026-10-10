"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { setLeadsOwner, setLeadsStatus } from "@/app/(app)/leads/actions";
import { useToast } from "@/components/ui/toast";
import {
  filtersToParams,
  type LeadDetail,
  type LeadFilters,
  type LeadPage,
  type LeadRow,
  type LeadStatus,
  type TeamMember,
} from "@/lib/leads";

type Cursor = LeadPage["next"];

export const leadsKey = (filters: LeadFilters) => ["leads", filtersToParams(filters).toString()] as const;
export const leadKey = (id: string) => ["lead", id] as const;

async function fetchPage(filters: LeadFilters, cursor: Cursor): Promise<LeadPage> {
  const params = filtersToParams(filters);
  if (cursor) {
    params.set("after_value", cursor.after_value);
    params.set("after_id", cursor.after_id);
  }
  const res = await fetch(`/api/leads?${params}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as LeadPage;
}

// Pages of 50 (keyset), the first one server-rendered when the filters match what the page was loaded with.
export function useLeads(filters: LeadFilters, initial: { key: string; page: LeadPage | null }) {
  const key = leadsKey(filters);
  const seeded = initial.page && key[1] === initial.key;
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(filters, pageParam),
    initialPageParam: null as Cursor,
    getNextPageParam: (last) => last.next,
    initialData: seeded ? { pages: [initial.page as LeadPage], pageParams: [null] } : undefined,
  });
}

export async function fetchLead(id: string): Promise<LeadDetail | null> {
  const res = await fetch(`/api/leads/${id}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as LeadDetail;
}

export function useLead(id: string | null) {
  return useQuery({ queryKey: leadKey(id ?? "none"), queryFn: () => fetchLead(id as string), enabled: !!id });
}

type Patch = Partial<Pick<LeadRow, "lead_status" | "owner_id" | "owner_first_name" | "owner_last_name">>;

// Shows a change in every cached list and preview at once (optimistic); the server answer then confirms it.
function usePatchCache() {
  const queryClient = useQueryClient();
  return useCallback(
    (patches: Map<string, Patch>) => {
      queryClient.setQueriesData<InfiniteData<LeadPage>>({ queryKey: ["leads"] }, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                rows: p.rows.map((r) => (patches.has(r.id) ? { ...r, ...patches.get(r.id) } : r)),
              })),
            }
          : old,
      );
      for (const [id, patch] of patches) {
        queryClient.setQueryData<LeadDetail | null>(leadKey(id), (old) => {
          if (!old) return old;
          const owner =
            "owner_id" in patch
              ? patch.owner_id
                ? { id: patch.owner_id, first_name: patch.owner_first_name ?? "", last_name: patch.owner_last_name ?? "" }
                : null
              : old.owner;
          return { ...old, lead_status: patch.lead_status ?? old.lead_status, owner };
        });
      }
    },
    [queryClient],
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return useCallback(
    (ids: string[]) => {
      void queryClient.invalidateQueries({ queryKey: ["leads"] });
      ids.forEach((id) => void queryClient.invalidateQueries({ queryKey: leadKey(id) }));
    },
    [queryClient],
  );
}

type Before = { id: string; status: LeadStatus; owner_id: string | null; owner_first_name: string | null; owner_last_name: string | null };

// Status and owner changes, from the preview and the bulk bar: instant, then confirmed, with Undo in the toast.
export function useLeadChanges(team: TeamMember[]) {
  const t = useTranslations("Leads");
  const tErr = useTranslations("Leads.errors");
  const toast = useToast();
  const patch = usePatchCache();
  const refresh = useRefresh();

  const restore = useCallback(
    (before: Before[]) => {
      patch(new Map(before.map((b) => [b.id, { lead_status: b.status, owner_id: b.owner_id, owner_first_name: b.owner_first_name, owner_last_name: b.owner_last_name }])));
    },
    [patch],
  );

  const changeStatus = useCallback(
    async (before: Before[], status: LeadStatus) => {
      const ids = before.map((b) => b.id);
      patch(new Map(ids.map((id) => [id, { lead_status: status }])));
      const res = await setLeadsStatus(ids, status);
      if (!res.ok) {
        restore(before);
        toast.show(tErr(res.error));
        return;
      }
      refresh(ids);
      const changed = res.data.changed;
      const undo = {
        label: t("undo"),
        run: async () => {
          restore(before);
          const groups = new Map<LeadStatus, string[]>();
          before.forEach((b) => groups.set(b.status, [...(groups.get(b.status) ?? []), b.id]));
          await Promise.all([...groups].map(([s, groupIds]) => setLeadsStatus(groupIds, s)));
          refresh(ids);
          toast.show(t("undone"));
        },
      };
      toast.show(changed < ids.length ? t("partlyChanged", { changed, total: ids.length }) : t("statusChanged", { count: changed }), undo);
    },
    [patch, refresh, restore, t, tErr, toast],
  );

  const changeOwner = useCallback(
    async (before: Before[], ownerId: string | null) => {
      const ids = before.map((b) => b.id);
      const owner = team.find((m) => m.id === ownerId);
      patch(new Map(ids.map((id) => [id, { owner_id: ownerId, owner_first_name: owner?.first_name ?? null, owner_last_name: owner?.last_name ?? null }])));
      const res = await setLeadsOwner(ids, ownerId);
      if (!res.ok) {
        restore(before);
        toast.show(tErr(res.error));
        return;
      }
      refresh(ids);
      const undo = {
        label: t("undo"),
        run: async () => {
          restore(before);
          const groups = new Map<string, string[]>();
          before.forEach((b) => groups.set(b.owner_id ?? "", [...(groups.get(b.owner_id ?? "") ?? []), b.id]));
          await Promise.all([...groups].map(([o, groupIds]) => setLeadsOwner(groupIds, o || null)));
          refresh(ids);
          toast.show(t("undone"));
        },
      };
      toast.show(t("ownerChanged", { count: res.data.changed }), undo);
    },
    [patch, refresh, restore, t, tErr, team, toast],
  );

  return { changeStatus, changeOwner };
}

export function rowBefore(r: Pick<LeadRow, "id" | "lead_status" | "owner_id" | "owner_first_name" | "owner_last_name">): Before {
  return { id: r.id, status: r.lead_status, owner_id: r.owner_id, owner_first_name: r.owner_first_name, owner_last_name: r.owner_last_name };
}
