import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { fetchLeadTasks } from "@/lib/leads-server";

// GET /api/leads/<id>/tasks : the lead's open tasks the caller can see (list_lead_tasks). Private and never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const tasks = await fetchLeadTasks(session.supabase, id.data);
  if (!tasks) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  return NextResponse.json(tasks, { headers });
}
