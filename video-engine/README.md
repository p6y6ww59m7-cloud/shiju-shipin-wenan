# 拾句视频文案 · 视频引擎

本目录包含工作台实际使用的视频下载与本地口播转写源码。完整工作台的安装和使用说明见[项目首页](../README.md)。

## 能力

- 支持抖音、YouTube、B站、快手、X / Twitter 分享链接。
- 自动下载目标作品，验证时长、画面和音轨；已有完整文件可以复用。
- YouTube 使用 yt-dlp 的原生 DASH 分段与最多 8 个分段并发，优先保留最高可用 MP4 与原始声音；仅合并或重新封装，不重编码。
- 抖音和快手通过独立 Chrome 会话识别当前作品资源；需要登录或验证时提示用户完成。
- 转文字须逐条勾选，使用完整 Whisper large-v3 FP16 和 Silero VAD，输出 TXT、SRT、JSON。
- 两个本地入口可连接同一视频服务，避免重复处理任务和竞争写入历史。

## 文件

| 文件 | 用途 |
| --- | --- |
| `server.mjs` | 本地接口、队列和历史 |
| `browser.mjs` | 独立 Chrome 会话与平台登录 |
| `platforms.mjs`、`core.mjs` | 链接识别、资源匹配与保存 |
| `downloader.mjs`、`proxy-discovery.mjs` | 下载进程、分段并发与本机代理发现 |
| `transcription.mjs` | 本地语音识别及字幕输出 |
| `native/*.swift` | 媒体校验、音频准备与桌面入口源码 |
| `scripts/setup_runtime.py` | 按固定版本和 SHA256 安装运行资源 |
| `runtime-manifest.json` | 模型与下载工具清单 |
| `test/` | 自动测试 |

下载器默认只保存目标视频，不获取播放列表。转写与下载分别排队。缺失分段、时长异常、音轨缺失或合并失败时不会发布不完整文件。

网络自动模式复用用户已有代理；显式网络设置优先。本工具不修改系统网络优先级。下载速度受网络出口、代理线路和平台限制影响。

## 安装与检查

建议在项目根目录执行：

```bash
npm run setup:video
npm run verify:video
npm test
```

第三方工具包括 yt-dlp、FFmpeg 与 whisper.cpp。来源、版本和校验值保存在资源清单中，许可证保存在 `native/vendor/`。本目录内的运行时二进制和模型由安装脚本获取。

浏览器资料、Cookie、会话令牌、历史、配置、媒体和转写文件属于本地私人数据，不提交到公开仓库。
