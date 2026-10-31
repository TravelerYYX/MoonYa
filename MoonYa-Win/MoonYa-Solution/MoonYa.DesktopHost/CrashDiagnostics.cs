using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace MoonYa.DesktopHost;

// Diagnostic-only debugger for the process created on our own desktop/job.
// It records exceptions without modifying instructions, memory, security or
// the launch target. A timeout kills the job via the existing probe cleanup.
internal static class CrashDiagnostics
{
    public static void Record(IntPtr process, uint processId, string output)
    {
        var events = new List<object>();
        var buffer = Marshal.AllocHGlobal(176); // x64 DEBUG_EVENT
        var clock = Stopwatch.StartNew();
        try {
            while (clock.Elapsed < TimeSpan.FromSeconds(15)) {
                if (!WaitForDebugEvent(buffer, 200)) {
                    if (Marshal.GetLastWin32Error() == 121) continue;
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForDebugEvent");
                }
                var kind = (uint)Marshal.ReadInt32(buffer, 0);
                var pid = (uint)Marshal.ReadInt32(buffer, 4);
                var tid = (uint)Marshal.ReadInt32(buffer, 8);
                var status = 0x00010002u; // DBG_CONTINUE
                try {
                    if (pid != processId) throw new InvalidOperationException("Unexpected process in diagnostic debugger.");
                    if (kind == 1) {
                        var code = (uint)Marshal.ReadInt32(buffer, 16);
                        var address = (ulong)Marshal.ReadInt64(buffer, 32);
                        var first = Marshal.ReadInt32(buffer, 168) != 0;
                        string? module = null; ulong? rva = null;
                        using var target = Process.GetProcessById((int)processId);
                        foreach (ProcessModule image in target.Modules) {
                            var start = (ulong)image.BaseAddress.ToInt64();
                            if (address >= start && address - start < (ulong)image.ModuleMemorySize) { module = image.FileName; rva = address - start; break; }
                        }
                        events.Add(new { code = $"0x{code:X8}", address = $"0x{address:X}", first_chance = first, thread_id = tid,
                            module, rva = rva.HasValue ? $"0x{rva:X}" : null, registers = Registers(tid) });
                        // Ignore the initial debugger breakpoint; deliver all
                        // actual application exceptions to its own handlers.
                        if (code != 0x80000003) status = 0x80010001; // DBG_EXCEPTION_NOT_HANDLED
                        if (!first) {
                            using var dump = File.Create(Path.Combine(output, "crash.dmp"));
                            if (!MiniDumpWriteDump(process, processId, dump.SafeFileHandle.DangerousGetHandle(), 0x1000, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero))
                                throw new Win32Exception(Marshal.GetLastWin32Error(), "MiniDumpWriteDump");
                        }
                    }
                    // Debugger receives file/process/thread handles; release
                    // its copies independently of our job/process ownership.
                    if (kind == 3) { CloseIfPresent(buffer, 16); CloseIfPresent(buffer, 24); CloseIfPresent(buffer, 32); }
                    if (kind == 2) CloseIfPresent(buffer, 16);
                    if (kind == 6) CloseIfPresent(buffer, 16);
                } finally {
                    if (!ContinueDebugEvent(pid, tid, status)) throw new Win32Exception(Marshal.GetLastWin32Error(), "ContinueDebugEvent");
                }
                if (kind == 5) return;
            }
            throw new TimeoutException("Owned-process launch diagnosis exceeded 15 seconds; probe will clean up its job.");
        } finally {
            File.WriteAllText(Path.Combine(output, "debug-events.json"), JsonSerializer.Serialize(events, new JsonSerializerOptions { WriteIndented = true }));
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static object Registers(uint threadId)
    {
        var thread = OpenThread(8, false, threadId);
        if (thread == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenThread");
        var allocation = Marshal.AllocHGlobal(1248);
        var context = new IntPtr((allocation.ToInt64() + 15) & ~15L);
        try {
            Marshal.Copy(new byte[1232], 0, context, 1232);
            Marshal.WriteInt32(context, 48, 0x100003); // AMD64 CONTROL | INTEGER
            if (!GetThreadContext(thread, context)) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetThreadContext");
            return new { rax = $"0x{Marshal.ReadInt64(context, 120):X}", rip = $"0x{Marshal.ReadInt64(context, 248):X}" };
        } finally { Marshal.FreeHGlobal(allocation); CloseHandle(thread); }
    }
    private static void CloseIfPresent(IntPtr buffer, int offset) { var handle = Marshal.ReadIntPtr(buffer, offset); if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WaitForDebugEvent(IntPtr debugEvent, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ContinueDebugEvent(uint process, uint thread, uint status);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenThread(uint access, bool inherit, uint thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetThreadContext(IntPtr thread, IntPtr context);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("dbghelp.dll", SetLastError = true)] private static extern bool MiniDumpWriteDump(IntPtr process, uint pid, IntPtr file, uint type, IntPtr exception, IntPtr userStreams, IntPtr callback);
}
