// Dependency-free QR Code encoder (ISO/IEC 18004), byte mode only, error
// correction level M, auto-selecting the smallest version in the range
// 1-10. This is intentionally a narrow subset of the full spec (no
// numeric/alphanumeric/kanji modes, no ECI, no levels other than M, no
// versions above 10) — enough to render short strings (URLs, share codes,
// card ids) as a scannable code without pulling in a QR library.
//
// Pipeline: text -> UTF-8 bytes -> bit stream (mode + char count + data +
// terminator/padding) -> Reed-Solomon error correction codewords (GF(256))
// -> codeword interleaving -> module matrix placement (finder/timing/
// alignment/format/version patterns + zigzag data placement) -> masking
// (all 8 masks scored by the four penalty rules N1-N4, lowest wins).

// ---------------------------------------------------------------------------
// Per-version tables (versions 1-10, error correction level M only)
// ---------------------------------------------------------------------------

/** Alignment pattern center coordinates (row/col candidates) per version.
 * Version 1 has no alignment patterns. The actual pattern centers are every
 * combination of these coordinates, except the three that would overlap a
 * finder pattern (first-first, first-last, last-first). Source: ISO/IEC
 * 18004 Annex E. */
const ALIGNMENT_COORDS: readonly (readonly number[])[] = [
  [], // version 0 unused (index kept === version for readability)
  [], // version 1
  [6, 18], // version 2
  [6, 22], // version 3
  [6, 26], // version 4
  [6, 30], // version 5
  [6, 34], // version 6
  [6, 22, 38], // version 7
  [6, 24, 42], // version 8
  [6, 26, 46], // version 9
  [6, 28, 50], // version 10
];

/** How the data codewords split into (possibly two) groups of equal-sized
 * blocks, plus how many Reed-Solomon error-correction codewords each block
 * carries. Error correction level M only. Source: ISO/IEC 18004 Table 9
 * ("Error correction characteristics"). */
interface BlockGroup {
  /** Number of blocks in this group. */
  count: number;
  /** Number of data codewords in each block of this group. */
  dataCodewords: number;
}
interface VersionBlocks {
  ecCodewordsPerBlock: number;
  groups: BlockGroup[];
}
const BLOCK_TABLE: readonly VersionBlocks[] = [
  { ecCodewordsPerBlock: 0, groups: [] }, // version 0 unused
  { ecCodewordsPerBlock: 10, groups: [{ count: 1, dataCodewords: 16 }] }, // v1-M
  { ecCodewordsPerBlock: 16, groups: [{ count: 1, dataCodewords: 28 }] }, // v2-M
  { ecCodewordsPerBlock: 26, groups: [{ count: 1, dataCodewords: 44 }] }, // v3-M
  { ecCodewordsPerBlock: 18, groups: [{ count: 2, dataCodewords: 32 }] }, // v4-M
  { ecCodewordsPerBlock: 24, groups: [{ count: 2, dataCodewords: 43 }] }, // v5-M
  { ecCodewordsPerBlock: 16, groups: [{ count: 4, dataCodewords: 27 }] }, // v6-M
  { ecCodewordsPerBlock: 18, groups: [{ count: 4, dataCodewords: 31 }] }, // v7-M
  {
    ecCodewordsPerBlock: 22,
    groups: [
      { count: 2, dataCodewords: 38 },
      { count: 2, dataCodewords: 39 },
    ],
  }, // v8-M
  {
    ecCodewordsPerBlock: 22,
    groups: [
      { count: 3, dataCodewords: 36 },
      { count: 2, dataCodewords: 37 },
    ],
  }, // v9-M
  {
    ecCodewordsPerBlock: 26,
    groups: [
      { count: 4, dataCodewords: 43 },
      { count: 1, dataCodewords: 44 },
    ],
  }, // v10-M
];

function totalDataCodewords(version: number): number {
  return BLOCK_TABLE[version].groups.reduce((sum, g) => sum + g.count * g.dataCodewords, 0);
}

/** Character count indicator length (bits) for byte mode. Versions 1-9 use
 * 8 bits; versions 10-26 use 16 bits (only version 10 is reachable here). */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic and Reed-Solomon error correction codewords
// ---------------------------------------------------------------------------

// QR codes use the field GF(2^8) with reduction polynomial
// x^8 + x^4 + x^3 + x^2 + 1 (0x11D) and generator element 2.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Builds the Reed-Solomon generator polynomial of the given degree:
 * product over i=0..degree-1 of (x + alpha^i). Returned as coefficients
 * highest-degree-first, including the (always-1) leading coefficient. */
