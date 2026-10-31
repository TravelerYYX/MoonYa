using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Text.Json;
using System.IO;
using CefSharp;

namespace MoonYa;

/// <summary>
/// JS 桥：外观配置（背景媒体、模糊度、不透明度、配色与主题库）的整份读写。
/// 主题库的增删改查全部在前端内存完成，这里只做「取快照 / 落盘」两个动作，
/// 因此写入始终是原子的，也不会出现多处并发改同一份配置。
/// </summary>
public partial class MainWindow
{
    private void InitializeAppearance()
    {
        WebView.BrowserSettings = new BrowserSettings { BackgroundColor = 0x00000000 };
        WebView.JavascriptObjectRepository.Register("moonYaAppearance", new AppearanceBridge(this), BindingOptions.DefaultBinder);
        ApplyBackgroundVideo(App.AppearancePreferences.Snapshot());
    }

    private void ApplyBackgroundVideo(string snapshot)
    {
        using var document = JsonDocument.Parse(snapshot);
        if (document.RootElement.TryGetProperty("working", out var working) &&
            working.TryGetProperty("background", out var background) &&
            background.TryGetProperty("type", out var type) && type.GetString() == "video" &&
            background.TryGetProperty("path", out var pathValue) && pathValue.GetString() is string path &&
            IsNativeBackgroundVideo(path))
        {
            var fill = background.TryGetProperty("fill", out var value) ? value.GetString() ?? "cover" : "cover";
            var blur = working.TryGetProperty("blur", out var radius) && radius.TryGetDouble(out var amount)
                ? (int)Math.Clamp(amount, 0, 60) : 0;
            BackgroundVideo.Apply(path, fill, blur);
        }
        else _backgroundVideo?.Clear();
    }

    private static bool IsNativeBackgroundVideo(string path) =>
        Path.GetExtension(path).ToLowerInvariant() is ".mp4" or ".m4v" or ".mov";

    private sealed class AppearanceBridge(MainWindow window)
    {
        public async Task<string> GetAppearance() => await window.RunOnUiAsync(() =>
        {
            if (!window.IsBuiltinBrowserBridgeTrusted()) throw new UnauthorizedAccessException();
            return App.AppearancePreferences.Snapshot();
        });

        public async Task<string> SetAppearance(string document) => await window.RunOnUiAsync(() =>
        {
            if (!window.IsBuiltinBrowserBridgeTrusted()) throw new UnauthorizedAccessException();
            var saved = App.AppearancePreferences.Save(document);
            window.ApplyBackgroundVideo(saved);
            return saved;
        });

        /// <summary>内置主题资源：只查本地缓存（不联网）。</summary>
        public Dictionary<string, object> ThemeAssetStatus(string slug, string sha256) => window.ThemeAssetStatus(slug, sha256);

        /// <summary>内置主题资源：下载到 .moonya/appearance/themes/，进度经 acceptAssetProgress 推送。</summary>
        public Task<Dictionary<string, object>> FetchThemeAsset(string url, string slug, string sha256, long expectedBytes)
            => window.FetchThemeAssetAsync(url, slug, sha256, expectedBytes);
    }
}
