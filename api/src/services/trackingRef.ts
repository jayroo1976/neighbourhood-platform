// Tracking reference: {community_code}-{YYMM}-{sequence}-{check}
// The check character uses the Luhn mod 36 method over the characters 0-9A-Z. It catches single-character
// typing errors and most swapped neighbours. A reference is a filing aid, never a credential.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const N = ALPHABET.length;

export function luhnMod36Check(input: string): string {
  let factor = 2;
  let sum = 0;
  const s = input.toUpperCase();
  for (let i = s.length - 1; i >= 0; i--) {
    const code = ALPHABET.indexOf(s[i]);
    if (code < 0) throw new Error(`Invalid character in reference: ${s[i]}`);
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return ALPHABET[(N - (sum % N)) % N];
}

/** Letters/digits only, 2-5 characters, upper case. Falls back to the first letters of the slug. */
export function normaliseCommunityCode(raw: string | null | undefined, fallbackSlug = 'CMT'): string {
  const clean = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (clean.length >= 2) return clean;
  const fb = fallbackSlug.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return fb.length >= 2 ? fb : 'CMT';
}

/** YYMM in Dubai time (UTC+4), the time residents see. */
export function yymm(iso: string): string {
  const d = new Date(Date.parse(iso) + 4 * 3_600_000);
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function makeTrackingRef(code: string, iso: string, seq: number): string {
  const c = normaliseCommunityCode(code);
  const ym = yymm(iso);
  const s = String(seq).padStart(4, '0');
  return `${c}-${ym}-${s}-${luhnMod36Check(`${c}${ym}${s}`)}`;
}

const REF_RE = /\b([A-Za-z0-9]{2,5})-(\d{4})-(\d{4,7})-([A-Za-z0-9])\b/g;

export function isValidTrackingRef(ref: string): boolean {
  const m = /^([A-Z0-9]{2,5})-(\d{4})-(\d{4,7})-([A-Z0-9])$/.exec(ref.toUpperCase());
  return !!m && luhnMod36Check(`${m[1]}${m[2]}${m[3]}`) === m[4];
}

/** Every reference in the text whose check character is correct (upper-cased, de-duplicated). */
export function findTrackingRefs(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(REF_RE)) {
    const ref = m[0].toUpperCase();
    if (isValidTrackingRef(ref)) found.add(ref);
  }
  return [...found];
}

/** Removes anything shaped like a tracking reference so it is never mistaken for a management ticket number. */
export function stripTrackingRefs(text: string): string {
  return text.replace(REF_RE, ' ');
}
