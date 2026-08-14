// Wallet gate — markup ported from otc.html §gate; classes must keep matching
// styles.css (.gate, .eyebrow, .gate__trust, …). Hidden (not unmounted) when a
// wallet is connected, mirroring vanilla's display toggle.

export function Gate({ onConnect, hidden }: { onConnect: () => void; hidden: boolean }) {
  return (
    <section className="gate" id="gate" style={hidden ? { display: 'none' } : undefined}>
      <div className="gate__mark">
        <svg width="44" height="44" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M20 21 C26 13.5, 38 13.5, 44 21" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M44 43 C38 50.5, 26 50.5, 20 43" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="15" cy="32" r="7.5" fill="currentColor" />
          <circle cx="49" cy="32" r="7.5" stroke="currentColor" strokeWidth="3.5" />
        </svg>
      </div>
      <div className="eyebrow"><span className="eyebrow__dot" />Peer-to-peer OTC · Stellar Testnet</div>
      <h1>Your wallet is your desk.</h1>
      <p>
        No sign-up, nothing custodied. Connect a Stellar wallet to send a directed order
        to your counterparty — or to see orders addressed to you.
      </p>
      <button className="btn btn--gold" id="connectBtn" onClick={onConnect}>Connect wallet</button>
      <div className="gate__trust">
        <span>Non-custodial</span>
        <span>Wallet-signed terms</span>
        <span>Atomic settlement</span>
      </div>
    </section>
  );
}
