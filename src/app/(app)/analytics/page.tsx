import { SectionPlaceholder } from "@/components/shell/section-page";
import { requireSession } from "@/lib/auth";

export default async function Page() {
  await requireSession();
  return <SectionPlaceholder id="analytics" />;
}
