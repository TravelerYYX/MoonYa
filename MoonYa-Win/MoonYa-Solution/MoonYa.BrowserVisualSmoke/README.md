# 内置浏览器指针与光效验收

此程序直接编译生产浏览器宿主、指针覆盖层、自动化服务及语音光效源码。使用独立 CEF 缓存和随机本机端口，测试页面只含本地夹具，不启动 MoonYa 的其他服务，也不关闭已有客户端或其 CEF 子进程。

```powershell
dotnet build MoonYa-Win/MoonYa-Solution/MoonYa.BrowserVisualSmoke
& MoonYa-Win/MoonYa-Solution/MoonYa.BrowserVisualSmoke/bin/Debug/net8.0-windows10.0.19041.0/MoonYa.BrowserVisualSmoke.exe D:/Project/Project/MoonYa <可运行客户端的CEF运行库目录>
```

第二个参数须指向具有完整 CEF 运行库的客户端输出目录，包括 `libcef.dll`、`CefSharp.BrowserSubprocess.exe`、`Ijwhost.dll` 和 `locales`。程序显式配置该目录的 DLL 搜索路径；不安装运行库。增加 `--hold` 可在自动检查结束前保留原生窗口 90 秒，供用户鼠标接管验收。

覆盖点击、输入、悬停、复选框、下拉选择、iframe、屏幕外目标、缩放、面板尺寸、手动/AI 标签切换、收起展开、会话结束、关闭及重置、旧坐标拒绝、CDP/OSR 截图隔离和原语音光效资源加载。当前显示器的 DPI 会用于尺寸检查；跨显示器 DPI 切换还需实际显示器验收。

启动时占用一个系统分配的端口作为配置端口，调用生产端口选择器避开占用，并在独立面板 profile 下直接启动自动化会话。验证首次自动创建面板、发现端点、连接和导航，以及离开起始页后重新发现面板；不会预先手动打开面板。

截图输出到 `artifacts/browser-visuals/verification`。标签来源和坐标世代回归测试另见 `MoonYa-Frontend/tests/browser-visuals.test.mjs`，已纳入前端 `npm test`。

指针资源从用户提供的 75×53 截图提取，裁切原图 `(28,17)` 起的 22×23 像素区域，以背景色和黑白前景分离透明度，保留箭头和白色描边。定位点为资源内 `(3,3)`；显示时转换为物理像素对应的 DIP，不随网页缩放改变大小。指针旁和浏览器四边光效均引用 `SharedGlowResources.xaml`。
