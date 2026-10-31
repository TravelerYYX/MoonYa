<?php
declare(strict_types=1);

// Run once with the database migration. Only the former managed WorkLogMedia
// directory is accepted; arbitrary paths and symlink traversal are rejected.
require_once dirname(__DIR__) . '/env_loader.php';
$localAppData = trim((string)getenv('LOCALAPPDATA'));   // 真实 OS 变量，非 .env
$root = trim((string)env('MOONYA_WORKLOG_MEDIA_DIR', ''));
if ($root === '' && $localAppData !== '') {
    $root = rtrim($localAppData, "\\/") . DIRECTORY_SEPARATOR . 'MoonYa' . DIRECTORY_SEPARATOR . 'WorkLogMedia';
}
if ($root === '') {
    fwrite(STDERR, "Managed media directory is not configured.\n");
    exit(1);
}
$root = rtrim($root, "\\/");
if (basename($root) !== 'WorkLogMedia' || is_link($root)) {
    fwrite(STDERR, "Refusing unexpected media directory: {$root}\n");
    exit(1);
}
if (!is_dir($root)) exit(0);

$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
    RecursiveIteratorIterator::CHILD_FIRST
);
foreach ($iterator as $entry) {
    if ($entry->isLink()) {
        unlink($entry->getPathname());
    } elseif ($entry->isDir()) {
        rmdir($entry->getPathname());
    } else {
        unlink($entry->getPathname());
    }
}
rmdir($root);
