import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { NO_STORE, fetchProduct } from "@/lib/inventory-server";

// GET /api/inventory/products/<id> : one product for its panel (levels, active holds, last 20 movements). A malformed id
// and a product that is missing or not visible get the same 404.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const product = await fetchProduct(session.supabase, id.data);
  if (product === "missing") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!product) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(product, { headers: NO_STORE });
}
