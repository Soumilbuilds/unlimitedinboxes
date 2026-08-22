export function normalizeDomain(value) {
  if (value == null) return null;

  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');

  return normalized || null;
}
