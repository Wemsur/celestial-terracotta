# 陶瓦联机 · Celestial Terracotta

为 [Celestial Launcher](https://github.com/) 提供的联机插件，接入 [陶瓦（Terracotta）](https://github.com/burningtnt/Terracotta) 实现免端口转发的 Minecraft 联机。

开一个局域网世界即可生成房间号分享给朋友，或输入房间号加入别人的世界。底层由陶瓦 + EasyTier 中继网络打洞，无需公网 IP、无需路由器端口映射。

## 功能

- 一键开房，自动生成房间号
- 输入房间号加入他人世界
- 房间成员实时显示
- 首次使用自动下载陶瓦程序（从 GitHub / Gitee 择优）
- 可选在左侧导航栏显示"联机"页面、在右侧边栏显示联机卡片

## 安装

**方式一：插件商店**（推荐）
在启动器的插件管理里搜索"陶瓦联机"并安装。

**方式二：手动**
把本仓库的 `index.js` 和 `manifest.json` 放进启动器插件目录：

```
%AppData%\CelestialLauncher\plugins\cn.terracotta.celestial\
```

放好后重启启动器或在插件页热重载。

## 权限说明

| 权限 | 用途 |
|------|------|
| `style` | 注入卡片/页面样式 |
| `slot:sidebar.after-account` | 在右侧边栏账户下方显示联机卡片 |
| `slot:navbar.bottom` | 在左侧导航栏底部显示联机入口 |
| `route` | 注册独立的联机页面路由 |
| `storage` | 记住上次使用的玩家名 |
| `sidecar` | 启动并控制本地陶瓦进程 |
| `lan` | 加入成功后向本机局域网广播，让游戏识别到房间 |
| `hostapi:auth.default_username` | 读取当前登录账户名作为默认玩家名 |
| `network:github.com` / `network:api.github.com` / `network:gitee.com` | 下载陶瓦程序 |

## 设置项

| 设置 | 默认 | 说明 |
|------|------|------|
| 在左侧栏显示联机页面 | 开 | 是否在导航栏显示联机图标 |
| 在右侧栏显示联机卡片 | 开 | 是否在边栏账户下方显示卡片 |
| 中继节点 | zkitefly EU 节点 | 陶瓦使用的公共中继节点，每行或用逗号分隔一个，一般保持默认即可 |

## 注意事项

- **两端都要装**：房主和加入方都需要在各自启动器里安装本插件（或用其他陶瓦客户端）。
- **代理会干扰**：Clash / TUN 等系统代理可能拦截非 443 端口的中继连接，联机失败时先尝试关闭代理。
- **中继可达性**：公共中继节点偶尔不可用，可在设置里换成其他可用节点。
- 首次开房/加入会下载陶瓦程序，请保持网络畅通。

## 致谢

- [Terracotta](https://github.com/burningtnt/Terracotta) by burningtnt
- [EasyTier](https://github.com/EasyTier/EasyTier) 中继网络
- 公共中继节点由 [zkitefly](https://etnode.zkitefly.eu.org/) 提供
