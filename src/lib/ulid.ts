// Crockford base32 alphabet (excludes I, L, O, U).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
const lastRandom = new Uint8Array(RANDOM_LEN);

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN;
    out = ENCODING[mod]! + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function fillRandom(): void {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < RANDOM_LEN; i++) lastRandom[i] = bytes[i]! % ENCODING_LEN;
}

/**
 * Monotonic-within-the-same-millisecond: if two ULIDs are generated in the
 * same ms, the random component is incremented rather than re-rolled, so
 * lexicographic order matches creation order.
 */
function incrementRandom(): void {
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    if (lastRandom[i]! < ENCODING_LEN - 1) {
      lastRandom[i]!++;
      return;
    }
    lastRandom[i] = 0;
  }
}

function encodeRandom(): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[lastRandom[i]!];
  return out;
}

/**
 * Standard ULID: 26 chars (10 time + 16 randomness), Crockford base32,
 * lexicographically sortable and monotonic. No external dependency.
 */
export function ulid(): string {
  const now = Date.now();
  if (now === lastTime) {
    incrementRandom();
  } else {
    lastTime = now;
    fillRandom();
  }
  return encodeTime(now) + encodeRandom();
}
