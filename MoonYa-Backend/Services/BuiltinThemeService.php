<?php
declare(strict_types=1);

/**
 * 内置主题：目录（下发）+ 资源落盘 + 配置文件覆盖。
 *
 * 优先级规则（catalog()）：DB 为底，config/builtin_themes.json 按 slug 覆盖，last-writer-wins。
 *  - 文件条目写了 updated_at 就用它，没写就用文件自身的 mtime
 *  - 时间较新的一侧生效；后台每次保存都会写 updated_at，所以手改文件后一旦在后台改一次就能夺回优先权
 *  - 文件条目 enabled:false 视为下架，可以盖掉 DB 的上架状态
 * 后台「导出到配置文件」会把 DB 全量按原 updated_at 写出，此后每次后台保存都会 bump
 * updated_at，于是自动夺回优先权，无需手动同步。
 */
final class BuiltinThemeService
{
    /** 必须与前端 appearance.js 的 COLOR_DEFS 键完全一致。 */
    public const COLOR_KEYS = [
        'appBackground', 'sidebar', 'surface', 'inputBackground', 'inputText',
        'buttonBackground', 'buttonText', 'border', 'accent', 'textPrimary', 'textSecondary',
    ];
    public const FILLS = ['cover', 'contain', 'fill'];
    public const KINDS = ['image', 'video'];

