/**
 * The OpenGeni brand mark — the geometric glyph from the marketing site
 * (Cloudgeni-ai/agent-heartbeat-03, landing Nav + favicon), rendered with
 * currentColor so it inherits whatever brand tint its container sets.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 140 133"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform="translate(-17.5,-20.999893188476562) scale(1.75)">
        <g transform="translate(0,-952.36218)">
          <path d="m 60.7828,964.36215 27.1809,0.8834 -27.1809,25.9958 z m -1.9745,1.4513 0,26.7845 -25.2681,0 c 8.6166,-8.7334 16.8796,-17.8103 25.2681,-26.7845 z m 27.7053,3.628 3.4864,1.1989 -12.5877,7.4768 z m -68.1835,2.9656 5.5226,0 12.8654,14.0705 -5.9854,6.1204 -12.4026,0 c 9e-4,-6.7347 0,-13.4597 0,-20.1909 z m -1.9746,1.2304 0,5.8364 -6.3555,0 z m 3.363,20.9796 38.627,0 -10.7675,29.43465 z m 39.0898,4.54286 0,41.20229 -12.5878,-6.8775 c 4.1972,-11.443 8.3886,-22.879 12.5878,-34.32479 z" />
        </g>
      </g>
    </svg>
  );
}
