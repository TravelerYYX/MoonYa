<?php
declare(strict_types=1);

require_once __DIR__ . '/LocalDocumentExtractor.php';

final class WebAttachmentService
{
    private PDO $pdo;
    private array $config;
    private array $attachmentConfig;

    public function __construct(PDO $pdo, array $config)
    {
        $this->pdo = $pdo;
        $this->config = $config;
        $this->attachmentConfig = is_array($config['web_attachments'] ?? null)
            ? $config['web_attachments']
            : [];
        foreach (['max_files', 'max_file_size', 'ttl_seconds', 'max_extracted_chars',
                  'provider_connect_timeout_seconds', 'provider_timeout_seconds'] as $requiredKey) {
            if ((int)($this->attachmentConfig[$requiredKey] ?? 0) <= 0) {
                throw new InvalidArgumentException('Web 附件配置缺失：' . $requiredKey);
            }
        }
        if (!is_array($this->attachmentConfig['categories'] ?? null)) {
            throw new InvalidArgumentException('Web 附件格式白名单未配置');
        }
    }

    public function publicConfig(): array
    {
        return [
            'limits' => [
                'max_files' => (int)$this->attachmentConfig['max_files'],
                'max_images' => (int)($this->attachmentConfig['max_images'] ?? 600),
                'max_file_size' => (int)$this->attachmentConfig['max_file_size'],
                'max_image_size' => (int)($this->attachmentConfig['max_image_size'] ?? 64 * 1024 * 1024),
                'ttl_seconds' => (int)$this->attachmentConfig['ttl_seconds'],
            ],
            'categories' => $this->attachmentConfig['categories'] ?? [],
        ];
    }

    public function upload(int $userId, array $file, string $batchId, string $relativePath): array
    {
        $this->assertUuid($batchId, '批次标识无效');
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new RuntimeException('文件上传失败（错误码 ' . (int)($file['error'] ?? -1) . '）');
        }

        $tmpName = (string)($file['tmp_name'] ?? '');
        $size = (int)($file['size'] ?? 0);
        if ($tmpName === '' || !is_uploaded_file($tmpName)) {
            throw new RuntimeException('上传临时文件无效');
        }

        if ($size <= 0) throw new RuntimeException('不能上传空文件');

        $maxFiles = (int)($this->attachmentConfig['max_files'] ?? 0);
        $originalName = $this->cleanName((string)($file['name'] ?? 'file'));
        $extension = strtolower((string)pathinfo($originalName, PATHINFO_EXTENSION));
        $mimeType = $this->detectMime($tmpName, (string)($file['type'] ?? ''));
        $category = $this->categoryFor($extension, $mimeType);
        if ($category === null) {
            throw new RuntimeException('不支持的 Web 文件格式：.' . ($extension !== '' ? $extension : '(无扩展名)'));
        }
        $maxSize = $category === 'image'
            ? (int)($this->attachmentConfig['max_image_size'] ?? 64 * 1024 * 1024)
            : (int)($this->attachmentConfig['max_file_size'] ?? 0);
        if ($size > $maxSize) {
            throw new RuntimeException('单文件大小不得超过 ' . $maxSize . ' 字节');
        }
        $categoryLimit = $category === 'image'
            ? (int)($this->attachmentConfig['max_images'] ?? 600)
            : $maxFiles;
        $countStmt = $this->pdo->prepare(
            "SELECT COUNT(*) FROM chat_attachments
             WHERE user_id=? AND batch_id=? AND deleted_at IS NULL AND status IN ('pending','ready')"
             . ($category === 'image' ? " AND category='image'" : " AND category<>'image'")
        );
        $countStmt->execute([$userId, $batchId]);
        if ((int)$countStmt->fetchColumn() >= $categoryLimit) {
            throw new RuntimeException($category === 'image'
                ? '本条消息最多上传 600 张图片'
                : '本条消息最多上传 ' . $categoryLimit . ' 个非图片文件');
        }
        $this->validateMime($category, $extension, $mimeType);

