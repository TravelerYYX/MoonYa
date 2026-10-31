using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services;

internal sealed record ProgramRelease
{
    [JsonPropertyName("id")] public long Id { get; init; }
    [JsonPropertyName("version")] public string Version { get; init; } = "";
    [JsonPropertyName("notes")] public string Notes { get; init; } = "";
    [JsonPropertyName("force_update")] public bool ForceUpdate { get; init; }
    [JsonPropertyName("minimum_required_version")] public string? MinimumRequiredVersion { get; init; }
    [JsonPropertyName("size")] public long Size { get; init; }
    [JsonPropertyName("sha256")] public string Sha256 { get; init; } = "";
    [JsonPropertyName("download_url")] public string DownloadUrl { get; init; } = "";
}

/// <summary>Owns durable update downloads independently of UI visibility and account identity.</summary>
internal sealed class ProgramUpdateService : IDisposable
{
    private sealed record SavedDownload(string Backend, ProgramRelease Release);
    private readonly Uri _backend;
    private readonly string _root, _installDirectory;
    private readonly Version _currentVersion;
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly object _sync = new();
    private ProgramRelease? _release;
    private string _state = "idle", _error = "";
    private long _downloaded;
    private DateTimeOffset _nextCheck = DateTimeOffset.MinValue;
    private DateTimeOffset NextCheck { get { lock (_sync) return _nextCheck; } set { lock (_sync) _nextCheck = value; } }
    private Task? _runner;
    private bool _installing;
    private string _lastInstallError = "";
    internal Action? ShutdownRequested { get; set; }
    internal string CurrentVersion => $"{_currentVersion.Major}.{_currentVersion.Minor}.{_currentVersion.Build}";
    internal bool IsUpdateRequired { get { lock (_sync) return Required(_release); } }
    private bool Required(ProgramRelease? release) => release != null &&
        (release.MinimumRequiredVersion != null ? ParseVersion(release.MinimumRequiredVersion) > _currentVersion : release.ForceUpdate);
    internal TimeSpan CheckInterval { get; set; } = TimeSpan.FromMinutes(30);
    internal TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(15);
    internal Task? Completion => _runner;

