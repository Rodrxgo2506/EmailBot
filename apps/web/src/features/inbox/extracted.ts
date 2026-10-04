/** Extracted values that deserve a prominent display (verification codes). */
export const CODE_KEYS = ["verification_code", "code", "otp", "codigo"];

export function primaryCode(extracted: Record<string, unknown>): string | null {
  for (const key of CODE_KEYS) {
    const value = extracted[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function extractedEntries(extracted: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(extracted)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
}
