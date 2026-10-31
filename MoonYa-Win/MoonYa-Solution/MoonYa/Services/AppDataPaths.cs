using System;
using System.IO;

namespace MoonYa.Services
{
    public static class AppDataPaths
    {
        public static string Root { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".MoonYa");
        public static string PathFor(params string[] parts) => Path.Combine(Root, Path.Combine(parts));
        public static string DirectoryFor(params string[] parts)
        {
            var path = parts.Length == 0 ? Root : PathFor(parts);
            Directory.CreateDirectory(path);
            return path;
        }
        public static void Initialize()
        {
            Environment.SetEnvironmentVariable("MOONYA_DATA_ROOT", DirectoryFor());
            Environment.SetEnvironmentVariable("MOONYA_CRAWLER_DATA_DIR", Root);
            var temporary = DirectoryFor("temp");
            Environment.SetEnvironmentVariable("TEMP", temporary);
            Environment.SetEnvironmentVariable("TMP", temporary);
            Environment.SetEnvironmentVariable("PYTHONDONTWRITEBYTECODE", "1");
            DirectoryFor("logs");
        }
    }
}
