"use client";

import { use } from "react";
import { DealSheet } from "@/components/pipeline/deal-sheet";
import { useDealFlows } from "@/components/pipeline/deal-flows";
import type { TeamMember } from "@/lib/leads";

// The deal sheet over Home (Day 5 design 7.10: a Needs attention row opens it), with the same Win, Lose, Reopen and
// Delete flows as the board. Loaded only when a row is opened, so Home's first load does not carry the pipeline code.
export default function HomeDealSheet({
  dealId,
  onClose,
  teamPromise,
  canAssign,
  stepUpSeconds,
}: {
  dealId: string | null;
  onClose: () => void;
  teamPromise: Promise<TeamMember[]>;
  canAssign: boolean;
  stepUpSeconds: number;
}) {
  const team = use(teamPromise);
  const flows = useDealFlows(stepUpSeconds);
  return (
    <>
      <DealSheet dealId={dealId} onClose={onClose} flows={flows} team={team} canAssign={canAssign} />
      {flows.dialogs}
    </>
  );
}