function rsGeneratorPolynomial(degree: number): number[] {
  let coeffs = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(coeffs.length + 1).fill(0);
    for (let j = 0; j < coeffs.length; j++) {
      next[j] ^= coeffs[j]; // multiply existing term by x
      next[j + 1] ^= gfMul(coeffs[j], GF_EXP[i]); // multiply existing term by alpha^i
    }
    coeffs = next;
  }
  return coeffs;
}

/** Computes the `degree` Reed-Solomon error-correction codewords for one
 * block of data codewords, via polynomial long division mod the generator. */
function rsComputeRemainder(data: number[], degree: number): number[] {
  const generator = rsGeneratorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const dataByte of data) {
    const factor = dataByte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) {
        remainder[i] ^= gfMul(generator[i + 1], factor);
      }
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Bit stream: mode header + data + terminator/padding
// ---------------------------------------------------------------------------

class BitWriter {
  private bits: boolean[] = [];

  get length(): number {
    return this.bits.length;
  }

  push(bit: boolean): void {
    this.bits.push(bit);
  }

  writeBits(value: number, bitCount: number): void {
    for (let i = bitCount - 1; i >= 0; i--) {
      this.bits.push(((value >>> i) & 1) === 1);
    }
  }

  /** Packs the bit stream into bytes, zero-padding the final byte if needed. */
  toBytes(): number[] {
    const byteCount = Math.ceil(this.bits.length / 8);
    const bytes = new Array<number>(byteCount).fill(0);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
    }
    return bytes;
  }
}

const MODE_BYTE = 0b0100; // byte mode indicator (the only mode this encoder supports)
const PAD_BYTES = [0xec, 0x11]; // standard alternating pad codewords

/** Picks the smallest version (1-10) whose byte-mode capacity at level M
 * fits `bytes`, or null if it doesn't fit even at version 10. */
function selectVersion(bytes: Uint8Array): number | null {
  for (let version = 1; version <= 10; version++) {
    const capacityBits = totalDataCodewords(version) * 8;
    const headerBits = 4 + charCountBits(version);
    if (headerBits + bytes.length * 8 <= capacityBits) return version;
  }
  return null;
}

/** Builds the padded data codeword sequence (one per version's total data
 * codeword count) for `bytes` in byte mode. Assumes `version` was already
 * chosen via selectVersion so the data is known to fit. */
function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const capacityBits = totalDataCodewords(version) * 8;
  const writer = new BitWriter();
  writer.writeBits(MODE_BYTE, 4);
  writer.writeBits(bytes.length, charCountBits(version));
  for (const b of bytes) writer.writeBits(b, 8);

  const terminatorBits = Math.min(4, capacityBits - writer.length);
  writer.writeBits(0, terminatorBits);
  while (writer.length % 8 !== 0) writer.push(false);

  const codewords = writer.toBytes();
  let padIndex = 0;
  while (codewords.length < totalDataCodewords(version)) {
    codewords.push(PAD_BYTES[padIndex % 2]);
    padIndex++;
  }
  return codewords;
}

/** Splits data codewords into per-block groups, computes each block's EC
 * codewords, then interleaves data and EC codewords per the spec: data
 * codewords column-by-column across blocks (shorter blocks simply run out
 * first), followed by EC codewords column-by-column across blocks. */
function buildInterleavedCodewords(dataCodewords: number[], version: number): number[] {
  const { ecCodewordsPerBlock, groups } = BLOCK_TABLE[version];
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const group of groups) {
    for (let b = 0; b < group.count; b++) {
      const block = dataCodewords.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      dataBlocks.push(block);
      ecBlocks.push(rsComputeRemainder(block, ecCodewordsPerBlock));
    }
  }

  const result: number[] = [];
  const maxDataLength = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLength; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecCodewordsPerBlock; i++) {
    for (const block of ecBlocks) {
      result.push(block[i]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Format info (BCH(15,5)) and version info (BCH(18,6))
// ---------------------------------------------------------------------------

const EC_LEVEL_M_BITS = 0b00; // format info EC level indicator: L=01 M=00 Q=11 H=10
const FORMAT_GENERATOR = 0x537; // BCH(15,5) generator polynomial
const FORMAT_MASK = 0x5412; // fixed XOR mask applied to the format info codeword
const VERSION_GENERATOR = 0x1f25; // BCH(18,6) generator polynomial

/** Computes the 15-bit format info value (level M, given mask 0-7). */
function computeFormatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask; // 5 data bits: 2-bit EC level + 3-bit mask id
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GENERATOR);
  }
  return (((data << 10) | rem) ^ FORMAT_MASK) & 0x7fff;
}