    internal ProgramUpdateService(Uri backend, string? root = null, string? version = null, string? installDirectory = null, HttpMessageHandler? handler = null)
    {
        _backend = new Uri(backend.AbsoluteUri.TrimEnd('/') + "/");
        _root = Path.GetFullPath(root ?? AppDataPaths.PathFor("updates"));
        _installDirectory = Path.GetFullPath(installDirectory ?? AppContext.BaseDirectory);
        _currentVersion = ParseVersion(version ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0");
        _http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
        _http.Timeout = Timeout.InfiniteTimeSpan;
        Directory.CreateDirectory(_root);
    }

    internal static Version ParseVersion(string value)
    {
        if (!Regex.IsMatch(value, @"^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$")) throw new InvalidDataException("版本号必须是三段数字");
        var parsed = Version.Parse(value);
        if (parsed.Major > 65534 || parsed.Minor > 65534 || parsed.Build > 65534) throw new InvalidDataException("版本号超出范围");
        return parsed;
    }

    internal object Snapshot()
    {
        lock (_sync) return new {
            state = _state, current_version = CurrentVersion, release = _release, update_required = Required(_release),
            downloaded_bytes = _downloaded,
            percent = _state == "ready" ? 100 : _release == null ? 0 : Math.Min(99, (int)(_downloaded * 100 / _release.Size)),
            error = string.IsNullOrEmpty(_error) ? _lastInstallError : _error
        };
    }

    internal void Start()
    {
        if (_runner != null) return;
        try {
            var saved = JsonSerializer.Deserialize<SavedDownload>(File.ReadAllText(Path.Combine(_root, "download.json")));
            if (saved != null && saved.Backend == _backend.AbsoluteUri && ValidRelease(saved.Release)) {
                _release = saved.Release;
                var file = PackagePath(saved.Release);
                _downloaded = File.Exists(file) ? new FileInfo(file).Length : 0;
            }
        } catch (Exception error) { Debug.WriteLine("Update restore: " + error.Message); }
        try {
            using var result = JsonDocument.Parse(File.ReadAllText(Path.Combine(_root, "install-result.json")));
            if (!result.RootElement.GetProperty("Success").GetBoolean() && result.RootElement.GetProperty("Version").GetString() == _release?.Version)
                _lastInstallError = result.RootElement.GetProperty("Message").GetString() ?? "上次安装未完成";
        } catch { }
        _runner = Task.Run(RunAsync);
    }

    internal void Retry()
    {
        lock (_sync) { if (_installing) return; _nextCheck = DateTimeOffset.MinValue; _error = ""; }
        if (_wake.CurrentCount == 0) { try { _wake.Release(); } catch (SemaphoreFullException) { } }
    }

    private bool ValidRelease(ProgramRelease value)
    {
        try {
            var url = new Uri(_backend, value.DownloadUrl);
            return value.Id > 0 && value.Size >= 64 && value.Size <= long.MaxValue / 100 && ParseVersion(value.Version) > _currentVersion &&
                (value.MinimumRequiredVersion == null || ParseVersion(value.MinimumRequiredVersion) <= ParseVersion(value.Version)) &&
                Regex.IsMatch(value.Sha256, "^[a-fA-F0-9]{64}$") &&
                url.GetLeftPart(UriPartial.Authority) == _backend.GetLeftPart(UriPartial.Authority) &&
                url.AbsolutePath == new Uri(_backend, "admin/api/updates.php").AbsolutePath &&
                value.DownloadUrl == "admin/api/updates.php?action=download&id=" + value.Id;
        } catch { return false; }
    }

    private string PackagePath(ProgramRelease release) => Path.Combine(_root, release.Id + "-" + release.Sha256.ToLowerInvariant() + ".exe");
    private void SetState(string state, string error = "") { lock (_sync) { if (!_installing) { _state = state; _error = error; } } }

    private async Task CheckAsync(CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await _http.GetAsync(new Uri(_backend, "admin/api/updates.php?action=latest"), timeout.Token);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
        if (!json.RootElement.GetProperty("success").GetBoolean()) throw new InvalidDataException("检查更新失败");
        var data = json.RootElement.GetProperty("data");
        if (data.ValueKind == JsonValueKind.Null) { ClearRelease(); return; }
        var latest = data.Deserialize<ProgramRelease>() ?? throw new InvalidDataException("更新信息无效");
        if (ParseVersion(latest.Version) <= _currentVersion) { ClearRelease(); return; }
        if (!ValidRelease(latest)) throw new InvalidDataException("更新信息无效");
        lock (_sync) {
            if (_installing) return;
            var samePackage = _release?.Id == latest.Id && _release.Sha256 == latest.Sha256 && _release.Version == latest.Version;
            _release = latest;
            if (!samePackage) {
                _downloaded = File.Exists(PackagePath(latest)) ? new FileInfo(PackagePath(latest)).Length : 0;
                _state = "downloading"; _error = ""; _lastInstallError = "";
            }
        }
        var manifest = Path.Combine(_root, "download.json");
        await File.WriteAllTextAsync(manifest + ".tmp", JsonSerializer.Serialize(new SavedDownload(_backend.AbsoluteUri, latest)), token);
        File.Move(manifest + ".tmp", manifest, true);
    }

    private void ClearRelease()
    {
        lock (_sync) {
            if (_installing) return;
            _release = null; _downloaded = 0; _state = "idle"; _error = ""; _lastInstallError = "";
            File.Delete(Path.Combine(_root, "download.json"));
        }
    }

    private async Task RunAsync()
    {
        var token = _stop.Token;
        while (!token.IsCancellationRequested) {
            try {
                bool installing; lock (_sync) installing = _installing;
                if (installing) { await WaitAsync(TimeSpan.FromSeconds(1), token); continue; }
                if (DateTimeOffset.UtcNow >= NextCheck) {
                    try { await CheckAsync(token); NextCheck = DateTimeOffset.UtcNow + CheckInterval; }
                    catch when (!token.IsCancellationRequested) {
                        NextCheck = DateTimeOffset.UtcNow + RetryDelay;
                        if (_release == null) SetState("error", "暂时无法检查更新，将自动重试");
                    }
                }
                ProgramRelease? release; string state; lock (_sync) { release = _release; state = _state; }
                if (release != null && state != "ready") {
                    await DownloadAsync(release, token);
                    if (_state == "ready") continue;
                } else await WaitAsync(TimeSpan.FromSeconds(Math.Max(1, Math.Min(30, (NextCheck - DateTimeOffset.UtcNow).TotalSeconds))), token);
            } catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error) {
                Debug.WriteLine("Update download: " + error);
                SetState("error", "下载未完成，将自动续传：" + error.Message);
                try { await WaitAsync(RetryDelay, token); } catch (OperationCanceledException) { break; }
            }
        }
    }

