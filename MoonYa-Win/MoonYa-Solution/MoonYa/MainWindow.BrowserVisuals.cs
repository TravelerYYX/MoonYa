using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using MoonYa.Services;

namespace MoonYa
{
    public partial class MainWindow
    {
        private BuiltinBrowserVisuals? _builtinVisuals;
        private bool _builtinVisualsEnabled;
        private bool _builtinPointerOperation;
        private long _builtinVisualEpoch;
        private long _builtinVisualRevision;
        private int _builtinVisualTab;
        private int _builtinVisualResetGeneration;
        private DateTime _builtinPointerPublished;
        private readonly Dictionary<int, (double X, double Y)> _builtinPointerPositions = new();

        public void ApplyBuiltinBrowserVisuals(string json)
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.GetProperty("reset_generation").GetInt32() != _builtinVisualResetGeneration) return;
            var revision = root.GetProperty("revision").GetInt64();
            if (revision <= _builtinVisualRevision) return;
            if (_builtinVisualTab > 0 && _builtinVisualsEnabled && _builtinVisuals != null)
                _builtinPointerPositions[_builtinVisualTab] = (_builtinVisuals.PointerX, _builtinVisuals.PointerY);
            if (root.TryGetProperty("open_tab_ids", out var ids))
            {
                var open = new HashSet<int>();
                foreach (var id in ids.EnumerateArray()) open.Add(id.GetInt32());
                foreach (var id in new List<int>(_builtinPointerPositions.Keys))
                    if (!open.Contains(id)) _builtinPointerPositions.Remove(id);
            }
            _builtinVisualRevision = revision;
            _builtinVisualEpoch++;
            _builtinPointerOperation = false;
            _builtinVisualTab = root.GetProperty("tab_id").GetInt32();
            _builtinVisualsEnabled = root.GetProperty("enabled").GetBoolean();
            if (!_builtinVisualsEnabled) _builtinPointerPositions.Remove(_builtinVisualTab);
            if (_builtinVisuals != null)
            {
                var point = _builtinPointerPositions.TryGetValue(_builtinVisualTab, out var saved)
                    ? saved : (ReadRatio(root, "x"), ReadRatio(root, "y"));
                _builtinVisuals.SetPointer(point.Item1, point.Item2);
                UpdateBuiltinVisualLayout();
                if (_builtinVisualsEnabled) PublishBuiltinPointer(true);
            }
            UpdateBuiltinCursor();
        }

        private void InitializeBuiltinVisuals(PanelChromiumWebBrowser browser)
        {
            var visuals = new BuiltinBrowserVisuals();
            _builtinVisuals = visuals;
            Panel.SetZIndex(visuals, 1);
            BuiltinBrowserLayer.Children.Add(visuals);
            browser.PreviewMouseMove += (_, e) =>
            {
                if (!_builtinVisualsEnabled || _builtinPointerOperation || _builtinVisuals != visuals) return;
                var point = e.GetPosition(browser);
                visuals.SetPointer(point.X / Math.Max(1, browser.ActualWidth),
                    point.Y / Math.Max(1, browser.ActualHeight));
                PublishBuiltinPointer();
            };
            browser.MouseEnter += (_, _) =>
            {
                if (!_builtinPointerOperation && _builtinVisualsEnabled && _builtinVisuals == visuals) visuals.SetPointer(
                    visuals.PointerX, visuals.PointerY);
            };
            browser.MouseLeave += (_, _) =>
            {
                if (_builtinPointerOperation || _builtinVisuals != visuals) return;
                visuals.SetPointer(visuals.PointerX, visuals.PointerY, false);
                PublishBuiltinPointer(true);
            };
        }

        private void UpdateBuiltinCursor()
        {
            if (_builtinBrowser == null) return;
            _builtinBrowser.ShowAutomationCursor = _builtinVisualsEnabled;
            _builtinBrowser.ForceCursor = _builtinVisualsEnabled;
            _builtinBrowser.Cursor = _builtinVisualsEnabled ? Cursors.None : Cursors.Arrow;
        }

        private void UpdateBuiltinVisualLayout()
        {
            if (_builtinVisuals == null || _builtinBrowser == null) return;
            Canvas.SetLeft(_builtinVisuals, Canvas.GetLeft(_builtinBrowser));
            Canvas.SetTop(_builtinVisuals, Canvas.GetTop(_builtinBrowser));
            _builtinVisuals.Width = _builtinBrowser.Width;
            _builtinVisuals.Height = _builtinBrowser.Height;
            _builtinVisuals.Visibility = _builtinVisualsEnabled ? Visibility.Visible : Visibility.Collapsed;
            _builtinVisuals.RenderPointer();
        }

        internal async Task<BuiltinPointerState?> BeginBuiltinPointerOperationAsync()
        {
            if (!_builtinSessionActive) throw new OperationCanceledException("浏览器会话已结束");
            RequestBuiltinPanelReveal();
            // Wait for the trusted frontend's tab selection/visual acknowledgement.
            for (var attempt = 0; attempt < 100 && !_builtinVisualsEnabled; attempt++)
            {
                await Task.Delay(20);
                if (!_builtinSessionActive) throw new OperationCanceledException("浏览器会话已结束");
            }
            if (!_builtinVisualsEnabled || _builtinVisuals == null)
                throw new OperationCanceledException("浏览器标签已关闭或切换");
            _builtinPointerOperation = true;
            _builtinVisuals.SetPointer(_builtinVisuals.PointerX, _builtinVisuals.PointerY);
            return new BuiltinPointerState { Epoch = _builtinVisualEpoch,
                X = _builtinVisuals.PointerX, Y = _builtinVisuals.PointerY };
        }

        internal bool UpdateBuiltinPointer(long epoch, double x, double y)
        {
            if (!_builtinSessionActive || !_builtinPointerOperation || epoch != _builtinVisualEpoch || _builtinVisuals == null)
                return false;
            _builtinVisuals.SetPointer(x, y);
            PublishBuiltinPointer();
            return true;
        }

        internal void EndBuiltinPointerOperation(long epoch)
        {
            if (epoch != _builtinVisualEpoch) return;
            _builtinPointerOperation = false;
            PublishBuiltinPointer(true);
        }

        private void PublishBuiltinPointer(bool force = false)
        {
            if (_builtinVisuals == null || !force && (DateTime.UtcNow - _builtinPointerPublished).TotalMilliseconds < 50) return;
            _builtinPointerPublished = DateTime.UtcNow;
            var payload = JsonSerializer.Serialize(new { tab_id = _builtinVisualTab, revision = _builtinVisualRevision,
                reset_generation = _builtinVisualResetGeneration, x = _builtinVisuals.PointerX, y = _builtinVisuals.PointerY });
            ExecuteScriptOnMainWebView("window.moonyaBrowserPointerState&&window.moonyaBrowserPointerState(" + payload + ");");
        }

        internal void ResetBuiltinBrowserVisuals()
        {
            _builtinVisualResetGeneration++;
            _builtinVisualEpoch++;
            _builtinVisualsEnabled = false;
            _builtinPointerOperation = false;
            _builtinPointerPositions.Remove(_builtinVisualTab);
            UpdateBuiltinCursor();
            UpdateBuiltinVisualLayout();
            ExecuteScriptOnMainWebView("window.moonyaResetBrowserVisuals&&window.moonyaResetBrowserVisuals(" + _builtinVisualResetGeneration + "," + _builtinVisualTab + ");");
        }
    }
}
