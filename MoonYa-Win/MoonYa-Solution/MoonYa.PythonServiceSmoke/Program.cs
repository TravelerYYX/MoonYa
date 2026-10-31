using System.Text.Json;
using MoonYa.Services;

// Exercise the production resolver with a source config and a separate installed
// layout. No Python process, server or user data is needed for path regressions.
var fixture = Path.Combine(Path.GetTempPath(), "moonya-python-paths-" + Guid.NewGuid().ToString("N"));
var variables = new[] { "MOONYA_PYTHON_SCRIPT", "MOONYA_PYTHON_EXECUTABLE", "MOONYA_PYTHON_SERVICE_CONFIG", "MOONYA_PYTHON_PATH_ROOTS" };
var saved = variables.ToDictionary(name => name, Environment.GetEnvironmentVariable);
try
{
    foreach (var variable in variables) Environment.SetEnvironmentVariable(variable, null);
    var source = Path.Combine(fixture, "source");
    var installed = Path.Combine(fixture, "installed");
    Directory.CreateDirectory(source);
    Directory.CreateDirectory(Path.Combine(installed, "python_service"));
    Directory.CreateDirectory(Path.Combine(installed, "python"));
    var config = Path.Combine(source, "launcher_config.json");
    File.WriteAllText(config, JsonSerializer.Serialize(new { python_service = new {
        candidate_roots = new[] { "." }, script_candidate_paths = new[] { "python_service/main.py" },
        config_candidate_paths = new[] { "python_service/service_config.json" }, python_candidates = new[] { "python/python.exe" }
    }}));
    var script = Path.Combine(installed, "python_service", "main.py");
    var python = Path.Combine(installed, "python", "python.exe");
    var serviceConfig = Path.Combine(installed, "python_service", "service_config.json");
    File.WriteAllText(script, "# installed service fixture");
    File.WriteAllText(python, "interpreter path fixture");
    File.WriteAllText(serviceConfig, "{}");
    Check(WebCrawlerService.LoadRuntime(config, installed), script, python, serviceConfig, "newer source config resolves installed payload");
    var adjacent = Path.Combine(installed, "launcher_config.json");
    File.Copy(config, adjacent);
    Check(WebCrawlerService.LoadRuntime(adjacent, installed), script, python, serviceConfig, "adjacent installation config");

    // Custom relative roots still resolve against the selected config directory.
    var custom = Path.Combine(source, "python_service");
    Directory.CreateDirectory(custom);
    var customScript = Path.Combine(custom, "main.py");
    File.WriteAllText(customScript, "# custom service fixture");
    Environment.SetEnvironmentVariable("MOONYA_PYTHON_SCRIPT", "python_service/main.py");
    Check(WebCrawlerService.LoadRuntime(config, installed), script, python, serviceConfig, "executable payload takes precedence");
    File.Delete(script);
    Check(WebCrawlerService.LoadRuntime(config, installed), customScript, python, serviceConfig, "config-relative fallback remains available");
    Environment.SetEnvironmentVariable("MOONYA_PYTHON_SCRIPT", customScript);
    Check(WebCrawlerService.LoadRuntime(adjacent, installed), customScript, python, serviceConfig, "absolute environment override");
    Environment.SetEnvironmentVariable("MOONYA_PYTHON_SCRIPT", Path.Combine(fixture, "missing.py"));
    try { WebCrawlerService.LoadRuntime(config, installed); throw new Exception("Missing explicit script override was silently ignored"); }
    catch (InvalidOperationException ex) when (ex.Message.Contains("MOONYA_PYTHON_SCRIPT")) { Console.WriteLine("PASS: missing override reports an actionable error"); }
    return 0;
}
finally
{
    foreach (var variable in variables) Environment.SetEnvironmentVariable(variable, saved[variable]);
    // Only remove known fixture files; leave empty temporary directories.
    foreach (var name in new[] { "source/launcher_config.json", "source/python_service/main.py", "installed/launcher_config.json",
        "installed/python_service/main.py", "installed/python_service/service_config.json", "installed/python/python.exe" })
        File.Delete(Path.Combine(fixture, name));
}

static void Check((string ScriptPath, string PythonExecutable, string ServiceConfigPath) actual,
    string script, string python, string config, string scenario)
{
    if (actual != (script, python, config)) throw new Exception($"{scenario}: wrong resolved paths: {actual}");
    Console.WriteLine("PASS: " + scenario);
}
