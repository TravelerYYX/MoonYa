using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace MoonYa.Services;

/// <summary>Machine-local appearance preference. Accessed on the WPF dispatcher.</summary>
public sealed class ThemePreferences
{
    private readonly string _path;
    public string Preference { get; private set; } = "system";
    public ThemePreferences(string path)
    {
        _path = path;
        try
        {
            using var saved = JsonDocument.Parse(File.ReadAllText(path));
            if (saved.RootElement.ValueKind == JsonValueKind.Object &&
                saved.RootElement.TryGetProperty("preference", out var field) && field.ValueKind == JsonValueKind.String &&
                IsValid(field.GetString())) Preference = field.GetString()!;
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
    }
    public static bool IsValid(string? value) => value is "light" or "dark" or "system";
    public static string SystemTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int value && value == 0 ? "dark" : "light";
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return "light"; }
    }
    public string Resolved => Preference == "system" ? SystemTheme() : Preference;
    public string Snapshot()
    {
        var systemTheme = SystemTheme();
        return JsonSerializer.Serialize(new { preference = Preference, resolved = Preference == "system" ? systemTheme : Preference, systemTheme });
    }
    public void Save(string value)
    {
        if (!IsValid(value)) throw new ArgumentException("Invalid theme preference.", nameof(value));
        Preference = value;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temporary = _path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(new { preference = value }));
        File.Move(temporary, _path, overwrite: true);
    }
    public void ApplyResources(ResourceDictionary resources)
    {
        bool dark = Resolved == "dark";
        var palette = new Dictionary<string, string[]>
        {
            ["TitleBarBg"] = ["#F4F3F5", "#18191D"],
            ["TitleBarText"] = ["#26272B", "#EEEEF2"],
            ["TitleBarSubText"] = ["#767983", "#A4A6B1"],
            ["TitleBarBtnHover"] = ["#E6E6E6", "#32343B"],
            ["BgDark"] = ["#FFFFFF", "#1E1F23"],
            ["BgMid"] = ["#F5F5F5", "#27282E"],
            ["BgSurface"] = ["#EEEEEE", "#32343B"],
            ["BgElevated"] = ["#E8E8E8", "#383A43"],
            ["BorderSubtle"] = ["#E5E4E8", "#383A43"],
            ["BorderDefault"] = ["#D1D1D1", "#555863"],
            ["TextPrimary"] = ["#1A1A1A", "#EEEEF2"],
            ["TextSecondary"] = ["#6B6B6B", "#BEC0CB"],
            ["TextMuted"] = ["#767983", "#A4A6B1"],
            ["AccentWarm"] = ["#3B82F6", "#80B4FF"],
            ["AccentWarmHover"] = ["#2563EB", "#92BDFF"],
            ["AccentGreen"] = ["#287444", "#91D5A6"],
            ["AccentRed"] = ["#BD303F", "#FF9BAA"],
            ["AccentAmber"] = ["#986210", "#EDC47A"],
            ["LoadingSweep"] = ["#1A1A1A", "#EEEEF2"],
            ["LoadingSweepSoft"] = ["#4D1A1A1A", "#4DEEEEF2"]
        };
        foreach (var entry in palette)
        {
            var color = (Color)ColorConverter.ConvertFromString(entry.Value[dark ? 1 : 0]);
            resources[entry.Key] = color;
            resources["Brush" + entry.Key] = new SolidColorBrush(color);
        }
    }
}
