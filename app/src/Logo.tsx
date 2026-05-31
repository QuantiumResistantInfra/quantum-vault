// Qubit mark — a monochrome Quantum Orbit Q. Uses `currentColor`, so it takes
// the surrounding text color (white in the dark header).

export function QubitMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      role="img"
      aria-label="Qubit"
    >
      <g transform="rotate(-28 50 50)">
        <ellipse cx="50" cy="50" rx="42" ry="15" stroke="currentColor" strokeWidth="3" opacity="0.6" />
        <circle cx="92" cy="50" r="4.5" fill="currentColor" />
      </g>
      <circle cx="50" cy="50" r="22" stroke="currentColor" strokeWidth="7.5" />
      <line x1="61" y1="61" x2="75" y2="75" stroke="currentColor" strokeWidth="7.5" strokeLinecap="round" />
    </svg>
  );
}
