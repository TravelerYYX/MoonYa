using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using CefSharp;
using MoonYa.Services;

namespace MoonYa;

/// <summary>
/// 内置主题资源下载：下载到 .moonya/appearance/themes/&lt;slug&gt;/，写 .part 后校验 sha 再原子替换。
/// 进度通过 ExecuteScriptAsync 推给前端 window.MoonYaAppearance.acceptAssetProgress(slug, pct, loaded, total)。
/// 不使用现有的 moonYaFileOps.downloadFile：它直接覆盖目标文件、没有字节级进度，也无法做缓存判定与校验。
/// </summary>
public partial class MainWindow
{
    private static readonly HttpClient ThemeAssetClient = new(new HttpClientHandler { AllowAutoRedirect = true, UseProxy = false });
    private static readonly Regex ThemeSlug = new("^[a-z0-9][a-z0-9_-]{0,63}$", RegexOptions.Compiled);
    private static readonly SemaphoreSlim ThemeDownloadSlots = new(3, 3);
    private const long MaxThemeAssetBytes = 64L * 1024 * 1024;
    private static readonly HashSet<string> ThemeAssetExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
        ".mp4", ".webm", ".mov", ".mkv", ".m4v"
    };

    /// <summary>同一 slug+sha 的并发请求复用同一个 Task，避免重复下载。</summary>
    private readonly ConcurrentDictionary<string, Lazy<Task<Dictionary<string, object>>>> _themeAssetDownloads = new(StringComparer.Ordinal);

    private static string ThemeCacheDirectory() => Path.GetFullPath(AppDataPaths.PathFor("appearance", "themes"));

    private static string ShortHash(string sha) => string.IsNullOrWhiteSpace(sha) ? string.Empty : sha.Substring(0, Math.Min(16, sha.Length));

    private static Dictionary<string, object> AssetResult(bool success, string? path, long bytes, bool cached, string? error = null)
        => new() { ["success"] = success, ["path"] = path ?? string.Empty, ["bytes"] = bytes, ["cached"] = cached, ["error"] = error ?? string.Empty };

    /// <summary>只查缓存，不联网。前端点卡片时先问一次。</summary>
    internal Dictionary<string, object> ThemeAssetStatus(string slug, string sha256)
    {
        if (!IsBuiltinBrowserBridgeTrusted()) throw new UnauthorizedAccessException();
        if (string.IsNullOrWhiteSpace(slug) || !ThemeSlug.IsMatch(slug)) return AssetResult(false, null, 0, false, "主题标识无效");
        var directory = Path.Combine(ThemeCacheDirectory(), slug);
        if (!Directory.Exists(directory)) return AssetResult(true, null, 0, false);
        var prefix = "bg-" + ShortHash(sha256 ?? string.Empty);
        var candidates = Directory.EnumerateFiles(directory, "bg-*")
            .Where(file => string.IsNullOrEmpty(ShortHash(sha256 ?? string.Empty))
                || Path.GetFileName(file).StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .Select(file => new FileInfo(file))
            .Where(info => info.Length > 0)
            .OrderByDescending(info => info.LastWriteTimeUtc)
            .ToList();
        if (candidates.Count == 0) return AssetResult(true, null, 0, false);
        return AssetResult(true, candidates[0].FullName, candidates[0].Length, true);
    }

    /// <summary>下载（或命中缓存直接返回）主题资源。前端 await 它即可，进度靠推送。</summary>
    internal Task<Dictionary<string, object>> FetchThemeAssetAsync(string url, string slug, string sha256, long expectedBytes)
    {
        if (!IsBuiltinBrowserBridgeTrusted()) throw new UnauthorizedAccessException();
        if (string.IsNullOrWhiteSpace(slug) || !ThemeSlug.IsMatch(slug))
            return Task.FromResult(AssetResult(false, null, 0, false, "主题标识无效"));
        if (!Uri.TryCreate(url ?? string.Empty, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
            return Task.FromResult(AssetResult(false, null, 0, false, "资源地址无效"));
        var extension = Path.GetExtension(uri.AbsolutePath);
        if (string.IsNullOrEmpty(extension) || !ThemeAssetExtensions.Contains(extension))
            return Task.FromResult(AssetResult(false, null, 0, false, "资源格式不支持"));
        if (expectedBytes > MaxThemeAssetBytes)
            return Task.FromResult(AssetResult(false, null, 0, false, "资源过大"));

        var directory = ThemeCacheDirectory();
        var target = Path.GetFullPath(Path.Combine(directory, slug, "bg-" + ShortHash(sha256) + extension));
        // slug 已过正则白名单，这里再做一次前缀兜底，杜绝目录穿越。
        if (!target.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(AssetResult(false, null, 0, false, "资源路径越界"));

        if (File.Exists(target) && (expectedBytes <= 0 || new FileInfo(target).Length == expectedBytes))
            return Task.FromResult(AssetResult(true, target, new FileInfo(target).Length, true));

        var key = slug + "|" + (sha256 ?? string.Empty);
        var lazy = _themeAssetDownloads.GetOrAdd(key,
            _ => new Lazy<Task<Dictionary<string, object>>>(() => DownloadThemeAssetAsync(uri, target, slug, sha256, expectedBytes)));
        return AwaitAndReleaseAsync(key, lazy);
    }

    private async Task<Dictionary<string, object>> AwaitAndReleaseAsync(string key, Lazy<Task<Dictionary<string, object>>> lazy)
    {
        try { return await lazy.Value; }
        finally { _themeAssetDownloads.TryRemove(key, out _); }
    }

    private async Task<Dictionary<string, object>> DownloadThemeAssetAsync(Uri uri, string target, string slug, string sha256, long expectedBytes)
    {
        await ThemeDownloadSlots.WaitAsync().ConfigureAwait(false);
        var part = target + ".part";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using var response = await ThemeAssetClient.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return AssetResult(false, null, 0, false, "下载失败（" + (int)response.StatusCode + "）");
            var total = response.Content.Headers.ContentLength ?? expectedBytes;
            if (total > MaxThemeAssetBytes) return AssetResult(false, null, 0, false, "资源过大");

            long loaded = 0;
            double reported = 0;
            var lastReport = DateTime.UtcNow;
            using (var source = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
            using (var destination = File.Create(part))
            {
                var buffer = new byte[81920];
                int read;
                while ((read = await source.ReadAsync(buffer).ConfigureAwait(false)) > 0)
                {
                    await destination.WriteAsync(buffer.AsMemory(0, read)).ConfigureAwait(false);
                    loaded += read;
                    if (total <= 0) continue;
                    var percent = (double)loaded / total * 100;
                    var now = DateTime.UtcNow;
                    // 节流：每 ≥1% 或 ≥120ms 推一次，避免把 UI 线程刷爆。
                    if (percent - reported >= 1 || (now - lastReport).TotalMilliseconds >= 120)
                    {
                        reported = percent;
                        lastReport = now;
                        PushThemeAssetProgress(slug, percent, loaded, total);
                    }
                }
                await destination.FlushAsync().ConfigureAwait(false);
            }

            var length = new FileInfo(part).Length;
            if (expectedBytes > 0 && length != expectedBytes) { TryDelete(part); return AssetResult(false, null, 0, false, "资源大小不匹配"); }
            if (!string.IsNullOrWhiteSpace(sha256))
            {
                string actual;
                using (var stream = File.OpenRead(part)) actual = Convert.ToHexString(await SHA256.HashDataAsync(stream).ConfigureAwait(false));
                if (!actual.Equals(sha256, StringComparison.OrdinalIgnoreCase)) { TryDelete(part); return AssetResult(false, null, 0, false, "资源校验失败"); }
            }

            File.Move(part, target, overwrite: true);
            // 换了资源版本就只保留最新一份，避免缓存目录无限增长。
            foreach (var stale in Directory.EnumerateFiles(Path.GetDirectoryName(target)!, "bg-*")
                .Where(file => !string.Equals(file, target, StringComparison.OrdinalIgnoreCase))) TryDelete(stale);
            PushThemeAssetProgress(slug, 100, length, length);
            return AssetResult(true, target, length, false);
        }
        catch (Exception error)
        {
            TryDelete(part);
            return AssetResult(false, null, 0, false, error.Message);
        }
        finally { ThemeDownloadSlots.Release(); }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private void PushThemeAssetProgress(string slug, double percent, long loaded, long total)
    {
        var dispatcher = Dispatcher;
        if (dispatcher == null || dispatcher.HasShutdownStarted) return;
        dispatcher.BeginInvoke(new Action(() =>
        {
            if (!WebView.IsBrowserInitialized || !WebView.CanExecuteJavascriptInMainFrame) return;
            // slug 已过 ^[a-z0-9][a-z0-9_-]{0,63}$ 校验，直接内插无注入风险。
            var script = string.Format(CultureInfo.InvariantCulture,
                "window.MoonYaAppearance&&window.MoonYaAppearance.acceptAssetProgress('{0}',{1:0.##},{2},{3});",
                slug, Math.Clamp(percent, 0, 100), loaded, total);
            WebView.ExecuteScriptAsync(script);
        }));
    }
}
