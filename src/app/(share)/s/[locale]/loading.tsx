import { ShareSkeleton } from "@/components/share/share-page";

// The page's own skeleton at its final layout: the header, the search and 8 rows (design 10.5).
export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pt-6 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="h-12 w-[184px] max-w-[60vw] rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-[52px] w-[100px] rounded-md bg-muted motion-safe:animate-pulse" />
      </div>
      <div className="h-8 w-64 rounded-sm bg-muted motion-safe:animate-pulse" />
      <ShareSkeleton label="" />
    </div>
  );
}
