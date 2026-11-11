const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Keys typed here edit text or a field value, so viewer shortcuts leave them alone. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest(TEXT_ENTRY) !== null;
}

/** Arrow keys here move a caret, a menu, a list or a grid selection, never a viewer. */
export function ownsArrowKeys(target: EventTarget | null): boolean {
  return (
    isTextEntryTarget(target) ||
    (target instanceof HTMLElement &&
      target.closest('[role="menu"], [role="listbox"], [role="grid"], [role="slider"]') !== null)
  );
}
