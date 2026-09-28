import { useLayoutEffect } from "react";

/** Base-select sizes to its current label; reserve room for every option. */
export function useSelectWidths() {
  useLayoutEffect(() => {
    let stopped = false;
    let frame = 0;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const measure = () => {
      if (stopped || !context) return;
      document.querySelectorAll<HTMLSelectElement>(".cinema-shell select:not([multiple]):not([size])").forEach((select) => {
        if (!select.getClientRects().length) return;
        const style = getComputedStyle(select);
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const spacing = parseFloat(style.letterSpacing) || 0;
        const labelWidth = Math.max(0, ...Array.from(select.options, (option) => {
          const label = option.label;
          return context.measureText(label).width + label.length * spacing;
        }));
        const chrome = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
          + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
        select.style.setProperty("--select-option-width", `${Math.ceil(labelWidth + chrome + 8)}px`);
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden", "label"] });
    window.addEventListener("resize", schedule);
    void document.fonts.ready.then(schedule);
    measure();
    return () => {
      stopped = true;
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);
}