/** Computes the 18-bit version info value (versions 7-10 only, per this
 * encoder's supported range — the full spec needs it from version 7 up). */
function computeVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * VERSION_GENERATOR);
  }
  return ((version << 12) | rem) & 0x3ffff;
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) === 1;
}

// ---------------------------------------------------------------------------
// Mask patterns (the 8 standard predicates; true = invert this module)
// ---------------------------------------------------------------------------

function shouldInvert(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Module matrix placement
// ---------------------------------------------------------------------------

class QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = 17 + 4 * version;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(row: number, col: number, dark: boolean, fn: boolean): void {
    this.modules[row][col] = dark;
    if (fn) this.isFunction[row][col] = true;
  }

  /** Draws one 7x7 finder pattern (with its 1-module light separator ring,
   * clipped to the matrix bounds) whose top-left corner is (topRow, leftCol). */
  private drawFinderPattern(topRow: number, leftCol: number): void {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = topRow + r;
        const col = leftCol + c;
        if (row < 0 || row >= this.size || col < 0 || col >= this.size) continue;
        const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inFinder && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        this.set(row, col, dark, true);
      }
    }
  }

  private drawTiming(): void {
    for (let i = 8; i <= this.size - 9; i++) {
      const dark = i % 2 === 0;
      this.set(6, i, dark, true); // horizontal timing row
      this.set(i, 6, dark, true); // vertical timing column
    }
  }

  private drawAlignmentPatterns(): void {
    const coords = ALIGNMENT_COORDS[this.version];
    if (coords.length === 0) return;
    const last = coords[coords.length - 1];
    for (const row of coords) {
      for (const col of coords) {
        const overlapsFinder = (row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6);
        if (overlapsFinder) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
            this.set(row + r, col + c, dark, true);
          }
        }
      }
    }
  }

  private drawDarkModule(): void {
    // Always dark, at (row, col) = (4*version + 9, 8).
    this.set(this.size - 8, 8, true, true);
  }

  /** Marks the two format-info regions (flanking the top-left finder, and
   * split across the top-right/bottom-left finders) as function modules,
   * ahead of data placement. Values are filled in later by drawFormatInfo
   * once the winning mask is known. */
  private reserveFormatAreas(): void {
    for (let row = 0; row <= 8; row++) {
      if (row === 6) continue; // vertical timing column
      this.isFunction[row][8] = true;
    }
    for (let row = this.size - 7; row < this.size; row++) {
      this.isFunction[row][8] = true;
    }
    for (let col = 0; col <= 8; col++) {
      if (col === 6) continue; // horizontal timing row
      this.isFunction[8][col] = true;
    }
    for (let col = this.size - 8; col < this.size; col++) {
      this.isFunction[8][col] = true;
    }
  }

  /** Marks the two 6x3 / 3x6 version-info blocks (versions 7-10 only). */
  private reserveVersionAreas(): void {
    if (this.version < 7) return;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.isFunction[b][a] = true; // top-right block
      this.isFunction[a][b] = true; // bottom-left block
    }
  }

  /** Draws all fixed function patterns and reserves (without filling) the
   * format/version info areas. Call once per matrix, before placing data. */
  drawFunctionPatterns(): void {
    this.drawFinderPattern(0, 0);
    this.drawFinderPattern(0, this.size - 7);
    this.drawFinderPattern(this.size - 7, 0);
    this.drawTiming();
    this.drawAlignmentPatterns();
    this.drawDarkModule();
    this.reserveFormatAreas();
    this.reserveVersionAreas();
  }

  /** Places data codeword bits (MSB-first per byte) into all non-function
   * modules in the standard zigzag order (two-column strips scanning
   * bottom-to-top then top-to-bottom, skipping column 6's timing pattern),
   * inverting each placed bit per `maskFn`. Any module positions beyond the
   * codeword bits (the version's "remainder bits") are left as light,
   * still subject to masking like real data — matching the spec's encoding
   * region. */
  placeDataWithMask(codewords: number[], maskFn: (row: number, col: number) => boolean): void {
    const totalBits = codewords.length * 8;
    let bitIndex = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // column 6 is the vertical timing pattern; skip it
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? this.size - 1 - vert : vert;
          if (this.isFunction[row][col]) continue;
          let bit = false;
          if (bitIndex < totalBits) {
            const byte = codewords[bitIndex >> 3];
            bit = getBit(byte, 7 - (bitIndex & 7));
          }
          bitIndex++;
          this.modules[row][col] = bit !== maskFn(row, col); // boolean XOR
        }
      }
    }
  }

  drawFormatInfo(mask: number): void {
    const bits = computeFormatBits(mask);
    // First copy: vertical arm down column 8, then horizontal arm along row 8
    // (both flanking the top-left finder pattern).
    for (let i = 0; i <= 5; i++) this.set(i, 8, getBit(bits, i), true);
    this.set(7, 8, getBit(bits, 6), true);
    this.set(8, 8, getBit(bits, 7), true);
    this.set(8, 7, getBit(bits, 8), true);
    for (let i = 9; i < 15; i++) this.set(8, 14 - i, getBit(bits, i), true);

    // Second copy: split across the top-right finder (row 8) and the
    // bottom-left finder (column 8).
    for (let i = 0; i < 8; i++) this.set(8, this.size - 1 - i, getBit(bits, i), true);
    for (let i = 8; i < 15; i++) this.set(this.size - 15 + i, 8, getBit(bits, i), true);
  }

  drawVersionInfo(): void {
    if (this.version < 7) return;
    const bits = computeVersionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(b, a, bit, true); // top-right block
      this.set(a, b, bit, true); // bottom-left block
    }
  }
}

