// The explorer's backend URLs used to be baked in at build time and defaulted
// to http://localhost:4224. That is fine when the only way to reach the explorer
// is from the node itself, but these are *browser-side* fetches: served publicly,
// every visitor would query their own loopback rather than the node's gatekeeper.
//
// So they are resolved at runtime instead. server.js serves the values it was
// given, and the app fetches them before rendering. The build-time values remain
// as the fallback, which keeps existing local setups working unchanged.

export interface RuntimeConfig {
    gatekeeperUrl: string;
    searchServerUrl: string;
}

const buildTimeDefaults: RuntimeConfig = {
    gatekeeperUrl: import.meta.env.VITE_GATEKEEPER_URL || "http://localhost:4224",
    searchServerUrl: import.meta.env.VITE_SEARCH_SERVER || "http://localhost:4224",
};

let config: RuntimeConfig = { ...buildTimeDefaults };

export function getRuntimeConfig(): RuntimeConfig {
    return config;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    // Relative to the app's base, so this works under any prefix the explorer
    // is mounted at without knowing what that prefix is.
    const url = new URL("config.json", document.baseURI).toString();

    try {
        const response = await fetch(url, { cache: "no-store" });

        if (!response.ok) {
            return config;
        }

        const served = await response.json();

        config = {
            gatekeeperUrl: served.gatekeeperUrl || buildTimeDefaults.gatekeeperUrl,
            searchServerUrl: served.searchServerUrl || buildTimeDefaults.searchServerUrl,
        };
    }
    catch {
        // Serving config is best effort: an older server without the endpoint,
        // or a transient failure, leaves the build-time values in place rather
        // than blocking the app from starting.
    }

    return config;
}
