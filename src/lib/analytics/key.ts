// The query cache key of one view of Analytics (design 3.6), by its canonical query string (view.ts filtersToSearch;
// "" is the default view). Its own module so the dock's prefetch pulls in nothing else from Analytics.
export const analyticsKey = (search: string) => ["analytics", search] as const;
