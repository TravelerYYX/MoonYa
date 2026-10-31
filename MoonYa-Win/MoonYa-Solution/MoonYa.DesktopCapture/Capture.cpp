#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <vector>
#include <memory>
using Microsoft::WRL::ComPtr;

struct Capture {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGIOutputDuplication> duplication;
    ComPtr<ID3D11Texture2D> staging;
    std::vector<unsigned char> pixels;
    int width = 0, height = 0;
};

extern "C" __declspec(dllexport) void* MoonYaCaptureOpen(const wchar_t* name) {
    try {
        ComPtr<IDXGIFactory1> factory;
        if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return nullptr;
        for (UINT a = 0;; a++) {
            ComPtr<IDXGIAdapter1> adapter;
            if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;
            for (UINT o = 0;; o++) {
                ComPtr<IDXGIOutput> output;
                if (adapter->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
                DXGI_OUTPUT_DESC desc{};
                if (FAILED(output->GetDesc(&desc)) || wcscmp(desc.DeviceName, name) != 0 || !desc.AttachedToDesktop) continue;
                auto capture = std::make_unique<Capture>();
                D3D_FEATURE_LEVEL level;
                if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    nullptr, 0, D3D11_SDK_VERSION, &capture->device, &level, &capture->context))) return nullptr;
                ComPtr<IDXGIOutput1> output1;
                if (FAILED(output.As(&output1)) || FAILED(output1->DuplicateOutput(capture->device.Get(), &capture->duplication))) return nullptr;
                capture->width = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
                capture->height = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;
                D3D11_TEXTURE2D_DESC texture{};
                texture.Width = capture->width; texture.Height = capture->height; texture.MipLevels = 1; texture.ArraySize = 1;
                texture.Format = DXGI_FORMAT_B8G8R8A8_UNORM; texture.SampleDesc.Count = 1;
                texture.Usage = D3D11_USAGE_STAGING; texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                if (FAILED(capture->device->CreateTexture2D(&texture, nullptr, &capture->staging))) return nullptr;
                capture->pixels.resize(static_cast<size_t>(capture->width) * capture->height * 4);
                return capture.release();
            }
        }
    } catch (...) { }
    return nullptr;
}

extern "C" __declspec(dllexport) HRESULT MoonYaCaptureFrame(void* handle, void** pixels, int* width, int* height, int* stride, UINT timeoutMs) {
    if (!handle || !pixels || !width || !height || !stride) return E_INVALIDARG;
    auto c = static_cast<Capture*>(handle);
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    auto hr = c->duplication->AcquireNextFrame(timeoutMs, &info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT && c->pixels[3] != 0) hr = S_FALSE;
    else if (SUCCEEDED(hr)) {
        ComPtr<ID3D11Texture2D> frame;
        hr = resource.As(&frame);
        if (SUCCEEDED(hr)) {
            D3D11_TEXTURE2D_DESC desc{}; frame->GetDesc(&desc);
            if (desc.Width != static_cast<UINT>(c->width) || desc.Height != static_cast<UINT>(c->height)) hr = DXGI_ERROR_ACCESS_LOST;
            else {
                c->context->CopyResource(c->staging.Get(), frame.Get());
                D3D11_MAPPED_SUBRESOURCE mapped{};
                hr = c->context->Map(c->staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
                if (SUCCEEDED(hr)) {
                    for (int y = 0; y < c->height; y++) {
                        auto dst = c->pixels.data() + static_cast<size_t>(y) * c->width * 4;
                        memcpy(dst, static_cast<unsigned char*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch, static_cast<size_t>(c->width) * 4);
                        for (int x = 0; x < c->width; x++) dst[x * 4 + 3] = 255;
                    }
                    c->context->Unmap(c->staging.Get(), 0);
                }
            }
        }
        c->duplication->ReleaseFrame();
    }
    if (FAILED(hr)) return hr;
    *pixels = c->pixels.data(); *width = c->width; *height = c->height; *stride = c->width * 4;
    return S_OK;
}
extern "C" __declspec(dllexport) void MoonYaCaptureClose(void* handle) { delete static_cast<Capture*>(handle); }
