using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace MoonYa
{
    /// <summary>Host-only visuals: excluded from CDP and raw OSR screenshots.</summary>
    public partial class BuiltinBrowserVisuals : UserControl
    {
        public double PointerX { get; private set; } = 0.5;
        public double PointerY { get; private set; } = 0.5;
        public bool PointerVisible { get; set; } = true;

        public BuiltinBrowserVisuals()
        {
            InitializeComponent();
            SizeChanged += (_, _) => RenderPointer();
        }

        public void SetPointer(double x, double y, bool visible = true)
        {
            PointerX = Math.Clamp(x, 0, 1);
            PointerY = Math.Clamp(y, 0, 1);
            PointerVisible = visible;
            RenderPointer();
        }

        protected override void OnDpiChanged(DpiScale oldDpi, DpiScale newDpi)
        {
            base.OnDpiChanged(oldDpi, newDpi);
            if (IsInitialized) RenderPointer();
        }

        public void RenderPointer()
        {
            var dpi = VisualTreeHelper.GetDpi(this);
            // The source is 22x23 physical pixels, with the arrow tip at (3,3).
            Arrow.Width = 22 / dpi.DpiScaleX;
            Arrow.Height = 23 / dpi.DpiScaleY;
            Canvas.SetLeft(Pointer, PointerX * ActualWidth - 3 / dpi.DpiScaleX);
            Canvas.SetTop(Pointer, PointerY * ActualHeight - 3 / dpi.DpiScaleY);
            Pointer.Visibility = PointerVisible ? Visibility.Visible : Visibility.Hidden;
        }
    }
}
