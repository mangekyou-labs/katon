export function plaintextWorkflowError(method: string, pathname: string): string | undefined {
  if (method === 'POST' && (pathname === '/v1/auctions' || pathname === '/v1/standing-bids')) {
    return 'PLAINTEXT_WORKFLOW_DISABLED';
  }
  return undefined;
}
