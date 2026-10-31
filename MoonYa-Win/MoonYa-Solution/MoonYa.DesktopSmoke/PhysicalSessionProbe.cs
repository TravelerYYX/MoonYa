using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using MoonYa.Services;

internal static class PhysicalSessionProbe
{
    // Real DXGI, WPF affinity and session lifecycle. No application input or display settings changes.
    public static void Run(string output)
    {
        Exception? failure = null;
        var thread = new Thread(() => {
            var app = new Application();
            var window = new Window { Title = "MoonYa physical lifecycle test", Width = 260, Height = 120, ShowActivated = false };
            window.Loaded += async (_, _) => {
                var service = DesktopAutomationService.Current;
                try {
                    Directory.CreateDirectory(output);
                    var handle = new WindowInteropHelper(window).Handle;
                    Check(GetWindowDisplayAffinity(handle, out var original), "read original affinity");
                    using var started = JsonDocument.Parse(JsonSerializer.Serialize(await service.StartAsync("physical-probe")));
                    Check(started.RootElement.GetProperty("display").GetProperty("provider").GetString() == "physical", "physical provider");
                    Check(GetWindowDisplayAffinity(handle, out var active) && active == 0x11, "window excluded from capture");
                    using var busy = JsonDocument.Parse(JsonSerializer.Serialize(await service.StartAsync("other-chat")));
                    Check(busy.RootElement.GetProperty("error_code").GetString() == "desktop_busy", "single chat ownership");
                    var empty = JsonSerializer.SerializeToElement(new { });
                    using var shot = JsonDocument.Parse(JsonSerializer.Serialize(await service.RpcAsync("physical-probe", "screenshot", empty, false)));
                    var bounds = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
                    Check(shot.RootElement.GetProperty("width").GetInt32() == bounds.Width && shot.RootElement.GetProperty("height").GetInt32() == bounds.Height, "native primary dimensions");
                    await File.WriteAllBytesAsync(Path.Combine(output, "physical-lifecycle.png"), Convert.FromBase64String(shot.RootElement.GetProperty("image").GetString()!));
                    await service.ControlAsync("physical-probe", "takeover");
                    await Reject(() => service.RpcAsync("physical-probe", "hover", JsonSerializer.SerializeToElement(new { x = 500, y = 500 }), true), "preview forwarding rejected");
                    await service.ControlAsync("physical-probe", "resume");
                    await Reject(() => service.RpcAsync("physical-probe", "hover", JsonSerializer.SerializeToElement(new { x = 500, y = 500 }), false), "resume needs observation");
                    await service.RpcAsync("physical-probe", "screenshot", empty, false);
                    // Simulate a stale DPI lease without changing Windows settings.
                    var dpi = typeof(DesktopAutomationService).GetField("_dpiX", BindingFlags.Instance | BindingFlags.NonPublic)!;
                    dpi.SetValue(service, (uint)dpi.GetValue(service)! + 1);
                    await Reject(() => service.RpcAsync("physical-probe", "screenshot", empty, false), "DPI change invalidates lease");
                    Check(GetWindowDisplayAffinity(handle, out var restored) && restored == original, "affinity restored on failure");
                    await service.StartAsync("next-chat");
                    await service.ControlAsync("next-chat", "stop");
                    Check(GetWindowDisplayAffinity(handle, out restored) && restored == original, "affinity restored on stop");
                    await service.StartAsync("after-stop");
                    await service.StopAsync("after-stop");
                    Console.WriteLine("Physical capture, affinity, ownership, direct takeover, resume observation, DPI invalidation and stop/reconnect passed.");
                } catch (Exception error) { failure = error; }
                finally { await service.EndSessionAsync(); service.Dispose(); app.Shutdown(); }
            };
            app.Run(window);
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
        if (!thread.Join(TimeSpan.FromSeconds(30))) throw new TimeoutException("Physical lifecycle probe timed out.");
        if (failure != null) throw failure;
    }
    private static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
    private static async Task Reject(Func<Task<object>> action, string message) {
        try { await action(); } catch (InvalidOperationException) { return; }
        throw new Exception(message);
    }
    [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
}