        $id = self::uuidV4();
        $storageDir = $this->storageDirectory();
        $storedPath = $storageDir . DIRECTORY_SEPARATOR . $id . ($extension !== '' ? '.' . $extension : '');
        if (!move_uploaded_file($tmpName, $storedPath)) {
            throw new RuntimeException('无法保存临时附件');
        }

        $expiresAt = date('Y-m-d H:i:s', time() + (int)$this->attachmentConfig['ttl_seconds']);
        $relativePath = $this->cleanRelativePath($relativePath !== '' ? $relativePath : $originalName);
        $insert = $this->pdo->prepare(
            'INSERT INTO chat_attachments
             (id,user_id,batch_id,original_name,relative_path,extension,category,mime_type,size_bytes,
              provider,provider_file_id,local_path,extracted_path,status,error_message,expires_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,\'pending\',NULL,?)'
        );
        try {
            $insert->execute([
                $id, $userId, $batchId, $originalName, $relativePath, $extension, $category,
                $mimeType, $size, $category === 'audio' ? 'aliyun' : 'local', null,
                $storedPath, null, $expiresAt,
            ]);
        } catch (Throwable $insertError) {
            @unlink($storedPath);
            throw $insertError;
        }

        try {
            $providerFileId = null;
            $extractedText = '';
            $purpose = '';

            if ($category === 'image') {
                // DeepSeek consumes the authenticated local bytes directly.
                $purpose = 'image';
            } elseif ($category === 'audio') {
                $purpose = 'transcription';
                $extractedText = $this->transcribeAudio($storedPath, $extension);
            } else {
                // 文档：DeepSeek 没有远端 file-extract，改为本机解析文本。
                $purpose = 'file-extract';
                $localText = LocalDocumentExtractor::extract($storedPath, $extension);
                if (is_string($localText)) {
                    $extractedText = $localText;
                }
            }

            $extractedPath = null;
            if ($extractedText !== '') {
                $maxChars = (int)$this->attachmentConfig['max_extracted_chars'];
                if (mb_strlen($extractedText) > $maxChars) {
                    $extractedText = mb_substr($extractedText, 0, $maxChars);
                }
                $extractedPath = $storageDir . DIRECTORY_SEPARATOR . $id . '.txt';
                if (file_put_contents($extractedPath, $extractedText, LOCK_EX) === false) {
                    throw new RuntimeException('无法保存附件提取结果');
                }
            }

            $update = $this->pdo->prepare(
                "UPDATE chat_attachments
                 SET provider_file_id=?, extracted_path=?, status='ready', error_message=NULL
                 WHERE id=? AND user_id=?"
            );
            $update->execute([$providerFileId, $extractedPath, $id, $userId]);

            return [
                'attachment_id' => $id,
                'filename' => $originalName,
                'relative_path' => $relativePath,
                'category' => $category,
                'purpose' => $purpose,
                'expires_at' => date(DATE_ATOM, strtotime($expiresAt)),
            ];
        } catch (Throwable $error) {
            $failure = $this->pdo->prepare(
                "UPDATE chat_attachments SET status='failed', error_message=? WHERE id=? AND user_id=?"
            );
            $failure->execute([mb_substr($error->getMessage(), 0, 2000), $id, $userId]);
            throw $error;
        }
    }

    public function resolveOwned(int $userId, array $attachmentIds): array
    {
        $ids = array_values(array_unique(array_filter(array_map('strval', $attachmentIds))));
        if ($ids === []) {
            return [];
        }
        $maxImages = (int)($this->attachmentConfig['max_images'] ?? 600);
        $maxNonImages = (int)$this->attachmentConfig['max_files'];
        if (count($ids) > $maxImages + $maxNonImages) {
            throw new RuntimeException('附件数量超过限制');
        }
        foreach ($ids as $id) {
            $this->assertUuid($id, '附件标识无效');
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->pdo->prepare(
            "SELECT * FROM chat_attachments
             WHERE user_id=? AND id IN ($placeholders) AND status='ready'
               AND deleted_at IS NULL AND expires_at > NOW()"
        );
        $stmt->execute(array_merge([$userId], $ids));
        $byId = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $textPath = (string)($row['extracted_path'] ?? '');
            $row['extracted_text'] = $textPath !== '' && is_file($textPath)
                ? (string)file_get_contents($textPath)
                : '';
            $byId[(string)$row['id']] = $row;
        }
        $imageCount = count(array_filter($byId, static fn(array $row): bool => ($row['category'] ?? '') === 'image'));
        $nonImageCount = count($byId) - $imageCount;
        if ($imageCount > $maxImages) throw new RuntimeException('图片数量超过 600 张限制');
        if ($nonImageCount > $maxNonImages) {
            throw new RuntimeException('非图片附件数量超过限制');
        }
        $resolved = [];
        foreach ($ids as $id) {
            if (!isset($byId[$id])) {
                throw new RuntimeException('附件不存在、已过期或无权访问：' . $id);
            }
            $resolved[] = $byId[$id];
        }
        return $resolved;
    }

