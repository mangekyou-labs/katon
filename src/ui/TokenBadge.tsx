// Token display with the unknown-asset quarantine warning. JSX escapes all
// text; the .tok-warn/.tok-iss classes match styles.css.

import { isKnownToken, tokenIssuer, tokenLabel, trunc } from '../core/tokens';

export function TokenBadge({ value }: { value: string }) {
  if (isKnownToken(value)) return <>{tokenLabel(value)}</>;
  const issuer = tokenIssuer(value);
  return (
    <span className="tok-warn" title="Unrecognized asset — verify the issuer before trading">
      ⚠ {tokenLabel(value)}
      {issuer ? <> <span className="tok-iss">{trunc(issuer)}</span></> : null}
    </span>
  );
}
