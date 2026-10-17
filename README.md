# MoeBot Desktop

MoeBot（猫猫机器人）的 Windows 桌面控制台：把 MoeBot Web 控制台封装成本地应用，并支持在一台机器上管理多个机器人。

- 机器人列表保存在本机，Token 用 Windows DPAPI 加密，只有当前 Windows 用户能解密
- 侧边栏可一键在机器人之间切换，草稿随机器人独立保存
- 管理请求由 Rust 侧发出，不受浏览器 CORS 限制

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src-tauri/` | Rust 壳：窗口、机器人列表（`src/bots.rs`）、HTTP 插件、启动脚本 |
| `scripts/build-frontend.mjs` | 生成 `dist/`：复制控制台源码并按桌面端替换文案、注入脚本 |
| `scripts/desktop-shell.js` | 机器人中心、切换菜单、草稿、动效 |
| `scripts/desktop-overrides.css` | 桌面端样式与动效 |
| `scripts/desktop-fetch.js` | 在 `<head>` 早期注入的 fetch 代理（跨域请求交给 Rust） |
| `scripts/installer.iss` | Inno Setup 安装脚本 |
| `scripts/make-installer.ps1` | 构建安装包 |
| `scripts/prepare-wix.ps1` | 构建 MSI 前的 WiX 修补 |
| `dist/` | 生成物，不提交 |

## 构建

前置：Node 20+、Rust 稳定版（Windows 上使用 GNU 工具链）、[Inno Setup 6](https://jrsoftware.org/isdl.php)（只有打安装包需要）。

控制台源码默认取同级目录 `../qq-bot-webui-main/public`；仓库不在同一目录时用环境变量指定（仓库根目录或 `public` 目录都可以）：

```powershell
$env:MOEBOT_WEBUI_DIR = "D:\src\qq-bot-webui-main"
```

```powershell
npm install
npm run build          # MSI           -> src-tauri\target\release\bundle\msi\
npm run build:setup    # Inno 安装包    -> src-tauri\target\release\bundle\inno\
```

`build:setup` 默认把 Microsoft Edge WebView2 引导程序一起打进安装包（装到没有 WebView2 的机器上不需要联网），加 `-SkipWebView2Bundle` 可以不打包、改为安装时下载。

## 两个实现要点

**管理请求为什么走 Rust。** 桌面端页面来源是 `http://tauri.localhost`，相对后端一律是跨域；`app.js` 又带 `Authorization` / `X-CF-*` 请求头，会先触发预检，而后端的 `ADMIN_ALLOWED_ORIGINS` 只列自己的浏览器来源，于是预检返回 403、响应里没有 `Access-Control-Allow-Origin`，页面只能报「无法连接后端或请求超时」。因此跨域请求改由 `tauri-plugin-http` 在 Rust 侧发出：没有预检，也没有 CORS。

**为什么要把 Origin 删掉。** 插件默认会给每个请求补上页面来源作为 `Origin`（`tauri-plugin-http` 的 `commands.rs:350`），后端仍会按跨域来源拒绝；所以 `desktop-fetch.js` 传一个空 `Origin`，插件就会移除该请求头（同文件 `365` 行起，需要 `unsafe-headers` 特性），后端看到的是一个普通的非浏览器客户端请求。

另外，`desktop-fetch.js` 只代理跨域的 http(s) 请求：Tauri 自己的 IPC 也用 `window.fetch`（`http://ipc.localhost/...`），拦下来会让它退回慢速通道。

## 许可

AGPL-3.0-only，见 [LICENSE](LICENSE)。
