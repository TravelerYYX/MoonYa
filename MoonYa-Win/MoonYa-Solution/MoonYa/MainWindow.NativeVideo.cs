using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using MoonYa.Services;
using CefSharp;

namespace MoonYa;

/// <summary>
/// 原生视频播放层。
///
/// 为什么必须原生播放：内嵌 Chromium 的构建不含 H.264/AAC（实测 canPlayType 返回空、
/// VideoDecoder.isConfigSupported 在三种硬件偏好下全为 false），所以页面内 &lt;video&gt; 永远播不了 mp4。
/// 进程里的 Windows Media Foundation 才是这台机器上唯一零下载的 H.264 解码器（WPF MediaPlayer 就是它）。
///
/// 为什么是 MediaPlayer + VideoDrawing + DrawingBrush 而不是 MediaElement：
/// 主窗口是非分层的 WindowChrome 窗口，MediaElement 在这种窗口走硬件 overlay，
/// Effect（模糊）会被忽略甚至黑帧；走刷子管线能正常应用 BlurEffect，而且 DrawingBrush.Stretch
/// 能精确表达 cover / contain / fill 三种填充。
///
/// 注意：本文件**故意不引 using System.Drawing** —— MainWindow.xaml.cs 里有它，
/// Rectangle / Brush / Color / Size 在两个命名空间之间会二义（CS0104）。
/// </summary>
public partial class MainWindow
{
    private NativeVideoSurface? _splashVideo;
    private NativeVideoSurface? _backgroundVideo;

    private NativeVideoSurface BackgroundVideo
    {
        get
        {
            if (_backgroundVideo != null) return _backgroundVideo;
            _backgroundVideo = new NativeVideoSurface(AppearanceBackgroundVideo);
            _backgroundVideo.Failed += message =>
            {
                LogNativeVideo("背景视频播放失败：" + message);
                if (WebView.CanExecuteJavascriptInMainFrame)
                {
                    var text = System.Text.Json.JsonSerializer.Serialize("背景视频播放失败：" + message);
                    WebView.ExecuteScriptAsync($"window.MoonYaAppearance?.nativeVideoFailed({text})");
                }
            };
            return _backgroundVideo;
        }
    }

    /// <summary>启动画面视频（懒创建：只有真的把启动画面设成视频才建播放器）。</summary>
    private NativeVideoSurface SplashVideo => _splashVideo ??= new NativeVideoSurface(LoadingOverlayVideo);

    /// <summary>启动画面背景是视频 → 交给原生播放（图片层让位，Scrim 继续压暗保证文字可读）。</summary>
    private void ShowSplashVideo(string path, string fill)
    {
        var surface = SplashVideo;
        surface.Failed -= OnSplashVideoFailed;
        surface.Failed += OnSplashVideoFailed;
        surface.Apply(path, fill, 0);
    }

    /// <summary>启动画面没有视频（图片或未设置）→ 把播放器停干净。</summary>
    private void HideSplashVideo() => _splashVideo?.Clear();

    /// <summary>启动画面淡出后停止解码，别让它在后台一直占用解码器。</summary>
    private void PauseSplashVideo() => _splashVideo?.Pause();

    private void OnSplashVideoFailed(string message)
    {
        LogNativeVideo("启动画面视频播放失败：" + message);
        // 启动画面期间前端还没起来，弹不了提示；回落成主题底色并留下日志。
        LoadingOverlayImage.Visibility = Visibility.Collapsed;
        LoadingOverlayScrim.Visibility = Visibility.Collapsed;
    }

    /// <summary>窗口关闭时释放媒体句柄，否则进程会一直锁着视频文件。</summary>
    private void DisposeNativeVideoSurfaces()
    {
        _backgroundVideo?.Clear();
        _backgroundVideo = null;
        _splashVideo?.Clear();
        _splashVideo = null;
    }

    private static void LogNativeVideo(string message)
    {
        try
        {
            File.AppendAllText(AppDataPaths.PathFor("logs", "window-runtime.log"),
                $"[{DateTimeOffset.Now:O}] {message}\n");
        }
        catch (Exception error) { System.Diagnostics.Debug.WriteLine(error); }
    }

    /// <summary>一块原生视频画布：负责开文件、循环、填充模式、模糊与释放。</summary>
    private sealed class NativeVideoSurface
    {
        private const int OpenTimeoutSeconds = 8;
        private const int RetryDelaySeconds = 2;

        private readonly Rectangle _target;
        private readonly System.Windows.Threading.DispatcherTimer _deadline;
        private MediaPlayer? _player;
        private VideoDrawing? _drawing;
        private DrawingBrush? _brush;
        private string _signature = string.Empty;
        private string _fill = "cover";
        private int _nativeWidth;
        private int _nativeHeight;
        private bool _opened;
        private bool _failed;
        private DateTime _lastAttempt;

        internal NativeVideoSurface(Rectangle target)
        {
            _target = target;
            // 编解码器缺失时 MF 有时既不开成功也不报失败，必须自己设死线，否则表现为「静默什么都没发生」。
            _deadline = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(OpenTimeoutSeconds)
            };
            _deadline.Tick += (_, _) =>
            {
                _deadline.Stop();
                if (!_opened) Fail("打开超时，系统可能缺少对应的解码器");
            };
        }

        /// <summary>失败回调（同一文件在限流窗口内只会再触发一次，不会刷屏）。</summary>
        internal event Action<string>? Failed;

