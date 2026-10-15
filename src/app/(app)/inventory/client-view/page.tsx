import { ClientView } from "@/components/share-links/client-view";
import { requireSession } from "@/lib/auth";
import { fetchSharePreview } from "@/lib/share-links-server";

// What clients see (design 10.6; everyone on the team): the client page's list fed by share_preview(), the same
// whitelist as the client link, arriving stock included.
export default async function ClientViewPage() {
  const { supabase } = await requireSession();
  const preview = await fetchSharePreview(supabase);
  return <ClientView preview={preview} />;
}
