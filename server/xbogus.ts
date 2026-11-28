import crypto from 'node:crypto';

export const DEFAULT_XBOGUS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const HEX_ARRAY: Array<number | null> = [
  null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  null, 10, 11, 12, 13, 14, 15,
];

const XBOGUS_CHARSET =
  'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=';

const UA_KEY = Buffer.from([0x00, 0x01, 0x0c]);

function md5StrToArray(md5Str: string): number[] {
  if (md5Str.length > 32) {
    return Array.from(md5Str, (ch) => ch.charCodeAt(0) & 0xff);
  }
  const arr: number[] = [];
  for (let idx = 0; idx + 1 < md5Str.length; idx += 2) {
    const hi = HEX_ARRAY[md5Str.charCodeAt(idx)] ?? 0;
    const lo = HEX_ARRAY[md5Str.charCodeAt(idx + 1)] ?? 0;
    arr.push((hi << 4) | lo);
  }
  return arr;
}

function md5Hex(input: string | number[]): string {
  const bytes = typeof input === 'string' ? md5StrToArray(input) : input;
  return crypto.createHash('md5').update(Buffer.from(bytes)).digest('hex');
}

function md5Encrypt(urlPath: string): number[] {
  const hashed = md5Hex(md5StrToArray(md5Hex(urlPath)));
  return md5StrToArray(hashed);
}

function rc4Encrypt(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  const out = Buffer.allocUnsafe(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function encodeMergedPayload(merged: number[]): Buffer {
  const [a, b, c, e, d, t, f, r, n, o, i, u0, x, u1, s, l, v, h, p] = merged;
  return Buffer.from([
    a,
    Math.trunc(i),
    b,
    u0,
    c,
    x,
    e,
    u1,
    d,
    s,
    t,
    l,
    f,
    v,
    r,
    h,
    n,
    p,
    o,
  ]);
}

function encodeTriplet(a1: number, a2: number, a3: number): string {
  const x3 = ((a1 & 0xff) << 16) | ((a2 & 0xff) << 8) | (a3 & 0xff);
  return (
    XBOGUS_CHARSET[(x3 & 16515072) >> 18] +
    XBOGUS_CHARSET[(x3 & 258048) >> 12] +
    XBOGUS_CHARSET[(x3 & 4032) >> 6] +
    XBOGUS_CHARSET[x3 & 63]
  );
}

/**
 * Generates Douyin X-Bogus query signature for `/aweme/v1/play/` and web API endpoints.
 */
export function generateXBogus(
  url: string,
  userAgent: string = DEFAULT_XBOGUS_UA,
  timestampSec?: number,
): { signedUrl: string; token: string; userAgent: string } {
  const ua = userAgent || DEFAULT_XBOGUS_UA;
  const uaRc4B64 = rc4Encrypt(UA_KEY, Buffer.from(ua, 'latin1')).toString('base64');
  const uaMd5Array = md5StrToArray(md5Hex(uaRc4B64));
  const emptyMd5Array = md5StrToArray(
    md5Hex(md5StrToArray('d41d8cd98f00b204e9800998ecf8427e')),
  );
  const urlMd5Array = md5Encrypt(url);

  const timer =
    typeof timestampSec === 'number' && Number.isFinite(timestampSec)
      ? Math.trunc(timestampSec)
      : Math.floor(Date.now() / 1000);
  const ct = 536919696;

  const newArray: number[] = [
    64,
    0, // int(0.00390625) === 0
    1,
    12,
    urlMd5Array[14],
    urlMd5Array[15],
    emptyMd5Array[14],
    emptyMd5Array[15],
    uaMd5Array[14],
    uaMd5Array[15],
    (timer >>> 24) & 0xff,
    (timer >>> 16) & 0xff,
    (timer >>> 8) & 0xff,
    timer & 0xff,
    (ct >>> 24) & 0xff,
    (ct >>> 16) & 0xff,
    (ct >>> 8) & 0xff,
    ct & 0xff,
  ];

  let xorResult = newArray[0];
  for (let idx = 1; idx < newArray.length; idx += 1) {
    xorResult ^= newArray[idx];
  }
  newArray.push(xorResult);

  const array3: number[] = [];
  const array4: number[] = [];
  for (let idx = 0; idx < newArray.length; idx += 2) {
    array3.push(newArray[idx]);
    if (idx + 1 < newArray.length) {
      array4.push(newArray[idx + 1]);
    }
  }

  const merged = [...array3, ...array4];
  const encrypted = rc4Encrypt(Buffer.from([0xff]), encodeMergedPayload(merged));
  const garbled = Buffer.concat([Buffer.from([2, 255]), encrypted]);

  let token = '';
  for (let idx = 0; idx + 2 < garbled.length; idx += 3) {
    token += encodeTriplet(garbled[idx], garbled[idx + 1], garbled[idx + 2]);
  }

  const sep = url.includes('?') ? '&' : '?';
  return {
    signedUrl: `${url}${sep}X-Bogus=${token}`,
    token,
    userAgent: ua,
  };
}
