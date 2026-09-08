# DeepSeek Harness Chat — VSCode 插件

在 VSCode 面板里打开 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 聊天界面 —— 类似 GitHub Copilot Chat，但后端是本地启动的 `dsh web` 进程。

> Open the DeepSeek Harness web chat inside a VSCode panel — like GitHub Copilot Chat, but backed by a locally spawned `dsh web` process.

## 工作原理 / How it works

插件把 `dsh web --host 127.0.0.1 --port 3080` 作为本地子进程启动，并通过 `<iframe>` 把它的 Web UI 嵌入到 VSCode 面板视图里。完整的 harness UI（聊天、工具审批、计划、轨迹、会话、技能）原样复用。

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

## 已知限制 / Known limitations

- webview 是跨源 iframe，浏览器的第三方存储分区策略可能导致「当前会话」选择和 UI 偏好在 VSCode 重启后不保留；会话数据本身存在后端，不会丢失。
- 仅支持桌面版 VSCode —— 本地子进程和 loopback HTTP 假设插件与 harness 在同一台机器上。

## 许可 / License

MIT。本插件是对上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的独立封装，harness 后端通过 npm 包 `@deepseek-ai/dsh` 获取。
