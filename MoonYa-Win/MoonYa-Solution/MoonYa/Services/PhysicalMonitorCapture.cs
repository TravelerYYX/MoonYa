using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace MoonYa.Services;

/// <summary>DXGI capture of the selected physical primary output; never switches outputs.</summary>
public sealed class PhysicalMonitorCapture : IDisposable
{
    private IntPtr _capture;
    public PhysicalMonitorCapture(string deviceName)
    {
        _capture = MoonYaCaptureOpen(deviceName);
        if (_capture == IntPtr.Zero) throw new InvalidOperationException("无法初始化实体主屏幕 DXGI 捕获。");
    }
    public byte[] Capture(bool png, out int width, out int height)
    {
        if (_capture == IntPtr.Zero) throw new ObjectDisposedException(nameof(PhysicalMonitorCapture));
        var status = MoonYaCaptureFrame(_capture, out var pixels, out width, out height, out var stride, png ? 100u : 0u);
        if (status < 0 || pixels == IntPtr.Zero) throw new InvalidOperationException($"实体屏幕画面不可用 (DXGI 0x{status:X8})，请重新建立桌面会话。");
        using var bitmap = new Bitmap(width, height, stride, PixelFormat.Format32bppArgb, pixels);
        using var stream = new MemoryStream();
        bitmap.Save(stream, png ? ImageFormat.Png : ImageFormat.Jpeg);
        return stream.ToArray();
    }
    public void Dispose() { if (_capture != IntPtr.Zero) MoonYaCaptureClose(_capture); _capture = IntPtr.Zero; }
    [DllImport("MoonYa.DesktopCapture.dll", CharSet = CharSet.Unicode)] private static extern IntPtr MoonYaCaptureOpen(string deviceName);
    [DllImport("MoonYa.DesktopCapture.dll")] private static extern int MoonYaCaptureFrame(IntPtr capture, out IntPtr pixels, out int width, out int height, out int stride, uint timeoutMs);
    [DllImport("MoonYa.DesktopCapture.dll")] private static extern void MoonYaCaptureClose(IntPtr capture);
}
