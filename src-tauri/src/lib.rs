use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::window::Color;
use tauri::WebviewUrl;

mod bots;

const APP_TITLE: &str = "猫猫机器人（MoeBot）";
const THEME_BG: Color = Color(23, 109, 88, 255);

const BOOT_SCRIPT: &str = r##"
(function () {
  try {
    var PURGED_KEY = 'moebot-desktop-sw-purged';
    if (navigator.serviceWorker) {
      try {
        navigator.serviceWorker.register = function () {
          return Promise.reject(new Error('service worker disabled in desktop build'));
        };
      } catch (e) {}
    }
    var hadWork = false;
    var chain = Promise.resolve();
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      chain = chain.then(function () {
        return navigator.serviceWorker.getRegistrations().then(function (regs) {
          if (regs && regs.length) hadWork = true;
          return Promise.all((regs || []).map(function (reg) { return reg.unregister(); }));
        });
      });
    }
    if (window.caches && caches.keys) {
      chain = chain.then(function () {
        return caches.keys().then(function (keys) {
          if (keys && keys.length) hadWork = true;
          return Promise.all((keys || []).map(function (key) { return caches.delete(key); }));
        });
      });
    }
    chain.then(function () {
      if (!hadWork) return;
      var seen = false;
      try { seen = sessionStorage.getItem(PURGED_KEY) === '1'; } catch (e) {}
      if (seen) return;
      try { sessionStorage.setItem(PURGED_KEY, '1'); } catch (e) {}
      location.reload();
    }).catch(function () {});
  } catch (err) {}
})();

(function () {
  try {
    if (window.__moebotSplashReady) return;
    window.__moebotSplashReady = true;

    var STYLE = [
      '#moebot-splash{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;',
      'background:radial-gradient(130% 120% at 50% -10%,#1f8a6c 0%,#176d58 46%,#0f4e40 100%);color:#fff;',
      "font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;",
      'opacity:1;transition:opacity .4s ease;will-change:opacity}',
      '#moebot-splash.mb-out{opacity:0;pointer-events:none}',
      '#moebot-splash .mb-badge{width:98px;height:98px;border-radius:28px;display:flex;align-items:center;justify-content:center;',
      'background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.20);box-shadow:0 20px 44px rgba(0,0,0,.30);',
      'animation:mb-breathe 2.4s ease-in-out infinite}',
      "#moebot-splash .mb-name{font-size:22px;font-weight:700;letter-spacing:.01em;line-height:1;text-align:center}",
      '#moebot-splash .mb-name small{display:block;margin-top:9px;font-size:10px;font-weight:600;letter-spacing:.44em;opacity:.70;text-transform:uppercase;padding-left:.44em}',
      '#moebot-splash .mb-ring{width:26px;height:26px;border-radius:50%;border:3px solid rgba(255,255,255,.22);border-top-color:#fff;animation:mb-spin .85s linear infinite}',
      '@keyframes mb-spin{to{transform:rotate(360deg)}}',
      '@keyframes mb-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-4px) scale(1.035)}}'
    ].join('');

    var CAT = '<svg viewBox="0 0 64 64" width="60" height="60" aria-hidden="true">' +
      '<g fill="#fff">' +
      '<ellipse cx="23" cy="24" rx="3.5" ry="5"/>' +
      '<ellipse cx="41" cy="24" rx="3.5" ry="5"/>' +
      '<path d="M28 33h8l-4 5Z"/>' +
      '</g>' +
      '<g fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M32 37v3m-8 1c1 6 8 6 8-1 0 7 7 7 8 1"/>' +
      '<path d="m9 31 7 2m-7 9 7-2m39-9-7 2m7 9-7-2"/>' +
      '</g></svg>';

    var HTML = '<div class="mb-badge">' + CAT + '</div>' +
      '<div class="mb-name">MoeBot<small>Web Console</small></div>' +
      '<div class="mb-ring"></div>';

    var shownAt = 0;
    var finished = false;

    function dismiss() {
      if (finished) return;
      finished = true;
      var el = document.getElementById('moebot-splash');
      if (!el) return;
      var wait = Math.max(0, 900 - (Date.now() - shownAt));
      setTimeout(function () {
        el.classList.add('mb-out');
        setTimeout(function () {
          if (el.parentNode) el.remove();
          var style = document.getElementById('moebot-splash-style');
          if (style && style.parentNode) style.remove();
        }, 440);
      }, wait);
    }

    function mount() {
      if (!document.body || document.getElementById('moebot-splash')) return;
      shownAt = Date.now();
      var style = document.createElement('style');
      style.id = 'moebot-splash-style';
      style.textContent = STYLE;
      (document.head || document.documentElement).appendChild(style);
      var el = document.createElement('div');
      el.id = 'moebot-splash';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = HTML;
      document.body.appendChild(el);
      setTimeout(dismiss, 9000);
      if (document.readyState === 'complete') {
        setTimeout(dismiss, 240);
      } else {
        window.addEventListener('load', function () { setTimeout(dismiss, 240); });
      }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  } catch (err) {}
})();
"##;

fn is_internal(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "ipc" => true,
        "http" | "https" => url
            .host_str()
            .map(|host| host == "localhost" || host.ends_with(".localhost"))
            .unwrap_or(false),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![bots::bots_load, bots::bots_save])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(APP_TITLE)
                .inner_size(1200.0, 840.0)
                .min_inner_size(760.0, 560.0)
                .center()
                .background_color(THEME_BG)
                .initialization_script(BOOT_SCRIPT)
                .on_navigation(|url| {
                    if is_internal(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                })
                .on_new_window(|url, _features| {
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
