import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

// The app's own Select and Combobox read the same <option> and <optgroup> children a native <select> took, so a call
// site changes only its import (Haider 15 Oct 2026: no native pickers). Pure: React elements in, plain items out.

export type PickerOption = {
  value: string;
  label: ReactNode;
  /** The option's words as plain text: typeahead, search, and the screen-reader value. */
  textValue: string;
  disabled: boolean;
  /** Extra words that should also find this option in a Combobox search (e.g. a country's code). */
  keywords?: string[];
};

export type PickerGroup = { label: string; options: PickerOption[] };
export type PickerEntry = ({ kind: "option" } & PickerOption) | ({ kind: "group" } & PickerGroup);

type OptionProps = { value?: string | number | readonly string[]; label?: string; disabled?: boolean; children?: ReactNode };
type GroupProps = { label?: string; disabled?: boolean; children?: ReactNode };

/** The plain text of React children (strings and numbers, through fragments and elements). */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function readOption(element: ReactElement<OptionProps>, groupDisabled: boolean): PickerOption {
  const { value, label, disabled, children } = element.props;
  const text = (label ?? textOf(children)).replace(/\s+/g, " ").trim();
  return {
    // Like the native element: an option without a value submits its text.
    value: value === undefined ? text : Array.isArray(value) ? value.join(",") : String(value),
    label: label ?? children,
    textValue: text,
    disabled: !!disabled || groupDisabled,
  };
}

function walk(node: ReactNode, out: PickerEntry[], group: PickerGroup | null, groupDisabled: boolean) {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) {
      walk((child.props as { children?: ReactNode }).children, out, group, groupDisabled);
    } else if (child.type === "option") {
      const option = readOption(child as ReactElement<OptionProps>, groupDisabled);
      if (group) group.options.push(option);
      else out.push({ kind: "option", ...option });
    } else if (child.type === "optgroup" && !group) {
      const props = child.props as GroupProps;
      const next: PickerGroup = { label: props.label ?? "", options: [] };
      walk(props.children, out, next, !!props.disabled);
      out.push({ kind: "group", ...next });
    }
    // Anything else (a stray element, an optgroup inside an optgroup) is ignored, as the native select ignores it.
  });
}

/** <option> and <optgroup> children to items, in order; fragments, arrays, null and false are fine. */
export function parseOptionChildren(children: ReactNode): PickerEntry[] {
  const out: PickerEntry[] = [];
  walk(children, out, null, false);
  return out;
}

/** Every option in order, groups flattened. */
export function flattenEntries(entries: PickerEntry[]): PickerOption[] {
  return entries.flatMap((e) => (e.kind === "group" ? e.options : [stripKind(e)]));
}

function stripKind(entry: { kind: "option" } & PickerOption): PickerOption {
  const { kind: _kind, ...option } = entry;
  void _kind;
  return option;
}

/**
 * The value a native select would show and submit. A matching option wins (also a disabled one). With no match the
 * placeholder shows when one is set and the value is empty; otherwise the first enabled option, as the native
 * element does, so moving a call site from <select> to Select changes nothing it submits.
 */
export function resolveSelectValue(options: PickerOption[], value: string | undefined, hasPlaceholder = false): string {
  if (value !== undefined && options.some((o) => o.value === value)) return value;
  if (hasPlaceholder && (value === undefined || value === "")) return "";
  return options.find((o) => !o.disabled)?.value ?? "";
}

/** Lower case without accents, so "equateur" finds "Équateur" and "creteil" finds "Créteil". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * Combobox search score: every typed word must start a word of the option's text or keywords (1), or appear inside
 * one (0.5); otherwise 0 and the option is hidden. An empty search keeps every option (1).
 */
export function searchScore(search: string, haystack: string[]): number {
  const words = foldText(search).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const text = haystack.map(foldText).join(" ");
  const starts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let score = 1;
  for (const word of words) {
    if (starts.some((s) => s.startsWith(word))) continue;
    if (text.includes(word)) score = Math.min(score, 0.5);
    else return 0;
  }
  return score;
}
