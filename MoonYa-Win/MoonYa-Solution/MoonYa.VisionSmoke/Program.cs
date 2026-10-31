using System.Text.Json;
using System.Reflection;
using MoonYa.Services;

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

// Use exactly the options used by /cu-op; even an observe request with no target
// used to throw when the serializer discovered the duplicate mapped property.
var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
var observe = JsonSerializer.Deserialize<CuOpRequest>("""{"action":"computer_observe","goal":"inspect"}""", options)!;
Check(observe.VisualFallback ?? true, "observe must default to including an image");
var textOnly = JsonSerializer.Deserialize<CuOpRequest>("""{"action":"computer_observe","visual_fallback":false}""", options)!;
Check(textOnly.VisualFallback == false, "explicit text-only observations must remain supported");
var screenshot = JsonSerializer.Deserialize<CuOpRequest>("""{"action":"take_screenshot","target":"screen"}""", options)!;
Check(screenshot.Target == "screen", "legacy screenshot target must remain compatible");
var interaction = JsonSerializer.Deserialize<CuOpRequest>("""{"action":"computer_interact","target":"保存按钮","operation":"invoke"}""", options)!;
Check(interaction.Target == "保存按钮", "semantic interaction target must deserialize");
interaction.Candidates = JsonSerializer.SerializeToElement(Array.Empty<object>());
interaction.Candidate = JsonSerializer.SerializeToElement<object?>(null);
Check(JsonSerializer.SerializeToElement(interaction).GetProperty("target").GetString() == "保存按钮", "target must round-trip under one wire name");
Console.WriteLine("CU visual request contracts: PASS");

// Optional read-only desktop probe. It never clicks, opens a window, or sends
// captured content externally. Run with --observe on an interactive desktop.
if (args.Contains("--observe"))
{
    var desktop = new DesktopComputerService(new ComputerUseService());
    var observation = JsonSerializer.SerializeToElement(desktop.Observe("verify visual input", null, true));
    Check(observation.GetProperty("success").GetBoolean(), "desktop probe failed: " + observation.GetRawText());
    var image = observation.GetProperty("image").GetString();
    Check(!string.IsNullOrEmpty(image), "desktop must return actual image bytes");
    Check(Convert.FromBase64String(image!).AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }), "desktop observation must be a PNG");
    Check(!string.IsNullOrEmpty(observation.GetProperty("snapshot_version").GetString()), "visual observation must retain its snapshot version");
    Console.WriteLine("Read-only desktop screenshot: PASS");
    var noImage = JsonSerializer.SerializeToElement(desktop.Observe("verify text-only observation", null, false));
    Check(noImage.GetProperty("success").GetBoolean(), "text-only desktop probe failed");
    Check(noImage.GetProperty("image").ValueKind == JsonValueKind.Null, "text-only observation must omit image bytes");
    Console.WriteLine("Explicit text-only observation: PASS");

    var constructor = typeof(DesktopComputerService).GetConstructor(BindingFlags.Instance | BindingFlags.NonPublic,
        null, new[] { typeof(ComputerUseService), typeof(Func<IntPtr, object>) }, null)!;
    var unavailable = (DesktopComputerService)constructor.Invoke(new object[] {
        new ComputerUseService(), new Func<IntPtr, object>(_ => throw new InvalidOperationException("fixture UIA unavailable"))
    });
    var fallback = JsonSerializer.SerializeToElement(unavailable.Observe("verify UIA visual fallback", null, true));
    Check(fallback.GetProperty("success").GetBoolean(), "UIA failure must not discard the visual observation");
    Check(fallback.GetProperty("layer").GetString() == "gui", "missing accessibility must use visual evidence");
    Check(!string.IsNullOrEmpty(fallback.GetProperty("image").GetString()), "UIA fallback must supply actual PNG bytes");
    Check(fallback.GetProperty("accessibility").GetProperty("failure").GetProperty("failure_code").GetString() == "uia_provider_error", "UIA failure evidence must remain available");
    var withoutFallback = JsonSerializer.SerializeToElement(unavailable.Observe("no visual fallback", null, false));
    Check(!withoutFallback.GetProperty("success").GetBoolean(), "UIA failure without a screenshot must remain an explicit failure");
    Console.WriteLine("UIA failure with/without screenshot: PASS");
}
