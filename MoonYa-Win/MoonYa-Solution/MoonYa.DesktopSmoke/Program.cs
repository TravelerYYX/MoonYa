using System.Drawing;
using System.Text.Json;
using MoonYa.Services;

static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
if (args.Length == 2 && args[0] == "--physical-session") {
    PhysicalSessionProbe.Run(Path.GetFullPath(args[1]));
    return;
}
if (args.Length is 1 or 2 && args[0] == "--live-window") {
    Console.WriteLine(JsonSerializer.Serialize(LiveWindowProbe.Observe(args.Length == 2 ? args[1] : null)));
    return;
}
if (args.Length == 1 && args[0] == "--window-inventory") {
    Console.WriteLine(JsonSerializer.Serialize(LiveWindowProbe.Inventory()));
    return;
}
if (args.Length == 1 && args[0] == "--activate-viewer") {
    LiveWindowProbe.ActivateViewer();
    Console.WriteLine(JsonSerializer.Serialize(LiveWindowProbe.Observe(null)));
    return;
}
var observedTime = DateTime.UtcNow;
var observedRect = new Rectangle(2800, 200, 400, 600);
Check(DesktopAutomationService.DesktopObservationMatches(observedTime, observedTime.AddSeconds(1), new IntPtr(42), observedRect, new IntPtr(42), observedRect), "unchanged foreground and geometry retain observation");
Check(!DesktopAutomationService.DesktopObservationMatches(observedTime, observedTime.AddSeconds(31), new IntPtr(42), observedRect, new IntPtr(42), observedRect), "expired observations are rejected");
Check(!DesktopAutomationService.DesktopObservationMatches(observedTime, observedTime.AddSeconds(1), new IntPtr(42), observedRect, new IntPtr(43), observedRect), "a different foreground requires fresh observation");
Check(!DesktopAutomationService.DesktopObservationMatches(observedTime, observedTime.AddSeconds(1), new IntPtr(42), observedRect, new IntPtr(42), new Rectangle(2801, 200, 400, 600)), "changed target geometry requires fresh observation");
if (args.Length == 3 && args[0] == "--preview-style") {
    Exception? renderError = null;
    var renderThread = new Thread(() => {
        try {
            var bitmap = new System.Windows.Media.Imaging.BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad; bitmap.UriSource = new Uri(Path.GetFullPath(args[1])); bitmap.EndInit(); bitmap.Freeze();
            var window = new MoonYa.VirtualScreenWindow("offline-layout", "{}", false);
            window.SetVerificationFrame(bitmap);
            var content = (System.Windows.FrameworkElement)window.Content;
            content.Measure(new System.Windows.Size(800, 620)); content.Arrange(new System.Windows.Rect(0, 0, 800, 620)); content.UpdateLayout();
            var rendered = new System.Windows.Media.Imaging.RenderTargetBitmap(800, 620, 96, 96, System.Windows.Media.PixelFormats.Pbgra32); rendered.Render(content);
            var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder(); encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(rendered));
            using var output = File.Create(Path.GetFullPath(args[2])); encoder.Save(output);
            window.Close();
        } catch (Exception ex) { renderError = ex; }
    });
    renderThread.SetApartmentState(ApartmentState.STA); renderThread.Start(); renderThread.Join();
    if (renderError != null) throw renderError;
    Console.WriteLine("Preview layout rendered offline; no MoonYa client, connection or display was started.");
    return;
}
if (args.Length == 1 && args[0] == "--display-inventory") {
    Console.WriteLine(JsonSerializer.Serialize(new { displays = DisplayIdentity.Enumerate(), screens = System.Windows.Forms.Screen.AllScreens.Select(s => new { device = s.DeviceName, primary = s.Primary, bounds = s.Bounds }) }, new JsonSerializerOptions { WriteIndented = true }));
    return;
}
var displayFixture = new DisplayCandidate("virtual", "Same name", "monitor-path", new[] { "DISPLAY\\MONITOR", "ROOT\\DISPLAY\\0042" });
Check(DisplayIdentity.SelectOwned(new[] { displayFixture, new DisplayCandidate("physical", "Same name", "other-path", new[] { "PCI\\GPU" }) }, "root\\display\\0042") == displayFixture, "PnP ancestry selects the installation rather than the name");
foreach (var candidates in new[] { Array.Empty<DisplayCandidate>(), new[] { displayFixture, displayFixture }, new[] { displayFixture with { MonitorPath = "" } }, new[] { displayFixture with { Primary = true } } }) {
    try { DisplayIdentity.SelectOwned(candidates, "ROOT\\DISPLAY\\0042"); throw new Exception("invalid display identity accepted"); }
    catch (InvalidOperationException) { }
}
var fixtureRecord = Path.Combine(Path.GetTempPath(), "moonya-vdd-" + Guid.NewGuid() + ".json");
try {
    File.WriteAllText(fixtureRecord, JsonSerializer.Serialize(new { provider = "virtualdrivers", status = "installed", device_instance_id = "ROOT\\DISPLAY\\0042" }));
    var connectedDisplays = new[] { displayFixture };
    using var backend = new PersistentDisplayBackend(fixtureRecord, () => connectedDisplays, _ => 0);
    Check(await backend.AcquireAsync() == "virtual" && await backend.AcquireAsync() == "virtual", "persistent display acquisition is repeatable");
    Check(backend.IsAvailable("virtual"), "acquired display remains available");
    connectedDisplays = new[] { displayFixture with { MonitorPath = "replaced-monitor" } };
    Check(!backend.IsAvailable("virtual"), "a changed display path invalidates the lease");
    connectedDisplays = Array.Empty<DisplayCandidate>();
    Check(!backend.IsAvailable("virtual"), "disconnect invalidates the lease");
    connectedDisplays = new[] { displayFixture };
    backend.Dispose();
    Check(connectedDisplays.Length == 1, "release does not remove a persistent monitor");
    Check(await backend.AcquireAsync() == "virtual", "persistent display can be reacquired after release");
    var problem = 22; var enabledCalls = 0;
    connectedDisplays = Array.Empty<DisplayCandidate>();
    using var disabledBackend = new PersistentDisplayBackend(fixtureRecord, () => connectedDisplays, _ => problem, record => {
        Check(record == fixtureRecord, "enable component receives only its installation record");
        enabledCalls++; problem = 0; connectedDisplays = new[] { displayFixture }; return Task.CompletedTask;
    });
    Check(await disabledBackend.AcquireAsync() == "virtual" && enabledCalls == 1, "disabled installed device is enabled once by the host");
    Check(await disabledBackend.AcquireAsync() == "virtual" && enabledCalls == 1, "an enabled device is not re-enabled");
    problem = 10;
    try { await disabledBackend.AcquireAsync(); throw new Exception("driver failure treated as disabled"); } catch (InvalidOperationException) { }
    Check(enabledCalls == 1, "driver failures do not replay lifecycle side effects");
} finally { File.Delete(fixtureRecord); }
if (args.Length == 2 && args[0] == "--runtime-check") {
    using var runtime = new AgentRuntimeService(Path.GetFullPath(args[1]), Console.WriteLine);
    await runtime.StartAsync();
    using var client = new System.Net.Http.HttpClient { BaseAddress = runtime.BaseAddress };
    using var tools = JsonDocument.Parse(await client.GetStringAsync("v1/tools"));
    var toolNames = tools.RootElement.GetProperty("tools").EnumerateArray()
        .Select(tool => tool.GetProperty("function").GetProperty("name").GetString()).ToArray();
    Check(toolNames.Contains("computer_use_tool") && !toolNames.Contains("computer_observe") && !toolNames.Contains("computer_interact"), "runtime tool catalog matches the skill");
    Console.WriteLine("Runtime startup and capability checks passed.");
    return;
}
foreach (var health in new[] {
    ("{\"product\":\"MoonYa Agent Runtime\",\"protocol_version\":1}", false),
    ("{\"runtime_capability_version\":2,\"capabilities\":[\"desktop-python-v1\"]}", false),
    ("{\"runtime_capability_version\":2,\"capabilities\":[\"desktop-python-v1\",\"atomic-tool-compaction-v1\",\"tool-history-validation-v1\"]}", true)
}) {
    using var doc = JsonDocument.Parse(health.Item1);
    Check(AgentRuntimeService.HasRequiredCapabilities(doc.RootElement) == health.Item2, "runtime capability compatibility");
}
foreach (var bounds in new[] { new Rectangle(1920, 0, 1920, 1080), new Rectangle(-1920, -1080, 1920, 1080), new Rectangle(0, 0, 2560, 1440) }) {
    Check(DesktopAutomationService.MapPoint(bounds, 0, 0) == bounds.Location, "top-left mapping");
    Check(DesktopAutomationService.MapPoint(bounds, 1000, 1000) == new Point(bounds.Right - 1, bounds.Bottom - 1), "bottom-right mapping");
    var point = DesktopAutomationService.MapPoint(bounds, 500, 500);
    Check(Math.Abs(point.X - (bounds.Left + bounds.Width / 2)) <= 1 && Math.Abs(point.Y - (bounds.Top + bounds.Height / 2)) <= 1, "center mapping");
}
var service = DesktopAutomationService.Current;
var desktopConfig = Path.Combine(AppContext.BaseDirectory, "launcher_config.json");
if (File.Exists(desktopConfig)) {
    using var config = JsonDocument.Parse(File.ReadAllText(desktopConfig));
    if (config.RootElement.TryGetProperty("desktop_automation", out var desktopSection)
        && desktopSection.GetProperty("provider").GetString() == "disabled") {
        var recordPath = Environment.ExpandEnvironmentVariables(desktopSection.GetProperty("installation_record").GetString()!);
        string? installedInstance = null;
        if (File.Exists(recordPath)) {
            using var record = JsonDocument.Parse(File.ReadAllText(recordPath));
            installedInstance = record.RootElement.GetProperty("device_instance_id").GetString();
        }
        var previousProblem = installedInstance == null ? (int?)null : DisplayIdentity.DeviceProblem(installedInstance);
        var rejected = false;
        try { await service.StartAsync("migration-disabled-check"); }
        catch (InvalidOperationException error) { rejected = error.Message.Contains("旧扩展屏方案已停用", StringComparison.Ordinal); }
        Check(rejected, "a desktop task cannot start while the isolation migration is blocked");
        Check(installedInstance == null || DisplayIdentity.DeviceProblem(installedInstance) == previousProblem,
            "the rejected start must not change the installed display device state");
    }
}
using var preview = JsonDocument.Parse(await service.PreviewAsync("nonexistent-session", 58900));
Check(!preview.RootElement.GetProperty("success").GetBoolean(), "a preview token must not be granted for another session");
try { await service.ControlAsync("nonexistent-session", "takeover"); throw new Exception("missing owner accepted"); }
catch (InvalidOperationException) { }
service.Dispose();
Console.WriteLine("Desktop geometry and ownership checks passed. No display was created and no input was sent.");
