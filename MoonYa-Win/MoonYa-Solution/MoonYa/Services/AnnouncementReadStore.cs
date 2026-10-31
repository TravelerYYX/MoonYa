using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services;

/// <summary>Device-local acknowledgements, independent of login and ephemeral UI ports.</summary>
internal sealed class AnnouncementReadStore
{
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    internal AnnouncementReadStore(Uri backend, string? directory = null)
    {
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(backend.AbsoluteUri.TrimEnd('/'))));
        _path = Path.Combine(directory ?? AppDataPaths.PathFor("announcements"), key + ".json");
    }
    internal async Task<Dictionary<string, int>> ReadAsync()
    {
        await _gate.WaitAsync();
        try { return Load(); } finally { _gate.Release(); }
    }
    private Dictionary<string, int> Load()
    {
        try { return JsonSerializer.Deserialize<Dictionary<string, int>>(File.ReadAllText(_path)) ?? new(); }
        catch (FileNotFoundException) { return new(); }
        catch (DirectoryNotFoundException) { return new(); }
        catch (JsonException) { return new(); }
    }
    internal async Task AcknowledgeAsync(long id, int revision)
    {
        if (id < 1 || revision < 1) throw new ArgumentException("公告标识无效");
        await _gate.WaitAsync();
        try {
            var read = Load(); var key = id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            read[key] = Math.Max(read.GetValueOrDefault(key), revision);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            await File.WriteAllTextAsync(_path + ".tmp", JsonSerializer.Serialize(read));
            File.Move(_path + ".tmp", _path, true);
        } finally { _gate.Release(); }
    }
}
