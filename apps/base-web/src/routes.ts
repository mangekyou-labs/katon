export const V1_ROUTES = ['/', '/sell', '/facility', '/curator', '/liquidations'] as const;

export type V1Route = (typeof V1_ROUTES)[number];
