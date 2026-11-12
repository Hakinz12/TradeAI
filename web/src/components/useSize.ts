import { useEffect, useRef, useState } from "react";

/** Width of an element in CSS pixels, kept up to date as it resizes. */
export function useWidth<T extends HTMLElement>(fallback = 600): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(Math.round(el.getBoundingClientRect().width), 120));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(Math.round(e.contentRect.width), 120)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
