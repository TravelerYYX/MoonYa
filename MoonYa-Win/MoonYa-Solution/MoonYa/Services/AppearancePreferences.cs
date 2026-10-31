using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MoonYa.Services;

/// <summary>
/// Machine-local appearance preference: background media, blur, shell opacity, colors and the
/// saved theme library. Lives next to <c>theme.json</c> in the MoonYa data root.
/// The chosen background file is referenced by absolute path only — its bytes are never copied.
/// </summary>
public sealed class AppearancePreferences
{
    internal const int MaxBytes = 256 * 1024;
    internal const int MaxBlur = 60;
    internal const int MaxThemes = 60;
    private const int MaxPathLength = 260;

    /// <summary>Extensions the media route and the picker are allowed to reference.</summary>
    private static readonly HashSet<string> MediaExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
        ".mp4", ".webm", ".mov", ".mkv", ".m4v"
    };

    private static readonly Regex HexColor = new("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);
    private static readonly HashSet<string> ColorKeys = new(StringComparer.Ordinal)
    {
        "appBackground", "sidebar", "surface", "inputBackground", "inputText",
        "buttonBackground", "buttonText", "border", "accent", "textPrimary", "textSecondary"
    };
    private static readonly HashSet<string> BackgroundTypes = new(StringComparer.Ordinal) { "none", "image", "video" };
    private static readonly HashSet<string> FillModes = new(StringComparer.Ordinal) { "cover", "contain", "fill", "tile" };
    /// <summary>
    /// 启动画面支持静态图片与视频。图片走 WIC（BitmapImage），视频走 Windows Media Foundation
    /// （MediaPlayer + VideoDrawing），两者都在窗口构造期同步准备，进度条与文字照常叠在上层。
    /// </summary>
    private static readonly HashSet<string> SplashTypes = new(StringComparer.Ordinal) { "none", "image", "video" };

    private static string? _themeCacheRoot;
    /// <summary>客户端自己下载的内置主题资源目录。这部分是本机自管缓存，/local-media 直接放行。</summary>
    private static string ThemeCacheRoot => _themeCacheRoot ??= Path.GetFullPath(AppDataPaths.PathFor("appearance", "themes"));

    private readonly string _path;
    private readonly object _lock = new();
    private string _json;

    public AppearancePreferences(string path)
    {
        _path = path;
        _json = Load();
    }

    /// <summary>Current document, exactly as persisted.</summary>
    internal string Snapshot()
    {
        lock (_lock) return _json;
    }

    /// <summary>Validates then atomically persists the document. Returns the stored document.</summary>
    internal string Save(string? document)
    {
        var candidate = string.IsNullOrWhiteSpace(document) ? DefaultJson() : document!;
        if (candidate.Length > MaxBytes) throw new ArgumentException("外观配置过大。", nameof(document));
        using (var parsed = JsonDocument.Parse(candidate))
        {
            if (!IsValid(parsed.RootElement)) throw new ArgumentException("外观配置无效。", nameof(document));
        }

        lock (_lock)
        {
            _json = candidate;
            if (string.IsNullOrEmpty(_path)) return _json;
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temporary = _path + ".tmp";
            File.WriteAllText(temporary, candidate);
            File.Move(temporary, _path, overwrite: true);
        }
        return _json;
    }

    /// <summary>
    /// True when the absolute path is referenced by the saved theme library and carries an allowed
    /// media extension. This is the persistent half of the media route allow-list.
    /// </summary>
    internal bool IsAllowedMediaPath(string? fullPath)
    {
        if (string.IsNullOrWhiteSpace(fullPath) || fullPath!.Length > MaxPathLength) return false;
        if (!IsAbsolute(fullPath)) return false;
        if (!MediaExtensions.Contains(Path.GetExtension(fullPath))) return false;
        // 内置主题的本地缓存目录由本机自己写入，直接放行 —— 否则「已下载但尚未激活」的
        // 主题卡片无法用 /local-media 做本地预览。
        if (IsUnderThemeCache(fullPath)) return true;
        return MediaPaths(Snapshot()).Contains(fullPath, StringComparer.OrdinalIgnoreCase);
    }

    private static bool IsUnderThemeCache(string fullPath)
    {
        var root = ThemeCacheRoot;
        return fullPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    internal static string DefaultJson() => JsonSerializer.Serialize(new
    {
        version = 1,
        activeThemeId = "default",
        working = DefaultLayer(),
        // 启动画面背景与主界面背景互相独立。
        splash = new { type = "none", path = (string?)null, fill = "cover" },
        themes = Array.Empty<object>()
    });

    /// <summary>启动画面背景（WPF 侧在窗口构造期读取）。</summary>
    internal readonly record struct SplashBackground(string Type, string? Path, string Fill);

    internal SplashBackground Splash()
    {
        var fallback = new SplashBackground("none", null, "cover");
        try
        {
            using var document = JsonDocument.Parse(Snapshot());
            if (document.RootElement.ValueKind != JsonValueKind.Object ||
                !document.RootElement.TryGetProperty("splash", out var splash) ||
                splash.ValueKind != JsonValueKind.Object) return fallback;
            var type = splash.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : "none";
            var path = splash.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
            var fill = splash.TryGetProperty("fill", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() : "cover";
            // 防御手改 JSON：只认 image / video，其余一律回落成主题底色。
            if (type is not ("image" or "video") || string.IsNullOrWhiteSpace(path)) return fallback;
            if (!File.Exists(path)) return fallback;
            return new SplashBackground(type!, path, string.IsNullOrWhiteSpace(fill) ? "cover" : fill!);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
        {
            return fallback;
        }
    }

    private static object DefaultLayer() => new
    {
        background = new { type = "none", path = (string?)null, fill = "cover", video = new { muted = true, loop = true } },
        blur = 0,
        shellOpacity = 0.85,
        colors = new Dictionary<string, string>()
    };

    private static bool IsAbsolute(string path)
    {
        try { return Path.IsPathFullyQualified(path); }
        catch { return false; }
    }

    /// <summary>Every media path referenced by the working layer and the saved theme library.</summary>
    private static List<string> MediaPaths(string json)
    {
        var result = new List<string>();
        JsonDocument? document = null;
        try { document = JsonDocument.Parse(json); }
        catch (JsonException) { return result; }
        if (document == null) return result;
        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object) return result;
            if (document.RootElement.TryGetProperty("working", out var working))
                AddPath(result, working);
            // 顶层 splash 的 path 不在 layer 里，必须单独抽 —— 否则 /local-media 会对启动画面图 403。
            AddDirectPath(result, document.RootElement, "splash");
            if (document.RootElement.TryGetProperty("themes", out var themes) && themes.ValueKind == JsonValueKind.Array)
                foreach (var theme in themes.EnumerateArray()) AddPath(result, theme);
        }
        return result;
    }

    private static void AddPath(List<string> target, JsonElement layer)
    {
        if (layer.ValueKind != JsonValueKind.Object) return;
        if (!layer.TryGetProperty("background", out var background) || background.ValueKind != JsonValueKind.Object) return;
        if (!background.TryGetProperty("path", out var path) || path.ValueKind != JsonValueKind.String) return;
        var value = path.GetString();
        if (!string.IsNullOrWhiteSpace(value)) target.Add(value!);
    }

    /// <summary>抽取 `{ "path": ... }` 形式（顶层对象直接带 path 字段，例如 splash）。</summary>
    private static void AddDirectPath(List<string> target, JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object) return;
        if (!root.TryGetProperty(name, out var node) || node.ValueKind != JsonValueKind.Object) return;
        if (!node.TryGetProperty("path", out var path) || path.ValueKind != JsonValueKind.String) return;
        var value = path.GetString();
        if (!string.IsNullOrWhiteSpace(value)) target.Add(value!);
    }

    private string Load()
    {
        try
        {
            if (string.IsNullOrEmpty(_path) || !File.Exists(_path)) return DefaultJson();
            var text = File.ReadAllText(_path);
            // A file beyond the cap, or from a newer writer, is never rewritten from the shell side.
            if (text.Length > MaxBytes) return DefaultJson();
            using var document = JsonDocument.Parse(text);
            return IsValid(document.RootElement) ? text : DefaultJson();
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException or ArgumentException)
        {
            return DefaultJson();
        }
    }

    private static bool IsValid(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return false;
        if (root.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.Number && version.GetInt32() > 1) return false;
        if (root.TryGetProperty("working", out var working) && !IsValidLayer(working)) return false;
        // 老文件没有 splash 字段 —— 缺失即放行，所以新增它不需要提升 version。
        if (root.TryGetProperty("splash", out var splash) && !IsValidSplash(splash)) return false;
        if (root.TryGetProperty("themes", out var themes))
        {
            if (themes.ValueKind != JsonValueKind.Array) return false;
            var count = 0;
            foreach (var theme in themes.EnumerateArray())
            {
                if (++count > MaxThemes || !IsValidLayer(theme)) return false;
            }
        }
        return true;
    }

    private static bool IsValidLayer(JsonElement layer)
    {
        if (layer.ValueKind != JsonValueKind.Object) return false;

        if (layer.TryGetProperty("blur", out var blur))
        {
            if (blur.ValueKind != JsonValueKind.Number) return false;
            var value = blur.GetDouble();
            if (value < 0 || value > MaxBlur) return false;
        }

        if (layer.TryGetProperty("shellOpacity", out var opacity))
        {
            if (opacity.ValueKind != JsonValueKind.Number) return false;
            var value = opacity.GetDouble();
            if (value < 0.2 || value > 1) return false;
        }

        if (layer.TryGetProperty("colors", out var colors))
        {
            if (colors.ValueKind != JsonValueKind.Object) return false;
            foreach (var color in colors.EnumerateObject())
            {
                if (!ColorKeys.Contains(color.Name)) return false;
                if (color.Value.ValueKind != JsonValueKind.String || !HexColor.IsMatch(color.Value.GetString() ?? string.Empty)) return false;
            }
        }

        if (layer.TryGetProperty("background", out var background))
        {
            if (background.ValueKind != JsonValueKind.Object) return false;
            if (background.TryGetProperty("type", out var type))
            {
                if (type.ValueKind != JsonValueKind.String || !BackgroundTypes.Contains(type.GetString() ?? string.Empty)) return false;
            }
            if (background.TryGetProperty("fill", out var fill))
            {
                if (fill.ValueKind != JsonValueKind.String || !FillModes.Contains(fill.GetString() ?? string.Empty)) return false;
            }
            if (background.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.String)
            {
                var value = path.GetString();
                if (!string.IsNullOrWhiteSpace(value) &&
                    (value!.Length > MaxPathLength || !MediaExtensions.Contains(Path.GetExtension(value)))) return false;
            }
        }

        return true;
    }

    private static bool IsValidSplash(JsonElement splash)
    {
        if (splash.ValueKind != JsonValueKind.Object) return false;

        if (splash.TryGetProperty("type", out var type))
        {
            if (type.ValueKind != JsonValueKind.String || !SplashTypes.Contains(type.GetString() ?? string.Empty)) return false;
        }
        if (splash.TryGetProperty("fill", out var fill))
        {
            if (fill.ValueKind != JsonValueKind.String || !FillModes.Contains(fill.GetString() ?? string.Empty)) return false;
        }
        if (splash.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.String)
        {
            var value = path.GetString();
            if (!string.IsNullOrWhiteSpace(value) &&
                (value!.Length > MaxPathLength || !MediaExtensions.Contains(Path.GetExtension(value)))) return false;
        }
        return true;
    }
}
