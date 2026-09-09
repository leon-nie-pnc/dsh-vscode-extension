# DeepSeek Harness Chat — VSCode 插件

在 VSCode 面板里打开 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 聊天界面 —— 类似 GitHub Copilot Chat，但后端是本地启动的 `dsh web` 进程。

> Open the DeepSeek Harness web chat inside a VSCode panel — like GitHub Copilot Chat, but backed by a locally spawned `dsh web` process.

## 工作原理 / How it works

插件把 `dsh web --host 127.0.0.1 --port 3080` 作为本地子进程启动，并通过 `<iframe>` 把它的 Web UI 嵌入到 VSCode 面板视图里。完整的 harness UI（聊天、工具审批、计划、轨迹、会话、技能）原样复用。

两个细节保证它稳定工作：

- **鉴权代理 / Auth proxy**：`dsh web` 用 `SameSite=Strict` 的 cookie 保护 `/` 和 `/api`。webview 的 iframe 相对父页面 `vscode-webview://` 是跨站的，浏览器不会带这个 cookie，直连会一直 401。插件因此在本地起一个鉴权反向代理（`src/dsh-proxy.ts`）：它在 Node 侧用 `?token=` 换一次 cookie，之后每个转发请求都注入 cookie，并把 `Host`/`Origin` 改写成上游 authority（`/api` 的 CSRF 围栏要求 Origin 等于 Host）。iframe 加载的是代理地址，自身无需任何 cookie。
- **端口自愈 / Port reclaim**：spawn 之前，插件会先"抢回"配置端口——杀掉上次窗口重载遗留、仍占着端口的孤儿 `dsh web`，避免新进程 `EADDRINUSE` 崩溃。

## 一键安装 / One-click install

