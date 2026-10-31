using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

[assembly: InternalsVisibleTo("MoonYa.DesktopSmoke")]

namespace MoonYa.Services;

internal interface IVirtualDisplayBackend : IDisposable
{
    string Provider { get; }
    Task<string> AcquireAsync();
    bool IsAvailable(string deviceName);
}

internal static class VirtualDisplayBackend
{
    public static IVirtualDisplayBackend Create()
    {
        using var config = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "launcher_config.json")));
        if (!config.RootElement.TryGetProperty("desktop_automation", out var section))
            throw new InvalidOperationException("未配置桌面后端；不会自动启动旧扩展屏方案。");
        var provider = section.GetProperty("provider").GetString();
        return provider switch {
            "disabled" => throw new InvalidOperationException(section.TryGetProperty("disabled_reason", out var reason)
                ? reason.GetString() : "电脑操作已停用；不会自动启动旧扩展屏方案。"),
            "moonya" => new MoonYaDisplayBackend(),
            "virtualdrivers" => new PersistentDisplayBackend(Environment.ExpandEnvironmentVariables(section.GetProperty("installation_record").GetString()!)),
            _ => throw new InvalidOperationException("未知虚拟显示后端: " + provider)
        };
    }
}

internal sealed class MoonYaDisplayBackend : IVirtualDisplayBackend
{
    private Process? _helper;
    public string Provider => "moonya";
    public async Task<string> AcquireAsync()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "virtual_display", "MoonYa.DisplayHost.exe");
        if (!File.Exists(path)) throw new InvalidOperationException("MoonYa 虚拟显示器组件尚未构建或安装。");
        _helper = Process.Start(new ProcessStartInfo(path, "--create") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true });
        if (_helper == null) throw new InvalidOperationException("无法启动虚拟显示器。");
        var ready = await _helper.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
        if (ready != "READY") throw new InvalidOperationException("虚拟显示器驱动未就绪，请检查安装和签名。" + ready);
        for (var i = 0; i < 50; i++) {
            var matches = DisplayIdentity.Enumerate().Where(d => d.Description == "MoonYa Virtual Display").ToArray();
            if (matches.Length == 1) return matches[0].DeviceName;
            if (matches.Length > 1) throw new InvalidOperationException("发现多个 MoonYa 显示设备。");
            await Task.Delay(100);
        }
        throw new InvalidOperationException("未找到 MoonYa 创建的显示器。");
    }
    public bool IsAvailable(string deviceName) => _helper is { HasExited: false } && DisplayIdentity.Enumerate().Any(d => d.DeviceName == deviceName && d.Description == "MoonYa Virtual Display");
    public void Dispose()
    {
        if (_helper == null) return;
        try { _helper.StandardInput.WriteLine("STOP"); if (!_helper.WaitForExit(2000)) _helper.Kill(true); } catch { }
        _helper.Dispose(); _helper = null;
    }
}

