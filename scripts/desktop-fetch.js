// MoeBot desktop: run cross-origin requests from Rust instead of the webview.
//
// The console is served from http://tauri.localhost, so every call to the user's
// backend is cross-origin. app.js sends Authorization plus X-CF-* headers, which
// makes the browser send a CORS preflight first, and backends only list their own
// browser origins in ADMIN_ALLOWED_ORIGINS -> the preflight is answered with 403,
// no Access-Control-Allow-Origin comes back, and the browser refuses to hand the
// response to the page. app.js can only report "无法连接后端或请求超时", which is
// exactly what a correctly configured token + address looks like.
//
// tauri-plugin-http performs the same request with reqwest, outside the browser
// security model: no preflight, and no Origin header either, as long as we ask for
// it. The plugin appends the webview origin to every request unless the caller
// passes an empty Origin, which makes it drop the header (see `stripOrigin`).
//
// Two things must never be proxied:
//   * Tauri's own IPC. `ipc-protocol.js` sends every command over window.fetch to
//     `convertFileSrc(cmd, 'ipc')` -> http://ipc.localhost/<cmd>. Routing those
//     through reqwest fails the plugin's scope check, and Tauri then silently
//     falls back to the slow postMessage path for the whole session.
//   * same-origin, bundled assets, blob: and data: URLs.
//
// Inject this in <head> without `defer` so it is installed before app.js runs.

(function () {
  var tauri = window.__TAURI__;
  var rustFetch = tauri && tauri.http && tauri.http.fetch;
  var nativeFetch = window.fetch.bind(window);

  // small handle so a debugger can tell whether the shim is live
  window.__moebotProxy = {
    active: typeof rustFetch === 'function',
    proxied: 0,
    skipped: 0,
    lastError: '',
  };
  if (typeof rustFetch !== 'function') return;

  // Tauri hosts its own plumbing on these names (IPC, the app bundle, assets).
  var reserved = { 'ipc.localhost': 1, 'tauri.localhost': 1, 'asset.localhost': 1 };

  function describe(error) {
    return String(error && error.message ? error.message : error);
  }

  function targetOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch (error) {}
    return '';
  }

  // Returns the URL to proxy, or null when the native path must handle it.
  function plan(input) {
    var raw = targetOf(input);
    if (!raw) return null;
    var url;
    try {
      url = new URL(raw, window.location.href);
    } catch (error) {
      return null;
    }
    // ipc:, tauri:, asset:, data:, blob:, ... stay native
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (reserved[url.hostname]) return null;
    if (url.origin === window.location.origin) return null;
    return url.href;
  }

  // tauri-plugin-http appends Origin: <webview origin> to everything it sends.
  // An empty Origin is the documented way to remove it (commands.rs:365), because
  // a backend sees a foreign Origin as a browser CORS request and rejects it.
  function stripOrigin(init) {
    var next = {};
    for (var key in init) {
      if (Object.prototype.hasOwnProperty.call(init, key)) next[key] = init[key];
    }
    var headers;
    try {
      headers = new Headers(next.headers === undefined ? undefined : next.headers);
    } catch (error) {
      headers = new Headers();
    }
    headers.set('origin', '');
    next.headers = headers;
    return next;
  }

  function abortError(signal) {
    if (signal && signal.reason instanceof Error) return signal.reason;
    return new DOMException('The operation was aborted.', 'AbortError');
  }

  // The plugin cancels a request that has not been sent yet, but reqwest keeps
  // running once it is on the wire, so the promise can outlive the caller's
  // AbortSignal.timeout(). Settle the promise ourselves instead of hanging the UI.
  function withAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise(function (resolve, reject) {
      var settled = false;
      function onAbort() {
        if (settled) return;
        settled = true;
        reject(abortError(signal));
      }
      signal.addEventListener('abort', onAbort);
      promise.then(function (value) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  function track(promise) {
    return promise.catch(function (error) {
      window.__moebotProxy.lastError = describe(error);
      throw error;
    });
  }

  window.fetch = function (input, init) {
    // A Request object carries its own method and body; proxying would need to
    // read the body asynchronously, so leave those calls alone rather than send a
    // GET without the intended payload.
    if (input instanceof Request) {
      var planned = plan(input);
      if (planned) window.__moebotProxy.skipped += 1;
      return nativeFetch(input, init);
    }
    var target = plan(input);
    if (!target) return nativeFetch(input, init);
    window.__moebotProxy.proxied += 1;
    var signal = init && init.signal;
    var result;
    try {
      result = rustFetch(target, stripOrigin(init));
    } catch (error) {
      window.__moebotProxy.lastError = describe(error);
      throw error;
    }
    return track(withAbort(Promise.resolve(result), signal));
  };
})();
