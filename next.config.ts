import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Security headers for every route. The Content-Security-Policy is set per request in src/proxy.ts (it needs a nonce).
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Day 4d: opening a file answers with a 60-second Storage link in a redirect; that link must never be sent on as a
      // referrer (the last matching rule wins over the site-wide value above).
      { source: "/api/files/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

// Messages are compiled at build time (next-intl's precompile, experimental in 4.14): the lead page's first draw parsed
// its ICU messages in the browser, about 30 ms at 4x CPU (design 8.6). t.raw is not used anywhere (it is not supported).
const withNextIntl = createNextIntlPlugin({
  requestConfig: "./src/i18n/request.ts",
  experimental: { messages: { path: "./messages", format: "json", locales: "infer", precompile: true } },
});
export default withNextIntl(nextConfig);
