// Wails v2 does not stream response bodies through its asset server on
// Windows. Route ALL three JSON/SSE endpoints through a native loopback
// HTTP server, keeping the existing fetch contract unchanged.
type NativeBridge = {
 APIBaseURL: () => Promise<string>;
 AuthToken: () => Promise<string>;
};
declare global {
 interface Window { go?: { main?: { Bridge?: NativeBridge } } }
}
const nativeFetch = window.fetch.bind(window);
let bridgeInfo: Promise<{base: string; token: string}> | undefined;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
 const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
 if (!path.startsWith('/api/openai/')) return nativeFetch(input, init);
 const bridge = window.go?.main?.Bridge;
 if (!bridge) return nativeFetch(input, init);
 bridgeInfo ??= Promise.all([bridge.APIBaseURL(), bridge.AuthToken()])
  .then(([base, token]) => ({base,token}));
 const {base,token} = await bridgeInfo;
 const headers = new Headers(init?.headers);
 headers.set('X-Micro-Shop-Token', token);
 return nativeFetch(base + path, { ...init, headers });
};
