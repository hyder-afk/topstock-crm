import type { MetadataRoute } from "next";

// Nothing here is for search engines: the CRM is behind sign-in and the client stock page is for one client at a time.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
