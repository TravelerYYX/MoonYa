using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text;
using System.Threading.Tasks;
using CefSharp;
using CefSharp.Handler;
using MoonYa.Services;

namespace MoonYa;
public partial class MainWindow
{
    internal async void ActivatePaymentReturn()
    {
        if (System.Windows.Application.Current is not App app || app.PendingPaymentOrder is not string order) return;
        ShowWindow();
        if (!WebView.IsBrowserInitialized || !WebView.CanExecuteJavascriptInMainFrame) return;
        try
        {
            var response = await WebView.EvaluateScriptAsync("(() => { if (!window.MoonYaMembership?.paymentReturn) return false; void window.MoonYaMembership.paymentReturn(" + JsonSerializer.Serialize(order) + "); return true; })()");
            if (response.Success && response.Result is true && app.PendingPaymentOrder == order) app.PendingPaymentOrder = null;
        }
        catch (Exception error) { Debug.WriteLine("Payment return activation: " + error.Message); }
    }

    private bool _migrationRunning;
    private async Task MigrateLegacyFrontendAsync()
    {
        if (_migrationRunning || App.BackendBaseAddress == null || File.Exists(AppDataPaths.PathFor("frontend", "migration-complete"))) return;
        _migrationRunning = true;
        try {
            var uri = new Uri(App.BackendBaseAddress, "__moonya_local_migration__");
            var script = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "frontend", "migration-export.js"));
            // Both controls use CEF's global request context and its existing persistent cache.
            LegacyMigrationBrowser.RequestHandler = new LegacyMigrationRequestHandler(uri.AbsoluteUri, "<!DOCTYPE html><meta charset='utf-8'><script>" + script + "</script>");
            LegacyMigrationBrowser.Address = uri.AbsoluteUri;
            for (var attempt = 0; attempt < 600; attempt++) {
                await Task.Delay(100);
                if (!LegacyMigrationBrowser.IsBrowserInitialized || !LegacyMigrationBrowser.CanExecuteJavascriptInMainFrame) continue;
                var response = await LegacyMigrationBrowser.EvaluateScriptAsync("JSON.stringify(window.__moonyaMigration || null)");
                if (!response.Success || response.Result is not string text || text == "null") continue;
                using var json = JsonDocument.Parse(text);
                if (json.RootElement.TryGetProperty("error", out var error)) throw new InvalidOperationException(error.GetString());
                if (json.RootElement.GetProperty("source").GetString() != uri.GetLeftPart(UriPartial.Authority)) throw new InvalidOperationException("迁移来源不匹配");
                var directory = AppDataPaths.DirectoryFor("frontend");
                var source = uri.GetLeftPart(UriPartial.Authority);
                var backupName = "legacy-v2-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source)))[..16] + "-" + Guid.NewGuid().ToString("N");
                var backup = Path.Combine(directory, backupName);
                Directory.CreateDirectory(backup);
                var chunks = 0;
                WebView.ExecuteScriptAsync("if(window.MoonYaMigration)MoonYaMigration.showProgress('正在备份旧来源历史…');");
                while (true) {
                    var next = await LegacyMigrationBrowser.EvaluateScriptAsPromiseAsync("return MoonYaMigrationExport.next().then(JSON.stringify);", TimeSpan.FromMinutes(2));
                    if (!next.Success || next.Result is not string metadata) throw new InvalidOperationException("读取迁移批次失败：" + next.Message);
                    using var batch = JsonDocument.Parse(metadata);
                    if (batch.RootElement.GetProperty("done").GetBoolean()) break;
                    var length = batch.RootElement.GetProperty("length").GetInt32();
                    var content = new StringBuilder(length);
                    for (var offset = 0; offset < length; offset += 262144) {
                        var part = await LegacyMigrationBrowser.EvaluateScriptAsync($"window.__moonyaMigrationChunk.slice({offset},{offset + 262144})");
                        if (!part.Success || part.Result is not string slice) throw new InvalidOperationException("读取迁移分片失败：" + part.Message);
                        content.Append(slice);
                    }
                    await File.WriteAllBytesAsync(Path.Combine(backup, chunks.ToString("D8") + ".dat"),
                        ProtectedData.Protect(Encoding.UTF8.GetBytes(content.ToString()), null, DataProtectionScope.CurrentUser));
                    chunks++;
                }
                text = JsonSerializer.Serialize(new { version = 2, source, chunks, backupDirectory = backupName });
                await File.WriteAllBytesAsync(Path.Combine(backup, "manifest.dat"), ProtectedData.Protect(Encoding.UTF8.GetBytes(text), null, DataProtectionScope.CurrentUser));
                var stage = Path.Combine(directory, "migration.dat");
                await File.WriteAllBytesAsync(stage + ".tmp", ProtectedData.Protect(System.Text.Encoding.UTF8.GetBytes(text), null, DataProtectionScope.CurrentUser));
                File.Move(stage + ".tmp", stage, true);
                var errorFile = AppDataPaths.PathFor("frontend", "migration-error.json");
                if (File.Exists(errorFile)) File.Delete(errorFile);
                WebView.ExecuteScriptAsync("if(window.MoonYaMigration)void MoonYaMigration.run();");
                return;
            }
            throw new TimeoutException("读取旧来源本地数据超时");
        } catch (Exception error) {
            Debug.WriteLine("本地历史迁移未完成：" + error.Message);
            try { await File.AppendAllTextAsync(AppDataPaths.PathFor("logs", "frontend-migration.log"), $"[{DateTimeOffset.Now:O}] {error}\n"); } catch { }
            await File.WriteAllTextAsync(AppDataPaths.PathFor("frontend", "migration-error.json"), "{\"error\":\"本地历史迁移未完成\"}");
            WebView.ExecuteScriptAsync("if(window.MoonYaMigration)MoonYaMigration.showFailure('本地历史迁移未完成');");
        }
        finally { LegacyMigrationBrowser.Address = "about:blank"; _migrationRunning = false; }
    }
}
internal sealed class LegacyMigrationRequestHandler(string url, string html) : RequestHandler
{
    protected override IResourceRequestHandler GetResourceRequestHandler(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame,
        IRequest request, bool isNavigation, bool isDownload, string requestInitiator, ref bool disableDefaultHandling)
        => new MigrationResourceHandler(url, html);
    private sealed class MigrationResourceHandler(string url, string html) : ResourceRequestHandler
    {
        protected override CefReturnValue OnBeforeResourceLoad(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request, IRequestCallback callback)
            => request.Url == url ? CefReturnValue.Continue : CefReturnValue.Cancel;
        protected override IResourceHandler? GetResourceHandler(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request)
            => request.Url == url ? ResourceHandler.FromString(html) : null;
    }
}
internal sealed class FrontendNavigationHandler : RequestHandler
{
    private readonly Action<CefTerminationStatus, int, string> _rendererFailed;
    internal FrontendNavigationHandler(Action<CefTerminationStatus, int, string> rendererFailed)
        => _rendererFailed = rendererFailed;

    protected override void OnRenderProcessTerminated(IWebBrowser chromiumWebBrowser, IBrowser browser,
        CefTerminationStatus status, int errorCode, string errorString)
        => _rendererFailed(status, errorCode, errorString);

    protected override bool OnBeforeBrowse(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request, bool userGesture, bool isRedirect)
    {
        if (!frame.IsMain || request.Url == "about:blank" || !Uri.TryCreate(request.Url, UriKind.Absolute, out var target)) return false;
        if (App.FrontendBaseAddress is Uri local && target.GetLeftPart(UriPartial.Authority) == local.GetLeftPart(UriPartial.Authority)) return false;
        if (userGesture && target.Scheme is "http" or "https") { try { Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true }); } catch { } }
        return true;
    }
}
