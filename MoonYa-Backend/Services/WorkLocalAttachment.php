<?php
declare(strict_types=1);
require_once __DIR__ . '/DeepSeekVision.php';

/** Inline inference content from browser-local attachments; never writes a cloud attachment row. */
final class WorkLocalAttachment
{
    public static function resolve(mixed $attachments, string $detail): array
    {
        if (!is_array($attachments)) throw new InvalidArgumentException('本地附件参数格式无效');
        $parts = [];
        $texts = [];
        $bytes = 0;
        foreach ($attachments as $attachment) {
            if (!is_array($attachment)) throw new InvalidArgumentException('本地附件格式无效');
            $name = (string)($attachment['name'] ?? '附件');
            if (($attachment['category'] ?? '') === 'image') {
                $url = (string)($attachment['data_url'] ?? '');
                if (!preg_match('#^data:image/[^;,]+;base64,(.+)$#s', $url, $match)) throw new InvalidArgumentException('本地图片格式无效');
                $data = base64_decode($match[1], true);
                $info = is_string($data) ? @getimagesizefromstring($data) : false;
                if (!$info || !str_starts_with((string)($info['mime'] ?? ''), 'image/')) throw new InvalidArgumentException('本地图片内容无效');
                $metadata = DeepSeekVision::describeImageInfo($info, $name);
                if (strlen($data) > DeepSeekVision::MAX_INLINE_IMAGE_BYTES) throw new InvalidArgumentException('本地图片超过模型内联图片限制，请通过桌面文件选择器添加');
                $bytes += strlen($data);
                $parts[] = ['type' => 'image_url', 'image_url' => ['url' => 'data:' . $metadata['mime_type'] . ';base64,' . base64_encode($data), 'detail' => $detail],
                    '_order' => (float)($attachment['order'] ?? count($parts)), '_width' => $metadata['width'], '_height' => $metadata['height'], '_name' => $name];
            } elseif (($attachment['category'] ?? '') === 'document') {
                $texts[] = '本地附件：' . $name . "\n内容：\n" . (string)($attachment['text'] ?? '');
            } else {
                throw new InvalidArgumentException('此本地附件需要通过桌面文件选择器添加：' . $name);
            }
        }
        if (count($parts) > DeepSeekVision::MAX_IMAGES || $bytes > DeepSeekVision::MAX_INLINE_TOTAL_BYTES) throw new InvalidArgumentException('本地图片超过模型单次内联请求限制');
        DeepSeekVision::validateBatchDimensions(array_map(static fn(array $part): array => ['width' => $part['_width'], 'height' => $part['_height'], 'name' => $part['_name']], $parts));
        return ['parts' => $parts, 'texts' => $texts];
    }
}
