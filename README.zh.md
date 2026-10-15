# dsh-app-restart

在 DeepSeek Harness 桌面应用端的**设置**里新增一个"重启应用"区块，并提供一个带二次确认的按钮，用于重启整个应用 —— 包括 Electron 壳、它承载的 Web GUI，以及 cordis Host 进程。

[English](README.md) | 中文

## 功能说明

- 设置页新增"应用重启"区块，说明重启行为，并显示当前环境是否支持。
- 按钮采用两步确认（先点击、再确认），避免误触。
- 重启 = **优雅退出 + 自动重启**：
  1. 先启动一个分离（detached）的 relauncher 辅助进程，等待应用主进程退出后重新打开应用包；
  2. 插件通过平台正常的退出路径请求退出 —— macOS 上是 Quit Apple Event，应用壳会把它当作用户按了 Cmd+Q 一样处理，包括"有进行中任务"的确认对话框；
  3. 若用户在对话框里取消，relauncher 超时后的最后一步 `open` 只会把仍在运行的应用调到前台 —— 无副作用。

Electron 壳没有给插件提供重启 IPC（`app.relaunch()` 仅主进程可用），因此重启由 Host 进程在操作系统层面编排，**无需改动 DSH 源码**。

## 安装

### 从 GitHub 安装（一条命令）

```sh
dsh plugin --profile desktop add "https://github.com/foreee/dsh-app-restart"
```

Web 端**插件**页面按地址安装也填这个链接。

### 手动等价操作

与插件管理器行为一致的两步：

```sh
cd ~/.dsh/profiles/desktop
pnpm add "file:/插件目录的绝对路径"   # 或上面的 GitHub 地址
# 然后在 package.json 的 dsh.profile.bundles 里加入 "dsh-app-restart"
```

安装后重启一次桌面应用即可加载插件，此后设置页会常驻该区块。

## 路由

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `api/dsh-app-restart/status` | GET | 按钮所需的支持状态信息 |
| `api/dsh-app-restart/restart` | POST | 执行重启 |

两个路由都位于仅限回环（loopback-only）的信任围栏之后（回环 socket 地址 **且** 回环 Host 头，并校验同源标记）。已配对的远程设备会被刻意拒绝：只有本机自己的 GUI 才能重启应用。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 时不挂载任何内容 |
| `dryRun` | `false` | `POST /restart` 只返回计算出的计划、不启动任何进程 —— 用于验证 |

## 平台支持

| 平台 | 退出方式 | 重启方式 | 状态 |
| --- | --- | --- | --- |
| macOS | Quit Apple Event（先按 bundle id，再按应用名） | 主进程退出后 `open <应用包>` | 主要目标 |
| Windows | `taskkill /PID`（优雅 WM_CLOSE） | 主进程退出后 PowerShell `Start-Process` | 尽力而为；若应用无法被优雅关闭，relauncher 会在下次手动退出后将其重新打开 |
| Linux | `SIGTERM` | 主进程退出后 `nohup <可执行文件>` | 尽力而为 |

插件会拒绝在开发版 Electron 检出（可执行文件旁没有 `app.asar`，或 bundle id 为通用的 `com.github.Electron`）上工作 —— 重启一个通用 Electron 二进制并不能启动 DSH。

## 开发

客户端半边（`lib/client.js`）是手写的 `window.__ModuleLoader__` bundle —— 与官方客户端插件经 tsdown 产出的形态一致 —— 因此无需构建步骤；改完重新安装即可。

```sh
# 一次性测试环境（刻意不进插件 manifest）
npm i react@18.3.1 react-dom@18.3.1 react-test-renderer@18.3.1 --prefix test/react-env --cache test/react-env/.npm-cache

node test/plan.test.mjs        # 重启计划构建 + 信任围栏
node test/client.test.mjs      # 浏览器端 bundle：注册 + 交互流程
node test/host-routes.test.mjs # Host 路由：守卫、状态、dry-run、卸载
```

## 许可

[MIT](LICENSE)
