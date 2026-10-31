<?php
declare(strict_types=1);
require_once __DIR__ . '/DeepSeekVision.php';

/** Receive bytes, never desktop paths. Provider uploads run with server credentials. */
final class DesktopImageInput
{
    public static function attachments(array $attachments, string $detail, array $config): array
    {
        $temporary = []; $images = []; $texts = []; $total = 0;
        try {
            foreach ($attachments as $attachment) {
                $name = (string)($attachment['name'] ?? '图片');
                if (($attachment['category'] ?? '') === 'document') { $texts[] = "本地附件：{$name}\n内容：\n" . (string)($attachment['text'] ?? ''); continue; }
                if (($attachment['category'] ?? '') !== 'image' || !preg_match('#^data:image/[^;,]+;base64,(.+)$#s', (string)($attachment['data_url'] ?? ''), $match)) throw new InvalidArgumentException('本地图片格式无效');
                $bytes = base64_decode($match[1], true);
                if (!is_string($bytes) || strlen($bytes) > DeepSeekVision::MAX_FILE_IMAGE_BYTES || ($total += strlen($bytes)) > DeepSeekVision::MAX_FILE_TOTAL_BYTES) throw new InvalidArgumentException('图片超过单次请求大小限制');
                $info = @getimagesizefromstring($bytes);
                if (!is_array($info)) throw new InvalidArgumentException('图片实际内容无效');
                DeepSeekVision::describeImageInfo($info, $name);
                $path = tempnam(AppDataPaths::directory('temp', 'client-images'), 'moonya-image-');
                if ($path === false) throw new RuntimeException('图片临时目录不可用');
                $temporary[] = $path;
                if (file_put_contents($path, $bytes) !== strlen($bytes)) throw new RuntimeException('图片接收失败');
                $images[] = DeepSeekVision::describePath($path, $name);
            }
            DeepSeekVision::validateBatchDimensions($images);
            return ['parts' => DeepSeekVision::prepareWireParts($images, $detail, $config), 'texts' => $texts];
        } finally { foreach ($temporary as $path) @unlink($path); }
    }

    public static function messages(array $messages, array $config): array
    {
        foreach ($messages as &$message) {
            if (!is_array($message['content'] ?? null)) continue;
            foreach (['low', 'high'] as $detail) {
                $attachments = []; $indexes = [];
                foreach ($message['content'] as $index => $part) {
                    if (($part['type'] ?? '') !== 'image_url' || !str_starts_with((string)($part['image_url']['url'] ?? ''), 'data:image/')) continue;
                    if (($part['image_url']['detail'] ?? 'high') !== $detail) continue;
                    $indexes[] = $index;
                    $attachments[] = ['category' => 'image', 'data_url' => $part['image_url']['url'], 'name' => '客户端图片 ' . ($index + 1)];
                }
                if ($attachments === []) continue;
                $resolved = self::attachments($attachments, $detail, $config);
                foreach ($indexes as $position => $index) $message['content'][$index] = $resolved['parts'][$position];
            }
        }
        unset($message);
        return $messages;
    }
}
