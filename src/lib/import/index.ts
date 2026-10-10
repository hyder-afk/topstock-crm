// Browser-side lead import rules (design docs/evidence/day3b/design.md, section 3). Pure modules: they run in the
// browser and in Node (unit tests), never import React or server-only code, and never log.
export * from "./rules";
export * from "./text";
export * from "./decode";
export * from "./parse";
export * from "./headers";
export * from "./values";
export * from "./normalise";
export * from "./schema";
export * from "./chunk";
export * from "./csv-out";
