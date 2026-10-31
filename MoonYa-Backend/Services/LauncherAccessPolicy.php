<?php
declare(strict_types=1);

final class LauncherAccessPolicy
{
    public const REQUIRED_ERROR_CODE = 'moonya_launcher_required';
    public const REQUIRED_MESSAGE = '当前为网页访问，无法调用本地工具。请使用 MoonYa 启动器后重试。';

    /**
     * Older clients did not send launcher_available. Keep those clients
     * compatible; current browser clients always send an explicit boolean.
     */
    public static function isAvailable(array $request): bool
    {
        if (!array_key_exists('launcher_available', $request)) {
            return true;
        }

        return $request['launcher_available'] === true;
    }

    /** @return array<string,mixed> */
    public static function unavailableToolResult(): array
    {
        return [
            'success' => false,
            'error_code' => self::REQUIRED_ERROR_CODE,
            'message' => self::REQUIRED_MESSAGE,
            'requires_launcher' => true,
        ];
    }
}
