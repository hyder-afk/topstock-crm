// The client page's messages (design 8.6): only the Share namespace, the skip link and its page title, so the page's
// HTML and bundle carry none of the CRM's words. Pure; unit-tested (share_messages_subset_exact).
type Messages = Record<string, unknown>;

export function shareMessages(all: Messages): Messages {
  const share = (all.Share ?? {}) as Messages;
  const common = (all.Common ?? {}) as Messages;
  return { Share: share, Common: { skipToContent: common.skipToContent }, Metadata: share.meta };
}

/** True only for the value the proxy itself sets on /s and /api/share (it deletes any incoming copy first). */
export function isShareSurface(value: string | null | undefined): boolean {
  return value === "share";
}
