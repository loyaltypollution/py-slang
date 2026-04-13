export type Revision = number & { readonly __brand: 'Revision' };

export const REVISION_ZERO = 0 as Revision;
