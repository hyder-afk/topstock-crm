import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { NextRequest } from "next/server";
import sharp from "sharp";
import manifest from "@/app/manifest";
import { themeColors } from "@/lib/theme-colors";

// Day 7c PWA basics (Haider's answer to plan question 8: home-screen icon, maskable too; display standalone; theme
// colours from DESIGN.md; safe areas; no service worker, no offline cache, no install prompt).
const ROOT = path.join(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p));

test.beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefgh.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "x".repeat(40);
});

test("the manifest: standalone, start at Home, light theme colour, any and maskable icons at 192 and 512", () => {
  const m = manifest();
  expect(m).toMatchObject({ id: "/", name: "TopStock CRM", short_name: "TopStock", start_url: "/", scope: "/", display: "standalone" });
  expect(m.theme_color).toBe(themeColors.light);
  expect(m.background_color).toBe(themeColors.light);
  const icons = (m.icons ?? []).map((i) => `${i.purpose} ${i.sizes} ${i.type} ${i.src}`);
  expect(icons).toEqual([
    "any 192x192 image/png /icons/icon-192.png",
    "any 512x512 image/png /icons/icon-512.png",
    "maskable 192x192 image/png /icons/maskable-192.png",
    "maskable 512x512 image/png /icons/maskable-512.png",
  ]);
  // Nothing beyond the basics: no service worker, no share target, no protocol handlers.
  expect(Object.keys(m).sort()).toEqual(["background_color", "display", "icons", "id", "name", "scope", "short_name", "start_url", "theme_color"]);
});

test("theme colours are DESIGN.md's page backgrounds, the same as --background in globals.css", () => {
  const css = read("src/app/globals.css").toString();
  const token = (block: string) => new RegExp(`${block}\\s*\\{[^}]*--background:\\s*(#[0-9a-f]{6})`).exec(css)?.[1];
  expect(token(":root")).toBe(themeColors.light);
  expect(token("\\.dark")).toBe(themeColors.dark);
  expect(themeColors).toEqual({ light: "#f5f3ef", dark: "#0e0e10" });
});

test("every icon file exists at its declared size; apple-icon is 180 x 180 and opaque", async () => {
  for (const [file, size] of [
    ["public/icons/icon-192.png", 192],
    ["public/icons/icon-512.png", 512],
    ["public/icons/maskable-192.png", 192],
    ["public/icons/maskable-512.png", 512],
    ["src/app/apple-icon.png", 180],
  ] as const) {
    const meta = await sharp(read(file)).metadata();
    expect(meta.format, file).toBe("png");
    expect([meta.width, meta.height], file).toEqual([size, size]);
  }
  const apple = await sharp(read("src/app/apple-icon.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minAlpha = 255;
  for (let i = 3; i < apple.data.length; i += 4) minAlpha = Math.min(minAlpha, apple.data[i]);
  expect(minAlpha).toBe(255);
});

// Reads the icon's pixels: red (the tile), chalk (the mark) or transparent.
async function pixels(file: string) {
  const { data, info } = await sharp(read(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  return { at, width: info.width, height: info.height };
}
const isChalk = (p: { r: number; g: number; b: number; a: number }) => p.a > 128 && p.r > 200 && p.g > 200 && p.b > 200;

test("maskable icons: full-bleed red, and the whole mark inside the central safe circle (radius 40%)", async () => {
  for (const file of ["public/icons/maskable-192.png", "public/icons/maskable-512.png"]) {
    const img = await pixels(file);
    for (const [x, y] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) {
      expect(img.at(x, y), `${file} corner`).toEqual({ r: 0xf2, g: 0x20, b: 0x3e, a: 255 });
    }
    const c = img.width / 2;
    let chalk = 0;
    let farthest = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (!isChalk(img.at(x, y))) continue;
        chalk++;
        farthest = Math.max(farthest, Math.hypot(x + 0.5 - c, y + 0.5 - c) / img.width);
      }
    }
    expect(chalk, `${file} has the mark`).toBeGreaterThan(img.width * img.height * 0.05);
    expect(farthest, `${file} mark inside the safe circle`).toBeLessThan(0.4);
  }
});

test("the 'any' icons keep the tile's rounded corners (transparent corner pixel)", async () => {
  for (const file of ["public/icons/icon-192.png", "public/icons/icon-512.png"]) {
    const img = await pixels(file);
    expect(img.at(0, 0).a, file).toBe(0);
    expect(img.at(img.width / 2, Math.round(img.height * 0.05)).a, file).toBe(255);
  }
});

test("the manifest is open to signed-out visitors; app pages are not", async () => {
  const { proxy, publicPaths, matches } = (await import("@/proxy")) as typeof import("@/proxy");
  expect(matches("/manifest.webmanifest", publicPaths)).toBe(true);
  expect(matches("/manifest.webmanifest.evil", publicPaths)).toBe(false);
  const res = await proxy(new NextRequest("http://localhost:3100/manifest.webmanifest"));
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const app = await proxy(new NextRequest("http://localhost:3100/leads"));
  expect(app.headers.get("location")).toContain("/login");
});

test("viewport-fit=cover and the safe-area padding are in place; no service worker anywhere", () => {
  const layout = read("src/app/layout.tsx").toString();
  expect(layout).toContain('viewportFit: "cover"');
  const css = read("src/app/globals.css").toString();
  for (const side of ["top", "right", "left"]) expect(css).toContain(`padding-${side}: env(safe-area-inset-${side}, 0px)`);
  for (const f of ["src/app/layout.tsx", "src/app/manifest.ts", "src/proxy.ts", "next.config.ts"]) {
    expect(read(f).toString(), f).not.toMatch(/serviceWorker|navigator\.serviceWorker|beforeinstallprompt/);
  }
});

test("safe areas hold while a dialog is open, and full-height pages do not scroll by the top inset", () => {
  const css = read("src/app/globals.css").toString();
  // Radix's scroll lock rewrites the body's padding while a dialog is open; the safe-area padding is kept.
  const at = css.indexOf("body[data-scroll-locked] {");
  expect(at, "body[data-scroll-locked] rule").toBeGreaterThan(-1);
  const locked = css.slice(at, css.indexOf("}", at));
  for (const side of ["top", "right", "left"]) {
    expect(locked).toContain(`padding-${side}: env(safe-area-inset-${side}, 0px) !important`);
  }
  expect(css).toContain("min-height: calc(100dvh - env(safe-area-inset-top, 0px));");
  // The page wrappers inside the padded body use 100dvh less the top inset; only the body itself is min-h-dvh.
  for (const f of ["src/app/(app)/layout.tsx", "src/app/(auth)/layout.tsx", "src/app/(share)/layout.tsx", "src/app/error.tsx"]) {
    const src = read(f).toString();
    expect(src, f).toContain("min-h-safe-screen");
    expect(src, f).not.toContain("min-h-dvh");
  }
  // The deal sheet (a full-width bottom sheet below 1024 px) clears the status bar and, in landscape, the notch side.
  const sheet = read("src/components/pipeline/deal-sheet.tsx").toString();
  for (const c of ["max-h-[calc(100dvh-max(12px,env(safe-area-inset-top,0px)))]", "pl-[env(safe-area-inset-left,0px)]", "pr-[env(safe-area-inset-right,0px)]"]) {
    expect(sheet).toContain(c);
  }
});
