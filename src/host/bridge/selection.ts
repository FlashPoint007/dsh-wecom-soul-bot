/**
 * Per (conversation, sender) state for administrators: the Session they
 * switched to and the numbered listing from the latest `/sessions`, so
 * `/use 3` refers to what that person just saw. Ordinary users never have a
 * selection — their binding owns the Session. A selection never widens
 * access: every use re-checks the administrator's Workspace scope and the
 * catalog, and `/reset` drops it.
 */
export interface SelectionStore {
  get(chat: string, user: string): string | undefined;
  set(chat: string, user: string, sessionId: string): void;
  clear(chat: string, user: string): void;
  /** Invalidate all switches and numbered listings for a re-assigned chat. */
  clearChat(chat: string): void;
  listing(chat: string, user: string): readonly string[] | undefined;
  setListing(chat: string, user: string, sessionIds: readonly string[]): void;
}

export function createSelectionStore(maxEntries = 500): SelectionStore {
  const selected = new Map<string, string>();
  const listings = new Map<string, readonly string[]>();
  const key = (chat: string, user: string) => `${chat}\0${user}`;
  function put<T>(map: Map<string, T>, k: string, value: T): void {
    map.delete(k);
    map.set(k, value);
    if (map.size > maxEntries) map.delete(map.keys().next().value!);
  }
  return {
    get: (chat, user) => selected.get(key(chat, user)),
    set: (chat, user, sessionId) => put(selected, key(chat, user), sessionId),
    clear: (chat, user) => { selected.delete(key(chat, user)); },
    clearChat(chat) {
      for (const map of [selected, listings]) {
        for (const k of map.keys()) if (k.startsWith(`${chat}\0`)) map.delete(k);
      }
    },
    listing: (chat, user) => listings.get(key(chat, user)),
    setListing: (chat, user, ids) => put(listings, key(chat, user), [...ids]),
  };
}
