type CredentialStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class JoinIntent {
  readonly key: string;
  private readonly pendingKey: string;
  constructor(invite: string, private readonly storage: CredentialStorage) {
    this.key = "progdm.playerToken:" + invite;
    this.pendingKey = "progdm.playerJoinPending:" + invite;
  }
  read() { return this.storage.getItem(this.key) ?? ""; }
  pending() { return this.storage.getItem(this.pendingKey) === "1"; }
  begin(createToken: () => string) {
    const token = this.read() || createToken();
    // Persist uncertainty before sending: a reload must not interpret an early 401 as revocation.
    this.storage.setItem(this.pendingKey, "1");
    this.storage.setItem(this.key, token);
    return token;
  }
  confirm(token: string) {
    if (this.read() === token) this.storage.removeItem(this.pendingKey);
  }
  clear(token: string) {
    if (this.read() !== token) return;
    this.storage.removeItem(this.key);
    this.storage.removeItem(this.pendingKey);
  }
  retainUnauthorized(inFlight: boolean) { return inFlight || this.pending(); }
}
