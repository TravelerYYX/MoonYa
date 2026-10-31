using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using MoonYa.Services;

Console.OutputEncoding = new System.Text.UTF8Encoding(false);
if (args.Length == 1 && args[0] == "--updates-smoke") { await ProgramUpdateSmoke.RunAsync(); return 0; }
if (args.Length == 3 && args[0] == "--update-integration-host") {
    var backend = new Uri(args[1]);
    using var updater = new ProgramUpdateService(backend, version: "0.9.0");
    using var frontend = new DesktopFrontendService(FreePort(), backend, new Uri("http://127.0.0.1:1/"), args[2]);
    frontend.Updates = updater;
    updater.ShutdownRequested = () => Environment.Exit(0);
    if (!frontend.Start()) throw new Exception(frontend.StartupError);
    updater.Start();
    Console.WriteLine(JsonSerializer.Serialize(new { url = frontend.BaseAddress.AbsoluteUri, token = frontend.GatewayToken }));
    await Task.Delay(Timeout.Infinite);
    return 0;
}
if (args.Length == 1 && args[0] == "--payment-activation-smoke") {
    var order = "MYfixture0000000001";
    if (PaymentActivationService.OrderFromUri("moonya://payment/return?order_no=" + order) != order) throw new Exception("Payment URI rejected");
    foreach (var invalid in new[]{"moonya://payment/return?order_no=x", "moonya://payment/return?order_no=" + order + "&url=https://evil.invalid", "moonya://execute/return?order_no=" + order, "https://payment/return?order_no=" + order})
        if (PaymentActivationService.OrderFromUri(invalid) != null) throw new Exception("Invalid URI accepted");
    using var activation = new PaymentActivationService();
    var received = new System.Collections.Concurrent.ConcurrentQueue<string>();
    activation.Start(received.Enqueue);
    for (var i = 0; i < 3; i++) if (!await Task.Run(() => PaymentActivationService.TryForward(order))) throw new Exception("Existing instance did not accept payment return");
    if (received.Count != 3 || received.Any(value => value != order)) throw new Exception("Payment activation lost an order");
    activation.Dispose();
    if (await Task.Run(() => PaymentActivationService.TryForward(order))) throw new Exception("Stopped listener accepted payment return");
    Console.WriteLine("Payment activation smoke passed: URI validation, existing-instance forwarding, repeated activation, cold-start fallback");
    return 0;
}
var port = args.Length > 3 ? int.Parse(args[3]) : FreePort();
using var service = new DesktopFrontendService(port, new Uri(args[1]), new Uri(args[2]), args[0]);
using var updates = Environment.GetEnvironmentVariable("MOONYA_SMOKE_UPDATES") == "1" ? new ProgramUpdateService(new Uri(args[1]), version: "1.0.0") : null;
service.Updates = updates;
updates?.Start();
if (!service.Start()) { Console.Error.WriteLine(service.StartupError); return 1; }
Console.WriteLine(JsonSerializer.Serialize(new { url = service.BaseAddress.AbsoluteUri, token = service.GatewayToken, runtimeSecret = service.RuntimeSecret }));
await Console.In.ReadLineAsync();
return 0;
static int FreePort() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var result = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return result; }

namespace MoonYa {
    internal static class App {
        internal static Uri? FileServiceBaseAddress => Uri.TryCreate(Environment.GetEnvironmentVariable("MOONYA_SMOKE_FILE_SERVICE"), UriKind.Absolute, out var address) ? address : null;
        internal static Uri? ExecutionServiceBaseAddress => null;
        internal static Uri? BrowserServiceBaseAddress => null;
        internal static SmokeGate? BrowserSecurityGate => null;
        internal static SmokeBrowserApi BrowserApi { get; } = new();
        internal static SmokeMediaAccess AppearancePreferences { get; } = new();
        internal static FileOperationService LocalFileService { get; } = CreateFiles();
        private static FileOperationService CreateFiles() {
            var path = AppDataPaths.PathFor("files.json");
            File.WriteAllText(path, JsonSerializer.Serialize(new { file_operations = new {
                allowed_roots = new[] { AppDataPaths.PathFor("unused-root") }, blocked_paths = Array.Empty<string>(), max_file_size_mb = 64, enable_delete = false } }));
            var files = new FileOperationService(path);
            var granted = JsonSerializer.Deserialize<string[]>(Environment.GetEnvironmentVariable("MOONYA_SMOKE_GRANTED_FILES") ?? "[]")!;
            if (granted.Length > 0) files.GrantDroppedFiles(granted);
            return files;
        }
        internal static Task<string> ExecuteMcpOpAsync(string body) => Task.FromResult("{}");
    }
    internal sealed class SmokeGate {
        public object[] ListPersistentPermissions() => Array.Empty<object>();
        public bool RevokeSessionPermission(string host, string user) => false;
    }
    internal sealed class SmokeMediaAccess {
        public bool IsAllowedMediaPath(string path) => false;
        public bool IsLocallyGrantedFile(string path) => false;
    }
    internal sealed class SmokeBrowserApi {
        private readonly BrowserPreferences _preferences = new(AppDataPaths.PathFor("browser-preferences.json"));
        public object PreferencesSnapshot() => _preferences.Snapshot();
        public async Task<object> SavePreferencesAsync(bool chrome, bool edge) { await _preferences.SaveAsync(chrome, edge); return _preferences.Snapshot(); }
    }
}
namespace MoonYa.Services {
    internal static class AppDataPaths {
        internal static string PathFor(params string[] parts) => Path.Combine(new[]{Environment.GetEnvironmentVariable("MOONYA_SMOKE_DATA")!}.Concat(parts).ToArray());
    }
}
