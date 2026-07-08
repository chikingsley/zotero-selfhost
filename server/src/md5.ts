const initialA = 0x6745_2301;
const initialB = 0xefcd_ab89;
const initialC = 0x98ba_dcfe;
const initialD = 0x1032_5476;

const shifts = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4,
  11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
  10, 15, 21,
];

const constants = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32)
);

export const md5Hex = (buffer: ArrayBuffer): string => {
  const input = new Uint8Array(buffer);
  const bitLength = BigInt(input.length) * 8n;
  const paddingLength = (56 - ((input.length + 1) % 64) + 64) % 64;
  const totalLength = input.length + 1 + paddingLength + 8;
  const bytes = new Uint8Array(totalLength);

  bytes.set(input);
  bytes[input.length] = 0x80;

  for (let index = 0; index < 8; index += 1) {
    bytes[totalLength - 8 + index] = Number(
      (bitLength >> BigInt(8 * index)) & 0xffn
    );
  }

  let a0 = initialA;
  let b0 = initialB;
  let c0 = initialC;
  let d0 = initialD;

  for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += 64) {
    const words = new Array<number>(16);

    for (let index = 0; index < 16; index += 1) {
      const offset = chunkStart + index * 4;
      words[index] =
        (bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;

      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const previousD = d;
      d = c;
      c = b;
      b =
        (b +
          leftRotate(
            (a + f + (constants[index] ?? 0) + (words[g] ?? 0)) >>> 0,
            shifts[index] ?? 0
          )) >>>
        0;
      a = previousD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(wordToHex).join("");
};

const leftRotate = (value: number, amount: number): number =>
  ((value << amount) | (value >>> (32 - amount))) >>> 0;

const wordToHex = (word: number): string =>
  [0, 8, 16, 24]
    .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0"))
    .join("");
