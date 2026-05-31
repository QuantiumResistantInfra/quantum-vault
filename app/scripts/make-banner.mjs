// Renders a 1500x500 Twitter/X banner for Qubit.
// Run: node scripts/make-banner.mjs
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

const W = 1500, H = 500;

// The mono mark, placed at (cx, cy) scaled to `s` (centered on its visual center).
const mark = (cx, cy, s, color) => `
  <g transform="translate(${cx} ${cy}) scale(${s}) translate(-51.9 -52.3)">
    <g stroke="${color}" fill="none">
      <g transform="rotate(-28 50 50)">
        <ellipse cx="50" cy="50" rx="42" ry="15" stroke-width="3" opacity="0.55"/>
        <circle cx="92" cy="50" r="4.5" fill="${color}" stroke="none"/>
      </g>
      <circle cx="50" cy="50" r="22" stroke-width="7.5"/>
      <line x1="61" y1="61" x2="75" y2="75" stroke-width="7.5" stroke-linecap="round"/>
    </g>
  </g>`;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>

  <!-- centered lockup: mark + wordmark, mono ink on white -->
  ${mark(560, 222, 1.45, "#16191f")}
  <text x="650" y="256" font-family="Segoe UI, Arial, sans-serif" font-weight="700"
        font-size="104" letter-spacing="-2" fill="#16191f">Qubit</text>

  <text x="750" y="338" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-weight="400" font-size="34" letter-spacing="0.5" fill="#5a6573">Post-quantum secure vaults for Solana</text>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
writeFileSync(new URL("../../qubit-banner.png", import.meta.url), png);
console.log(`wrote qubit-banner.png (${W}x${H})`);
