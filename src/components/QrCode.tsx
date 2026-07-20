// Renders arbitrary text as a scannable QR code (SVG), via the dependency-
// free encoder in lib/qr.ts. Self-contained: no props beyond the text to
// encode and an optional pixel size.
import type { JSX } from "preact";
import { encodeQr } from "../lib/qr";

export interface QrCodeProps {
  text: string;
  /** Rendered width/height in CSS pixels. Defaults to 192. */
  size?: number;
}

const QUIET_ZONE = 4; // modules of light border required around the symbol per spec

export function QrCode({ text, size }: QrCodeProps): JSX.Element | null {
  const matrix = encodeQr(text);
  if (!matrix) return null;

  const moduleCount = matrix.length;
  const dimension = moduleCount + QUIET_ZONE * 2;
  const pixelSize = size ?? 192;

  // One SVG path for every dark module (faster to render than one <rect>
  // per module), each module drawn as a 1x1 unit square offset by the
  // quiet zone.
  let path = "";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (matrix[row][col]) {
        const x = col + QUIET_ZONE;
        const y = row + QUIET_ZONE;
        path += `M${x} ${y}h1v1h-1z`;
      }
    }
  }

  return (
    <svg
      class="qr-code"
      width={pixelSize}
      height={pixelSize}
      viewBox={`0 0 ${dimension} ${dimension}`}
      role="img"
      aria-label={text}
    >
      {/*
        Colors are deliberately hardcoded (not the app's theme tokens) —
        QR scanners need reliable light-background/dark-module contrast to
        decode, and following the user's light/dark theme would break that
        (e.g. dark-mode inverted or low-contrast tokens can make the code
        unreadable to a camera). This is the one place in the app where the
        CLAUDE.md "use design tokens" rule intentionally does not apply.
      */}
      <rect x={0} y={0} width={dimension} height={dimension} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
