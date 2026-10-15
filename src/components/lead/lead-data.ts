import type { CallTarget } from "@/components/activity/call-panel";
import { personName, type LeadDetail } from "@/lib/leads";

// Numbers and addresses of a lead and its contacts, in the order the page offers them: the main line first.
export type NumberChoice = {
  number: string;
  dialled: "lead" | "contact";
  contactId: string | null;
  contactName: string | null;
  wrong: boolean;
};

export function leadNumbers(lead: LeadDetail): NumberChoice[] {
  const out: NumberChoice[] = [];
  if (lead.phone) out.push({ number: lead.phone, dialled: "lead", contactId: null, contactName: null, wrong: !!lead.phone_wrong_at });
  for (const c of lead.contacts) {
    if (c.phone) out.push({ number: c.phone, dialled: "contact", contactId: c.id, contactName: personName(c) || null, wrong: !!c.phone_wrong_at });
  }
  return out;
}

export function workingNumbers(lead: LeadDetail) {
  return leadNumbers(lead).filter((n) => !n.wrong);
}

export type EmailChoice = { address: string; contactId: string | null; contactName: string | null };

export function leadEmails(lead: LeadDetail): EmailChoice[] {
  const out: EmailChoice[] = [];
  if (lead.email) out.push({ address: lead.email, contactId: null, contactName: null });
  for (const c of lead.contacts) if (c.email) out.push({ address: c.email, contactId: c.id, contactName: personName(c) || null });
  return out;
}

export function callTarget(lead: LeadDetail, n: NumberChoice): CallTarget {
  return {
    leadId: lead.id,
    leadName: lead.name,
    ownerName: lead.owner ? personName(lead.owner) || null : null,
    callZoneKey: lead.call_zone_key ?? "Europe/Paris",
    number: n.number,
    dialled: n.dialled,
    contactId: n.contactId,
    contactName: n.contactName,
    openDeals: lead.deals?.open_count ?? 0,
    latestDeal: lead.deals?.latest_open ? { stage: lead.deals.latest_open.stage, value: lead.deals.latest_open.value } : null,
    canOpenDeal: lead.can_open_deal ?? false,
  };
}
