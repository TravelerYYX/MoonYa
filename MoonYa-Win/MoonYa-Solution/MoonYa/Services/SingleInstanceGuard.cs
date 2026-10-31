using System;
using System.Security.Principal;
using System.Threading;

namespace MoonYa.Services;

internal sealed class SingleInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;
    private bool _ownsMutex;
    internal bool IsOwner => _ownsMutex;

    internal SingleInstanceGuard(string? name = null)
    {
        name ??= @"Local\MoonYa.Desktop." + WindowsIdentity.GetCurrent().User!.Value;
        _mutex = new Mutex(true, name, out var created);
        if (created) _ownsMutex = true;
        else
        {
            try { _ownsMutex = _mutex.WaitOne(0); }
            catch (AbandonedMutexException) { _ownsMutex = true; }
        }
    }

    public void Dispose()
    {
        if (_ownsMutex)
        {
            _mutex.ReleaseMutex();
            _ownsMutex = false;
        }
        _mutex.Dispose();
    }
}
