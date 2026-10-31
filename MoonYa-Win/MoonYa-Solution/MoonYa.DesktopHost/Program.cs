using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace MoonYa.DesktopHost;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // This is a feasibility gate, not a production backend. There is no
        // path which starts on, captures, or sends input to the Default desktop.
        if (args.Length < 3 || (args[0] != "--probe" && args[0] != "--diagnose")) {
            Console.Error.WriteLine("Usage: MoonYa.DesktopHost --probe OUTPUT_DIRECTORY APPLICATION [ARGUMENTS] [ACTIONS_JSON] [PACKAGE_FAMILY]");
            return 2;
        }
        var output = Path.GetFullPath(args[1]);
        Directory.CreateDirectory(output);
        var before = HiddenDesktop.PhysicalState();
        object? launch = null;
        object[] windows = [];
        object[] controls = [];
        object? input = null;
        string? failure = null;
        uint? processId = null;
        var desktopName = "MoonYa-Probe-" + Guid.NewGuid().ToString("N");
        void Probe() {
        try {
            using var desktop = new HiddenDesktop(desktopName, args.Length > 5 ? args[5] : null);
            launch = desktop.Launch(Path.GetFullPath(args[2]), args.Length > 3 ? args[3] : "", args[0] == "--diagnose" ? output : null);
            processId = desktop.ProcessId;
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(12)) {
                windows = desktop.Windows();
                if (windows.Length > 0) break;
                if (desktop.HasExited) throw new InvalidOperationException($"Application exited before creating a hidden-desktop window (exit 0x{desktop.ExitCode:X8}).");
                Thread.Sleep(100);
            }
            if (windows.Length == 0) throw new InvalidOperationException("Application created no window on the owned hidden desktop within 12 seconds.");
            Thread.Sleep(1000);
            desktop.Capture(Path.Combine(output, "before.png"));
            controls = desktop.Controls();
            File.WriteAllText(Path.Combine(output, "controls.json"), JsonSerializer.Serialize(controls, JsonOptions));
            // Optional input gate: coordinates and text are test inputs, never
            // application-name branches or production calculator scripts.
            if (args.Length > 4 && args[4].Length > 0) {
                using var actions = JsonDocument.Parse(File.ReadAllText(args[4]));
                var results = new List<object>();
                foreach (var action in actions.RootElement.EnumerateArray()) {
                    results.Add(desktop.Execute(action));
                    Thread.Sleep(150);
                }
                input = results;
                Thread.Sleep(500);
                desktop.Capture(Path.Combine(output, "after.png"));
                controls = desktop.Controls();
                File.WriteAllText(Path.Combine(output, "controls-after.json"), JsonSerializer.Serialize(controls, JsonOptions));
            }
            windows = desktop.Windows();
        } catch (Exception error) {
            failure = error.ToString();
        }
        }
        // Screen/UIA initialization may create windows on the main thread.
        // Bind a pristine worker before invoking any windowing or COM API.
        var worker = new Thread(Probe);
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        var timedOut = !worker.Join(TimeSpan.FromSeconds(35));
        if (timedOut) failure = "Hidden-desktop probe exceeded its 35-second capture/input deadline. Worker process will exit and its job will clean up owned children.";
        var after = HiddenDesktop.PhysicalState();
        var report = new { feasibility_only = true, desktop_name = desktopName, application = args[2], process_id = processId,
            launch, windows, controls, input, failure, physical_before = before, physical_after = after,
            process_cleanup_verified = processId == null || !HiddenDesktop.ProcessExists(processId.Value) };
        File.WriteAllText(Path.Combine(output, "report.json"), JsonSerializer.Serialize(report, JsonOptions));
        Console.WriteLine(JsonSerializer.Serialize(new { success = failure == null, desktop_name = desktopName, process_id = processId, failure, report = Path.Combine(output, "report.json") }, JsonOptions));
        if (timedOut) Environment.Exit(1);
        return failure == null ? 0 : 1;
    }
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true, IncludeFields = true };
}
