export function appendDigit(value: string, digit: string): string {
  if (!/^[0-9]$/.test(digit) || value.replace(",", ".").length >= 7) return value;
  return value === "0" ? digit : value + digit;
}
export function appendDecimal(value: string): string { return /[.,]/.test(value) ? value : `${value || "0"},`; }
export function backspace(value: string): string { return value.slice(0, -1); }
export function parseGrams(value: string): number | undefined {
  if (!value || !/^\d+(?:[.,]\d*)?$/.test(value)) return undefined;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
