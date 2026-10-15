import { getTranslations } from "next-intl/server";
import { PipelineSkeleton } from "@/components/pipeline/pipeline-skeleton";

// The pipeline's skeleton, block for block (Day 5 design 7.1): shown on a navigation until the page streams.
export default async function Loading() {
  const t = await getTranslations("Pipeline");
  return <PipelineSkeleton label={t("loading")} />;
}
