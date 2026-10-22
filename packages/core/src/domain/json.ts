/**
 * JSON.stringify replacer that writes bigint (paise) as an integer string. Pair it with
 * paiseSchema / paise() on the way back in; both ends agree that paise travel as strings.
 */
export function bigintJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
