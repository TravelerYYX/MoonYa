using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services
{
    /// <summary>CEF 启动和自动化连接共用的回环端点逻辑。</summary>
    public static class BuiltinBrowserConnection
    {
        public static int SelectDebuggingPort(int configuredPort, params int[] reservedPorts)
        {
            if (configuredPort < IPEndPoint.MinPort || configuredPort > IPEndPoint.MaxPort)
                throw new ArgumentOutOfRangeException(nameof(configuredPort));
            try { if (!reservedPorts.Contains(configuredPort)) return BindPort(configuredPort); }
            catch (SocketException error) when (error.SocketErrorCode is SocketError.AddressAlreadyInUse or SocketError.AccessDenied)
            {
                // 配置端口被占用，继续由系统分配。
            }
            // 让操作系统分配空闲端口，不能猜测或递增配置端口。
            int selected;
            do { selected = BindPort(IPEndPoint.MinPort); } while (reservedPorts.Contains(selected));
            return selected;
        }

        private static int BindPort(int port)
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Server.ExclusiveAddressUse = true;
            try
            {
                listener.Start();
                return ((IPEndPoint)listener.LocalEndpoint).Port;
            }
            finally { listener.Stop(); }
        }

        public static Uri DebuggingAddress(int port) =>
            new UriBuilder(Uri.UriSchemeHttp, IPAddress.Loopback.ToString(), port).Uri;

        public static async Task<JsonDocument> ReadDiscoveryAsync(int port, string route, CancellationToken cancellationToken)
        {
            // 本机 CDP 不应经过系统代理；请求期限由调用方的连接令牌统一控制。
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
            { Timeout = Timeout.InfiniteTimeSpan };
            var json = await client.GetStringAsync(new Uri(DebuggingAddress(port), route), cancellationToken).ConfigureAwait(false);
            return JsonDocument.Parse(json);
        }

        public static async Task<string> ReadBrowserWebSocketAsync(int port, CancellationToken cancellationToken)
        {
            using var document = await ReadDiscoveryAsync(port, "json/version", cancellationToken).ConfigureAwait(false);
            if (!document.RootElement.TryGetProperty("webSocketDebuggerUrl", out var value)
                || value.ValueKind != JsonValueKind.String
                || !Uri.TryCreate(value.GetString(), UriKind.Absolute, out var endpoint)
                || !endpoint.IsLoopback || endpoint.Port != port
                || (endpoint.Scheme != "ws" && endpoint.Scheme != "wss"))
                throw new InvalidOperationException("内置浏览器未返回有效的浏览器级 CDP 端点: " + DebuggingAddress(port));
            return endpoint.AbsoluteUri;
        }
    }
}
