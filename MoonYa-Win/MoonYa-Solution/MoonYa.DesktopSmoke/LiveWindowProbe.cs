using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

// Read-only acceptance diagnostics for the actual viewer, rather than an offline render.
internal static class LiveWindowProbe
{
    public static void ActivateViewer()
    {
        IntPtr viewer = IntPtr.Zero;
        EnumWindows((window, _) => { if (IsWindowVisible(window) && Title(window) == "MoonYa 实体桌面") viewer = window; return true; }, IntPtr.Zero);
        if (viewer == IntPtr.Zero) throw new InvalidOperationException("Live viewer is missing.");
        GetWindowRect(viewer, out var rect);
        GetCursorPos(out var cursor);
        var input = new MoonYa.Services.ComputerUseService();
        // Simulate clicking the actual caption for acceptance, without typing
        // or changing the user's unrelated windows. Restore the cursor.
        try {
            input.FocusWindow(viewer.ToInt64());
            if (GetForegroundWindow() != viewer) {
                SetWindowPos(viewer, IntPtr.Zero, 0, 0, 0, 0, 0x0013);
                Thread.Sleep(150);
                GetWindowRect(viewer, out rect);
                input.MouseClick(rect.Left + 200, rect.Top + 24, "left");
            }
            for (var attempt = 0; attempt < 20 && GetForegroundWindow() != viewer; attempt++) Thread.Sleep(50);
        }
        finally { input.MouseMove(cursor.X, cursor.Y); }
    }
    public static object Inventory()
    {
        var windows = new List<object>();
        EnumWindows((window, _) => {
            GetWindowThreadProcessId(window, out var pid);
            try {
                using var process = System.Diagnostics.Process.GetProcessById((int)pid);
                if (IsWindowVisible(window) && process.ProcessName is "MoonYa" or "CalculatorApp" or "ApplicationFrameHost") {
                    GetWindowRect(window, out var rect);
                    DwmGetWindowAttribute(window, 14, out var cloaked, sizeof(int));
                    var className = new StringBuilder(256); GetClassName(window, className, className.Capacity);
                    windows.Add(new { handle = window.ToInt64(), process = process.ProcessName, title = Title(window), class_name = className.ToString(), cloaked,
                        foreground = GetForegroundWindow() == window, bounds = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom) });
                }
            } catch (ArgumentException) { }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
    public static object Observe(string? imagePath)
    {
        IntPtr viewer = IntPtr.Zero;
        EnumWindows((window, _) => { if (IsWindowVisible(window) && Title(window) == "MoonYa 实体桌面") viewer = window; return true; }, IntPtr.Zero);
        if (viewer == IntPtr.Zero) throw new InvalidOperationException("Live physical desktop window is not open.");
        GetWindowRect(viewer, out var rect);
        var bounds = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        var foreground = GetForegroundWindow();
        if (imagePath != null) {
            if (foreground != viewer || IsIconic(viewer)) throw new InvalidOperationException("Viewer must be visible and foreground before capturing its screen pixels.");
            using var bitmap = new Bitmap(bounds.Width, bounds.Height);
            using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            bitmap.Save(Path.GetFullPath(imagePath), ImageFormat.Png);
        }
        return new { viewer = viewer.ToInt64(), foreground = foreground.ToInt64(), foreground_title = Title(foreground), normal = !IsZoomed(viewer) && !IsIconic(viewer), bounds,
            screens = System.Windows.Forms.Screen.AllScreens.Select(s => new { device = s.DeviceName, primary = s.Primary, bounds = s.Bounds }) };
    }
    private static string Title(IntPtr window) { var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity); return text.ToString(); }
    private delegate bool EnumCallback(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
}
