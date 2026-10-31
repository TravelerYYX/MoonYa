using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MoonYa.Services
{
    /// <summary>
    /// 把子进程绑定到 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 作业对象。
    ///
    /// 背景：MoonYa 的本地服务（Node 编码运行时、Python 爬虫/搜索后端）都是子进程。
    /// 如果主进程异常终止（崩溃、被任务管理器结束、强杀），Exit 回调不会执行，
    /// Stop() 也就不会调用，子进程会变成孤儿继续占用 58901 / 58907 端口。
    /// 下一次启动时新实例要么 EADDRINUSE 崩溃，要么静默把孤儿当成自己的服务。
    ///
    /// 作业对象把这个清理责任交给内核：句柄一旦关闭（正常退出或进程被销毁），
    /// Windows 会连同作业内的所有进程一起回收。
    ///
    /// 句柄必须保存在字段里活到主进程结束，Release 时关闭句柄会立即杀掉作业内进程。
    /// </summary>
    internal sealed class KillOnCloseJob : IDisposable
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, JOBOBJECTINFOCLASS jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private enum JOBOBJECTINFOCLASS { ExtendedLimitInformation = 9 }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public IntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        private readonly Action<string> _diagnostics;
        private readonly string _jobName;
        private IntPtr _handle = IntPtr.Zero;

        public KillOnCloseJob(string jobName, Action<string>? diagnostics = null)
        {
            _jobName = jobName;
            _diagnostics = diagnostics ?? (_ => { });
        }

        /// <summary>把进程加入作业对象；返回是否成功（失败只影响异常退出的清理兜底）。</summary>
        public bool Attach(Process process)
        {
            try
            {
                if (_handle == IntPtr.Zero)
                {
                    _handle = CreateJobObject(IntPtr.Zero, _jobName);
                    if (_handle == IntPtr.Zero)
                    {
                        _diagnostics($"[{_jobName}] 创建作业对象失败，异常退出时可能残留子进程");
                        return false;
                    }
                    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
                    {
                        BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                        {
                            LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                        }
                    };
                    var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                    var pointer = Marshal.AllocHGlobal(size);
                    try
                    {
                        Marshal.StructureToPtr(info, pointer, false);
                        if (!SetInformationJobObject(_handle, JOBOBJECTINFOCLASS.ExtendedLimitInformation, pointer, (uint)size))
                            _diagnostics($"[{_jobName}] 作业对象配置失败，异常退出时将依赖 Stop() 回收进程");
                    }
                    finally { Marshal.FreeHGlobal(pointer); }
                }

                if (!AssignProcessToJobObject(_handle, process.Handle))
                {
                    _diagnostics($"[{_jobName}] 子进程未能加入作业对象，异常退出时可能残留进程");
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                _diagnostics($"[{_jobName}] 作业对象绑定异常: {ex.Message}");
                return false;
            }
        }

        /// <summary>关闭句柄。会立即终止作业内仍然存活的进程。</summary>
        public void Dispose()
        {
            if (_handle == IntPtr.Zero) return;
            var handle = _handle;
            _handle = IntPtr.Zero;
            try { CloseHandle(handle); } catch { }
        }
    }
}
