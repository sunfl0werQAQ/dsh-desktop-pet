# 大肥鱼桌宠 · 本地端（Standalone）

一只**不需要运行 DSH、不需要浏览器、不联网**的 Windows 桌面宠物。

> ## 致谢 / Credits
>
> 本项目的**全部动画素材、渲染逻辑与物理引擎**都来自
> **[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)**（MIT License，Copyright (c) 2026 powerycy）。
>
> 上游作者做出了这只可爱的桌宠并慷慨开源，本项目只是在它之上补了一个
> 「脱离 DSH 独立运行」的启动器。**特此致谢！**
> 如果你喜欢这只桌宠，请去上游仓库点个 ⭐，也欢迎给它反馈问题。
>
> This project is a derivative work of [dsh-pet](https://github.com/PC2005-cloud/dsh-pet).
> All animation assets, rendering logic and physics come from the upstream project.
> Huge thanks to its author.

---

## 它解决了什么问题

`dsh-pet` 原本是 DSH（DeepSeek Harness）的一个插件：需要 **DSH 宿主进程**拉起 Electron 透明窗口，
才能看到桌面宠物。DSH 不开，桌宠就没有。

本项目保留了上游的 helper 与素材，另加一个 `app/bootstrap.js`，让它可以完全独立运行：

1. 在 `127.0.0.1` 随机端口起一个小 HTTP 服务，提供与 DSH 宿主**同形**的
   `/dsh-pet-7340/*` 端点（`config` / `thumb` / `font` / `pic`）；
2. 注入 `DSH_PET_CONFIG_URL` / `DSH_PET_PETS`，并删除 `DSH_PET_BRIDGE`
   —— 走上游「**没有 bridge 时，渲染端直接 HTTP 访问**」的那条回退通道；
3. **不注入 `DSH_PET_HOST_PID`** —— 上游 helper 的「宿主没了就自杀」探测因此被跳过
   （源码里 `parseHostPid` 返回 0 即不做探测）；
4. 补了一个**系统托盘**，提供退出入口（脱离 DSH 后没有宿主能关它了）。

> 上游的 Electron helper 主进程与渲染端代码**一行未改**，只新增了启动器。
> 原理依据全部来自上游源码注释与既有行为，没有猜测。

## 功能

**有：**

- 106 个手绘风透明动画（待机呼吸、左右转向、随机动作、分类动作池）
- 点击互动、拖拽跟手、甩抛抛物线飞行、屏幕边缘反弹
- 屏幕漫游（多屏按各自工作区判定，不会走出屏幕）
- 右键动作点播菜单（分类 → 具体动画）
- 系统托盘：隐藏 / 显示 / 打开日志 / 退出
- **DSH 优先守卫**（见下节）

**没有：**

- 余额动画与余额气泡、碎碎念、AI 对话、工作状态联动

  这四项依赖 DSH 的 LLM 与 provider 凭据，独立运行无法提供，已在配置中关闭；
  需要的请安装上游的 dsh-pet 插件。

## DSH 优先守卫

如果本机同时也装了 DSH 的 dsh-pet 插件，两个桌宠会打架。本启动器内置守卫：

| 情况 | 行为 |
|---|---|
| DSH 在运行，且那边**确实会显示桌面桌宠** | 本地端自动隐藏，让位给 DSH |
| DSH 没开，或那边不显示桌面桌宠 | 本地端自动出现，接管 |
| 每次 DSH「调出」时 | 对齐一次宠物尺寸：相同则**不刷新**，不同则立即刷新 |

判定条件不是「DSH 进程在不在」，而是「**DSH 那边是否真的会显示桌宠**」——
所以即使 DSH 开着但插件没装、或被设成只在浏览器显示，本地端也会顶上，不会出现两边都空的空档。

### 端口探测：多端口 + 自动发现

DSH 的监听端口并不固定（`npx dsh web` 默认 **3080**，桌面版默认 **19387**）。
守卫按三层顺序去找它，**你不需要手改配置**：

1. **配置的端口列表** `guard.dshPorts`，默认 `[3080, 19387]` —— 命中即用，毫秒级；
2. **自动发现**：列表里的端口都没有活跃 DSH 时，用 `netstat` 列出本机全部 TCP 监听端口，
   并发探测每个端口的 pet 端点，找到就认（限频 60 秒一次，只记内存、不写回你的配置）；
3. **记忆**：自动发现的端口会加入本次运行的优先列表，后续轮询直接命中。

> 实测：把 `dshPorts` 故意配成不存在的 `[9999]`，仍能在 **9 ms** 内自动发现 3080 并正确让位，
> 期间本地端不会闪现。

关闭守卫：把 `app/pets.json` 里的 `guard.enabled` 设为 `false`。

## 运行方法

需要 **Windows x64** + **Electron 运行时**（本仓库不含运行时，因为它有 300+ MB）。

### 方式一：一键脚本（推荐）

```powershell
.\setup.ps1
```

脚本会自动：从 npmmirror 下载 Electron 43.3.0 → 解压 → 把 `app/` 放进 `resources/app/`
→ 把 `electron.exe` 改名为 `大肥鱼桌宠.exe`。完成后双击 `runtime\大肥鱼桌宠.exe` 即可。

### 方式二：手动

1. 下载 Electron 43.3.0（Windows x64）：
   `https://npmmirror.com/mirrors/electron/43.3.0/electron-v43.3.0-win32-x64.zip`
2. 解压到任意目录
3. 把本仓库的 `app/` 整个复制进去，成为 `<解压目录>\resources\app\`
4. 双击 `electron.exe`

### 开机自启（可选）

```
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run  →  "<路径>\大肥鱼桌宠.exe"
```

用户级，不需要管理员权限。

## 配置

`app/pets.json`：

```json
{
  "guard": {
    "enabled": true,
    "dshHost": "127.0.0.1",
    "dshPorts": [3080, 19387],
    "pollMs": 3000
  },
  "pets": [
    {
      "id": "main",
      "size": 462,
      "display": "desktop",
      "position": { "corner": "bottom-right", "marginX": 24, "marginY": 100 }
    }
  ]
}
```

- `size`：宽度像素（高度自动按 9:16 计算）
- `position.corner`：`top-left` / `top-right` / `bottom-left` / `bottom-right`
- `guard.dshPorts`：要探测的 DSH 端口列表，默认 `[3080, 19387]`。
  都探测不到时守卫会自动发现（见上节）。旧的单值写法 `"dshPort": 3080` 仍然有效，会被当作单元素列表。
- 想同时显示多只：往 `pets` 数组里加项，`id` 不能重复

动画池、播放权重、事件动画等进阶配置沿用上游格式（见 `app/assets/config.jsonc`）。

## 目录结构

```
app/                      ← 复制到 Electron 的 resources/app/
├─ bootstrap.js           ← 本项目新增：独立运行启动器
├─ package.json           ← 入口指向 bootstrap.js
├─ pets.json              ← 本项目新增：宠物配置（含守卫配置）
├─ main.js                ← 上游：Electron 主进程
├─ index.html / preload.js / renderer.js / sprite.js / events.js
├─ constants.js / shared-core.js / host-liveness.js / pointer-target.js
└─ assets/
   ├─ webm/      106 个动画素材
   ├─ fonts/     上首软糖体
   ├─ pic/       光标与通知图标
   └─ config.jsonc
setup.ps1                 ← 一键组装脚本
```

## 许可与归属

| 部分 | 许可 |
|---|---|
| 本项目新增（`bootstrap.js`、`pets.json`、文档、`setup.ps1`） | MIT |
| 上游 dsh-pet 的 helper 代码与全部素材 | MIT，Copyright (c) 2026 powerycy |

详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

**本项目是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的衍生作品，不是官方项目。**
原始著作权归其作者所有；若上游作者认为本仓库有任何不妥，请联系后我会立即调整或撤下。
