"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Building2, X } from "lucide-react";
import { countryName } from "@/lib/countries";
import type { LeadPage } from "@/lib/leads";
import { cn } from "@/lib/utils";

export type PickedLead = { id: string; name: string };

const SHOWN = 8;

async function searchLeads(q: string): Promise<LeadPage> {
  const params = new URLSearchParams({ q, sort: "name" });
  const res = await fetch(`/api/leads?${params.toString()}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as LeadPage;
}

// "Link a lead" (Day 4 design 7.5): a WAI-ARIA combobox over the leads list search (GET /api/leads, the text travels
// as a function argument), at most 8 names. Arrows move, Enter picks, Escape closes; the picked lead shows as a chip
// with its own remove button.
export function LeadPicker({ value, onChange }: { value: PickedLead | null; onChange: (lead: PickedLead | null) => void }) {
  const t = useTranslations("Tasks");
  const locale = useLocale();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  // After a pick the field gives way to the chip: the focus goes to the chip's remove button, never to the page.
  const focusChip = useRef(false);
  useEffect(() => {
    if (value && focusChip.current) {
      focusChip.current = false;
      removeRef.current?.focus();
    }
  }, [value]);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // A short pause after typing before searching (one request per word, not per key).
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [text]);

  const results = useQuery({ queryKey: ["lead-search", q], queryFn: () => searchLeads(q), enabled: open && q.length > 0, staleTime: 30_000 });
  const rows = (results.data?.rows ?? []).slice(0, SHOWN);

  const pick = (row: { id: string; name: string }) => {
    focusChip.current = true;
    onChange({ id: row.id, name: row.name });
    setText("");
    setOpen(false);
  };

  if (value) {
    return (
      <span className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-3 text-sm sm:min-h-9">
        <Building2 aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{value.name}</span>
        <button
          ref={removeRef}
          type="button"
          aria-label={t("unlinkLead", { name: value.name })}
          onClick={() => {
            onChange(null);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97] sm:size-7"
        >
          <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
        </button>
      </span>
    );
  }

  const listId = `${id}-list`;
  const showList = open && q.length > 0;
  return (
    <div className="relative min-w-0 flex-[1_1_220px] sm:max-w-[320px]">
      <label htmlFor={id} className="sr-only">
        {t("leadSearch")}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && rows[active] ? `${id}-opt-${rows[active].id}` : undefined}
        autoComplete="off"
        spellCheck={false}
        name="lead_search"
        value={text}
        placeholder={t("linkLead")}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && rows.length) {
            e.preventDefault();
            setActive((a) => (a + 1) % rows.length);
          } else if (e.key === "ArrowUp" && rows.length) {
            e.preventDefault();
            setActive((a) => (a - 1 + rows.length) % rows.length);
          } else if (e.key === "Enter" && showList && rows[active]) {
            e.preventDefault();
            e.stopPropagation();
            pick(rows[active]);
          } else if (e.key === "Escape" && showList) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground sm:min-h-9"
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("leadSearch")}
          className="floating-content absolute top-full left-0 z-30 mt-1 max-h-72 w-full min-w-[240px] overflow-y-auto rounded-lg border border-border bg-card p-1.5 shadow-[0_16px_40px_rgb(14_14_16/0.18)]"
        >
          {results.isPending ? (
            <li aria-hidden="true" className="h-9 rounded-md bg-muted motion-safe:animate-pulse" />
          ) : results.isError ? (
            <li role="option" aria-selected={false} aria-disabled="true" className="px-3 py-2 text-sm text-muted-foreground">
              {t("leadSearchError")}
            </li>
          ) : rows.length === 0 ? (
            <li role="option" aria-selected={false} aria-disabled="true" className="px-3 py-2 text-sm text-muted-foreground">
              {t("noLeadMatch")}
            </li>
          ) : (
            rows.map((row, i) => (
              <li
                key={row.id}
                id={`${id}-opt-${row.id}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(row)}
                onMouseEnter={() => setActive(i)}
                className={cn("flex min-h-11 cursor-pointer flex-col justify-center rounded-md px-3 text-sm sm:min-h-9", i === active && "bg-muted")}
              >
                <span className="truncate">{row.name}</span>
                {row.city || row.country ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {[row.city, row.country ? countryName(row.country, locale) : null].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
