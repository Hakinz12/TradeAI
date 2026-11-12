export type Cell = string | number | boolean | null | undefined;

/**
 * Minimal CSV writer. Text cells that start with = + - @ (or a tab/CR) get a leading apostrophe, so a hostile
 * token name like `=HYPERLINK(...)` cannot run as a formula when the file is opened in Excel or Sheets.
 * Numbers are written as-is.
 */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
