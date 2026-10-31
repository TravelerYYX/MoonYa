using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Effects;
using Rectangle = System.Windows.Shapes.Rectangle;
using Windows.Media.Editing;
using Windows.Media.MediaProperties;
using Windows.Storage;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var result = 1;
        application.Dispatcher.BeginInvoke(async () =>
        {
            var directory = Path.Combine(Path.GetTempPath(), "MoonYa-Mp4Smoke-" + Guid.NewGuid());
            object? surface = null;
            Type? type = null;
            try
            {
                Directory.CreateDirectory(directory);
                var folder = await StorageFolder.GetFolderFromPathAsync(directory);
                var file = await folder.CreateFileAsync("native-background.mp4");
                var composition = new MediaComposition();
                composition.Clips.Add(MediaClip.CreateFromColor(Windows.UI.Color.FromArgb(255, 40, 160, 220), TimeSpan.FromSeconds(1)));
                var encoding = MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Vga);
                var rendered = await composition.RenderToFileAsync(file, MediaTrimmingPreference.Precise, encoding);
                Require(rendered == Windows.Media.Transcoding.TranscodeFailureReason.None, "generate a real H.264 MP4 fixture");

                var frontend = typeof(MoonYa.MainWindow).Assembly.GetType("MoonYa.Services.DesktopFrontendService")!;
                var thumbnailMethod = frontend.GetMethod("MediaThumbnailAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
                var thumbnail = await (Task<byte[]>)thumbnailMethod.Invoke(null, new object[] { file.Path })!;
                using (var stream = new MemoryStream(thumbnail)) {
                    var image = System.Windows.Media.Imaging.BitmapFrame.Create(stream);
                    Require(image.PixelWidth > 100 && image.PixelHeight > 100, "native MP4 preview produces a real thumbnail");
                    var pixels = new System.Windows.Media.Imaging.FormatConvertedBitmap(image, PixelFormats.Bgra32, null, 0);
                    var center = new byte[4];
                    pixels.CopyPixels(new Int32Rect(pixels.PixelWidth / 2, pixels.PixelHeight / 2, 1, 1), center, 4, 0);
                    Require(center[0] > 150 && center[1] > 90 && center[2] < 100, "thumbnail contains the decoded blue video frame");
                }

                if (args.Contains("--thumbnail-only")) {
                    File.Delete(file.Path);
                    Require(!File.Exists(file.Path), "thumbnail extraction releases the video file");
                    result = 0;
                    return;
                }

                var videoPath = args.Length > 0 ? Path.GetFullPath(args[0]) : file.Path;

                type = typeof(MoonYa.MainWindow).GetNestedType("NativeVideoSurface", BindingFlags.NonPublic)!;
                var rectangle = new Rectangle();
                surface = Activator.CreateInstance(type, BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { rectangle }, null)!;
                Invoke(type, surface, "Apply", videoPath, "contain", 12);
                var deadline = DateTime.UtcNow.AddSeconds(12);
                while (!Get<bool>(type, surface, "_opened") && DateTime.UtcNow < deadline)
                    await Task.Delay(100);
                var player = Get<MediaPlayer?>(type, surface, "_player");
                Require(player != null && player.NaturalVideoWidth > 0, "native player decodes MP4 frames");
                Require(rectangle.Visibility == Visibility.Visible, "decoded video makes the background visible");
                Require(player!.IsMuted && player.Volume == 0, "background stays muted");
                Require(rectangle.Fill is DrawingBrush { Stretch: Stretch.Uniform }, "contain preserves aspect ratio");
                Require(rectangle.Effect is BlurEffect { Radius: 6 }, "blur is applied to the native surface");
                Invoke(type, surface, "Apply", videoPath, "fill", 0);
                Require(ReferenceEquals(player, Get<MediaPlayer?>(type, surface, "_player")), "appearance changes do not reopen the video");
                Require(rectangle.Fill is DrawingBrush { Stretch: Stretch.Fill } && rectangle.Effect == null, "fill and removing blur take effect");
                await Task.Delay(300);
                Require(player.Position > TimeSpan.Zero, "playback advances");
                if (args.Length == 0)
                {
                    await Task.Delay(1300);
                    Require(player.Position > TimeSpan.Zero && player.Position < TimeSpan.FromSeconds(1), "video loops after reaching the end");
                }
                await CompositionSmoke.VerifyAsync(rectangle, videoPath);
                Invoke(type, surface, "Clear");
                Require(rectangle.Visibility == Visibility.Collapsed && rectangle.Fill == null, "removing background releases and hides the player");
                File.Delete(file.Path);
                Require(!File.Exists(file.Path), "video file is unlocked after removal");
                result = 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error); }
            finally
            {
                if (surface != null && type != null) Invoke(type, surface, "Clear");
                if (Directory.Exists(directory)) Directory.Delete(directory, true);
                application.Shutdown();
            }
        });
        application.Run();
        return result;
    }

    private static T Get<T>(Type type, object instance, string name) =>
        (T)type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(instance)!;

    private static void Invoke(Type type, object instance, string name, params object[] args) =>
        type.GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(instance, args);

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
        Console.WriteLine("PASS: " + message);
    }
}
