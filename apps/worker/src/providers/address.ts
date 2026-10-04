import type { EmailAddress } from "@emailbot/types";

/**
 * Splits an RFC 5322 address list on commas that are not inside quotes or
 * angle brackets: `"Doe, John" <j@x.com>, other@y.com`.
 */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "<" && !inQuotes) inAngle = true;
    else if (char === ">" && !inQuotes) inAngle = false;

    if (char === "," && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Longest single address accepted (RFC 5321 path limit is 256; display names add more). */
const MAX_ADDRESS_INPUT = 1_000;
/** Header values are attacker-controlled; bound the work per header. */
const MAX_ADDRESS_LIST_INPUT = 50_000;
const MAX_ADDRESSES = 500;

export function parseAddress(raw: string): EmailAddress | null {
  const trimmed = raw.trim().slice(0, MAX_ADDRESS_INPUT);
  if (!trimmed) return null;

  const angle = /^(.*?)<\s*([^<>\s]+)\s*>\s*$/.exec(trimmed);
  if (angle?.[2]) {
    const name = (angle[1] ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    return { address: angle[2].toLowerCase(), name: name.length > 0 ? name : null };
  }

  return { address: trimmed.replace(/^mailto:/i, "").toLowerCase(), name: null };
}

export function parseAddressList(value: string | null | undefined): EmailAddress[] {
  if (!value) return [];
  return splitAddressList(value.slice(0, MAX_ADDRESS_LIST_INPUT))
    .slice(0, MAX_ADDRESSES)
    .map(parseAddress)
    .filter((address): address is EmailAddress => address !== null);
}

const VALID_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Same check as the emails.sender_email constraint. */
export function isStorableAddress(address: string): boolean {
  return address.length >= 3 && address.length <= 320 && VALID_EMAIL.test(address);
}
