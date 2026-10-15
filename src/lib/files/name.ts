import { EXTENSION_TYPES, FILE_NAME_MAX, FILE_TYPES, type FileMime } from "@/lib/files/types";

// File names (Day 4 design 5.7, threat 24). The database refuses (constant error, hint file_name) any name with a
// control, invisible or bidi character, a slash, a backslash or a double quote, or longer than 180 characters
// (files_name_check, private.file_name_ok); the server cleans every name first, so a real file never meets that refusal.
// The stored path never uses the name (it is built from ids and the type), so a name is only ever text on screen.

/** The characters the database refuses in a name: the same code point ranges as the migration's regex (written as
 * escapes, never as the characters themselves). */
export const UNSAFE_NAME =
  /[\u0001-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}/\\"]/u;
const UNSAFE_ALL = new RegExp(UNSAFE_NAME.source, "gu");

/** The extension of a name, lower case, without the dot ("" when none). */
export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The type a chosen file means: its browser type when it is one of ours, otherwise its extension's (or null). */
export function typeOf(file: { name: string; type: string }): FileMime | null {
  if (file.type in FILE_TYPES) return file.type as FileMime;
  if (file.type && file.type !== "application/octet-stream") return null;
  return EXTENSION_TYPES[extensionOf(file.name)] ?? null;
}

/**
 * A name safe to store and show: Unicode NFC; unsafe characters removed (a slash or backslash becomes a space, so
 * "../devis.pdf" stays readable as text); spaces collapsed and trimmed; the extension forced to the type's ("photo.png"
 * of a JPEG becomes "photo.jpg"; "Devis" becomes "Devis.pdf"); at most 180 characters, cut before the extension; never
 * empty ("file.pdf").
 */
export function cleanFileName(name: string, mime: FileMime): string {
  const ext = FILE_TYPES[mime];
  let text = name.normalize("NFC").replace(/[/\\]/g, " ").replace(UNSAFE_ALL, "").replace(/\s+/g, " ").trim();
  // One of our extensions (whichever type it names) gives way to the type's; any other stays part of the name.
  const current = extensionOf(text);
  if (EXTENSION_TYPES[current]) text = text.slice(0, -(current.length + 1));
  text = text.replace(/[\s.]+$/, "").replace(/^[\s.]+/, "");
  if (!text) text = "file";
  const room = FILE_NAME_MAX - ext.length - 1;
  const chars = Array.from(text);
  if (chars.length > room) text = chars.slice(0, room).join("").trimEnd();
  return `${text}.${ext}`;
}

/** The name in two parts for display: the stem (cut with an ellipsis when narrow) and the extension (always shown). */
export function splitName(name: string): { stem: string; ext: string } {
  const ext = extensionOf(name);
  return ext ? { stem: name.slice(0, -(ext.length + 1)), ext: `.${ext}` } : { stem: name, ext: "" };
}
