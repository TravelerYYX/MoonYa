using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

namespace MoonYa.DesktopHost;

internal sealed class HiddenDesktop : IDisposable
{
    private readonly IntPtr _originalDesktop;
    private IntPtr _desktop, _job, _process;
    private readonly string _name;
    public uint ProcessId { get; private set; }
    public bool HasExited => GetExitCodeProcess(_process, out var code) && code != 259;
    public uint ExitCode { get { GetExitCodeProcess(_process, out var code); return code; } }

    public HiddenDesktop(string name, string? packageFamily = null)
    {
        _name = name;
        _originalDesktop = GetThreadDesktop(GetCurrentThreadId());
        // Access rights intentionally omit DESKTOP_SWITCHDESKTOP.
        _desktop = CreateOwnedDesktop(name, packageFamily);
        if (_desktop == IntPtr.Zero) throw NativeError("CreateDesktop");
        try {
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) throw NativeError("CreateJobObject");
            var limits = new JobLimits { Basic = new BasicLimits { LimitFlags = 0x2000 } };
            if (!SetInformationJobObject(_job, 9, ref limits, (uint)Marshal.SizeOf<JobLimits>())) throw NativeError("SetInformationJobObject");
            if (!SetThreadDesktop(_desktop)) throw NativeError("SetThreadDesktop");
        } catch { Dispose(); throw; }
    }

    private static IntPtr CreateOwnedDesktop(string name, string? packageFamily)
    {
        if (string.IsNullOrEmpty(packageFamily)) return CreateDesktop(name, null, IntPtr.Zero, 0, 0x00FF, IntPtr.Zero);
        // AppContainer programs need an explicit package grant and low
        // integrity label. Change only this newly-created private object;
        // never modify Default, WinSta0 or any pre-existing security policy.
        var result = DeriveAppContainerSidFromAppContainerName(packageFamily, out var packageSid);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        IntPtr sidText = IntPtr.Zero, descriptor = IntPtr.Zero, attributesMemory = IntPtr.Zero;
        try {
            if (!ConvertSidToStringSid(packageSid, out sidText)) throw NativeError("ConvertSidToStringSid");
            var userSid = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Current user SID is missing.");
            var sddl = $"D:P(A;;0x000F00FF;;;SY)(A;;0x000F00FF;;;{userSid})(A;;0x000000FF;;;{Marshal.PtrToStringUni(sidText)})S:(ML;;NW;;;LW)";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out _)) throw NativeError("ConvertStringSecurityDescriptorToSecurityDescriptor");
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            attributesMemory = Marshal.AllocHGlobal(attributes.Length);
            Marshal.StructureToPtr(attributes, attributesMemory, false);
            return CreateDesktop(name, null, IntPtr.Zero, 0, 0x000F00FF, attributesMemory);
        } finally {
            if (attributesMemory != IntPtr.Zero) Marshal.FreeHGlobal(attributesMemory);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            if (sidText != IntPtr.Zero) LocalFree(sidText);
            if (packageSid != IntPtr.Zero) FreeSid(packageSid);
        }
    }

    public object Launch(string executable, string arguments, string? diagnosticOutput = null)
    {
        if (!File.Exists(executable)) throw new FileNotFoundException("Application executable is missing.", executable);
        if (_process != IntPtr.Zero) throw new InvalidOperationException("This probe already owns an application.");
        var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Desktop = "WinSta0\\" + _name };
        var command = new StringBuilder('"' + executable + '"' + (arguments.Length > 0 ? " " + arguments : ""));
        var creationFlags = 0x08000004u | (diagnosticOutput != null ? 2u : 0u); // DEBUG_ONLY_THIS_PROCESS, never attach to user processes.
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, creationFlags, IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out var info)) throw NativeError("CreateProcess");
        _process = info.Process;
        ProcessId = info.ProcessId;
        try {
            // Assign before the first instruction runs, so children cannot
            // escape cleanup by racing the job assignment.
            if (!AssignProcessToJobObject(_job, _process)) {
                TerminateProcess(_process, 1);
                throw NativeError("AssignProcessToJobObject");
            }
            if (ResumeThread(info.Thread) == uint.MaxValue) throw NativeError("ResumeThread");
        } finally { CloseHandle(info.Thread); }
        if (diagnosticOutput != null) CrashDiagnostics.Record(_process, ProcessId, diagnosticOutput);
        return new { process_id = ProcessId, desktop = _name, application = executable, ready = false };
    }

    private IntPtr[] OwnedWindows()
    {
        var windows = new List<IntPtr>();
        Exception? failure = null;
        var desktopName = new StringBuilder(256);
        if (!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, desktopName, 512, out _) || desktopName.ToString() != _name)
            throw new InvalidOperationException("Worker is not bound to its owned desktop.");
        Marshal.SetLastPInvokeError(0);
        var enumerated = EnumDesktopWindows(_desktop, (window, parameter) => {
            try {
            if (IsWindowVisible(window)) {
                // Membership comes from EnumDesktopWindows with the explicit
                // owned HDESK, not an ambient foreground/window enumeration.
                GetWindowThreadProcessId(window, out var pid);
                using var process = Process.GetProcessById((int)pid);
                if (!IsProcessInJob(process.Handle, _job, out var owned) || !owned) throw new InvalidOperationException("Window is not in the owned process job.");
                GetWindowRect(window, out var rect);
                if (rect.Right > rect.Left && rect.Bottom > rect.Top) windows.Add(window);
            }
            return true;
            } catch (Exception error) { failure = error; return false; }
        }, IntPtr.Zero);
        if (failure != null) throw failure;
        if (!enumerated && Marshal.GetLastPInvokeError() != 0) throw NativeError("EnumDesktopWindows");
        return windows.ToArray();
    }

    public object[] Windows() => OwnedWindows().Select(window => {
        var thread = GetWindowThreadProcessId(window, out var pid);
        GetWindowRect(window, out var rect);
        var title = new StringBuilder(512); GetWindowText(window, title, title.Capacity);
        var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
        return (object)new { handle = window.ToInt64(), pid, thread, desktop = _name, title = title.ToString(), class_name = name.ToString(), bounds = rect };
    }).ToArray();

    public void Capture(string path)
    {
        var windows = OwnedWindows();
        if (windows.Length == 0) throw new InvalidOperationException("There are no verified windows to capture.");
        using var frame = new Bitmap(1920, 1080);
        using var canvas = Graphics.FromImage(frame);
        canvas.Clear(Color.FromArgb(238, 241, 246));
        // EnumDesktopWindows returns topmost first. Composite back-to-front.
        foreach (var window in windows.Reverse()) {
            GetWindowRect(window, out var rect);
            var width = rect.Right - rect.Left; var height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0 || width > 8192 || height > 8192) throw new InvalidOperationException("Invalid capture dimensions.");
            using var bitmap = new Bitmap(width, height);
            using (var graphics = Graphics.FromImage(bitmap)) {
                var dc = graphics.GetHdc();
                try { if (!PrintWindow(window, dc, 2)) throw NativeError("PrintWindow"); }
                finally { graphics.ReleaseHdc(dc); }
            }
            canvas.DrawImageUnscaled(bitmap, rect.Left, rect.Top);
        }
        frame.Save(path, ImageFormat.Png);
    }

    private AutomationElement[] WindowElements()
    {
        // No ElementFromPoint or global UIA root: anchor every query to an
        // ownership-checked HWND belonging to this desktop and job.
        return OwnedWindows().Select(AutomationElement.FromHandle).ToArray();
    }
    public object[] Controls()
    {
        var controls = new List<object>();
        foreach (var root in WindowElements()) {
            var elements = root.FindAll(TreeScope.Subtree, Condition.TrueCondition);
            foreach (AutomationElement element in elements) {
                var current = element.Current;
                var rect = current.BoundingRectangle;
                controls.Add(new { name = current.Name, automation_id = current.AutomationId, control_type = current.ControlType.ProgrammaticName,
                    bounds = rect.IsEmpty ? null : new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height },
                    patterns = element.GetSupportedPatterns().Select(pattern => pattern.ProgrammaticName).ToArray() });
            }
        }
        return controls.ToArray();
    }

    public object Execute(JsonElement action)
    {
        var x = action.GetProperty("x").GetDouble(); var y = action.GetProperty("y").GetDouble();
        if (!double.IsFinite(x) || !double.IsFinite(y) || x < 0 || x >= 1920 || y < 0 || y >= 1080) throw new InvalidOperationException("Point is outside the logical viewport.");
        foreach (var root in WindowElements()) {
            var elements = root.FindAll(TreeScope.Subtree, Condition.TrueCondition).Cast<AutomationElement>()
                .Where(element => element.Current.BoundingRectangle.Contains(new System.Windows.Point(x, y)))
                .OrderBy(element => element.Current.BoundingRectangle.Width * element.Current.BoundingRectangle.Height);
            foreach (var element in elements) {
                if (action.GetProperty("method").GetString() == "click" && element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke)) {
                    ((InvokePattern)invoke).Invoke(); return new { success = true, method = "click", x, y };
                }
                if (action.GetProperty("method").GetString() == "type" && element.TryGetCurrentPattern(ValuePattern.Pattern, out var value)) {
                    ((ValuePattern)value).SetValue(action.GetProperty("text").GetString() ?? ""); return new { success = true, method = "type", x, y };
                }
            }
        }
        throw new InvalidOperationException("No verified hidden-desktop control supports this action. Global input fallback is disabled.");
    }

    public void Dispose()
    {
        if (_job != IntPtr.Zero) { TerminateJobObject(_job, 0); CloseHandle(_job); _job = IntPtr.Zero; }
        if (_process != IntPtr.Zero) { WaitForSingleObject(_process, 3000); CloseHandle(_process); _process = IntPtr.Zero; }
        if (_desktop != IntPtr.Zero) { SetThreadDesktop(_originalDesktop); CloseDesktop(_desktop); _desktop = IntPtr.Zero; }
    }
    public static bool ProcessExists(uint pid) { try { using var process = Process.GetProcessById((int)pid); return !process.HasExited; } catch (ArgumentException) { return false; } }
    public static object PhysicalState()
    {
        GetCursorPos(out var point);
        var input = OpenInputDesktop(0, false, 1);
        var name = new StringBuilder(256);
        if (input != IntPtr.Zero) { GetUserObjectInformation(input, 2, name, 512, out _); CloseDesktop(input); }
        return new { foreground = GetForegroundWindow().ToInt64(), cursor = new { x = point.X, y = point.Y }, input_desktop = name.ToString(),
            displays = System.Windows.Forms.Screen.AllScreens.Select(screen => new { screen.DeviceName, screen.Primary, x = screen.Bounds.X, y = screen.Bounds.Y, width = screen.Bounds.Width, height = screen.Bounds.Height }) };
    }
    private static Win32Exception NativeError(string operation) => new(Marshal.GetLastWin32Error(), operation + " failed");
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo { public int Size; public string? Reserved, Desktop, Title; public int X, Y, XSize, YSize, XCount, YCount, Fill, Flags; public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct JobLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    private delegate bool EnumCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateDesktop(string name, string? device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDesktopWindows(IntPtr desktop, EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, uint length, out uint needed);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string? directory, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int type, ref JobLimits information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll")] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