> **前置要求 / Prerequisites**: [Node.js](https://nodejs.org) 22.19+（或 24+）、VSCode，以及 VSCode 的 `code` 命令行工具（VSCode 里执行 `Shell Command: Install 'code' command in PATH`）。

克隆本仓库后运行对应脚本，它会自动：安装 `dsh` 后端 → 构建插件 → 装进 VSCode。

**macOS / Linux**

```sh
git clone https://github.com/leon-nie-pnc/dsh-vscode-extension.git
cd dsh-vscode-extension
./install.sh
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/leon-nie-pnc/dsh-vscode-extension.git
cd dsh-vscode-extension
./install.ps1
```

安装脚本做了这些事：

1. 校验 Node.js 版本和 `code` 命令；
2. `npm i -g @deepseek-ai/dsh` 安装 harness 后端；
3. 从源码构建出 `dsh-chat.vsix`；
4. `code --install-extension` 装入 VSCode。

### 配置 API Key / Configure the API key

harness 需要 DeepSeek API Key 才能调用模型。按以下顺序读取：进程环境变量 → 工作区 `.env` → `~/.dsh/.env`。推荐写入 `~/.dsh/.env` 做持久化：

```sh
mkdir -p ~/.dsh
echo 'DEEPSEEK_API_KEY=sk-...' >> ~/.dsh/.env
```

装好后：打开底部面板，选择 **DeepSeek Harness** 标签页；或在命令面板运行 **DSH: Open chat panel**。

## 直接安装预构建的 .vsix / Install a prebuilt .vsix

如果不想在本地构建，可到本仓库的 [Releases](https://github.com/leon-nie-pnc/dsh-vscode-extension/releases) 下载 `dsh-chat.vsix`，然后：

```sh
npm i -g @deepseek-ai/dsh
code --install-extension dsh-chat.vsix
```

## 设置 / Settings

| Key | 默认值 | 含义 |
|---|---|---|
| `dsh.binPath` | `""` | `dsh` 可执行文件的绝对路径（覆盖 env/PATH） |
| `dsh.host` | `127.0.0.1` | 绑定地址（仅支持 `127.0.0.1`） |
| `dsh.port` | `3080` | 绑定端口 |
| `dsh.extraArgs` | `[]` | 追加给 `dsh web` 的额外参数 |

`dsh` 可执行文件的解析顺序：`dsh.binPath` 设置 → `DSH_BIN` 环境变量 → `PATH` 上的 `dsh`。

## 命令 / Commands

- **DSH: Start server** — 启动（或接管）`dsh web` 进程
- **DSH: Restart server** — 停掉本插件启动的进程并重启
- **DSH: Stop server** — 停掉本插件启动的进程
- **DSH: Open in browser** — 在系统浏览器里打开同一个聊天界面

## 开发 / Development

```sh
npm install
npm run compile          # 把 src/extension.ts 打包成 dist/extension.js
npm run package          # 构建 .vsix
```

在本文件夹按 **F5** 可启动 Extension Development Host 调试。

## 对着本地 harness 源码开发 / Develop against a local harness checkout

上面的 `install.sh` 用的是 npm 发布版 `@deepseek-ai/dsh`。若要对着**本地 harness 源码检出**跑（改一行 harness 源码就能立即在插件里看到效果），用下面这套。它假设 harness 检出在 `../harness/deepseek-harness`，可用环境变量 `DSH_HARNESS_REPO` 覆盖。

### 1. 让 `dsh.binPath` 指向源码 launcher

本仓库带一个 `bin/dsh-source`，它 `cd` 进 harness 检出后用 tsx 直接跑源码（`node --import tsx/esm apps/cli/src/bin.ts`），无需全局安装 `dsh`。在 VSCode 用户设置里：

```jsonc
"dsh.binPath": "/absolute/path/to/dsh-vscode-extension/bin/dsh-source"
```

launcher 放在**本仓库**（而不是 harness 工作树内），这样对 harness 做 `git stash` / revert 时不会把插件依赖的 launcher 一起删掉。换检出目录用 `DSH_HARNESS_REPO=/path/to/deepseek-harness` 覆盖。

### 2. 一键脚本 / One-touch scripts

| 脚本 | 做什么 | 何时用 |
|---|---|---|
| `./dev-setup.sh` | 建 harness 产物（缺才建）→ 腾出 3080 → 编译打包 `dsh-chat.vsix` → `code --install-extension` | 改了**插件源码**，或首次安装源码开发版 |
| `./dev-setup.sh --rebuild-harness` | 强制 `pnpm run clean && build` 后再打包安装 | 切了分支 / 报 `MissingClientBundleError` |
| `./dev-setup.sh --skip-harness` | 跳过 harness 构建，只重打包安装插件 | 只改了插件、确定 harness 已是最新 |
| `./restart-dsh.sh` | 腾出 3080 + 重建 harness（失败自动 clean 重建），不占端口 | 只改了 **harness 源码**、想让插件下次 spawn 用上 |

两个脚本都**不启动服务器**（服务器由插件自己在打开面板时 spawn），只负责构建/安装与腾端口。跑完在 VSCode 里：

```
Ctrl+Shift+P → Developer: Reload Window
```

即可让插件用最新代码重新 spawn。**单纯"重启插件"不必跑脚本，直接 Reload Window 或 `DSH: Restart server` 即可**——脚本只在改了代码需要重新构建时才用。

harness 缺构建产物时脚本会自动 `pnpm run build`；日常别让源码 dev server 连跑很多天，跑久了 + 中途动过构建产物容易出现「进程活着但交互失效」，此时重建 + Reload 即可。

## 已知限制 / Known limitations

- iframe 通过本地鉴权代理加载，代理端口每次启动随机分配，因此以「源」为作用域的浏览器端状态（如「当前会话」选择、UI 偏好）在 VSCode 重启后可能不保留；会话数据本身存在后端，不会丢失。
- app 若对 harness 使用**绝对 URL**（指向 `127.0.0.1:<上游端口>` 而非相对路径）会绕过代理、丢失注入的 cookie；插件依赖 app 用同源相对请求。
- 仅支持桌面版 VSCode —— 本地子进程、loopback HTTP 与鉴权代理都假设插件与 harness 在同一台机器上。

## 许可 / License

MIT。本插件是对上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的独立封装，harness 后端通过 npm 包 `@deepseek-ai/dsh` 获取。
