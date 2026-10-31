using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services
{
    /// <summary>Native enforcement state. Model arguments cannot grant access.</summary>
    public sealed class BrowserPreferences
    {
        private readonly string _path;
        private readonly SemaphoreSlim _writeLock = new(1, 1);
        private volatile bool _chrome;
        private volatile bool _edge;

        public BrowserPreferences(string path)
        {
            _path = path;
            try
            {
                using var saved = JsonDocument.Parse(File.ReadAllText(path));
                _chrome = Read(saved.RootElement, "chrome");
                _edge = Read(saved.RootElement, "edge");
            }
            catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
        }

        private static bool Read(JsonElement value, string key) =>
            value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.True;

        public bool Allows(string browser) => browser == "builtin" || (browser == "chrome" ? _chrome : browser == "edge" && _edge);
        public object Snapshot() => new { chrome = _chrome, edge = _edge };

        public async Task SaveAsync(bool chrome, bool edge)
        {
            await _writeLock.WaitAsync();
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                var temporary = _path + ".tmp";
                await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(new { chrome, edge }));
                File.Move(temporary, _path, overwrite: true);
                _chrome = chrome;
                _edge = edge;
            }
            finally { _writeLock.Release(); }
        }
    }
}
