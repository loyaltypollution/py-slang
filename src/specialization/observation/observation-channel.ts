export class ObservationSource<K, O> {
  declare readonly _types?: readonly [K, O];

  constructor(readonly isUnknown: (observed: O) => boolean) {}
}
