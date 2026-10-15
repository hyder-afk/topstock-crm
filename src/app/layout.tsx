import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ThemeProvider } from "@/components/theme-provider";
import { themeColors } from "@/lib/theme-colors";
import "./globals.css";

// Brand fonts, self-hosted (no request to Google): Outfit Regular/Bold, DM Mono Medium.
const outfit = localFont({
  src: [
    { path: "./fonts/Outfit-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/Outfit-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-outfit",
  display: "swap",
});
const dmMono = localFont({
  src: [{ path: "./fonts/DMMono-Medium.ttf", weight: "500", style: "normal" }],
  variable: "--font-dm-mono",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata");
  // Opened from the home screen (Day 7c PWA basics): full screen, the brand name under the icon, the system status bar.
  return {
    title: t("title"),
    description: t("description"),
    appleWebApp: { capable: true, title: "TopStock", statusBarStyle: "default" },
  };
}

// viewportFit "cover": the page draws edge to edge on phones with a notch or a home indicator, and env(safe-area-inset-*)
// then reports the real insets (it reports 0 without it): the dock, sheets and toasts already add the bottom inset, and
// globals.css pads the body by the side and top insets.
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: themeColors.light },
    { media: "(prefers-color-scheme: dark)", color: themeColors.dark },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const t = await getTranslations("Common");
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang={locale} className={`${outfit.variable} ${dmMono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
          <a
            href="#main"
            className="sr-only rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
          >
            {t("skipToContent")}
          </a>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