    private const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
    private const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'm4v'];
    private const MAX_ASSET_BYTES = 67108864; // 64MB，与客户端下载桥的上限一致

    public function __construct(
        private PDO $db,
        private string $root,
        private string $baseUrl,
        private string $configPath
    ) {
        $this->root = rtrim($this->root, '/\\');
        $this->baseUrl = rtrim($this->baseUrl, '/');
        if (!is_dir($this->root) && !@mkdir($this->root, 0700, true) && !is_dir($this->root)) {
            throw new RuntimeException('主题资源目录不可用');
        }
    }

    /** 配置文件 mtime，作为文件条目缺 updated_at 时的时间基准。 */
    private ?int $_configMtime = null;

    /* ── 读取 ─────────────────────────────────────────────── */

    /** @return array<int,array<string,mixed>> 后台列表（含未上架） */
    public function listing(): array
    {
        $rows = $this->db->query('SELECT * FROM builtin_themes ORDER BY sort_order ASC, id ASC')->fetchAll(PDO::FETCH_ASSOC);
        return array_map(fn(array $row): array => $this->adminRow($row), $rows ?: []);
    }

    /** 公开目录：仅 enabled，并叠加配置文件覆盖。 */
    public function catalog(): array
    {
        $bySlug = [];
        foreach ($this->db->query('SELECT * FROM builtin_themes WHERE enabled = 1 ORDER BY sort_order ASC, id ASC')->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $bySlug[$row['slug']] = $row;
        }
        foreach ($this->configEntries() as $slug => $entry) {
            // 文件里显式 enabled:false 视为「下架」，可以盖掉 DB 里的上架状态。
            if (array_key_exists('enabled', $entry) && !$entry['enabled']) { unset($bySlug[$slug]); continue; }
            $current = $bySlug[$slug] ?? null;
            if ($current !== null && !$this->configWins($entry, $current)) continue;
            $bySlug[$slug] = [
                'slug' => $slug,
                'name' => (string)($entry['name'] ?? $slug),
                'summary' => (string)($entry['summary'] ?? ''),
                'sort_order' => (int)($entry['sort_order'] ?? 0),
                'enabled' => 1,
                'colors' => json_encode($entry['colors'] ?? new stdClass(), JSON_UNESCAPED_UNICODE),
                'blur' => (int)($entry['blur'] ?? 0),
                'shell_opacity' => (string)($entry['shell_opacity'] ?? '0.85'),
                'background_kind' => (string)($entry['background']['kind'] ?? 'image'),
                'background_fill' => (string)($entry['background']['fill'] ?? 'cover'),
                'background_key' => (string)($entry['background']['key'] ?? ''),
                'thumb_key' => (string)($entry['thumb_key'] ?? ''),
                'asset_sha256' => (string)($entry['background']['sha256'] ?? ''),
                'asset_bytes' => (int)($entry['background']['bytes'] ?? 0),
                'asset_version' => (int)($entry['asset_version'] ?? 1),
                'updated_at' => (string)($entry['updated_at'] ?? ''),
            ];
        }
        $themes = array_values(array_map(fn(array $row): array => $this->publicRow($row), $bySlug));
        usort($themes, static fn(array $a, array $b): int => [$a['sort'], $a['slug']] <=> [$b['sort'], $b['slug']]);
        return ['version' => $this->catalogVersion($themes), 'base' => $this->baseUrl, 'themes' => $themes];
    }

    /* ── 写入 ─────────────────────────────────────────────── */

    /** upsert：有 id 按 id，否则按 slug。返回后台行。 */
    public function save(int $adminId, array $input): array
    {
        $slug = strtolower(trim((string)($input['slug'] ?? '')));
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $slug)) throw new InvalidArgumentException('主题标识只能是小写字母、数字、- 和 _');
        $name = trim((string)($input['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 64) throw new InvalidArgumentException('主题名称需为 1-64 个字符');
        $summary = mb_substr(trim((string)($input['summary'] ?? '')), 0, 200);
        $colors = $this->validateColors($input['colors'] ?? []);
        $blur = (int)($input['blur'] ?? 0);
        if ($blur < 0 || $blur > 60) throw new InvalidArgumentException('模糊度需在 0-60 之间');
        $opacity = (float)($input['shellOpacity'] ?? 0.85);
        if ($opacity < 0.2 || $opacity > 1) throw new InvalidArgumentException('界面不透明度需在 0.2-1 之间');
        $kind = (string)($input['backgroundKind'] ?? 'image');
        $fill = (string)($input['backgroundFill'] ?? 'cover');
        if (!in_array($kind, self::KINDS, true)) throw new InvalidArgumentException('背景类型无效');
        if (!in_array($fill, self::FILLS, true)) throw new InvalidArgumentException('填充方式无效');

        $existing = $this->findBySlug($slug);
        // 缺 enabled 视为「保持现状」而不是「下架」——避免只改配色却把主题静默下架。
        $enabled = array_key_exists('enabled', $input) ? (!empty($input['enabled']) ? 1 : 0) : (int)($existing['enabled'] ?? 1);
        $backgroundKey = (string)($input['backgroundKey'] ?? ($existing['background_key'] ?? ''));
        $thumbKey = (string)($input['thumbKey'] ?? ($existing['thumb_key'] ?? ''));
        $sha = (string)($existing['asset_sha256'] ?? '');
        $bytes = (int)($existing['asset_bytes'] ?? 0);

        if ((int)($input['id'] ?? 0) > 0) {
            $stmt = $this->db->prepare(
                'UPDATE builtin_themes SET slug=?, name=?, summary=?, sort_order=?, enabled=?, colors=?, blur=?, shell_opacity=?,
                 background_kind=?, background_fill=?, background_key=?, thumb_key=?, updated_at=? WHERE id=?'
            );
            $stmt->execute([
                $slug, $name, $summary, (int)($input['sortOrder'] ?? $existing['sort_order'] ?? 0),
                $enabled, json_encode($colors, JSON_UNESCAPED_UNICODE), $blur, $opacity,
                $kind, $fill, $backgroundKey, $thumbKey, date('Y-m-d H:i:s'), (int)$input['id'],
            ]);
        } else {
            $stmt = $this->db->prepare(
                'INSERT INTO builtin_themes (slug, name, summary, sort_order, enabled, colors, blur, shell_opacity,
                 background_kind, background_fill, background_key, thumb_key, asset_sha256, asset_bytes, admin_id, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([
                $slug, $name, $summary, (int)($input['sortOrder'] ?? 0), $enabled,
                json_encode($colors, JSON_UNESCAPED_UNICODE), $blur, $opacity, $kind, $fill,
                $backgroundKey, $thumbKey, $sha, $bytes, $adminId, date('Y-m-d H:i:s'),
            ]);
        }
        $row = $this->findBySlug($slug);
        $this->pruneConfigEntry($slug);
        return $this->adminRow($row);
    }

    /**
     * 从配置文件里摘掉某个 slug。后台一旦动过某个主题，配置文件就交出该主题的话语权，
     * 这样「导出的快照」既不会复活已删除的主题，也不会盖掉刚保存的修改。
     */
    private function pruneConfigEntry(string $slug): void
    {
        if (!is_file($this->configPath)) return;
        try {
            $raw = json_decode((string)file_get_contents($this->configPath), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable) { return; }
        $themes = is_array($raw['themes'] ?? null) ? $raw['themes'] : [];
        $kept = array_values(array_filter($themes, static fn($entry): bool => !is_array($entry) || ($entry['slug'] ?? '') !== $slug));
        if (count($kept) === count($themes)) return;
        $raw['themes'] = $kept;
        $tmp = $this->configPath.'.tmp';
        if (@file_put_contents($tmp, json_encode($raw, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false) {
            @unlink($tmp);
            return;
        }
        @rename($tmp, $this->configPath);
    }

    public function setEnabled(int $id, bool $enabled): array
    {
        $this->requireRow($id);
        $this->db->prepare('UPDATE builtin_themes SET enabled = ?, updated_at = ? WHERE id = ?')
            ->execute([$enabled ? 1 : 0, date('Y-m-d H:i:s'), $id]);
        $row = $this->requireRow($id);
        $this->pruneConfigEntry((string)$row['slug']);
        return $this->adminRow($row);
    }

    public function setSort(int $id, int $sort): array
    {
        $this->requireRow($id);
        $this->db->prepare('UPDATE builtin_themes SET sort_order = ?, updated_at = ? WHERE id = ?')
            ->execute([$sort, date('Y-m-d H:i:s'), $id]);
        $row = $this->requireRow($id);
        $this->pruneConfigEntry((string)$row['slug']);
        return $this->adminRow($row);
    }

    public function remove(int $id): array
    {
        $row = $this->requireRow($id);
        $this->db->prepare('DELETE FROM builtin_themes WHERE id = ?')->execute([$id]);
        // 从配置文件里摘掉，否则导出的快照会让刚删掉的主题复活。
        $this->pruneConfigEntry((string)$row['slug']);
        // 资源目录按 slug 独立，只在没有任何行再引用同一 slug 时才删。
        if ($this->findBySlug((string)$row['slug']) === null) {
            $dir = $this->root.'/'.$row['slug'];
            foreach (glob($dir.'/*') ?: [] as $file) @unlink($file);
            @rmdir($dir);
        }
        return $this->adminRow($row);
    }

    /**
     * 保存上传的背景图/缩略图到 uploads/themes/<slug>/，并更新 sha/字节数/版本号。
     * @param array{name?:string,type?:string,tmp_name?:string,error?:int,size?:int} $file
     */
    public function attachAsset(int $id, array $file, bool $isThumb = false): array
    {
        $row = $this->requireRow($id);
        $slug = (string)$row['slug'];
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) throw new InvalidArgumentException('资源上传失败');
        $bytes = (int)($file['size'] ?? 0);
        if ($bytes <= 0 || $bytes > self::MAX_ASSET_BYTES) throw new InvalidArgumentException('资源大小超出限制（最大 64MB）');
        $ext = strtolower(pathinfo((string)($file['name'] ?? ''), PATHINFO_EXTENSION));
        $allowed = $isThumb ? self::IMAGE_EXT : array_merge(self::IMAGE_EXT, self::VIDEO_EXT);
        if (!in_array($ext, $allowed, true)) throw new InvalidArgumentException('不支持的资源格式');

        $dir = $this->root.'/'.$slug;
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('资源目录不可创建');
        $sha = (string)hash_file('sha256', (string)$file['tmp_name']);
        $name = ($isThumb ? 'thumb' : 'bg-'.substr($sha, 0, 16)).'.'.$ext;
        $target = $dir.'/'.$name;
        if (!@move_uploaded_file((string)$file['tmp_name'], $target)) throw new RuntimeException('资源写入失败');

        if ($isThumb) {
            $this->db->prepare('UPDATE builtin_themes SET thumb_key = ? WHERE id = ?')->execute([$slug.'/'.$name, $id]);
        } else {
            // 换图就升资源版本，客户端据此判定缓存过期。
            $this->db->prepare('UPDATE builtin_themes SET background_key = ?, asset_sha256 = ?, asset_bytes = ?, asset_version = asset_version + 1 WHERE id = ?')
                ->execute([$slug.'/'.$name, $sha, $bytes, $id]);
        }
        return $this->adminRow($this->requireRow($id));
    }

    /* ── 配置文件 ─────────────────────────────────────────── */

    /** 把当前 DB 全量导出到 config/builtin_themes.json（原子写）。 */
    public function exportConfig(): array
    {
        $themes = [];
        foreach ($this->db->query('SELECT * FROM builtin_themes ORDER BY sort_order ASC, id ASC')->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $themes[] = [
                'slug' => $row['slug'],
                'name' => $row['name'],
                'summary' => $row['summary'],
                'sort_order' => (int)$row['sort_order'],
                'enabled' => (bool)$row['enabled'],
                'colors' => $this->decodeColors((string)$row['colors']),
                'blur' => (int)$row['blur'],
                'shell_opacity' => (float)$row['shell_opacity'],
                'asset_version' => (int)$row['asset_version'],
                'thumb_key' => (string)$row['thumb_key'],
                'background' => [
                    'kind' => (string)$row['background_kind'],
                    'fill' => (string)$row['background_fill'],
                    'key' => (string)$row['background_key'],
                    'sha256' => (string)$row['asset_sha256'],
                    'bytes' => (int)$row['asset_bytes'],
                ],
                // 故意不写 updated_at：导出只是一份快照，之后以文件 mtime 为准，
                // 这样手改文件立刻生效，而后台一保存就会把该 slug 从文件里摘掉、重新掌权。
            ];
        }
        $payload = ['version' => 1, 'updated_at' => gmdate('c'), 'themes' => $themes];
        $dir = dirname($this->configPath);
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('配置目录不可写');
        $tmp = $this->configPath.'.tmp';
        if (@file_put_contents($tmp, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false) {
            throw new RuntimeException('配置文件写入失败');
        }
        if (!@rename($tmp, $this->configPath)) { @unlink($tmp); throw new RuntimeException('配置文件替换失败'); }
        return ['written' => count($themes), 'path' => basename($this->configPath)];
    }

    /** 用配置文件内容 upsert 落库（把文件当一次性权威）。 */
    public function importConfig(int $adminId): array
    {
        $entries = $this->configEntries();
        if (!$entries) throw new InvalidArgumentException('配置文件里没有可导入的主题');
        $imported = 0;
        foreach ($entries as $slug => $entry) {
            $this->save($adminId, [
                'slug' => $slug,
                'name' => (string)($entry['name'] ?? $slug),
                'summary' => (string)($entry['summary'] ?? ''),
                'sortOrder' => (int)($entry['sort_order'] ?? 0),
                'enabled' => (bool)($entry['enabled'] ?? true),
                'colors' => (array)($entry['colors'] ?? []),
                'blur' => (int)($entry['blur'] ?? 0),
                'shellOpacity' => (float)($entry['shell_opacity'] ?? 0.85),
                'backgroundKind' => (string)($entry['background']['kind'] ?? 'image'),
                'backgroundFill' => (string)($entry['background']['fill'] ?? 'cover'),
                'backgroundKey' => (string)($entry['background']['key'] ?? ''),
                'thumbKey' => (string)($entry['thumb_key'] ?? ''),
            ]);
            $imported++;
        }
        return ['imported' => $imported];
    }

    /** @return array<string,array<string,mixed>> */
    private function configEntries(): array
    {
        $this->_configMtime = null;
        if (!is_file($this->configPath)) return [];
        $this->_configMtime = @filemtime($this->configPath) ?: null;
        try {
            $raw = json_decode((string)file_get_contents($this->configPath), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable $error) {
            error_log('Builtin themes config unreadable: '.$error->getMessage());
            return [];
        }
        $entries = [];
        foreach ((array)($raw['themes'] ?? []) as $entry) {
            if (!is_array($entry)) continue;
            $slug = strtolower(trim((string)($entry['slug'] ?? '')));
            if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $slug)) continue;
            $entries[$slug] = $entry;
        }
        return $entries;
    }

    /** 文件条目是否压过 DB 行。两侧都用 PHP 时区解析，避免与 MySQL CURRENT_TIMESTAMP 的时区产生偏移。 */
    private function configWins(array $entry, array $row): bool
    {
        $stamp = trim((string)($entry['updated_at'] ?? ''));
        // 没写 updated_at 就用文件自身的 mtime（经 PHP 时区来回一次，保证与 DB 字符串同口径比秒）。
        $fileTime = $stamp !== ''
            ? strtotime($stamp)
            : ($this->_configMtime !== null ? strtotime(date('Y-m-d H:i:s', $this->_configMtime)) : false);
        if ($fileTime === false) return true;
        $dbTime = strtotime(trim((string)($row['updated_at'] ?? '')));
        if ($dbTime === false) return true;
        // 平局判给 DB：同一秒内既改了文件又在后台保存时以后台的显式操作为准。
        return $fileTime > $dbTime;
    }

    /* ── 行映射与校验 ─────────────────────────────────────── */

    private function findBySlug(string $slug): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM builtin_themes WHERE slug = ? LIMIT 1');
        $stmt->execute([$slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    private function requireRow(int $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM builtin_themes WHERE id = ? LIMIT 1');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) throw new InvalidArgumentException('主题不存在');
        return $row;
    }

    private function decodeColors(string $json): array
    {
        try { $decoded = json_decode($json, true, 32, JSON_THROW_ON_ERROR); }
        catch (Throwable) { return []; }
        return is_array($decoded) ? $decoded : [];
    }

    private function adminRow(array $row): array
    {
        return [
            'id' => (int)$row['id'],
            'slug' => (string)$row['slug'],
            'name' => (string)$row['name'],
            'summary' => (string)$row['summary'],
            'sortOrder' => (int)$row['sort_order'],
            'enabled' => (bool)$row['enabled'],
            'colors' => $this->decodeColors((string)$row['colors']),
            'blur' => (int)$row['blur'],
            'shellOpacity' => (float)$row['shell_opacity'],
            'backgroundKind' => (string)$row['background_kind'],
            'backgroundFill' => (string)$row['background_fill'],
            'backgroundKey' => (string)$row['background_key'],
            'thumbKey' => (string)$row['thumb_key'],
            'assetVersion' => (int)$row['asset_version'],
            'assetBytes' => (int)$row['asset_bytes'],
            'updatedAt' => (string)($row['updated_at'] ?? ''),
        ];
    }

    /** 客户端目录条目：拼绝对 URL，键名 camelCase 对齐前端。 */
    private function publicRow(array $row): array
    {
        $key = (string)($row['background_key'] ?? '');
        $thumb = (string)($row['thumb_key'] ?? '');
        return [
            'slug' => (string)$row['slug'],
            'name' => (string)$row['name'],
            'summary' => (string)($row['summary'] ?? ''),
            'sort' => (int)($row['sort_order'] ?? 0),
            'assetVersion' => (int)($row['asset_version'] ?? 1),
            'blur' => (int)($row['blur'] ?? 0),
            'shellOpacity' => (float)($row['shell_opacity'] ?? 0.85),
            'colors' => $this->decodeColors((string)($row['colors'] ?? '{}')),
            'background' => [
                'type' => (string)($row['background_kind'] ?? 'image'),
                'fill' => (string)($row['background_fill'] ?? 'cover'),
                'key' => $key,
                'ext' => strtolower(pathinfo($key, PATHINFO_EXTENSION)),
                'sha256' => (string)($row['asset_sha256'] ?? ''),
                'bytes' => (int)($row['asset_bytes'] ?? 0),
                // 桌面端 origin 是 127.0.0.1，静态资源不经网关，必须绝对地址。
                'url' => $this->absoluteUrl($key),
            ],
            'thumbUrl' => $this->absoluteUrl($thumb),
        ];
    }

    private function absoluteUrl(string $key): ?string
    {
        if ($key === '' || $this->baseUrl === '') return null;
        return $this->baseUrl.'/uploads/themes/'.ltrim($key, '/');
    }

    private function catalogVersion(array $themes): string
    {
        $parts = array_map(static fn(array $t): string => $t['slug'].':'.$t['assetVersion'], $themes);
        return substr(hash('sha256', implode('|', $parts)), 0, 12);
    }

    /** @return array<string,string> 只保留白名单键与合法色值 */
    private function validateColors(mixed $colors): array
    {
        if (!is_array($colors)) throw new InvalidArgumentException('配色格式无效');
        $result = [];
        foreach ($colors as $key => $value) {
            if (!in_array((string)$key, self::COLOR_KEYS, true)) throw new InvalidArgumentException('未知的配色项：'.(string)$key);
            if (!is_string($value) || !preg_match('/^#[0-9a-fA-F]{6}$/', $value)) throw new InvalidArgumentException('配色值必须是 #RRGGBB');
            $result[(string)$key] = strtolower($value);
        }
        return $result;
    }
}
