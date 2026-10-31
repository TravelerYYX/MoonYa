<?php
declare(strict_types=1);
require_once __DIR__ . '/AppDataPaths.php';

/**
 * DeepSeek visual-input validation and OpenAI-compatible content serialization.
 * @see https://api-docs.deepseek.com/zh-cn/guides/vision/
 */
final class DeepSeekVision
{
    public const MAX_IMAGES = 600;
    public const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
    public const MAX_FILE_IMAGE_BYTES = 64 * 1024 * 1024;
    public const MAX_INLINE_TOTAL_BYTES = 64 * 1024 * 1024;
    public const MAX_FILE_TOTAL_BYTES = 200 * 1024 * 1024;
    public const INLINE_BODY_BUDGET_BYTES = 40 * 1024 * 1024;

    /** @return array{path:string,name:string,mime_type:string,size_bytes:int,width:int,height:int} */
    public static function describePath(string $path, ?string $name = null): array
    {
        $path = trim($path);
        if ($path === '' || strlen($path) > 4096 || preg_match('/[\x00-\x1F\x7F]/u', $path)) {
            throw new InvalidArgumentException('本地图片路径无效');
        }
        if (!is_file($path) || !is_readable($path)) {
            throw new RuntimeException('图片不存在或不可读取：' . basename($path));
        }
        $size = (int)filesize($path);
        if ($size <= 0 || $size > self::MAX_FILE_IMAGE_BYTES) {
            throw new RuntimeException('单张图片必须大于 0 且不超过 64 MiB：' . basename($path));
        }
        $info = @getimagesize($path);
        if (!is_array($info)) {
            throw new RuntimeException('无法识别图片实际内容：' . basename($path));
        }
        $metadata = self::describeImageInfo($info, basename($path));
        $mime = $metadata['mime_type'];
        $width = $metadata['width'];
        $height = $metadata['height'];
        return [
            'path' => $path,
            'name' => self::safeName($name ?: basename($path)),
            'mime_type' => $mime,
            'size_bytes' => $size,
            'width' => $width,
            'height' => $height,
        ];
    }

    public static function describeImageInfo(array $info, string $name): array
    {
        $mime = match ((int)($info[2] ?? 0)) {
            IMAGETYPE_JPEG => 'image/jpeg',
            IMAGETYPE_PNG => 'image/png',
            IMAGETYPE_GIF => 'image/gif',
            defined('IMAGETYPE_WEBP') ? IMAGETYPE_WEBP : 18 => 'image/webp',
            default => throw new RuntimeException('DeepSeek 仅支持 JPEG、PNG、GIF、WebP 图片：' . $name),
        };
        $width = (int)($info[0] ?? 0);
        $height = (int)($info[1] ?? 0);
        if ($width <= 0 || $height <= 0 || $width > 8192 || $height > 8192) {
            throw new RuntimeException('图片尺寸必须在 1×1 到 8192×8192 之间：' . $name);
        }
        return ['mime_type' => $mime, 'width' => $width, 'height' => $height];
    }

    /** @param list<array<string,mixed>> $sources @return list<array<string,mixed>> */
    public static function describeSources(array $sources): array
    {
        if (count($sources) > self::MAX_IMAGES) {
            throw new RuntimeException('单次请求最多支持 600 张图片，当前为 ' . count($sources) . ' 张');
        }
        $result = [];
        foreach ($sources as $source) {
            if (!is_array($source)) throw new InvalidArgumentException('图片描述格式无效');
            $result[] = self::describePath(
                (string)($source['path'] ?? $source['local_path'] ?? ''),
                (string)($source['name'] ?? $source['original_name'] ?? '')
            );
        }
        self::validateBatchDimensions($result);
        return $result;
    }

    /** @param list<array<string,mixed>> $images @return list<array<string,mixed>> */
    public static function prepareWireParts(array $images, string $detail, array $config): array
    {
        if (!in_array($detail, ['low', 'high'], true)) {
            throw new InvalidArgumentException('无效的图片细节级别：' . $detail);
        }
        if (count($images) > self::MAX_IMAGES) {
            throw new RuntimeException('单次请求最多支持 600 张图片');
        }
        $rawBytes = array_sum(array_map(static fn(array $image): int => (int)$image['size_bytes'], $images));
        $estimatedInline = (int)ceil($rawBytes * 4 / 3);
        $inlineBudget = max(1, min(
            self::INLINE_BODY_BUDGET_BYTES,
            (int)($config['deepseek_upload']['inline_body_budget_bytes'] ?? self::INLINE_BODY_BUDGET_BYTES)
        ));
        $allInlineSized = !array_filter(
            $images,
            static fn(array $image): bool => (int)$image['size_bytes'] > self::MAX_INLINE_IMAGE_BYTES
        );
        if ($allInlineSized && $estimatedInline <= $inlineBudget && $rawBytes <= self::MAX_INLINE_TOTAL_BYTES) {
            return array_map(static function (array $image) use ($detail): array {
                $data = file_get_contents((string)$image['path']);
                if (!is_string($data)) throw new RuntimeException('读取图片失败：' . $image['name']);
                return [
                    'type' => 'image_url',
                    'image_url' => [
                        'url' => 'data:' . $image['mime_type'] . ';base64,' . base64_encode($data),
                        'detail' => $detail,
                    ],
                ];
            }, $images);
        }
        if ($rawBytes > self::MAX_FILE_TOTAL_BYTES) {
            throw new RuntimeException('本次图片总大小超过 DeepSeek 200 MiB 限制');
        }
        if (!empty($config['generic_model_images'])) throw new RuntimeException('图片过大，超过自定义模型内联输入限制，请缩小图片后重试');
        return self::uploadParts($images, $detail, $config);
    }

