<?php
declare(strict_types=1);
require_once __DIR__ . '/Services/AppDataPaths.php';
// An unguessable, short-lived URL allows the configured OCR service to read its input.
$name = (string)($_GET['file'] ?? '');
if (!preg_match('/^_ocr_[a-f0-9]{16}\.(png|jpg|jpeg|gif|bmp|tif|pdf)$/', $name)) { http_response_code(404); exit; }
$path = AppDataPaths::path('temp', 'ocr', $name);
if (!is_file($path) || filemtime($path) < time() - 300) { http_response_code(404); exit; }
header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff');
header('Content-Type: ' . (new finfo(FILEINFO_MIME_TYPE))->file($path));
readfile($path);
