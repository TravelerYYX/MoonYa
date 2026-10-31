using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using CefSharp;

namespace MoonYa.Services
{
    internal sealed class AttachmentDropController
    {
        private readonly CefSharp.Wpf.ChromiumWebBrowser WebView;
        private readonly FileOperationService _fileService;
        private readonly Uri _origin;

        internal AttachmentDropController(CefSharp.Wpf.ChromiumWebBrowser browser, FileOperationService files, Uri origin)
        {
            WebView = browser; _fileService = files; _origin = origin;
            InitializeAttachmentDrop();
        }

        private bool _attachmentDragAccepted;
        private bool _attachmentDragChecking;
        private int _attachmentDragGeneration;

        private bool AttachmentDropOriginTrusted()
        {
            return WebView.CanExecuteJavascriptInMainFrame && Uri.TryCreate(WebView.Address, UriKind.Absolute, out var actual)
                && _origin is Uri expected
                && actual.Scheme == expected.Scheme && actual.Host == expected.Host && actual.Port == expected.Port;
        }

        private void InitializeAttachmentDrop()
        {
            WebView.AllowDrop = true;
            WebView.PreviewDragEnter += OnAttachmentDragOver;
            WebView.PreviewDragOver += OnAttachmentDragOver;
            WebView.PreviewDragLeave += (_, e) =>
            {
                if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
                _attachmentDragGeneration++; _attachmentDragAccepted = false;
                if (WebView.IsBrowserInitialized && AttachmentDropOriginTrusted())
                    WebView.ExecuteScriptAsync("window.moonyaAttachmentDragAt?.(0,0,false)");
            };
            WebView.PreviewDrop += OnAttachmentDrop;
        }

        private string AttachmentDropHitScript(DragEventArgs e)
        {
            var point = e.GetPosition(WebView);
            var x = (point.X / Math.Max(1, WebView.ActualWidth)).ToString("R", CultureInfo.InvariantCulture);
            var y = (point.Y / Math.Max(1, WebView.ActualHeight)).ToString("R", CultureInfo.InvariantCulture);
            return $"JSON.stringify(window.moonyaAttachmentDragAt?.({x},{y}) || null)";
        }

        private async void OnAttachmentDragOver(object sender, DragEventArgs e)
        {
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            // Prevent CefSharp's default file navigation, including rejected surfaces.
            e.Handled = true;
            e.Effects = _attachmentDragAccepted ? DragDropEffects.Copy : DragDropEffects.None;
            if (_attachmentDragChecking || !WebView.IsBrowserInitialized || !AttachmentDropOriginTrusted()) return;
            _attachmentDragChecking = true;
            var generation = _attachmentDragGeneration;
            try
            {
                var hit = await WebView.EvaluateScriptAsync(AttachmentDropHitScript(e));
                if (generation == _attachmentDragGeneration)
                    _attachmentDragAccepted = hit.Success && hit.Result is string json && json != "null";
            }
            catch { _attachmentDragAccepted = false; }
            finally { _attachmentDragChecking = false; }
        }

        private async void OnAttachmentDrop(object sender, DragEventArgs e)
        {
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            e.Handled = true; e.Effects = DragDropEffects.None;
            _attachmentDragGeneration++; _attachmentDragAccepted = false;
            if (!WebView.IsBrowserInitialized || !AttachmentDropOriginTrusted()) return;
            var paths = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (paths == null || paths.Length == 0) return;
            var newlyGranted = new List<string>();
            try
            {
                var hit = await WebView.EvaluateScriptAsync(AttachmentDropHitScript(e));
                if (!hit.Success || hit.Result is not string json || json == "null" || !AttachmentDropOriginTrusted()) return;
                using var context = JsonDocument.Parse(json);
                newlyGranted.AddRange(paths.Where(path => !_fileService.IsLocallyGrantedFile(path)));
                var result = _fileService.GrantDroppedFiles(paths);
                if (!result.TryGetValue("items", out var items)) return;
                var payload = JsonSerializer.Serialize(new { id = Guid.NewGuid().ToString(), context = context.RootElement, items });
                // Capture the conversation at the drop position and reject if it changed while awaiting the host.
                var accepted = await WebView.EvaluateScriptAsPromiseAsync($"return Promise.resolve(window.moonyaReceiveNativeDrop?.({payload})).then(value=>JSON.stringify(value || []));");
                if (!accepted.Success) throw new InvalidOperationException("附件拖放交接失败");
                var retained = JsonSerializer.Deserialize<string[]>(accepted.Result as string ?? "[]") ?? Array.Empty<string>();
                newlyGranted.RemoveAll(path => retained.Contains(path, StringComparer.OrdinalIgnoreCase));
            }
            catch (Exception error) { System.Diagnostics.Debug.WriteLine("Attachment drop: " + error); }
            finally
            {
                foreach (var path in newlyGranted) _fileService.RevokeLocalPath(path);
                if (WebView.IsBrowserInitialized && AttachmentDropOriginTrusted())
                    WebView.ExecuteScriptAsync("window.moonyaAttachmentDragAt?.(0,0,false)");
            }
        }
    }
}
