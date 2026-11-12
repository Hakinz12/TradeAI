import { useEffect, useState } from "react";

export function useRoute(): { path: string; parts: string[] } {
  const read = () => (location.hash.replace(/^#/, "") || "/").split("?")[0];
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => setPath(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return { path, parts: path.split("/").filter(Boolean) };
}
export const go = (p: string) => {
  location.hash = p;
};
