// The address seal: a deterministic ink constellation drawn from a hash of the
// address. It is a VERIFICATION AID, not decoration — two addresses that differ
// by one character draw visibly different seals, so a maker who has seen their
// counterparty's seal once can spot a swapped address without reading 56
// base32 characters. It pairs with the highlighted tail in the field itself.
//
// Not a security control: an attacker who can pick their own keypair can grind
// for a similar-looking seal. It defends against typos and clipboard mishaps.

const SEED = 0x811c9dc5;

/** FNV-1a — cheap, well-mixed, and stable across engines (Math.imul keeps it 32-bit). */
function hash32(s: string): number {
  let h = SEED;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function points(addr: string): Array<[number, number]> {
  let h = hash32(addr);
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < 6; k++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const ang = ((h % 360) * Math.PI) / 180;
    const rad = 6.5 + ((h >>> 9) % 87) / 10;
    pts.push([22 + rad * Math.cos(ang), 22 + rad * Math.sin(ang)]);
  }
  return pts;
}

export type SealState = 'idle' | 'ok' | 'err';

export function AddressSeal({ state, address, size = 28 }: {
  state: SealState;
  address: string;
  size?: number;
}) {
  const ring = state === 'ok' ? 'seal-ring seal-ring--live'
    : state === 'err' ? 'seal-ring seal-ring--err'
      : 'seal-ring seal-ring--idle';
  const pts = state === 'ok' ? points(address) : [];
  const d = pts.length
    ? 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')
    : '';

  return (
    <svg viewBox="0 0 44 44" width={size} height={size} aria-hidden="true">
      <circle cx={22} cy={22} r={20.5} className={ring} />
      {state === 'ok' ? (
        <>
          <path d={d} className="seal-path" />
          {pts.map(([x, y], i) => (
            <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={i === 0 ? 2.3 : 1.4} className="seal-dot" />
          ))}
        </>
      ) : state === 'err' ? (
        <path d="M17.5 17.5l9 9M26.5 17.5l-9 9" className="seal-x" fill="none" />
      ) : (
        <text x={22} y={27.5} textAnchor="middle" className="seal-g">G</text>
      )}
    </svg>
  );
}
