// The page background tokens of DESIGN.md ("Page background": Chalk White light, TopStock Black dark), for the places
// that cannot read CSS variables: the browser's theme colour (src/app/layout.tsx viewport) and the web app manifest
// (src/app/manifest.ts). tests/unit/pwa.spec.ts checks they equal --background in src/app/globals.css.
export const themeColors = { light: "#f5f3ef", dark: "#0e0e10" } as const;