    public function deleteOwned(int $userId, string $attachmentId): void
    {
        $this->assertUuid($attachmentId, '附件标识无效');
        $stmt = $this->pdo->prepare(
            'SELECT * FROM chat_attachments WHERE id=? AND user_id=? AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([$attachmentId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return;
        }
        $this->destroyFiles($row);
        $this->pdo->prepare(
            "UPDATE chat_attachments SET status='deleted', deleted_at=NOW() WHERE id=? AND user_id=?"
        )->execute([$attachmentId, $userId]);
    }

    public function cleanupExpired(int $limit = 50): int
    {
        $limit = max(1, min(200, $limit));
        $rows = $this->pdo->query(
            "SELECT * FROM chat_attachments
             WHERE deleted_at IS NULL AND expires_at <= NOW()
             ORDER BY expires_at ASC LIMIT $limit"
        )->fetchAll(PDO::FETCH_ASSOC);
        $cleaned = 0;
        foreach ($rows as $row) {
            try {
                $this->destroyFiles($row);
                $this->pdo->prepare(
                    "UPDATE chat_attachments SET status='expired', deleted_at=NOW() WHERE id=?"
                )->execute([(string)$row['id']]);
                $cleaned++;
            } catch (Throwable $error) {
                // 保留未标记状态，下一轮清理继续重试远端删除。
                error_log('[Attachment] 清理过期附件失败，将重试：' . $error->getMessage());
            }
        }
        return $cleaned;
    }

    private function destroyFiles(array $row): void
    {
        foreach (['local_path', 'extracted_path'] as $field) {
            $path = (string)($row[$field] ?? '');
            if ($path !== '' && is_file($path)) {
                @unlink($path);
            }
        }
    }

    private function categoryFor(string $extension, string $mimeType): ?string
    {
        if ($extension === 'webm') {
            if (str_starts_with($mimeType, 'audio/')) return 'audio';
            if (str_starts_with($mimeType, 'video/')) return 'video';
        }
        foreach (['image', 'video', 'audio', 'document'] as $category) {
            $extensions = $this->attachmentConfig['categories'][$category] ?? [];
            if (is_array($extensions) && in_array($extension, $extensions, true)) {
                return $category;
            }
        }
        return null;
    }