// ---------------------------------------------------------------------------
// Mask penalty scoring (rules N1-N4)
// ---------------------------------------------------------------------------

// The 1:1:3:1:1 (dark:light:dark:light:dark) finder-like ratio, padded with
// 4 light modules on one side, as two 11-cell windows (light-padding first
// or last). This is a simplified but valid N3 scan: it only counts the
// pattern when the full 11-cell window (including its light padding) lies
// within the row/column, rather than treating the matrix edge itself as an
// implicit light border. That only ever under-counts penalty near the
// edges — it cannot make an invalid mask choice, since all 8 masks produce
// a structurally valid, scannable symbol regardless of penalty score; the
// score only chooses which valid mask "looks" least noisy.
const FINDER_LIKE_A = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LIKE_B = [false, false, false, false, true, false, true, true, true, false, true];

function matchesAt(line: boolean[], start: number, pattern: boolean[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (line[start + i] !== pattern[i]) return false;
  }
  return true;
}

/** N1: penalty for runs of 5+ same-colored modules in a line. */
function runPenalty(line: boolean[]): number {
  let penalty = 0;
  let runLength = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      runLength++;
    } else {
      if (runLength >= 5) penalty += 3 + (runLength - 5);
      runLength = 1;
    }
  }
  return penalty;
}

/** N3: penalty for 1:1:3:1:1 finder-like patterns in a line. */
function finderLikePenalty(line: boolean[]): number {
  let count = 0;
  for (let i = 0; i + 11 <= line.length; i++) {
    if (matchesAt(line, i, FINDER_LIKE_A) || matchesAt(line, i, FINDER_LIKE_B)) count++;
  }
  return count * 40;
}

function computePenalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let penalty = 0;

  for (let row = 0; row < size; row++) {
    penalty += runPenalty(matrix[row]);
    penalty += finderLikePenalty(matrix[row]);
  }
  for (let col = 0; col < size; col++) {
    const column = matrix.map((r) => r[col]);
    penalty += runPenalty(column);
    penalty += finderLikePenalty(column);
  }

  // N2: 2x2 blocks of same-colored modules.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const c = matrix[row][col];
      if (matrix[row][col + 1] === c && matrix[row + 1][col] === c && matrix[row + 1][col + 1] === c) {
        penalty += 3;
      }
    }
  }

  // N4: overall dark-module ratio deviation from 50%, in 5% steps.
  let dark = 0;
  for (const row of matrix) {
    for (const cell of row) {
      if (cell) dark++;
    }
  }
  const total = size * size;
  const k = Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  penalty += k * 10;

  return penalty;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Encodes `text` (UTF-8, byte mode) as a QR module matrix (true = dark).
 * Auto-selects the smallest version 1..10 at error-correction level M.
 * Returns null when the text doesn't fit version 10-M (213 bytes — the
 * byte-mode capacity of version 10 at error correction level M). */
export function encodeQr(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  const version = selectVersion(bytes);
  if (version === null) return null;

  const dataCodewords = buildDataCodewords(bytes, version);
  const codewords = buildInterleavedCodewords(dataCodewords, version);

  let bestMatrix: boolean[][] | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const matrix = new QrMatrix(version);
    matrix.drawFunctionPatterns();
    matrix.placeDataWithMask(codewords, (row, col) => shouldInvert(mask, row, col));
    matrix.drawFormatInfo(mask);
    matrix.drawVersionInfo();
    const penalty = computePenalty(matrix.modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = matrix.modules;
    }
  }
  return bestMatrix;
}
