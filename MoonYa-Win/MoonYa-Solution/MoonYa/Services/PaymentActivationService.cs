using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace MoonYa.Services;

internal sealed class PaymentActivationService : IDisposable
{
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint processId);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint processId);
    private readonly CancellationTokenSource _stop = new();
    private NamedPipeServerStream? _pipe;
    private readonly string _pipeName;
    internal PaymentActivationService(string? pipeName = null) => _pipeName = pipeName ?? PipeName;
    private static string PipeName => "MoonYa.PaymentReturn." + WindowsIdentity.GetCurrent().User!.Value + "." + Process.GetCurrentProcess().SessionId;

    internal static string? OrderFromUri(string value)
    {
        // Accept only the payment-return command, never arbitrary navigation or execution.
        var match = Regex.Match(value, @"\Amoonya://payment/return\?order_no=(MY[a-zA-Z0-9]{14,38})\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        return match.Success && match.Groups[1].Value.StartsWith("MY", StringComparison.Ordinal) ? match.Groups[1].Value : null;
    }

    internal const string ShowCommand = "moonya://window/show";
    internal static bool TryShowExisting() => TrySend(ShowCommand);
    internal static bool TryForward(string order) => TrySend("moonya://payment/return?order_no=" + order);

    internal static bool TrySend(string command, string? pipeName = null)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName ?? PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            client.Connect(2000);
            // Transfer the browser-launched process's foreground permission to the
            // already running client before it restores the payment window.
            if (GetNamedPipeServerProcessId(client.SafePipeHandle, out var processId)) AllowSetForegroundWindow(processId);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var bytes = Encoding.UTF8.GetBytes(command + "\n");
            client.WriteAsync(bytes, timeout.Token).AsTask().GetAwaiter().GetResult();
            var ack = new byte[1];
            return client.ReadAsync(ack, timeout.Token).AsTask().GetAwaiter().GetResult() == 1 && ack[0] == 1;
        }
        catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    internal void Start(Action<string> activate)
    {
        try
        {
            _pipe = new NamedPipeServerStream(_pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            _ = ListenAsync(activate);
        }
        catch (IOException error) { Debug.WriteLine("Payment activation listener: " + error.Message); }
    }

    private async Task ListenAsync(Action<string> activate)
    {
        var pipe = _pipe!;
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                await pipe.WaitForConnectionAsync(_stop.Token);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(3));
                var buffer = new byte[128];
                var length = 0;
                while (length < buffer.Length)
                {
                    var read = await pipe.ReadAsync(buffer.AsMemory(length, 1), timeout.Token);
                    if (read == 0 || buffer[length++] == '\n') break;
                }
                var command = Encoding.UTF8.GetString(buffer, 0, length).TrimEnd('\n');
                var order = command == ShowCommand ? ShowCommand : OrderFromUri(command);
                if (order != null)
                {
                    activate(order);
                    await pipe.WriteAsync(new byte[] { 1 }, timeout.Token);
                }
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException)
            {
                if (_stop.IsCancellationRequested) break;
                Debug.WriteLine("Payment activation request: " + error.Message);
            }
            finally { if (!_stop.IsCancellationRequested && pipe.IsConnected) pipe.Disconnect(); }
        }
    }

    internal static void RegisterProtocol()
    {
        var executable = Environment.ProcessPath;
        if (executable == null || !string.Equals(Path.GetFileName(executable), "FarSide.exe", StringComparison.OrdinalIgnoreCase)) return;
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\moonya");
            key.SetValue("", "URL:MoonYa Protocol");
            key.SetValue("URL Protocol", "");
            using var icon = key.CreateSubKey("DefaultIcon");icon.SetValue("", "\"" + executable + "\",0");
            using var command = key.CreateSubKey(@"shell\open\command");command.SetValue("", "\"" + executable + "\" \"%1\"");
        }
        catch (Exception error) when (error is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Debug.WriteLine("MoonYa protocol registration: " + error.Message);
        }
    }

    public void Dispose()
    {
        _stop.Cancel();_pipe?.Dispose();
    }
}
