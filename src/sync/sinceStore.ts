export interface SinceStore {
  get(): Promise<number>;
  set(since: number): Promise<void>;
}

export class MemorySinceStore implements SinceStore {
  private since: number;
  constructor(initialSince = 0) {
    this.since = initialSince;
  }
  async get(): Promise<number> {
    return this.since;
  }
  async set(since: number): Promise<void> {
    this.since = since;
  }
}
