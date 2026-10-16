import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { noStore } from "@/lib/http";
import { tasksParams } from "@/lib/tasks";
import { fetchTaskCounts, fetchTaskPage } from "@/lib/tasks-server";

// GET /api/tasks?bucket=&scope=&after_sort=&after_id= : one page of a Tasks tab (keyset), with the tab counts on the
// first page. Zod-checked (unknown parameters refused); every value reaches the database as a function argument. A
// cursor needs its id (and its time, except for Upcoming's undated rows): 400 otherwise. Team is for managers and
// admins (403). Private and never cached.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const query = tasksParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: noStore });
  const { bucket, scope = "mine", after_sort, after_id } = query.data;
  const cursor = after_id ? { after_sort: after_sort ?? null, after_id } : null;
  const [page, counts] = await Promise.all([
    fetchTaskPage(session.supabase, bucket, scope, cursor),
    cursor ? Promise.resolve(undefined) : fetchTaskCounts(session.supabase, scope),
  ]);
  if (page === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers: noStore });
  if (page === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  if (!page || counts === null) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: noStore });
  return NextResponse.json({ ...page, counts: counts ?? null }, { headers: noStore });
}
