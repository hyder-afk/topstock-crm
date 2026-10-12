import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  BOARD_PAGE,
  DEAL_TITLE_MAX,
  DEAL_UNDO_SECONDS,
  LOST_NOTE_MAX,
  STALL_DAYS,
  UNSAFE_NOTE,
  UNSAFE_TITLE,
  WON_WINDOW_DAYS,
  fulfilments,
  lostReasons,
  openStageKeys,
  stageKeys,
} from "@/lib/deals";
import { DEAL_VALUE_MAX } from "@/lib/money";

// The pipeline's lists and limits against the Day 5a and 5b migrations (Day 5 design 8.4): a stage, reason, shipping
// choice or limit the database does not share would make a save fail, or show a raw code.
const read = (name: string) => readFileSync(join(__dirname, "../../supabase/migrations", name), "utf8");
const deals = read("20261015090000_deals_pipeline.sql");
const links = read("20261015120000_deal_links.sql");
const quoted = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
  return text.slice(start + from.length, text.indexOf(to, start + from.length));
};

test("stage keys and their order match the stages check and the key backfill", () => {
  expect(quoted(between(deals, "add constraint pipeline_stages_key_check check (key in (", ")"))).toEqual([...stageKeys]);
  expect(between(deals, "key = case position", " end,").replace(/\s+/g, " ")).toBe(
    " when 1 then 'lead' when 2 then 'qualified' when 3 then 'negotiations' when 4 then 'won' when 5 then 'lost'",
  );
  expect(quoted(between(deals, "add constraint pipeline_stages_stall_open_only check (stall_days is null or key in (", ")"))).toEqual([...openStageKeys]);
});

test("stall days are 7, 14 and 21", () => {
  expect(deals).toContain("stall_days = case position when 1 then 7 when 2 then 14 when 3 then 21 end");
  expect(STALL_DAYS).toEqual({ lead: 7, qualified: 14, negotiations: 21 });
});

test("lost reasons match the check, move_deal and log_activity's sibling lists", () => {
  expect(quoted(between(deals, "add constraint deals_lost_reason_code check (lost_reason is null or lost_reason in", ")"))).toEqual([...lostReasons]);
  expect(quoted(between(deals, "if p_lost_reason is not null and p_lost_reason not in (", ")"))).toEqual([...lostReasons]);
});

test("ways of shipping match the guard and the RPCs", () => {
  expect(quoted(between(deals, "if new.fulfilment is not null and new.fulfilment not in (", ")"))).toEqual([...fulfilments]);
});

test("value cap, decimals, and the RPC value rule", () => {
  expect(deals).toContain("value <> 'NaN' and value <= 100000000");
  expect(deals).toContain("p_value <> 'NaN' and p_value >= 0 and p_value <= 100000000 and p_value = round(p_value, 2)");
  expect(DEAL_VALUE_MAX).toBe("100000000");
  expect(links).toContain("if not private.deal_value_ok(p_deal_value) then");
});

test("the undo window is 120 seconds and the Won window 30 days", () => {
  expect(between(deals, "create function private.deal_undo_candidate(", "$$;")).toContain("h.created_at > now() - interval '120 seconds'");
  expect(DEAL_UNDO_SECONDS).toBe(120);
  expect(between(deals, "create function public.pipeline_board(", "$$;")).toContain("now() - interval '30 days'");
  expect(WON_WINDOW_DAYS).toBe(30);
});

test("titles and notes: limits and unsafe characters match the CHECKs (the 5b deal title too)", () => {
  expect(deals).toContain("char_length(title) between 1 and 120");
  expect(deals).toContain("char_length(lost_note) between 1 and 500");
  expect(DEAL_TITLE_MAX).toBe(120);
  expect(LOST_NOTE_MAX).toBe(500);
  // The same characters refused (compared by behaviour over the first 0x2100 code points, not by source text).
  const sameSet = (ours: RegExp, sql: string) => {
    const theirs = new RegExp(sql);
    const differ: string[] = [];
    for (let c = 1; c < 0x2100; c += 1) {
      const ch = String.fromCharCode(c);
      if (ours.test(ch) !== theirs.test(ch)) differ.push(`U+${c.toString(16)}`);
    }
    expect(differ).toEqual([]);
  };
  sameSet(UNSAFE_TITLE, between(deals, "and title !~ '", "'"));
  sameSet(UNSAFE_NOTE, between(deals, "and lost_note !~ '", "'"));
  sameSet(UNSAFE_TITLE, between(links, "v_deal_title ~ '", "'"));
});

test("page sizes and the open and move limits", () => {
  expect(between(deals, "create function public.list_stage_deals(", "$$;")).toContain("p_limit not between 1 and 100");
  expect(BOARD_PAGE).toBeGreaterThanOrEqual(1);
  expect(BOARD_PAGE + 1).toBeLessThanOrEqual(100);
  expect(deals).toContain("limit 30) recent) >= 30 then");
  expect(deals).toContain("limit 120) recent) >= 120 then");
  expect(links).toContain("limit 30) recent) >= 30 then");
});

test("log_activity opens deals from Interested and Book meeting only", () => {
  expect(quoted(between(links, "or p_outcome not in (", ")"))).toEqual(["interested", "meeting_booked"]);
});
