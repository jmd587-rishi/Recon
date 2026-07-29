/** Row-count formatting shared by the fix cards and the evidence tables. */

/** `1204331` -> `1,204,331`; a missing count renders as an em dash rather than "null". */
export function fmt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

/** Always carries a sign, so a delta reads as a change rather than a total. */
export function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}`;
}
