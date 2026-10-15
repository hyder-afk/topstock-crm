// The client page's messages (design 8.6): only the Share namespace, the skip link and its page title, so the page's
// HTML and bundle carry none of the CRM's words. Pure; unit-tested (share_messages_subset_exact).
type Messages = Record<string, unknown>;

export function shareMessages(all: Messages): Messages {
  const share = (all.Share ?? {}) as Messages;
  const common = (all.Common ?? {}) as Messages;
  return { Share: share, Common: { skipToContent: common.skipToContent }, Metadata: share.meta };
}

/** The team app's messages plus the client-facing ShareText words in both languages (a link's language can differ
 *  from the teammate's), under ShareTextByLanguage. About 1 KB; the client page never gets it. Pure; unit-tested. */
export function withShareTexts(all: Messages, en: Messages, fr: Messages): Messages {
  return { ...all, ShareTextByLanguage: { en: en.ShareText ?? {}, fr: fr.ShareText ?? {} } };
}

/** True only for the value the proxy itself sets on /s and /api/share (it deletes any incoming copy first). */
export function isShareSurface(value: string | null | undefined): boolean {
  return value === "share";
}
