<?php
declare(strict_types=1);
require_once __DIR__ . '/../Services/WorkImagePaths.php';
require_once __DIR__ . '/../Services/WorkLocalAttachment.php';

function check(bool $value, string $message): void
{
    if (!$value) throw new RuntimeException($message);
}

// Load the actual gateway content builders without running its HTTP/auth/database bootstrap.
$gateway = (string)file_get_contents(__DIR__ . '/../harness_api.php');
$start = strpos($gateway, 'function resolveRuntimeImageDetail(');
$end = strpos($gateway, 'function runtimePdo(', $start);
eval(substr($gateway, $start, $end - $start));

$paths = WorkImagePaths::extract("\u{202A}C:\\Users\\Administrator\\Pictures\\yax.png这是什么\u{202C}\n\"D:\\中文 目录\\参考 图.JPG\" 和 C:/other.webp");
check($paths === ['C:\\Users\\Administrator\\Pictures\\yax.png', 'D:\\中文 目录\\参考 图.JPG', 'C:/other.webp'], 'copy/pasted paths, quotes, spaces and Chinese prose must survive');
check(WorkImagePaths::extract('C:\\one.png 和 C:\\two.gif') === ['C:\\one.png', 'C:\\two.gif'], 'multiple images must preserve message order');
check(WorkImagePaths::extract('C:\\one.png C:/ONE.PNG') === ['C:\\one.png'], 'case and separator variants must deduplicate');
check(WorkImagePaths::extract('\\\\server\\share\\图 像.png') === ['\\\\server\\share\\图 像.png'], 'UNC references must remain intact');
check(WorkImagePaths::extract('relative.png https://site/image.png C:\\image.png.bak C:\\image.png\\other.txt') === [], 'URLs, relative text and image-looking components must not grant reads');

$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'moonya-work-image-' . bin2hex(random_bytes(6));
mkdir($directory);
$file = $directory . DIRECTORY_SEPARATOR . 'reference image.png';
$bad = $directory . DIRECTORY_SEPARATOR . 'bad.png';
$png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
file_put_contents($file, base64_decode($png));
file_put_contents($bad, 'not an image');
try {
    // This fixture is outside any selected project; the gateway needs no shell approval.
    $content = buildRuntimeUserContent(['message' => $file . '这是什么', 'image_detail' => 'low'], [], 1);
    check($content[0]['image_url']['url'] === 'data:image/png;base64,' . $png, 'raw user paths must reach the real multimodal wire');
    check($content[0]['image_url']['detail'] === 'low', 'the existing detail setting must be preserved');
    check(str_contains($content[1]['text'], $file), 'image identity must be available to the model');
    $dedup = buildRuntimeUserContent(['message' => $file, 'local_paths' => [['path' => $file]]], [], 1);
    check(count(array_filter($dedup, static fn($part) => $part['type'] === 'image_url')) === 1, 'picker and pasted image references must deduplicate');
    $attachmentOnly = buildRuntimeUserContent(['message' => 'read the attached document', 'local_attachments' => [
        ['name' => 'document.txt', 'category' => 'document', 'text' => $file],
    ]], [], 1);
    check(count($attachmentOnly) === 1 && $attachmentOnly[0]['type'] === 'text', 'paths in untrusted attached documents must not authorize image reads');
    foreach ([$bad, $directory . DIRECTORY_SEPARATOR . 'missing.png'] as $invalid) {
        $threw = false;
        try { buildRuntimeUserContent(['message' => $invalid], [], 1); }
        catch (RuntimeException $error) { $threw = true; }
        check($threw, 'missing and corrupt images must report a concrete error');
    }
    $oversized = $directory . DIRECTORY_SEPARATOR . 'oversized.png';
    $handle = fopen($oversized, 'w+b');
    ftruncate($handle, DeepSeekVision::MAX_FILE_IMAGE_BYTES + 1);
    fclose($handle);
    try {
        $threw = false;
        try { buildRuntimeUserContent(['message' => $oversized], [], 1); }
        catch (RuntimeException $error) { $threw = str_contains($error->getMessage(), '64 MiB'); }
        check($threw, 'pasted paths must share the existing file size limit');
    } finally { unlink($oversized); }
    $threw = false;
    try { DeepSeekVision::describeImageInfo([8193, 1, IMAGETYPE_PNG], 'oversized-dimensions.png'); }
    catch (RuntimeException $error) { $threw = true; }
    check($threw, 'pasted image dimensions must share the existing model limit');
    $svg = $directory . DIRECTORY_SEPARATOR . 'unsupported.svg';
    file_put_contents($svg, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    try {
        $threw = false;
        try { buildRuntimeUserContent(['message' => $svg], [], 1); }
        catch (RuntimeException $error) { $threw = true; }
        check($threw, 'unsupported image paths must fail visibly instead of being ignored');
    } finally { unlink($svg); }
    check(str_contains($gateway, "'image_detail' => resolveRuntimeImageDetail(\$data)"), 'the runtime must receive image detail for tool images');
} finally {
    unlink($file);
    unlink($bad);
    rmdir($directory);
}
echo "Work image path and multimodal gateway: PASS\n";
