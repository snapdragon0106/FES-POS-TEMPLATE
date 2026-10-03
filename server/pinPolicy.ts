/**
 * PINs that are the first thing anyone would try. A 4-digit PIN is only
 * 10,000 combinations and the login limits (server/login.ts) keep a
 * guesser to a handful of tries an hour — which is no protection at all
 * for 1234 or 0000. Refused wherever a PIN is chosen: first login, the
 * admin's reset, the admin recovery. PINs already set keep working.
 */
export const WEAK_PIN_MESSAGE = "推測されやすいPIN（同じ数字・連続した数字・2桁の繰り返しなど）は使えません";

export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return false;
  const d = Array.from(pin, Number);
  // 0000, 1111, …
  if (d.every((x) => x === d[0])) return true;
  // 0123, 1234, … 9876, 8765, … (and wrapping 7890 / 0987)
  const steps = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return true;
  // 1212, 6969, …
  if (pin.slice(0, 2) === pin.slice(2)) return true;
  // 1122, 7788, …
  if (d[0] === d[1] && d[2] === d[3]) return true;
  // Keypad column, and the usual years.
  if (pin === "2580" || pin === "0852") return true;
  const year = Number(pin);
  if (year >= 1990 && year <= 2030) return true;
  return false;
}
