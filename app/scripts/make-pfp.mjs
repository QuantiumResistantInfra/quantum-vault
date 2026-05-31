// Renders the Qubit mark to a square PNG for a Twitter/X profile picture.
// Twitter crops to a circle, so the mark is centered with safe margins.
// Run: node scripts/make-pfp.mjs
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

const SIZE = 1000;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#ffffff"/>
  <!-- mark scaled up and centered on its true visual center (51.9, 52.3) -->
  <g transform="translate(500 500) scale(6.5) translate(-51.9 -52.3)">
    <g stroke="#16191f" fill="none">
      <g transform="rotate(-28 50 50)">
        <ellipse cx="50" cy="50" rx="42" ry="15" stroke-width="3" opacity="0.6"/>
        <circle cx="92" cy="50" r="4.5" fill="#16191f" stroke="none"/>
      </g>
      <circle cx="50" cy="50" r="22" stroke-width="7.5"/>
      <line x1="61" y1="61" x2="75" y2="75" stroke-width="7.5" stroke-linecap="round"/>
    </g>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: SIZE } }).render().asPng();
writeFileSync(new URL("../../qubit-twitter.png", import.meta.url), png);
console.log(`wrote qubit-twitter.png (${SIZE}x${SIZE})`);
