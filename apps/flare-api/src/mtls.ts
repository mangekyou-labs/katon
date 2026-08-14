export interface MtlsCertificate {
  readonly subject?: { readonly CN?: string };
  readonly subjectaltname?: string;
  readonly fingerprint256?: string;
}

export interface MtlsPeer {
  readonly authorized?: boolean;
  readonly getPeerCertificate?: () => MtlsCertificate | undefined;
}

export interface MtlsIdentity {
  readonly institution: string;
  readonly fingerprint256?: string;
}

export function authorizeMtlsPeer(peer: MtlsPeer, institution: string): MtlsIdentity {
  if (!institution.trim()) throw new Error('BOT_MTLS_INSTITUTION');
  if (peer.authorized !== true || typeof peer.getPeerCertificate !== 'function') throw new Error('BOT_MTLS_REQUIRED');
  const certificate = peer.getPeerCertificate();
  if (!certificate) throw new Error('BOT_MTLS_CERTIFICATE');
  const expected = institution.trim().toLowerCase();
  const names = [certificate.subject?.CN, ...(certificate.subjectaltname ?? '').split(',').map((name) => name.replace(/^[A-Z]+:/, '').trim())]
    .filter((name): name is string => Boolean(name?.trim()))
    .map((name) => name.toLowerCase());
  if (!names.includes(expected)) throw new Error('BOT_MTLS_INSTITUTION_MISMATCH');
  return { institution: institution.trim(), fingerprint256: certificate.fingerprint256 };
}
