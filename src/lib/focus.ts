// A retry that succeeds replaces the error block holding the focused Try again button; without this the focus would
// fall to the top of the page (WCAG 2.4.3). After the retry, if that button is gone and nothing else took the focus,
// focus moves to the target: the card's title, or the timeline's feed or panel. Targets with no tabindex get -1.
export async function retryKeepingFocus(button: HTMLElement, target: (button: HTMLElement) => HTMLElement | null | undefined, run: () => Promise<unknown>) {
  const fallback = target(button);
  await run();
  // The new content is committed by the frame after the query settles.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (button.isConnected || !fallback?.isConnected) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      if (!fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
      fallback.focus({ preventScroll: true });
    }),
  );
}

export const cardTitle = (el: HTMLElement) => el.closest("section")?.querySelector<HTMLElement>("[data-card-title]");

export const timelineTarget = (el: HTMLElement) => {
  const panel = el.closest<HTMLElement>('[role="tabpanel"]');
  return panel?.querySelector<HTMLElement>('[role="feed"]') ?? panel;
};
