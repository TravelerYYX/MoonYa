namespace MoonYa
{
    public partial class MainWindow
    {
        private void InitializeAttachmentDrop()
        {
            _ = new Services.AttachmentDropController(WebView, _fileService,
                App.FrontendBaseAddress ?? throw new System.InvalidOperationException("Frontend origin is unavailable"));
        }
    }
}
