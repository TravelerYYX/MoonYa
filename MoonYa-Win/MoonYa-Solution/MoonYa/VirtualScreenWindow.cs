using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Shell;

namespace MoonYa;

public sealed class VirtualScreenWindow : Window
{
    public string SessionId { get; }
    public bool IsConnected => _socket.State == WebSocketState.Open;
    public event Action? Resumed;
    public event Action? Stopped;
    private readonly ClientWebSocket _socket = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly Image _image = new() { Stretch = Stretch.Uniform };
    private readonly Canvas _overlay = new() { IsHitTestVisible = false, ClipToBounds = true };
    private readonly TextBlock _status = new() { Margin = new Thickness(0), Text = "连接中…", FontSize = 12, Foreground = new SolidColorBrush(Color.FromRgb(112, 117, 126)), VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid _viewport = new() { Background = Brushes.WhiteSmoke, Focusable = true };
    private readonly Button _takeover = new() { Content = "接管", Margin = new Thickness(4), Padding = new Thickness(14, 6, 14, 6) };
    private readonly Button _resume = new() { Content = "恢复 AI", Margin = new Thickness(4), Padding = new Thickness(14, 6, 14, 6) };
    private readonly Button _stop = new() { Content = "停止", Margin = new Thickness(4), Padding = new Thickness(14, 6, 14, 6) };
    private bool _human;
    private int _width = 1920, _height = 1080;
    private long _lastCursorSequence = -1;
    private readonly System.Collections.Generic.Queue<(Point point, long time)> _trail = new();
    public VirtualScreenWindow(string sessionId, string info) : this(sessionId, info, true) { }
    internal VirtualScreenWindow(string sessionId, string info, bool connectOnLoad)
    {
        SessionId = sessionId; Title = "MoonYa 实体桌面"; Width = 800; Height = 620; MinWidth = 600; MinHeight = 440;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brushes.White; WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.CanResize;
        WindowChrome.SetWindowChrome(this, new WindowChrome { CaptionHeight = 54, ResizeBorderThickness = new Thickness(6), GlassFrameThickness = new Thickness(0), CornerRadius = new CornerRadius(10), UseAeroCaptionButtons = false });
        var root = new Grid { Background = new SolidColorBrush(Color.FromRgb(252, 252, 252)) };
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(54) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var header = new Grid { Background = Brushes.White };
        header.Children.Add(new TextBlock { Text = Title, Margin = new Thickness(28, 0, 150, 0), VerticalAlignment = VerticalAlignment.Center, FontSize = 14, Foreground = Brushes.Black });
        var caption = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var minimize = CaptionButton("—", () => WindowState = WindowState.Minimized);
        var maximize = CaptionButton("□", () => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized);
        var close = CaptionButton("×", Close, true);
        caption.Children.Add(minimize); caption.Children.Add(maximize); caption.Children.Add(close); header.Children.Add(caption);
        header.Children.Add(new Border { BorderBrush = new SolidColorBrush(Color.FromRgb(235, 235, 235)), BorderThickness = new Thickness(0, 0, 0, 1), IsHitTestVisible = false });
        root.Children.Add(header);
        var body = new Grid { Margin = new Thickness(28, 28, 28, 28) };
        var frame = new Border { CornerRadius = new CornerRadius(10), Background = Brushes.WhiteSmoke, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Child = _viewport };
        _viewport.Children.Add(_image); _viewport.Children.Add(_overlay); body.Children.Add(frame);
        void FitFrame() {
            var ratio = (double)_width / _height;
            frame.Width = Math.Max(1, Math.Min(body.ActualWidth, body.ActualHeight * ratio));
            frame.Height = frame.Width / ratio;
        }
        body.SizeChanged += (_, _) => FitFrame();
        _viewport.SizeChanged += (_, _) => _viewport.Clip = new RectangleGeometry(new Rect(0, 0, _viewport.ActualWidth, _viewport.ActualHeight), 10, 10);
        Grid.SetRow(body, 1); root.Children.Add(body);
        var footer = new Grid { Margin = new Thickness(28, 0, 24, 16) };
        footer.Children.Add(_status);
        var controls = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        foreach (var button in new[] { _takeover, _resume, _stop }) button.Style = ActionButtonStyle();
        controls.Children.Add(_takeover); controls.Children.Add(_resume); controls.Children.Add(_stop); footer.Children.Add(controls);
        Grid.SetRow(footer, 2); root.Children.Add(footer); Content = root;
        _takeover.Click += async (_, _) => await SendAsync(new { kind = "control", command = "takeover" });
        _resume.Click += async (_, _) => await SendAsync(new { kind = "control", command = "resume" });
        _stop.Click += async (_, _) => {
            await SendAsync(new { kind = "control", command = "stop" });
            _takeover.IsEnabled = _resume.IsEnabled = _stop.IsEnabled = false;
            Stopped?.Invoke();
        };
        // Takeover is performed directly on the physical desktop. Never forward preview input.
        Closed += (_, _) => { _lifetime.Cancel(); _socket.Abort(); _socket.Dispose(); };
        if (connectOnLoad) Loaded += async (_, _) => await ConnectAsync(info);
    }
    private static Button CaptionButton(string label, Action action, bool close = false)
    {
        var button = new Button { Content = label, Width = 46, Height = 54, FontSize = 16, Background = Brushes.Transparent, BorderThickness = new Thickness(0), Foreground = Brushes.Black, Focusable = false };
        var style = new Style(typeof(Button));
        var template = new ControlTemplate(typeof(Button));
        var border = new FrameworkElementFactory(typeof(Border));
        border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        var content = new FrameworkElementFactory(typeof(ContentPresenter));
        content.SetValue(HorizontalAlignmentProperty, HorizontalAlignment.Center); content.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(content); template.VisualTree = border; style.Setters.Add(new Setter(TemplateProperty, template));
        var hover = new Trigger { Property = IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(BackgroundProperty, close ? new SolidColorBrush(Color.FromRgb(196, 43, 28)) : new SolidColorBrush(Color.FromRgb(237, 237, 237))));
        if (close) hover.Setters.Add(new Setter(ForegroundProperty, Brushes.White));
        style.Triggers.Add(hover); button.Style = style;
        WindowChrome.SetIsHitTestVisibleInChrome(button, true); button.Click += (_, _) => action();
        return button;
    }
    internal void SetVerificationFrame(BitmapSource frame) { _image.Source = frame; _status.Text = "实体桌面预览"; }
    private static Style ActionButtonStyle()
    {
        var style = new Style(typeof(Button));
        style.Setters.Add(new Setter(Control.BackgroundProperty, Brushes.White));
        style.Setters.Add(new Setter(Control.ForegroundProperty, new SolidColorBrush(Color.FromRgb(55, 61, 70))));
        style.Setters.Add(new Setter(Control.BorderBrushProperty, new SolidColorBrush(Color.FromRgb(222, 226, 232))));
        style.Setters.Add(new Setter(Control.FontSizeProperty, 12.0));
        var template = new ControlTemplate(typeof(Button));
        var border = new FrameworkElementFactory(typeof(Border)); border.SetValue(Border.CornerRadiusProperty, new CornerRadius(6)); border.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        border.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        border.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(HorizontalAlignmentProperty, HorizontalAlignment.Center); presenter.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center); border.AppendChild(presenter); template.VisualTree = border;
        style.Setters.Add(new Setter(Control.TemplateProperty, template));
        var hover = new Trigger { Property = IsMouseOverProperty, Value = true }; hover.Setters.Add(new Setter(Control.BackgroundProperty, new SolidColorBrush(Color.FromRgb(242, 244, 247)))); style.Triggers.Add(hover);
        var disabled = new Trigger { Property = IsEnabledProperty, Value = false }; disabled.Setters.Add(new Setter(OpacityProperty, 0.45)); style.Triggers.Add(disabled);
        return style;
    }
    private async Task ConnectAsync(string info)
    {
        try
        {
            using var doc = JsonDocument.Parse(info); var data = doc.RootElement;
            if (!data.GetProperty("success").GetBoolean()) { _status.Text = data.GetProperty("error").GetString(); return; }
            _width = data.GetProperty("width").GetInt32(); _height = data.GetProperty("height").GetInt32();
            await _socket.ConnectAsync(new Uri(data.GetProperty("url").GetString()!), _lifetime.Token);
            var buffer = new byte[256 * 1024];
            while (_socket.State == WebSocketState.Open && !_lifetime.IsCancellationRequested)
            {
                using var message = new MemoryStream(); WebSocketReceiveResult received;
                do {
                    received = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), _lifetime.Token);
                    if (received.MessageType == WebSocketMessageType.Close) return;
                    message.Write(buffer, 0, received.Count);
                    if (message.Length > 32 * 1024 * 1024) throw new InvalidOperationException("画面超过尺寸限制。");
                } while (!received.EndOfMessage);
                if (received.MessageType == WebSocketMessageType.Text)
                {
                    using var state = JsonDocument.Parse(message.ToArray()); UpdateState(state.RootElement);
                }
                else
                {
                    message.Position = 0; var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.StreamSource = message; bitmap.EndInit(); bitmap.Freeze(); _image.Source = bitmap;
                }
            }
        }
        catch (Exception ex) { if (!_lifetime.IsCancellationRequested) { _status.Text = "连接断开：" + ex.Message; _human = false; } }
        finally { _status.Text = "屏幕会话已结束或连接断开"; _takeover.IsEnabled = _resume.IsEnabled = _stop.IsEnabled = false; }
    }
    private void UpdateState(JsonElement state)
    {
        var mode = state.GetProperty("state").GetString(); var wasHuman = _human; _human = mode == "human";
        if (wasHuman && mode == "ai") Resumed?.Invoke();
        if (mode == "stopped" && _stop.IsEnabled) Stopped?.Invoke();
        _status.Text = _human ? "已接管 · 请直接操作实体桌面" : mode == "stopped" ? "操作已停止" : "实时画面 · AI 操作中";
        _takeover.IsEnabled = mode == "ai"; _resume.IsEnabled = _human; _stop.IsEnabled = mode != "stopped";
        _overlay.Children.Clear(); if (_human) return;
        var imageBounds = ImageBounds();
        var point = new Point(imageBounds.Left + state.GetProperty("x").GetDouble() / 1000 * imageBounds.Width, imageBounds.Top + state.GetProperty("y").GetDouble() / 1000 * imageBounds.Height);
        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); var sequence = state.GetProperty("sequence").GetInt64();
        if (sequence != _lastCursorSequence) { _trail.Enqueue((point, timestamp)); _lastCursorSequence = sequence; }
        while (_trail.Count > 0 && timestamp - _trail.Peek().time > 650) _trail.Dequeue();
        var line = new Polyline { Stroke = new SolidColorBrush(Color.FromArgb(100, 66, 142, 255)), StrokeThickness = 3 };
        foreach (var item in _trail) line.Points.Add(item.point); _overlay.Children.Add(line);
        if (state.GetProperty("action").GetString() == "click" && timestamp - state.GetProperty("timestamp").GetInt64() < 400) {
            var circle = new Ellipse { Width = 30, Height = 30, Stroke = Brushes.DodgerBlue, StrokeThickness = 2 }; Canvas.SetLeft(circle, point.X - 15); Canvas.SetTop(circle, point.Y - 15); _overlay.Children.Add(circle);
        }
        var cursor = new Polygon { Fill = new SolidColorBrush(Color.FromRgb(66, 142, 255)), Stroke = Brushes.White, StrokeThickness = 1.5, Points = new PointCollection { new(0, 0), new(7, 23), new(12, 14), new(22, 10) } };
        Canvas.SetLeft(cursor, point.X); Canvas.SetTop(cursor, point.Y); _overlay.Children.Add(cursor);
    }
    private Rect ImageBounds() { double scale = Math.Min(_viewport.ActualWidth / _width, _viewport.ActualHeight / _height); double w = _width * scale, h = _height * scale; return new Rect((_viewport.ActualWidth - w) / 2, (_viewport.ActualHeight - h) / 2, w, h); }
    private async Task SendAsync(object message)
    {
        if (_socket.State != WebSocketState.Open) return;
        try { await _sendGate.WaitAsync(_lifetime.Token); try { await _socket.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(message)), WebSocketMessageType.Text, true, _lifetime.Token); } finally { _sendGate.Release(); } }
        catch (Exception ex) { if (!_lifetime.IsCancellationRequested) _status.Text = ex.Message; }
    }
}
