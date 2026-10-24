import { DbConnection } from './module_bindings/index.ts';

export const DB_URI = import.meta.env.VITE_SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
export const DB_NAME = import.meta.env.VITE_SPACETIMEDB_MODULE || 'skyfall-calhacks';

// Each browser keeps its own identity so rate limits and "my sightings" follow
// the device. Storage can be unavailable (private mode); then we get a fresh
// identity per page load, which still works.
const KEY = `skyfall.token.${DB_NAME}`;
function loadToken(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function saveToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* ignore */
  }
}

export const connectionBuilder = DbConnection.builder()
  .withUri(DB_URI)
  .withDatabaseName(DB_NAME)
  .withToken(loadToken())
  .onConnect((_conn, identity, token) => {
    saveToken(token);
    console.log('[skyfall] connected as', identity.toHexString());
  })
  .onConnectError((_ctx, err) => console.error('[skyfall] connect error', err))
  .onDisconnect(() => console.warn('[skyfall] disconnected'));