    private async Task WaitAsync(TimeSpan delay, CancellationToken token)
    {
        await _wake.WaitAsync(delay, token);
    }

    private async Task DownloadAsync(ProgramRelease release, CancellationToken token)
    {
        SetState("downloading");
        var path = PackagePath(release);
        using (var file = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read, 131072, true)) {
            var offset = file.Length;
            if (offset > release.Size) { file.SetLength(0); offset = 0; }
            lock (_sync) _downloaded = offset;
            if (offset < release.Size) {
                using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_backend, release.DownloadUrl));
                var etag = "\"" + release.Sha256.ToLowerInvariant() + "\"";
                request.Headers.TryAddWithoutValidation("Accept-Encoding", "identity");
                if (offset > 0) { request.Headers.Range = new RangeHeaderValue(offset, null); request.Headers.TryAddWithoutValidation("If-Range", etag); }
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(30));
                using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable) { file.SetLength(0); lock (_sync) _downloaded = 0; throw new IOException("服务器拒绝旧下载断点，将从头重试"); }
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentEncoding.Count != 0) throw new InvalidDataException("下载文件不能使用传输压缩");
                if (response.StatusCode == HttpStatusCode.PartialContent) {
                    var range = response.Content.Headers.ContentRange;
                    if (range?.Unit != "bytes" || range.From != offset || range.To != release.Size - 1 || range.Length != release.Size || response.Headers.ETag?.ToString() != etag)
                        throw new InvalidDataException("服务器返回的续传范围或文件标识不一致");
                } else if (response.StatusCode == HttpStatusCode.OK) { offset = 0; file.SetLength(0); }
                else throw new InvalidDataException("服务器返回了无效的下载状态");
                if (response.Content.Headers.ContentLength is long length && length != release.Size - offset) throw new InvalidDataException("服务器返回的文件大小不一致");
                file.Position = offset;
                using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                var buffer = new byte[131072];
                while (true) {
                    timeout.CancelAfter(TimeSpan.FromSeconds(30));
                    var count = await stream.ReadAsync(buffer.AsMemory(), timeout.Token);
                    if (count == 0) break;
                    if (file.Position + count > release.Size) throw new InvalidDataException("下载内容超过声明大小");
                    await file.WriteAsync(buffer.AsMemory(0, count), token);
                    lock (_sync) _downloaded = file.Position;
                    if (DateTimeOffset.UtcNow >= NextCheck) { await file.FlushAsync(token); return; }
                }
                await file.FlushAsync(token);
                if (file.Length != release.Size) throw new EndOfStreamException("下载连接提前结束");
            }
        }
        SetState("verifying");
        if (!await VerifyAsync(path, release, token)) {
            File.Delete(path); lock (_sync) _downloaded = 0;
            throw new InvalidDataException("安装程序校验失败，正在重新下载");
        }
        SetState("ready");
    }

    private static async Task<bool> VerifyAsync(string file, ProgramRelease release, CancellationToken token)
    {
        if (!File.Exists(file) || new FileInfo(file).Length != release.Size) return false;
        using var stream = File.OpenRead(file);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase);
    }

    internal async Task InstallAsync()
    {
        ProgramRelease release;
        var redownload = false;
        lock (_sync) {
            if (_installing) throw new InvalidOperationException("安装程序已经启动");
            if (_state != "ready" || _release == null) throw new InvalidOperationException("更新尚未下载或校验完成");
            _installing = true; _state = "installing"; _error = ""; release = _release;
        }
        try {
            if (ShutdownRequested == null) throw new InvalidOperationException("客户端退出入口不可用");
            var executable = PackagePath(release);
            if (!await VerifyAsync(executable, release, _stop.Token)) {
                redownload = true; File.Delete(executable); lock (_sync) _downloaded = 0;
                throw new InvalidDataException("安装程序校验失败，正在重新下载");
            }
            var info = FileVersionInfo.GetVersionInfo(executable);
            if (info.ProductName != "FarSideSetup.UpdateProtocol/1" || info.FileMajorPart != ParseVersion(release.Version).Major || info.FileMinorPart != ParseVersion(release.Version).Minor || info.FileBuildPart != ParseVersion(release.Version).Build)
                throw new InvalidDataException("此安装程序不支持自动更新，或安装包版本与发布版本不一致");
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)); var pipeName = "MoonYa.Update." + Guid.NewGuid().ToString("N");
            using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            using var current = Process.GetCurrentProcess();
            var requestFile = Path.Combine(_root, "request-" + Guid.NewGuid().ToString("N") + ".json");
            await File.WriteAllTextAsync(requestFile, JsonSerializer.Serialize(new {
                Protocol = 1, ParentId = current.Id, ParentStartTicks = current.StartTime.ToUniversalTime().Ticks,
                InstallDirectory = _installDirectory, TargetVersion = release.Version,
                ResultFile = Path.Combine(_root, "install-result.json"), PipeName = pipeName, Nonce = nonce
            }));
            var start = new ProcessStartInfo(executable) { UseShellExecute = false, WorkingDirectory = _root, CreateNoWindow = true };
            start.ArgumentList.Add("--update"); start.ArgumentList.Add("--request"); start.ArgumentList.Add(requestFile);
            using var installer = Process.Start(start) ?? throw new InvalidOperationException("无法启动安装程序");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token); timeout.CancelAfter(TimeSpan.FromMinutes(2));
            var connected = pipe.WaitForConnectionAsync(timeout.Token);
            var exited = installer.WaitForExitAsync(timeout.Token);
            if (await Task.WhenAny(connected, exited) == exited) throw new InvalidOperationException("安装准备已取消或失败，请重试");
            await connected;
            using var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true);
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true };
            var message = await reader.ReadLineAsync(timeout.Token);
            if (message != nonce + ":ready") throw new InvalidOperationException(message?.StartsWith(nonce + ":error:") == true ? message[(nonce.Length + 7)..] : "安装程序握手失败");
            await writer.WriteLineAsync("exit");
            if (await reader.ReadLineAsync(timeout.Token) != nonce + ":accepted") throw new InvalidOperationException("安装工作进程未接受更新，客户端保持运行");
            _ = Task.Run(async () => { await Task.Delay(400); ShutdownRequested(); });
        } catch (Exception error) {
            lock (_sync) { _installing = false; _state = redownload ? "error" : "ready"; _error = error.Message; }
            if (redownload) Retry();
            throw;
        }
    }

    public void Dispose() { _stop.Cancel(); /* Worker owns its open stream; cancellation closes it without losing the durable prefix. */ }
}