        /// <summary>
        /// 应用一次设置。path 为空即停止并隐藏。
        /// 只有「换了文件」或「上次失败且已过限流窗口」才重新打开 —— 拖模糊滑条会高频保存，
        /// 每次都重开文件既费 IO、又会让失败提示刷屏。
        /// </summary>
        internal void Apply(string? path, string fill, int blurPx)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                Clear();
                return;
            }
            if (ShouldOpen(path!)) Open(path!);
            SetFill(fill);
            SetBlur(blurPx);
            if (_opened) _target.Visibility = Visibility.Visible;
        }

        internal void Pause()
        {
            try { _player?.Pause(); } catch { /* 播放器已释放 */ }
        }

        internal void Resume()
        {
            if (_player == null || !_opened) return;
            try { _player.Play(); } catch { /* 播放器已释放 */ }
        }

        /// <summary>停止播放并隐藏（也用于「移除背景」）。</summary>
        internal void Clear()
        {
            StopPlayback();
            _signature = string.Empty;
            _failed = false;
        }

        private bool ShouldOpen(string path)
        {
            if (!string.Equals(path, _signature, StringComparison.OrdinalIgnoreCase)) return true;
            if (!_failed) return false;
            return (DateTime.UtcNow - _lastAttempt) > TimeSpan.FromSeconds(RetryDelaySeconds);
        }

        private void Open(string path)
        {
            StopPlayback();
            _signature = path;
            _failed = false;
            _opened = false;
            _nativeWidth = 0;
            _nativeHeight = 0;
            _lastAttempt = DateTime.UtcNow;

            // 背景视频一律静音；占位纵横比 16:9，MediaOpened 后用真实尺寸替换。
            var player = new MediaPlayer { Volume = 0, IsMuted = true };
            var drawing = new VideoDrawing { Player = player, Rect = new Rect(0, 0, 16, 9) };
            var brush = new DrawingBrush(drawing)
            {
                AlignmentX = AlignmentX.Center,
                AlignmentY = AlignmentY.Center,
                Stretch = Stretch.UniformToFill,
                ViewboxUnits = BrushMappingMode.Absolute,
                Viewbox = new Rect(0, 0, 16, 9),
                ViewportUnits = BrushMappingMode.RelativeToBoundingBox,
                Viewport = new Rect(0, 0, 1, 1),
            };
            _player = player;
            _drawing = drawing;
            _brush = brush;
            _target.Fill = brush;

            player.MediaOpened += (_, _) =>
            {
                if (!ReferenceEquals(_player, player)) return;
                _opened = true;
                _deadline.Stop();
                _nativeWidth = player.NaturalVideoWidth;
                _nativeHeight = player.NaturalVideoHeight;
                UpdateAspect();
                _target.Visibility = Visibility.Visible;
                try { player.Play(); } catch (Exception error) { Fail(error.Message); }
            };
            player.MediaEnded += (_, _) =>
            {
                if (!ReferenceEquals(_player, player)) return;
                // MediaPlayer 没有 Loop 属性：手动回到起点重播（背景视频都是循环的）。
                try { player.Position = TimeSpan.Zero; player.Play(); } catch { /* 忽略 */ }
            };
            player.MediaFailed += (_, args) =>
            {
                if (ReferenceEquals(_player, player)) Fail(args.ErrorException?.Message ?? "视频无法解码");
            };

            try
            {
                player.Open(new Uri(path));
                _deadline.Start();
            }
            catch (Exception error)
            {
                Fail(error.Message);
            }
        }

        private void Fail(string message)
        {
            // 记住是哪个文件坏了，供 ShouldOpen 限流；否则每次保存配置都会重开一次坏文件。
            var signature = _signature;
            Clear();
            _signature = signature;
            _failed = true;
            Failed?.Invoke(message);
        }

        private void StopPlayback()
        {
            _deadline.Stop();
            _opened = false;
            var player = _player;
            _player = null;
            if (player != null)
            {
                try { player.Stop(); player.Close(); } catch { /* 已释放 */ }
            }
            _drawing = null;
            _brush = null;
            _target.Fill = null;
            _target.Visibility = Visibility.Collapsed;
            _target.Effect = null;
        }

        private void SetFill(string fill)
        {
            _fill = string.IsNullOrWhiteSpace(fill) ? "cover" : fill;
            UpdateAspect();
        }

        private void SetBlur(int blurPx)
        {
            // CSS blur(Npx) 的 σ≈N/2，WPF BlurEffect.Radius 与 σ 量级接近 → 取一半；
            // 上限 30 是性能护栏：全窗口视频 + 大半径高斯模糊在软件回退下会很难看。
            var radius = Math.Clamp(blurPx * 0.5, 0, 30);
            if (radius <= 0)
            {
                _target.Effect = null;
                return;
            }
            if (_target.Effect is BlurEffect existing)
            {
                existing.Radius = radius;
                return;
            }
            _target.Effect = new BlurEffect { Radius = radius, KernelType = KernelType.Gaussian };
        }

        /// <summary>
        /// Stretch 决定填充模式，Viewbox 决定纵横比来源 —— 两个都要，只给 Stretch 会把视频当正方形。
        /// </summary>
        private void UpdateAspect()
        {
            var width = _nativeWidth > 0 ? _nativeWidth : 16d;
            var height = _nativeHeight > 0 ? _nativeHeight : 9d;
            if (_drawing != null) _drawing.Rect = new Rect(0, 0, width, height);
            if (_brush != null)
            {
                _brush.ViewboxUnits = BrushMappingMode.Absolute;
                _brush.Viewbox = new Rect(0, 0, width, height);
                _brush.Stretch = _fill switch
                {
                    "contain" => Stretch.Uniform,
                    "fill" => Stretch.Fill,
                    // tile 没有原生对应，与启动画面图片一样并到 cover。
                    _ => Stretch.UniformToFill,
                };
            }
        }
    }
}
