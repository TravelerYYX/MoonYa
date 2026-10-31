#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <swdevice.h>
#include <iostream>
#include <string>
#include <atomic>

struct Creation { HANDLE event; HRESULT result = E_PENDING; };
void CALLBACK Created(HSWDEVICE, HRESULT hr, PVOID context, PCWSTR) {
    auto creation = static_cast<Creation*>(context); creation->result = hr; SetEvent(creation->event);
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || std::wstring(argv[1]) != L"--create") { std::cerr << "Use --create"; return 2; }
    // The software device exists only while this process holds its handle.
    SW_DEVICE_CREATE_INFO info{}; info.cbSize = sizeof(info);
    info.pszInstanceId = L"MoonYaVirtualMonitor";
    info.pszzHardwareIds = L"MoonYaVirtualDisplay\0\0";
    info.pszzCompatibleIds = L"MoonYaVirtualDisplay\0\0";
    info.pszDeviceDescription = L"MoonYa Virtual Display";
    info.CapabilityFlags = SWDeviceCapabilitiesRemovable | SWDeviceCapabilitiesSilentInstall | SWDeviceCapabilitiesDriverRequired;
    Creation creation{ CreateEvent(nullptr, TRUE, FALSE, nullptr) };
    HSWDEVICE device = nullptr;
    auto hr = SwDeviceCreate(L"MoonYa", L"HTREE\\ROOT\\0", &info, 0, nullptr, Created, &creation, &device);
    if (FAILED(hr)) { CloseHandle(creation.event); std::cout << "ERROR " << std::hex << hr << std::endl; return 1; }
    if (WaitForSingleObject(creation.event, 15000) != WAIT_OBJECT_0 || FAILED(creation.result)) {
        std::cout << "ERROR " << std::hex << creation.result << std::endl; SwDeviceClose(device); CloseHandle(creation.event); return 1;
    }
    CloseHandle(creation.event);
    std::cout << "READY" << std::endl;
    std::string command; std::getline(std::cin, command);
    SwDeviceClose(device); return 0;
}
