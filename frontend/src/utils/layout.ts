/** Width of a side panel (or its collapsed tab) that sits beside the calendar; 0 when it floats over it or is absent. */
export function dockedWidth(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  return element && getComputedStyle(element).position !== "fixed" ? element.getBoundingClientRect().width : 0;
}
