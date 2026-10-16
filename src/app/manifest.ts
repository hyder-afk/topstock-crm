import type { MetadataRoute } from "next";
import { themeColors } from "@/lib/theme-colors";
import messages from "../../messages/en.json";

// PWA basics only (Day 7c; Haider's answer to plan question 8): a home-screen icon (maskable too), the full-screen app
// look (display standalone) and the theme colours. No service worker, no offline cache, no install prompt.
// Served at /manifest.webmanifest, open to signed-out visitors (src/proxy.ts publicPaths): browsers fetch it without
// cookies. The name is the app's title (the same in English and French); "TopStock" is the brand name, never translated.
// One document for both colour schemes: the manifest has a single theme colour (light); the browser's bar follows the
// scheme through the two theme-color tags in src/app/layout.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: messages.Metadata.title,
    short_name: "TopStock",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: themeColors.light,
    theme_color: themeColors.light,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
