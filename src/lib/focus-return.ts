// Focus that never drops to <body> (Day 5 design 7.8; verifier findings on the deal sheet, Lose, Delete and Reopen).
// When a dialog or sheet closes, the element that opened it may be gone: the deal left Needs attention, the card left
// its column, the row menu's trigger went with its row. rememberFocus() notes, while the opener is still there, its
// list and place and the heading of the card it sits in; focusTarget() then picks, in order: the opener itself, the
// caller's preferred element (the deal's own card or row), the row now at the opener's place (the next one) or the one
// before it, the card's heading (HomeCard and lead page headings carry tabIndex -1), and last the page's <main>.

/** Elements that stand for a row: a board card's main button, a deal row, or anything marked as a focusable row. */
const ROW = "[data-deal-main], [data-deal-row], [data-focus-row]";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type FocusReturn = { el: HTMLElement | null; list: HTMLElement | null; index: number; heading: HTMLElement | null };

/** Notes where the focus is now and where it can go if that element disappears. */
export function rememberFocus(el: Element | null): FocusReturn {
  const node = el instanceof HTMLElement && el !== document.body ? el : null;
  const item = node?.closest("li") ?? null;
  const list = item?.parentElement ?? null;
  const index = item && list ? Array.prototype.indexOf.call(list.children, item) : -1;
  const heading = node?.closest("section")?.querySelector<HTMLElement>("h2[tabindex='-1'], h1[tabindex='-1']") ?? null;
  return { el: node, list, index, heading };
}

function focusableIn(item: Element): HTMLElement | null {
  if (item instanceof HTMLElement && item.matches(ROW)) return item;
  return item.querySelector<HTMLElement>(ROW) ?? item.querySelector<HTMLElement>(FOCUSABLE);
}

/** The element to focus now (see the comment at the top). Null only on a page without <main>. */
export function focusTarget(r: FocusReturn | null, preferred?: HTMLElement | null): HTMLElement | null {
  if (r?.el?.isConnected) return r.el;
  if (preferred?.isConnected) return preferred;
  if (r?.list?.isConnected && r.index >= 0) {
    const items = Array.from(r.list.children);
    for (const i of [Math.min(r.index, items.length - 1), r.index - 1]) {
      const t = i >= 0 && items[i] ? focusableIn(items[i]) : null;
      if (t) return t;
    }
  }
  if (r?.heading?.isConnected) return r.heading;
  const main = document.getElementById("main");
  if (main && main.tabIndex < 0 && !main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  return main;
}

/** Focuses focusTarget(); true when something took the focus. */
export function returnFocus(r: FocusReturn | null, preferred?: HTMLElement | null): boolean {
  const t = focusTarget(r, preferred);
  if (!t) return false;
  t.focus({ preventScroll: true });
  return document.activeElement === t;
}
