/**
 * Routes LendaSwap API requests through Tauri's HTTP plugin instead of the
 * browser `fetch`, because `api.lendaswap.com` only CORS-whitelists `localhost`
 * origins. The Android WebView origin (`http://tauri.localhost`) and iOS
 * (`tauri://localhost`) get rejected by the API's Cloudflare config, which
 * manifests as `TypeError: Failed to fetch` in the SDK.
 *
 * Importing this module for its side-effect at app boot installs a `fetch`
 * proxy on `globalThis`. All other URLs fall through to the native fetch so
 * dev-server HMR, local asset loads, etc. stay untouched.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const PROXIED_HOSTS = new Set([
  "api.lendaswap.com",
  "api.ark.boltz.exchange",
  "api.yadio.io",
  "asp.109-176-197-122.nip.io",
  "arkade.computer",
  "afronut.xyz",
  "relay.walletconnect.org",
  "relay.walletconnect.com",
  "verify.walletconnect.org",
  "verify.walletconnect.com",
  "explorer-api.walletconnect.com",
]);

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : String(input);
  try {
    if (PROXIED_HOSTS.has(new URL(url).host)) {
      return await tauriFetch(input, init);
    }
  } catch {
    // Relative URL or malformed — fall through to native fetch.
  }
  return nativeFetch(input, init);
}) as typeof fetch;
