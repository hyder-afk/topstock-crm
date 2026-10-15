import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { PipelineView } from "@/components/pipeline/board";
import { PipelineSkeleton } from "@/components/pipeline/pipeline-skeleton";
import { requireSession, stepUpSecondsLeft } from "@/lib/auth";
import type { Board } from "@/lib/deals";
import { fetchBoard } from "@/lib/deals-server";
import { fetchTeam } from "@/lib/leads-server";

// The pipeline (Day 5 design 7.1). Two-factor session first. The team is read here (owner chips, the owner pickers);
// the board's first paint (pipeline_board: summaries plus 50 cards per column) starts as a promise handed to the client
// (D32): the board renders at once from the query cache when the dock warmed it, otherwise it streams under the
// Suspense skeleton. A board read that fails shows the board's own error with Retry (the shell stays), never database
// text. ?deal=<id> opens the deal sheet, ?stalled=1 shows stalled deals only, ?new=1 opens New deal.
export default async function PipelineRoute({ searchParams }: PageProps<"/pipeline">) {
  const { supabase, claims } = await requireSession();
  const query = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const deal = z.uuid().safeParse(one(query.deal));
  const boardPromise: Promise<Board | null> = fetchBoard(supabase, "team", null).then((b) => (b && typeof b === "object" ? b : null))
    .catch(() => null);
  const [team, t] = await Promise.all([fetchTeam(supabase), getTranslations("Pipeline")]);
  const role = team?.find((m) => m.id === claims.sub)?.role ?? "rep";
  return (
    <Suspense fallback={<PipelineSkeleton label={t("loading")} />}>
      <PipelineView
        boardPromise={boardPromise}
        team={team ?? []}
        me={{ id: claims.sub, role }}
        stepUpSeconds={stepUpSecondsLeft(claims)}
        initialDeal={deal.success ? deal.data : null}
        initialStalled={one(query.stalled) === "1"}
        initialNew={one(query.new) === "1"}
      />
    </Suspense>
  );
}
