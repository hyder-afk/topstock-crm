import { notFound } from "next/navigation";
import { z } from "zod";
import { ProductPage } from "@/components/inventory/product-page";
import { requireSession, stepUpSecondsLeft } from "@/lib/auth";
import { fetchProduct } from "@/lib/inventory-server";
import { fetchTeam } from "@/lib/leads-server";

// A product as a full page (design 10.1: phones open this instead of the side panel; any width can deep-link it). A
// malformed id and a product that is missing or not visible both get the same 404.
export default async function ProductRoute({ params }: { params: Promise<{ id: string }> }) {
  const { supabase, claims } = await requireSession();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const [product, team] = await Promise.all([fetchProduct(supabase, id.data), fetchTeam(supabase)]);
  if (product === "missing") notFound();
  if (!product) throw new Error("product unavailable");
  const role = team?.find((m) => m.id === claims.sub)?.role ?? "rep";
  return <ProductPage product={product} role={role} me={claims.sub} stepUpSeconds={stepUpSecondsLeft(claims)} />;
}