internal sealed class PersistentDisplayBackend : IVirtualDisplayBackend
{
    private readonly string _record;
    private readonly Func<DisplayCandidate[]> _enumerate;
    private readonly Func<string, int> _problem;
    private readonly Func<string, Task> _enable;
    private string _instance = "", _monitorPath = "";
    public string Provider => "virtualdrivers";
    public PersistentDisplayBackend(string record, Func<DisplayCandidate[]>? enumerate = null, Func<string, int>? problem = null, Func<string, Task>? enable = null)
    {
        _record = record; _enumerate = enumerate ?? DisplayIdentity.Enumerate;
        _problem = problem ?? DisplayIdentity.DeviceProblem; _enable = enable ?? EnableInstalledDeviceAsync;
    }
    public async Task<string> AcquireAsync()
    {
        using var record = JsonDocument.Parse(File.ReadAllText(_record));
        var root = record.RootElement;
        if (root.GetProperty("status").GetString() != "installed" || root.GetProperty("provider").GetString() != Provider)
            throw new InvalidOperationException("VirtualDrivers 安装记录无效或安装未完成。");
        _instance = root.GetProperty("device_instance_id").GetString() ?? "";
        if (!_instance.StartsWith("ROOT\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("VirtualDrivers 设备实例无效。");
        var problem = _problem(_instance);
        if (problem == 22) {
            var primaryPaths = _enumerate().Where(d => d.Primary).Select(d => d.MonitorPath).OrderBy(p => p).ToArray();
            // Starting an explicitly requested desktop session owns this lifecycle
            // action. The model does not need to invent a shell repair command.
            await _enable(_record);
            for (var attempt = 0; attempt < 50 && (!_enumerate().Any(d => d.Ancestors.Contains(_instance, StringComparer.OrdinalIgnoreCase)) || _problem(_instance) != 0); attempt++) await Task.Delay(100);
            if (_problem(_instance) != 0) throw new InvalidOperationException("虚拟显示设备未能启用，请查看设备状态日志。");
            var currentPrimaryPaths = _enumerate().Where(d => d.Primary).Select(d => d.MonitorPath).OrderBy(p => p).ToArray();
            if (!primaryPaths.SequenceEqual(currentPrimaryPaths)) throw new InvalidOperationException("启用虚拟屏幕后主屏发生变化，桌面操作已停止。");
        } else if (problem != 0) throw new InvalidOperationException($"虚拟显示设备异常（设备错误码 {problem}），不会重复执行启用脚本。");
        var display = DisplayIdentity.SelectOwned(_enumerate(), _instance);
        _monitorPath = display.MonitorPath;
        return display.DeviceName;
    }
    public bool IsAvailable(string deviceName)
    {
        try {
            var display = DisplayIdentity.SelectOwned(_enumerate(), _instance);
            return display.DeviceName == deviceName && display.MonitorPath.Equals(_monitorPath, StringComparison.OrdinalIgnoreCase);
        } catch { return false; }
    }
    // A persistent driver and monitor belong to the installation, not to a chat.
    public void Dispose() { _instance = ""; _monitorPath = ""; }
    private static async Task EnableInstalledDeviceAsync(string record)
    {
        var script = Path.Combine(AppContext.BaseDirectory, "virtual_display", "Set-VirtualDriversState.ps1");
        if (!File.Exists(script)) throw new InvalidOperationException("虚拟屏幕已停用，但客户端缺少设备启用组件，请更新客户端。");
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
        foreach (var argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-State", "Enabled", "-RecordPath", record }) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("无法启动虚拟屏幕设备组件。");
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(120));
        if (process.ExitCode != 0) throw new InvalidOperationException("虚拟屏幕启用未成功，请查看设备状态日志或完成系统权限提示。");
    }
}

public sealed record DisplayCandidate(string DeviceName, string Description, string MonitorPath, string[] Ancestors, bool Primary = false);

public static class DisplayIdentity
{
    public static int DeviceProblem(string instance)
    {
        if (CM_Locate_DevNode(out var node, instance, 0) != 0 || CM_Get_DevNode_Status(out _, out var problem, node, 0) != 0)
            throw new InvalidOperationException("安装记录对应的虚拟显示设备不存在或无法读取状态，请检查安装记录。");
        return (int)problem;
    }
    public static DisplayCandidate SelectOwned(IEnumerable<DisplayCandidate> displays, string instance)
    {
        if (string.IsNullOrWhiteSpace(instance)) throw new InvalidOperationException("安装记录缺少设备实例。");
        var candidates = displays.Where(d => d.Ancestors.Any(a => a.Equals(instance, StringComparison.OrdinalIgnoreCase))).ToArray();
        if (candidates.Length != 1 || string.IsNullOrWhiteSpace(candidates[0].MonitorPath) || candidates[0].Primary)
            throw new InvalidOperationException("无法唯一识别安装记录对应的 VirtualDrivers 屏幕；不会操作主屏幕。");
        return candidates[0];
    }
    public static DisplayCandidate[] Enumerate()
    {
        var result = new List<DisplayCandidate>();
        for (uint i = 0; ; i++) {
            var adapter = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
            if (!EnumDisplayDevices(null, i, ref adapter, 0)) break;
            for (uint j = 0; ; j++) {
                var monitor = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
                if (!EnumDisplayDevices(adapter.DeviceName, j, ref monitor, 1)) break;
                result.Add(new DisplayCandidate(adapter.DeviceName, adapter.DeviceString, monitor.DeviceID, Ancestors(monitor.DeviceID), (adapter.StateFlags & 4) != 0));
            }
        }
        return result.ToArray();
    }
    private static string[] Ancestors(string path)
    {
        var set = SetupDiCreateDeviceInfoList(IntPtr.Zero, IntPtr.Zero);
        if (set == new IntPtr(-1)) return Array.Empty<string>();
        try {
            var iface = new SP_DEVICE_INTERFACE_DATA { cbSize = Marshal.SizeOf<SP_DEVICE_INTERFACE_DATA>() };
            if (!SetupDiOpenDeviceInterface(set, path, 0, ref iface)) return Array.Empty<string>();
            var info = new SP_DEVINFO_DATA { cbSize = Marshal.SizeOf<SP_DEVINFO_DATA>() };
            SetupDiGetDeviceInterfaceDetail(set, ref iface, IntPtr.Zero, 0, out var length, ref info);
            if (length < 8 || length > 65536) return Array.Empty<string>();
            var detail = Marshal.AllocHGlobal((int)length);
            try {
                Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                if (!SetupDiGetDeviceInterfaceDetail(set, ref iface, detail, length, out _, ref info)) return Array.Empty<string>();
                var ids = new List<string>(); var node = info.DevInst;
                for (var depth = 0; depth < 32; depth++) {
                    var id = new StringBuilder(1024);
                    if (CM_Get_Device_ID(node, id, id.Capacity, 0) != 0) break;
                    ids.Add(id.ToString());
                    if (CM_Get_Parent(out var parent, node, 0) != 0 || parent == node) break;
                    node = parent;
                }
                return ids.ToArray();
            } finally { Marshal.FreeHGlobal(detail); }
        } finally { SetupDiDestroyDeviceInfoList(set); }
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct DISPLAY_DEVICE { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public int StateFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
    [StructLayout(LayoutKind.Sequential)] private struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }
    [StructLayout(LayoutKind.Sequential)] private struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplayDevices(string? device, uint index, ref DISPLAY_DEVICE data, uint flags);
    [DllImport("setupapi.dll")] private static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr classGuid, IntPtr hwnd);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool SetupDiOpenDeviceInterface(IntPtr set, string path, uint flags, ref SP_DEVICE_INTERFACE_DATA data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, uint size, out uint required, ref SP_DEVINFO_DATA info);
    [DllImport("setupapi.dll")] private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Get_Device_ID(uint node, StringBuilder id, int size, uint flags);
    [DllImport("cfgmgr32.dll")] private static extern uint CM_Get_Parent(out uint parent, uint node, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Locate_DevNode(out uint node, string instance, uint flags);
    [DllImport("cfgmgr32.dll")] private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint node, uint flags);
}
