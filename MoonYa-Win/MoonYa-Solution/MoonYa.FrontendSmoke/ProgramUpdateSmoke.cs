using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MoonYa.Services;

internal static class ProgramUpdateSmoke
{
    internal static async Task RunAsync()
    {
        Assert(ProgramUpdateService.ParseVersion("1.10.0") > ProgramUpdateService.ParseVersion("1.9.9"), "Numeric version ordering");
        foreach (var invalid in new[] { "1.0", "01.0.0", "1.2.3-beta", "65535.0.0", "-1.0.0" }) {
            try { ProgramUpdateService.ParseVersion(invalid); throw new Exception("Invalid version accepted: " + invalid); } catch (InvalidDataException) { }
        }
        var root = Path.Combine(Path.GetTempPath(), "moonya-update-smoke-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var previousData = Environment.GetEnvironmentVariable("MOONYA_SMOKE_DATA");
        Environment.SetEnvironmentVariable("MOONYA_SMOKE_DATA",root);
        try {
            var fixture = new Fixture(); var cache = Path.Combine(root, "resume");
            var first = new ProgramUpdateService(fixture.Backend, cache, "1.0.0", handler: fixture.Handler()) { RetryDelay = TimeSpan.FromHours(1) };
            first.Start(); await Until(first, status => status.GetProperty("state").GetString() == "error");
            var prefix = Directory.GetFiles(cache, "*.exe").Single(); var offset = new FileInfo(prefix).Length;
            Assert(offset > 0 && offset < fixture.Bytes.Length, "Interrupted download retains durable prefix");
            first.Dispose(); await first.Completion!;
            fixture.FailAfter = -1;
            using (var resumed = new ProgramUpdateService(fixture.Backend, cache, "1.0.0", handler: fixture.Handler())) {
                resumed.Start(); await Until(resumed, Ready);
                Assert(fixture.Offsets.Contains(offset), "New service resumes actual on-disk offset");
                Assert(File.ReadAllBytes(prefix).SequenceEqual(fixture.Bytes), "Resumed file matches payload");
                bool exit = false; resumed.ShutdownRequested = () => exit = true;
                try { await resumed.InstallAsync(); throw new Exception("Invalid installer accepted"); } catch (InvalidDataException) { }
                Assert(!exit, "Unsupported installer never closes client");
                resumed.Dispose(); await resumed.Completion!;
            }
            // A server ignoring Range must replace the partial file, never append a full body.
            fixture.IgnoreRange = true; fixture.Offsets.Clear();
            var ignored = Path.Combine(root, "ignored"); Directory.CreateDirectory(ignored);
            File.Copy(Path.Combine(cache, "download.json"), Path.Combine(ignored, "download.json"));
            File.WriteAllBytes(Path.Combine(ignored, Path.GetFileName(prefix)), fixture.Bytes[..5000]);
            using (var service = new ProgramUpdateService(fixture.Backend, ignored, "1.0.0", handler: fixture.Handler())) {
                service.Start(); await Until(service, Ready); Assert(File.ReadAllBytes(Directory.GetFiles(ignored, "*.exe").Single()).SequenceEqual(fixture.Bytes), "200 response resets partial file"); service.Dispose(); await service.Completion!;
            }
            fixture.IgnoreRange = false; fixture.BadRange = true;
            var bad = Path.Combine(root, "bad-range"); Directory.CreateDirectory(bad);
            File.Copy(Path.Combine(cache, "download.json"), Path.Combine(bad, "download.json"));
            File.WriteAllBytes(Path.Combine(bad, Path.GetFileName(prefix)), fixture.Bytes[..5000]);
            using (var service = new ProgramUpdateService(fixture.Backend, bad, "1.0.0", handler: fixture.Handler()) { RetryDelay = TimeSpan.FromHours(1) }) {
                service.Start(); await Until(service, status => status.GetProperty("state").GetString() == "error");
                Assert(new FileInfo(Directory.GetFiles(bad, "*.exe").Single()).Length == 5000, "Invalid Content-Range does not change prefix");
                fixture.BadRange = false; service.Retry(); await Until(service, Ready); service.Dispose(); await service.Completion!;
            }
            var rejected = Path.Combine(root, "range-416"); Directory.CreateDirectory(rejected);
            File.Copy(Path.Combine(cache, "download.json"), Path.Combine(rejected, "download.json"));
            File.WriteAllBytes(Path.Combine(rejected, Path.GetFileName(prefix)), fixture.Bytes[..5000]); fixture.RejectRange = true;
            using (var service = new ProgramUpdateService(fixture.Backend, rejected, "1.0.0", handler: fixture.Handler()) { RetryDelay = TimeSpan.FromHours(1) }) {
                service.Start(); await Until(service, status => status.GetProperty("state").GetString() == "error");
                Assert(new FileInfo(Directory.GetFiles(rejected, "*.exe").Single()).Length == 0, "416 discards stale prefix and applies retry backoff");
                fixture.RejectRange = false; service.Retry(); await Until(service, Ready); service.Dispose(); await service.Completion!;
            }
            // A completed corrupt cache must be discarded and downloaded again.
            var corrupt = Path.Combine(root, "corrupt"); Directory.CreateDirectory(corrupt);
            File.Copy(Path.Combine(cache, "download.json"), Path.Combine(corrupt, "download.json"));
            File.WriteAllBytes(Path.Combine(corrupt, Path.GetFileName(prefix)), new byte[fixture.Bytes.Length]);
            using (var service = new ProgramUpdateService(fixture.Backend, corrupt, "1.0.0", handler: fixture.Handler()) { RetryDelay = TimeSpan.FromMilliseconds(10) }) {
                service.Start(); await Until(service, Ready); Assert(File.ReadAllBytes(Directory.GetFiles(corrupt, "*.exe").Single()).SequenceEqual(fixture.Bytes), "Corrupt cache replaced"); service.Dispose(); await service.Completion!;
            }
            using (var current = new ProgramUpdateService(fixture.Backend, Path.Combine(root, "current"), "1.0.1", handler: fixture.Handler())) {
                var previous = fixture.Offsets.Count; current.Start(); await Task.Delay(100); Assert(fixture.Offsets.Count == previous, "Same version is not downloaded"); current.Dispose(); await current.Completion!;
            }
            // A newer release supersedes an in-progress download without two concurrent streams.
            fixture.Version = "1.0.1"; fixture.Delay = 3;
            using (var service = new ProgramUpdateService(fixture.Backend, Path.Combine(root, "newer"), "1.0.0", handler: fixture.Handler()) { CheckInterval = TimeSpan.FromMilliseconds(50) }) {
                service.Start(); await Until(service, status => status.GetProperty("downloaded_bytes").GetInt64() > 0);
                fixture.Version = "1.0.2";
                await Until(service, status => Ready(status) && status.GetProperty("release").GetProperty("version").GetString() == "1.0.2");
                service.Dispose(); await service.Completion!;
            }
            fixture.Delay = 0; fixture.Minimum = "1.0.1";
            var mandatoryCache = Path.Combine(root, "mandatory");
            using (var service = new ProgramUpdateService(fixture.Backend, mandatoryCache, "1.0.0", handler: fixture.Handler()) { CheckInterval = TimeSpan.FromHours(1) }) {
                service.Start(); await Until(service, Ready);
                Assert(service.IsUpdateRequired, "Earlier mandatory version still blocks a later optional release");
                var downloads = fixture.Offsets.Count;
                fixture.Minimum = null; service.Retry(); await Until(service, status => !status.GetProperty("update_required").GetBoolean());
                Assert(fixture.Offsets.Count == downloads, "Same-package metadata refresh must not download again");
                fixture.Minimum = "1.0.2"; service.Retry(); await Until(service, status => status.GetProperty("update_required").GetBoolean());
                fixture.FailLatest = true; service.Retry(); await Task.Delay(100);
                Assert(service.IsUpdateRequired, "Offline check preserves mandatory state");
                service.Dispose(); await service.Completion!;
            }
            using (var restored = new ProgramUpdateService(fixture.Backend, mandatoryCache, "1.0.0", handler: fixture.Handler())) {
                restored.Start(); Assert(restored.IsUpdateRequired, "Mandatory state survives process restart offline");
                await Until(restored, Ready);
                using var frontend = new DesktopFrontendService(FreePort(),fixture.Backend,new Uri("http://127.0.0.1:1/"),Path.GetFullPath("MoonYa-Frontend/dist"));
                frontend.Updates = restored; Assert(frontend.Start(), "Gateway starts for mandatory update checks");
                using var http = new HttpClient(); http.DefaultRequestHeaders.Add("X-MoonYa-Gateway",frontend.GatewayToken);
                var blocked = await http.PostAsync(new Uri(frontend.BaseAddress,"gateway/local/harness_api.php"),new StringContent("{}"));
                Assert((int)blocked.StatusCode == 426, "New user turns blocked at gateway");
                var resume = await http.PostAsync(new Uri(frontend.BaseAddress,"gateway/local/harness_api.php"),new StringContent("{\"resume\":{\"after_seq\":1}}"));
                Assert((int)resume.StatusCode == 401, "Resume continues to normal identity check rather than update rejection");
                var approval = await http.PostAsync(new Uri(frontend.BaseAddress,"gateway/local/harness_api.php?action=approval"),new StringContent("{}"));
                Assert((int)approval.StatusCode == 401, "Accepted-turn approval is not blocked by updates");
                restored.Dispose(); await restored.Completion!;
            }
            fixture.FailLatest = false; fixture.EmptyLatest = true;
            using (var withdrawn = new ProgramUpdateService(fixture.Backend,mandatoryCache,"1.0.0",handler:fixture.Handler())) {
                withdrawn.Start(); await Until(withdrawn,status=>status.GetProperty("release").ValueKind == JsonValueKind.Null);
                Assert(!withdrawn.IsUpdateRequired,"Withdrawing all releases clears the confirmed requirement"); withdrawn.Dispose(); await withdrawn.Completion!;
            }
            var readStore = new AnnouncementReadStore(fixture.Backend,Path.Combine(root,"read"));
            await Task.WhenAll(readStore.AcknowledgeAsync(1,2),readStore.AcknowledgeAsync(1,1),readStore.AcknowledgeAsync(2,1));
            var savedRead = await new AnnouncementReadStore(fixture.Backend,Path.Combine(root,"read")).ReadAsync();
            Assert(savedRead["1"] == 2 && savedRead["2"] == 1,"Device read records survive restart and never regress");
            Assert((await new AnnouncementReadStore(new Uri("http://different.invalid/"),Path.Combine(root,"read")).ReadAsync()).Count == 0,"Backend addresses have separate acknowledgements");
            Console.WriteLine("Program updates and announcements smoke passed: downloads, mandatory refresh/offline/gateway, device read persistence.");
        } finally {
            Environment.SetEnvironmentVariable("MOONYA_SMOKE_DATA",previousData);
            var resolved = Path.GetFullPath(root);
            if (Path.GetDirectoryName(resolved) == Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) && Path.GetFileName(resolved).StartsWith("moonya-update-smoke-")) Directory.Delete(resolved, true);
        }
    }
    private static int FreePort() { var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback,0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
    private static bool Ready(JsonElement status) => status.GetProperty("state").GetString() == "ready";
    private static async Task Until(ProgramUpdateService service, Func<JsonElement, bool> predicate)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline) {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(service.Snapshot()));
            if (predicate(json.RootElement)) return;
            await Task.Delay(10);
        }
        throw new Exception("Update state timed out: " + JsonSerializer.Serialize(service.Snapshot()));
    }
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Fixture
    {
        internal Uri Backend = new("http://127.0.0.1:12345/");
        internal byte[] Bytes = RandomNumberGenerator.GetBytes(262144);
        internal string Version = "1.0.1";
        internal int FailAfter = 65536, Delay;
        internal bool IgnoreRange, BadRange, RejectRange;
        internal string? Minimum;
        internal bool FailLatest, EmptyLatest;
        internal List<long> Offsets = new();
        internal HttpMessageHandler Handler() => new HandlerImpl(this);
        private sealed class HandlerImpl(Fixture fixture) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                var hash = Convert.ToHexString(SHA256.HashData(fixture.Bytes)).ToLowerInvariant();
                if (request.RequestUri!.Query.Contains("action=latest")) {
                    if (fixture.FailLatest) throw new HttpRequestException("offline fixture");
                    if (fixture.EmptyLatest) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"success\":true,\"data\":null}") });
                    var id = fixture.Version == "1.0.1" ? 1 : 2;
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { success = true, data = new { id, version = fixture.Version, notes = "fixture", minimum_required_version = fixture.Minimum, size = fixture.Bytes.Length, sha256 = hash, download_url = "admin/api/updates.php?action=download&id=" + id } }), Encoding.UTF8, "application/json") });
                }
                var requested = request.Headers.Range?.Ranges.Single().From ?? 0; fixture.Offsets.Add(requested);
                if (fixture.RejectRange) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.RequestedRangeNotSatisfiable) { Content = new ByteArrayContent(Array.Empty<byte>()) });
                var offset = fixture.IgnoreRange ? 0 : requested;
                var response = new HttpResponseMessage(requested > 0 && !fixture.IgnoreRange ? HttpStatusCode.PartialContent : HttpStatusCode.OK);
                response.Headers.ETag = new EntityTagHeaderValue("\"" + hash + "\"");
                response.Content = new StreamContent(new BodyStream(fixture.Bytes, (int)offset, fixture.FailAfter, fixture.Delay));
                response.Content.Headers.ContentLength = fixture.Bytes.Length - offset;
                if (response.StatusCode == HttpStatusCode.PartialContent) response.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset + (fixture.BadRange ? 1 : 0), fixture.Bytes.Length - 1, fixture.Bytes.Length);
                return Task.FromResult(response);
            }
        }
        private sealed class BodyStream(byte[] bytes, int offset, int failAfter, int delay) : Stream
        {
            private int _position = offset;
            public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
            public override long Length => bytes.Length; public override long Position { get => _position; set => throw new NotSupportedException(); }
            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            {
                if (delay > 0) await Task.Delay(delay, cancellationToken);
                if (failAfter >= 0 && _position >= failAfter) throw new IOException("fixture interrupted");
                var count = Math.Min(4096, Math.Min(buffer.Length, bytes.Length - _position));
                bytes.AsMemory(_position, count).CopyTo(buffer); _position += count; return count;
            }
            public override int Read(byte[] buffer, int start, int count) => ReadAsync(buffer.AsMemory(start, count)).AsTask().GetAwaiter().GetResult();
            public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }
    }
}