    public static function validateBatchDimensions(array $images): void
    {
        if (count($images) >= 15) {
            foreach ($images as $image) {
                if ($image['width'] > 4096 || $image['height'] > 4096) {
                    throw new RuntimeException('一次发送 15 张或更多图片时，单图尺寸不得超过 4096×4096：' . $image['name']);
                }
            }
        }
    }

    /** @param list<array<string,mixed>> $images @return list<array{type:string,file_id:string}> */
    private static function uploadParts(array $images, string $detail, array $config): array
    {
        $apiKey = trim((string)($config['deepseek_api_key'] ?? ''));
        $chatUrl = trim((string)($config['deepseek_api_url'] ?? ''));
        $testUploader = $config['_deepseek_file_uploader'] ?? null;
        if (!is_callable($testUploader) && ($apiKey === '' || $chatUrl === '')) throw new RuntimeException('DeepSeek Files API 未配置');
        $base = preg_replace('#/chat/completions/?$#', '', rtrim($chatUrl, '/'));
        $parts = [];
        foreach ($images as $image) {
            $upload = $image;
            $temporary = null;
            try {
                if ($detail === 'low') {
                    [$temporary, $upload] = self::lowDetailVersion($image);
                }
                if (is_callable($testUploader)) {
                    $fileId = trim((string)$testUploader($upload));
                } else {
                    $ch = curl_init($base . '/files');
                    curl_setopt_array($ch, [
                        CURLOPT_POST => true,
                        CURLOPT_POSTFIELDS => [
                            'purpose' => 'user_data',
                            'expires_after[anchor]' => 'created_at',
                            'expires_after[seconds]' => '2592000',
                            'file' => new CURLFile((string)$upload['path'], (string)$upload['mime_type'], (string)$upload['name']),
                        ],
                        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $apiKey],
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_CONNECTTIMEOUT => 15,
                        CURLOPT_TIMEOUT => 120,
                        CURLOPT_SSL_VERIFYPEER => true,
                        CURLOPT_SSL_VERIFYHOST => 2,
                    ]);
                    $response = curl_exec($ch);
                    $error = curl_error($ch);
                    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);
                    $json = is_string($response) ? json_decode($response, true) : null;
                    $fileId = is_array($json) ? trim((string)($json['id'] ?? '')) : '';
                    if ($error !== '' || $status < 200 || $status >= 300 || $fileId === '') {
                        $providerMessage = is_array($json) ? (string)($json['error']['message'] ?? '') : '';
                        throw new RuntimeException('DeepSeek 图片上传失败：' . ($providerMessage ?: ($error ?: 'HTTP ' . $status)));
                    }
                }
                if ($fileId === '') throw new RuntimeException('DeepSeek Files API 未返回文件标识');
                $parts[] = ['type' => 'file', 'file_id' => $fileId];
            } finally {
                if (is_string($temporary) && $temporary !== '') @unlink($temporary);
            }
        }
        return $parts;
    }

    /** @return array{0:string,1:array<string,mixed>} */
    private static function lowDetailVersion(array $image): array
    {
        if (!function_exists('imagecreatefromstring') || !function_exists('imagejpeg')) {
            throw new RuntimeException('低细节大图回退需要启用 PHP GD 扩展');
        }
        $data = file_get_contents((string)$image['path']);
        $source = is_string($data) ? @imagecreatefromstring($data) : false;
        if ($source === false) throw new RuntimeException('无法生成低细节图片：' . $image['name']);
        $scale = min(1.0, 512 / max((int)$image['width'], (int)$image['height']));
        $width = max(1, (int)round((int)$image['width'] * $scale));
        $height = max(1, (int)round((int)$image['height'] * $scale));
        $target = imagecreatetruecolor($width, $height);
        imagecopyresampled($target, $source, 0, 0, 0, 0, $width, $height, (int)$image['width'], (int)$image['height']);
        $path = tempnam(AppDataPaths::directory('temp', 'vision'), 'moonya-ds-low-');
        if ($path === false || !imagejpeg($target, $path, 85)) {
            imagedestroy($source); imagedestroy($target);
            throw new RuntimeException('无法写入低细节图片');
        }
        imagedestroy($source); imagedestroy($target);
        return [$path, array_merge($image, [
            'path' => $path,
            'name' => pathinfo((string)$image['name'], PATHINFO_FILENAME) . '-low.jpg',
            'mime_type' => 'image/jpeg',
            'size_bytes' => (int)filesize($path),
            'width' => $width,
            'height' => $height,
        ])];
    }

    private static function safeName(string $name): string
    {
        $name = trim(str_replace(["\r", "\n", "\0"], '', $name));
        return $name !== '' ? mb_substr($name, 0, 240) : 'image';
    }
}