    private function validateMime(string $category, string $extension, string $mimeType): void
    {
        $dangerous = ['application/x-dosexec', 'application/x-executable', 'application/x-msdownload'];
        if (in_array($mimeType, $dangerous, true)) {
            throw new RuntimeException('文件实际类型与扩展名不匹配');
        }
        if ($category === 'image' && !in_array($mimeType, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], true)) {
            throw new RuntimeException('DeepSeek 图片仅支持实际内容为 JPEG、PNG、GIF 或 WebP');
        }
        if ($category === 'video' && !str_starts_with($mimeType, 'video/') && $mimeType !== 'application/octet-stream') {
            throw new RuntimeException('视频 MIME 类型无效');
        }
        if ($category === 'audio' && !str_starts_with($mimeType, 'audio/')
            && !in_array($mimeType, ['video/webm', 'application/octet-stream'], true)) {
            throw new RuntimeException('音频 MIME 类型无效');
        }
    }

    private function transcribeAudio(string $path, string $format): string
    {
        $asr = $this->config['aliyun_asr'] ?? [];
        $apiKey = (string)($asr['api_key'] ?? '');
        if ($apiKey === '') {
            throw new RuntimeException('ASR 服务未配置');
        }
        foreach (['model', 'upload_policy_url', 'transcription_url', 'task_url_template', 'max_wait_seconds',
                  'poll_interval_microseconds', 'connect_timeout_seconds', 'request_timeout_seconds',
                  'upload_timeout_seconds', 'result_timeout_seconds'] as $requiredField) {
            if (empty($asr[$requiredField])) {
                throw new RuntimeException('ASR 服务缺少必填配置字段 aliyun_asr.' . $requiredField);
            }
        }
        if (!str_contains((string)$asr['task_url_template'], '{task_id}')) {
            throw new RuntimeException('ASR 服务配置 aliyun_asr.task_url_template 缺少 {task_id} 占位符');
        }
        $formatMap = [
            'webm' => 'audio/webm', 'wav' => 'audio/wav', 'pcm' => 'audio/pcm',
            'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'm4a' => 'audio/mp4',
        ];
        $mime = $formatMap[$format] ?? 'application/octet-stream';
        $models = array_values(array_unique($asr['fallback_models'] ?? [(string)$asr['model']]));
        $taskId = '';
        $lastError = null;
        foreach ($models as $model) {
            try {
                $policy = $this->dashscopeJson('GET', (string)$asr['upload_policy_url'], $apiKey, null, [
                    'action' => 'getPolicy', 'model' => $model,
                ]);
                $fileUrl = $this->dashscopeUpload($policy['data'] ?? [], $path, 'attachment_' . self::uuidV4() . '.' . $format, $mime);
                $task = $this->dashscopeJson('POST', (string)$asr['transcription_url'], $apiKey, [
                    'model' => $model,
                    'input' => ['file_urls' => [$fileUrl]],
                    'parameters' => ['language_hints' => $asr['language_hints'] ?? ['zh', 'en']],
                ]);
                $taskId = (string)($task['output']['task_id'] ?? '');
                if ($taskId === '') throw new RuntimeException('ASR 未返回任务标识');
                break;
            } catch (Throwable $error) {
                $lastError = $error;
                if (!str_contains($error->getMessage(), 'AccessDenied')
                    && !str_contains($error->getMessage(), 'ModelAccessDenied')) {
                    throw $error;
                }
            }
        }
        if ($taskId === '') {
            if ($lastError instanceof Throwable) {
                throw $lastError;
            }
            throw new RuntimeException('无法创建 ASR 任务');
        }
        $deadline = microtime(true) + (int)$asr['max_wait_seconds'];
        $result = null;
        while (microtime(true) < $deadline) {
            usleep((int)$asr['poll_interval_microseconds']);
            $taskUrl = str_replace('{task_id}', rawurlencode($taskId), (string)$asr['task_url_template']);
            $result = $this->dashscopeJson('GET', $taskUrl, $apiKey);
            $status = (string)($result['output']['task_status'] ?? '');
            if (in_array($status, ['SUCCEEDED', 'FAILED', 'CANCELED'], true)) break;
        }
        if (!is_array($result) || ($result['output']['task_status'] ?? '') !== 'SUCCEEDED') {
            throw new RuntimeException('音频转写失败或超时');
        }
        $text = '';
        foreach (($result['output']['results'] ?? []) as $item) {
            if (($item['subtask_status'] ?? '') !== 'SUCCEEDED') continue;
            if (!empty($item['text'])) {
                $text .= (string)$item['text'];
            } elseif (!empty($item['transcription_url'])) {
                $raw = $this->rawGet((string)$item['transcription_url']);
                $json = json_decode($raw, true);
                $text .= (string)($json['transcripts'][0]['text'] ?? '');
            }
        }
        if ($text === '' && !empty($result['output']['transcription_url'])) {
            $json = json_decode($this->rawGet((string)$result['output']['transcription_url']), true);
            $text = (string)($json['transcripts'][0]['text'] ?? '');
        }
        return trim($text);
    }

    private function dashscopeJson(string $method, string $url, string $apiKey, ?array $body = null, array $query = []): array
    {
        if ($query !== []) $url .= '?' . http_build_query($query);
        $headers = ['Authorization: Bearer ' . $apiKey, 'Accept: application/json', 'X-DashScope-OssResourceResolve: enable'];
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CONNECTTIMEOUT => (int)$this->config['aliyun_asr']['connect_timeout_seconds'],
            CURLOPT_TIMEOUT => (int)$this->config['aliyun_asr']['request_timeout_seconds'],
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
            $headers[] = 'X-DashScope-Async: enable';
            $options[CURLOPT_HTTPHEADER] = $headers;
            $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE);
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, $options);
        $response = curl_exec($ch);
        $error = curl_error($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $json = is_string($response) ? json_decode($response, true) : null;
        if ($error !== '' || $status < 200 || $status >= 300 || !is_array($json)) {
            throw new RuntimeException('DashScope 请求失败：' . ($error ?: 'HTTP ' . $status . ' ' . substr((string)$response, 0, 300)));
        }
        return $json;
    }

    private function dashscopeUpload(array $policy, string $path, string $filename, string $mime): string
    {
        $host = (string)($policy['upload_host'] ?? '');
        $dir = (string)($policy['upload_dir'] ?? '');
        if ($host === '' || $dir === '') throw new RuntimeException('ASR 上传策略无效');
        $fields = [
            'OSSAccessKeyId' => $policy['oss_access_key_id'] ?? '',
            'Signature' => $policy['signature'] ?? '',
            'policy' => $policy['policy'] ?? '',
            'x-oss-object-acl' => $policy['x_oss_object_acl'] ?? '',
            'x-oss-forbid-overwrite' => $policy['x_oss_forbid_overwrite'] ?? '',
            'key' => rtrim($dir, '/') . '/' . $filename,
            'success_action_status' => '200',
            'file' => new CURLFile($path, $mime, $filename),
        ];
        $ch = curl_init($host);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => $fields, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => (int)$this->config['aliyun_asr']['connect_timeout_seconds'],
            CURLOPT_TIMEOUT => (int)$this->config['aliyun_asr']['upload_timeout_seconds'],
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $response = curl_exec($ch);
        $error = curl_error($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($error !== '' || $status < 200 || $status >= 300) {
            throw new RuntimeException('ASR 音频上传失败：' . ($error ?: 'HTTP ' . $status . ' ' . substr((string)$response, 0, 200)));
        }
        return 'oss://' . rtrim($dir, '/') . '/' . $filename;
    }

    private function rawGet(string $url): string
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => (int)$this->config['aliyun_asr']['connect_timeout_seconds'],
            CURLOPT_TIMEOUT => (int)$this->config['aliyun_asr']['result_timeout_seconds'],
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $response = curl_exec($ch);
        $error = curl_error($ch);
        curl_close($ch);
        if ($error !== '') throw new RuntimeException('获取转写结果失败：' . $error);
        return (string)$response;
    }

    private function storageDirectory(): string
    {
        $dir = (string)($this->attachmentConfig['temp_dir'] ?? '');
        if ($dir === '') throw new RuntimeException('附件临时目录未配置');
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('无法创建附件临时目录');
        }
        return rtrim($dir, DIRECTORY_SEPARATOR);
    }

    public function detectMime(string $path, string $fallback): string
    {
        $finfo = new finfo(FILEINFO_MIME_TYPE);
        return (string)($finfo->file($path) ?: ($fallback !== '' ? $fallback : 'application/octet-stream'));
    }

    private function cleanName(string $name): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $name) ?: 'file';
        return mb_substr($name, 0, 255);
    }

    private function cleanRelativePath(string $path): string
    {
        $parts = [];
        foreach (preg_split('~[\\\\/]+~', $path) ?: [] as $part) {
            if ($part === '' || $part === '.' || $part === '..') continue;
            $parts[] = preg_replace('/[\x00-\x1F\x7F]/u', '', $part) ?: '_';
        }
        return mb_substr(implode('/', $parts) ?: 'file', 0, 1024);
    }

    private function assertUuid(string $value, string $message): void
    {
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value)) {
            throw new InvalidArgumentException($message);
        }
    }

    public static function uuidV4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
