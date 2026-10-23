/** Loaded in the isolated E2E server and its workers. Never permit an external
 * fetch, including paid inference/search calls accidentally left unmocked. */
const originalFetch = globalThis.fetch;
globalThis.fetch = function offlineFetch(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error(`Offline E2E blocked external fetch: ${url.hostname}`));
  }
  return originalFetch(input, init);
};
