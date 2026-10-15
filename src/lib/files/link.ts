// The file's name for a download link. storage-js `createSignedUrl({ download })` writes the name with URLSearchParams
// and then runs encodeURI over the whole link, so every "%" it made is encoded again ("°" arrives as the text "%C2%B0")
// and Storage sends that text as the file name (PR #16, name_accents_download). The name is added here instead, once:
// Storage decodes the query once and puts the real name in Content-Disposition (RFC 8187 `filename*`).

/** The signed link with `download` set to the file's real name (the signed token does not cover this parameter). */
export function withDownloadName(link: URL, name: string): URL {
  const url = new URL(link);
  url.searchParams.set("download", name);
  return url;
}
