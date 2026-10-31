using System.IO;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Web.Script.Serialization;
using FarSide_安装程序.Services;

if (args.Length == 3 && args[0] == "--e2e-parent") {
    var state = Path.GetFullPath(args[2]); Directory.CreateDirectory(state);
    using var current = Process.GetCurrentProcess();
    var request = new UpdateRequest {
        Protocol = 1, ParentId = current.Id, ParentStartTicks = current.StartTime.ToUniversalTime().Ticks,
        InstallDirectory = Path.GetDirectoryName(current.MainModule!.FileName)!, TargetVersion = "1.0.0",
        ResultFile = Path.Combine(state, "install-result.json"), PipeName = "MoonYa.Update." + Guid.NewGuid().ToString("N"),
        Nonce = (Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N")).ToUpperInvariant()
    };
    var file = Path.Combine(state, "request-" + Guid.NewGuid().ToString("N") + ".json");
    File.WriteAllText(file, new JavaScriptSerializer().Serialize(request));
    using var pipe = new NamedPipeServerStream(request.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
    using var installer = Process.Start(new ProcessStartInfo(Path.GetFullPath(args[1])) { UseShellExecute = false, Arguments = "--update --request \"" + file + "\"", WorkingDirectory = state });
    if (!pipe.WaitForConnectionAsync().Wait(120000)) throw new Exception("Installer did not connect");
    using var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true);
    using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true };
    var ready = reader.ReadLineAsync();
    if (!ready.Wait(120000) || ready.Result != request.Nonce + ":ready") throw new Exception("Installer readiness failed: " + (ready.IsCompleted ? ready.Result : "timeout"));
    writer.WriteLine("exit");
    var accepted = reader.ReadLineAsync();
    if (!accepted.Wait(10000) || accepted.Result != request.Nonce + ":accepted") throw new Exception("Worker did not accept the update");
    File.WriteAllText(Path.Combine(state, "parent-exited.txt"), current.Id.ToString());
    return 0;
}
if (args.Length == 0 && Environment.GetEnvironmentVariable("MOONYA_UPDATE_E2E_RESTART") is string restart && !string.IsNullOrEmpty(restart)) {
    File.WriteAllText(restart, Process.GetCurrentProcess().MainModule!.FileName);
    return 0;
}

var root = Path.Combine(Path.GetTempPath(), "moonya-installer-smoke-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try {
    var target = Path.Combine(root, "原安装目录 with spaces"); var stage = Path.Combine(root, "stage"); var work = Path.Combine(root, "work");
    Directory.CreateDirectory(target); Directory.CreateDirectory(stage); Directory.CreateDirectory(work);
    File.WriteAllText(Path.Combine(target, "a.dll"), "old"); File.WriteAllText(Path.Combine(target, "personal.txt"), "user data");
    Directory.CreateDirectory(Path.Combine(target, ".MoonYa")); File.WriteAllText(Path.Combine(target, ".MoonYa", "history.json"), "history");
    File.WriteAllText(Path.Combine(stage, "a.dll"), "new"); Directory.CreateDirectory(Path.Combine(stage, "frontend")); File.WriteAllText(Path.Combine(stage, "frontend", "index.html"), "new UI");
    UpdateInstaller.ApplyTransaction(target, stage, work);
    Check(File.ReadAllText(Path.Combine(target, "a.dll")) == "new", "replace program files");
    Check(File.ReadAllText(Path.Combine(target, "personal.txt")) == "user data", "preserve unowned files");
    Check(File.ReadAllText(Path.Combine(target, ".MoonYa", "history.json")) == "history", "preserve user history");
    var second = Path.Combine(root, "second"); Directory.CreateDirectory(second); File.WriteAllText(Path.Combine(second, "a.dll"), "newer");
    UpdateInstaller.ApplyTransaction(target, second, Path.Combine(root, "work2"));
    Check(!File.Exists(Path.Combine(target, "frontend", "index.html")), "remove only obsolete manifest-owned files");
    var failure = Path.Combine(root, "failure"); Directory.CreateDirectory(failure); File.WriteAllText(Path.Combine(failure, "a.dll"), "broken-new"); File.WriteAllText(Path.Combine(failure, "b.dll"), "new b");
    File.WriteAllText(Path.Combine(target, "b.dll"), "old b");
    using (var locked = new FileStream(Path.Combine(target, "b.dll"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
        ExpectFailure(() => UpdateInstaller.ApplyTransaction(target, failure, Path.Combine(root, "work3")));
        Check(File.ReadAllText(Path.Combine(target, "a.dll")) == "newer", "restore original files after write failure");
    }
    Check(File.ReadAllText(Path.Combine(target, "b.dll")) == "old b", "locked file preserved");
    var unsafeStage = Path.Combine(root, "unsafe"); Directory.CreateDirectory(Path.Combine(unsafeStage, ".MoonYa")); File.WriteAllText(Path.Combine(unsafeStage, ".MoonYa", "history.json"), "destroy");
    ExpectFailure(() => UpdateInstaller.ApplyTransaction(target, unsafeStage, Path.Combine(root, "work4")));
    Check(File.ReadAllText(Path.Combine(target, ".MoonYa", "history.json")) == "history", "reject payload targeting user data");
    File.WriteAllText(Path.Combine(target, ".moonya-install-files.json"), "[\"..\\\\escape.dll\"]");
    ExpectFailure(() => UpdateInstaller.ApplyTransaction(target, second, Path.Combine(root, "work5")));
    Check(!File.Exists(Path.Combine(root, "escape.dll")), "reject escaped manifest paths");
    Console.WriteLine("Update installer smoke: Chinese/spaced paths, transaction, obsolete managed files, rollback, user data and path containment passed.");
} catch (Exception error) {
    Console.Error.WriteLine(error.GetType().FullName);
    Console.Error.WriteLine(error.Message);
    Console.Error.WriteLine(error.StackTrace);
    return 1;
} finally {
    var path = Path.GetFullPath(root);
    if (Path.GetDirectoryName(path) == Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) && Path.GetFileName(path).StartsWith("moonya-installer-smoke-")) Directory.Delete(path, true);
}
static void Check(bool value, string message) { if (!value) throw new Exception(message); }
return 0;
static void ExpectFailure(Action action) { try { action(); } catch (Exception error) when (error is IOException || error is InvalidDataException) { return; } throw new Exception("Expected operation to fail"); }
