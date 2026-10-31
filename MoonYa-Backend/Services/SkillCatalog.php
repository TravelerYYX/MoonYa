<?php
declare(strict_types=1);

final class SkillCatalog
{
    public const ALLOWED = ['browser-use-automation', 'computer-use-automation'];
    public const MAX_FILE_BYTES = 1048576;
    public const MAX_UPLOAD_BYTES = 10485760;
    private const RESERVED = ['computer-use', 'realtime-voice-chat', 'external-browser-chrome', 'external-browser-edge'];

    private static function canonical(string $name): string
    {
        return $name === 'computer-use' ? 'computer-use-automation' : $name;
    }

    public static function isCustom(string $name): bool
    {
        return preg_match('/^[a-z0-9-]{1,63}$/', $name) === 1
            && !in_array($name, array_merge(self::ALLOWED, self::RESERVED), true);
    }

    private function requireCustom(string $name): void
    {
        if (!preg_match('/^[a-z0-9-]{1,63}$/', $name)) throw new InvalidArgumentException('技能标识无效');
        if (!self::isCustom($name)) throw new DomainException('内置技能或保留名称不允许编辑信息或删除');
    }

    public function __construct(private readonly string $root)
    {
    }

    public function list(bool $includeBody = false): array
    {
        $names = [];
        foreach (new DirectoryIterator($this->root) as $entry) {
            $name = $entry->getFilename();
            if ($entry->isDot() || $entry->isLink() || !$entry->isDir() || !preg_match('/^[a-z0-9-]{1,63}$/', $name)) continue;
            if (is_file($entry->getPathname() . '/SKILL.md')) $names[] = self::canonical($name);
        }
        sort($names, SORT_STRING);
        $names = array_values(array_unique(array_merge(array_intersect(self::ALLOWED, $names), $names)));
        return array_map(fn(string $name): array => $this->read($name, $includeBody), $names);
    }

    public function runtimeSkills(): array
    {
        $lockPath = $this->root . '/.catalog.lock';
        $lock = is_file($lockPath) ? fopen($lockPath, 'r') : false;
        try {
            if ($lock !== false && !flock($lock, LOCK_SH)) throw new RuntimeException('无法读取技能快照');
            return array_values(array_map(static fn(array $skill): array => array_intersect_key($skill,
                array_flip(['name', 'display_name', 'description', 'enabled', 'body', 'resources'])),
                array_filter($this->list(true), static fn(array $skill): bool => $skill['enabled'])));
        } finally { if ($lock !== false) { flock($lock, LOCK_UN); fclose($lock); } }
    }

    public function create(string $name, string $displayName, string $description, string $body): array
    {
        $this->normalizeRelativePath($name, true);
        if (!self::isCustom($name)) {
            throw new InvalidArgumentException('技能标识无效或为保留名称');
        }
        if (trim($description) === '' || preg_match('/[\r\n]/', $description)) throw new InvalidArgumentException('用途说明不能为空或包含换行');
        $raw = "---\nname: {$name}\ndescription: " . json_encode($description, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)
            . "\nmetadata: " . json_encode(['display_name' => trim($displayName) ?: $name], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)
            . "\n---\n\n" . trim($body) . "\n";
        self::parse($raw);
        $this->validateContent($raw);
        return $this->withWriteLock(function () use ($name, $raw): array {
            $directory = $this->root . DIRECTORY_SEPARATOR . $name;
            if (file_exists($directory) || is_link($directory)) throw new InvalidArgumentException('技能已存在');
            if (!mkdir($directory, 0775)) throw new RuntimeException('无法创建技能目录');
            try { $this->atomicWrite($directory . '/SKILL.md', $raw); return $this->read($name); }
            catch (Throwable $error) { @unlink($directory . '/SKILL.md'); @rmdir($directory); throw $error; }
        });
    }

    public function createDirectory(string $name, string $path): array
    {
        $path = $this->normalizeRelativePath($path, true);
        if ($path === '') throw new InvalidArgumentException('目录名称不能为空');
        return $this->withWriteLock(function () use ($name, $path): array {
            $parent = $this->directoryPath($name, dirname($path) === '.' ? '' : dirname($path));
            $target = $parent . DIRECTORY_SEPARATOR . basename($path);
            if (file_exists($target) || is_link($target)) throw new InvalidArgumentException('同名文件或目录已存在');
            if (!mkdir($target, 0775)) throw new RuntimeException('创建目录失败');
            return $this->browse($name, $path);
        });
    }

    /** @param array<array{name:string,raw:string}> $files */
    public function upload(string $name, string $path, array $files): array
    {
        if ($files === []) throw new InvalidArgumentException('请选择 Markdown 文件');
        return $this->withWriteLock(function () use ($name, $path, $files): array {
            $directory = $this->directoryPath($name, $this->normalizeRelativePath($path, true));
            $pending = []; $total = 0;
            foreach ($files as $file) {
                $filename = $this->normalizeRelativePath($file['name'], false);
                if (str_contains($filename, '/')) throw new InvalidArgumentException('上传文件名不能包含目录');
                $raw = $file['raw']; $this->validateContent($raw);
                $total += strlen($raw);
                if ($total > self::MAX_UPLOAD_BYTES) throw new InvalidArgumentException('单次上传总量不能超过 10 MiB');
                $key = strtolower($filename);
                $target = $directory . DIRECTORY_SEPARATOR . $filename;
                if (isset($pending[$key]) || file_exists($target) || is_link($target)) throw new InvalidArgumentException('同名文件已存在，请通过编辑器修改: ' . $filename);
                foreach (scandir($directory) ?: [] as $existing) {
                    if (strcasecmp($existing, $filename) === 0) throw new InvalidArgumentException('同名文件已存在: ' . $filename);
                }
                $pending[$key] = ['target' => $target, 'raw' => $raw];
            }
            $written = [];
            try {
                foreach ($pending as $file) { $this->atomicWrite($file['target'], $file['raw']); $written[] = $file['target']; }
            } catch (Throwable $error) { foreach ($written as $target) @unlink($target); throw $error; }
            return $this->browse($name, $path);
        });
    }

    /** Upload one validated tree in a single transaction; paths are relative to the selected destination. */
    public function uploadTree(string $name, string $path, array $directories, array $files): array
    {
        $tree = $this->prepareTree($directories, $files);
        $path = $this->normalizeRelativePath($path, true);
        return $this->withWriteLock(function () use ($name, $path, $tree): array {
            $root = $this->directoryPath($name, $path);
            $this->validateTreeDestination($root, $tree);
            $this->writeTree($root, $tree);
            return ['directory' => $this->browse($name, $path), 'uploaded_count' => count($tree['files']),
                'directory_count' => count($tree['directories']), 'skipped' => $tree['skipped']];
        });
    }

    /** Import complete skill folders. The manifest's name is the installed skill identifier. */
    public function importTrees(array $directories, array $files): array
    {
        $tree = $this->prepareTree($directories, $files);
        $groups = [];
        foreach ($tree['directories'] as $directory) {
            $parts = explode('/', $directory, 2);
            $groups[$parts[0]] ??= ['directories' => [], 'files' => []];
            if (isset($parts[1])) $groups[$parts[0]]['directories'][] = $parts[1];
        }
        foreach ($tree['files'] as $file) {
            $parts = explode('/', $file['path'], 2);
            if (!isset($parts[1])) throw new InvalidArgumentException('请上传完整技能文件夹，根目录必须包含 SKILL.md');
            $groups[$parts[0]] ??= ['directories' => [], 'files' => []];
            $groups[$parts[0]]['files'][] = ['path' => $parts[1], 'raw' => $file['raw']];
        }
        if ($groups === []) throw new InvalidArgumentException('没有可导入的技能文件夹');
        $imports = [];
        foreach ($groups as $folder => $group) {
            $manifest = null;
            foreach ($group['files'] as $file) if ($file['path'] === 'SKILL.md') $manifest = $file['raw'];
            if ($manifest === null) throw new InvalidArgumentException("技能文件夹 {$folder} 根目录缺少 SKILL.md");
            $skill = self::parse($manifest);
            $name = $skill['name'];
            $this->normalizeRelativePath($name, true);
            if (!self::isCustom($name)) throw new InvalidArgumentException('技能标识无效或为保留名称: ' . $name);
            if (isset($imports[$name])) throw new InvalidArgumentException('多个文件夹的技能标识重复: ' . $name);
            $imports[$name] = $group;
        }
        return $this->withWriteLock(function () use ($imports, $tree): array {
            foreach ($imports as $name => $group) {
                $target = $this->root . DIRECTORY_SEPARATOR . $name;
                $this->assertNoCaseConflict($target);
                if (file_exists($target) || is_link($target)) throw new InvalidArgumentException('技能已存在: ' . $name);
            }
            $stage = $this->root . DIRECTORY_SEPARATOR . '.import-' . bin2hex(random_bytes(12));
            if (!mkdir($stage, 0775)) throw new RuntimeException('无法创建技能导入临时目录');
            $published = [];
            try {
                foreach ($imports as $name => $group) {
                    $destination = $stage . DIRECTORY_SEPARATOR . $name;
                    if (!mkdir($destination, 0775)) throw new RuntimeException('无法创建技能导入目录');
                    $this->writeTree($destination, $group);
                }
                foreach ($imports as $name => $group) {
                    $target = $this->root . DIRECTORY_SEPARATOR . $name;
                    if (!rename($stage . DIRECTORY_SEPARATOR . $name, $target)) throw new RuntimeException('技能导入失败');
                    $published[] = $target;
                }
                $skills = array_map(fn(string $name): array => $this->read($name), array_keys($imports));
            } catch (Throwable $error) {
                foreach ($published as $target) $this->removeOwnedTree($target);
                throw $error;
            } finally { $this->removeOwnedTree($stage); }
            return ['skills' => $skills, 'uploaded_count' => count($tree['files']),
                'directory_count' => count($tree['directories']), 'skipped' => $tree['skipped']];
        });
    }

    private function prepareTree(array $directories, array $files): array
    {
        $nodes = []; $pending = []; $skipped = []; $total = 0;
        $addDirectory = function (string $path) use (&$nodes): void {
            $parts = explode('/', $path); $current = '';
            foreach ($parts as $part) {
                $current = ltrim($current . '/' . $part, '/'); $key = strtolower($current);
                if (isset($nodes[$key]) && ($nodes[$key]['type'] !== 'directory' || $nodes[$key]['path'] !== $current)) throw new InvalidArgumentException('上传目录名称冲突: ' . $current);
                $nodes[$key] = ['path' => $current, 'type' => 'directory'];
            }
        };
        foreach ($directories as $directory) {
            if (!is_string($directory)) throw new InvalidArgumentException('目录路径必须为文本');
            $directory = $this->normalizeRelativePath($directory, true);
            if ($directory === '') throw new InvalidArgumentException('上传目录路径不能为空');
            $addDirectory($directory);
        }
        foreach ($files as $file) {
            if (!is_array($file) || !isset($file['path']) || !is_string($file['path'])) throw new InvalidArgumentException('上传文件路径无效');
            $path = $this->normalizeRelativePath($file['path'], true);
            if ($path === '') throw new InvalidArgumentException('上传文件路径不能为空');
            if (strtolower(pathinfo($path, PATHINFO_EXTENSION)) !== 'md') {
                $skipped[] = ['path' => $path, 'reason' => '不支持的文件格式，仅支持 Markdown (.md)'];
                continue;
            }
            if (!isset($file['raw']) || !is_string($file['raw'])) throw new InvalidArgumentException('Markdown 文件内容必须为文本');
            $this->validateContent($file['raw']); $total += strlen($file['raw']);
            if ($total > self::MAX_UPLOAD_BYTES) throw new InvalidArgumentException('单次上传总量不能超过 10 MiB');
            $parent = dirname($path);
            if ($parent !== '.') $addDirectory($parent);
            $key = strtolower($path);
            if (isset($nodes[$key])) throw new InvalidArgumentException('上传文件名称冲突: ' . $path);
            $nodes[$key] = ['path' => $path, 'type' => 'file'];
            $pending[] = ['path' => $path, 'raw' => $file['raw']];
        }
        $folders = array_column(array_filter($nodes, static fn(array $node): bool => $node['type'] === 'directory'), 'path');
        usort($folders, static fn(string $a, string $b): int => substr_count($a, '/') <=> substr_count($b, '/') ?: strcmp($a, $b));
        return ['directories' => $folders, 'files' => $pending, 'skipped' => $skipped];
    }

    private function assertNoCaseConflict(string $target): void
    {
        $parent = dirname($target);
        if (!is_dir($parent)) return;
        $leaf = basename($target);
        foreach (scandir($parent) ?: [] as $existing) {
            if ($existing !== $leaf && strcasecmp($existing, $leaf) === 0) throw new InvalidArgumentException('同名文件或目录已存在: ' . $leaf);
        }
    }

    private function validateTreeDestination(string $root, array $tree): void
    {
        foreach (array_merge(array_map(static fn(string $path): array => ['path' => $path, 'directory' => true], $tree['directories']),
            array_map(static fn(array $file): array => ['path' => $file['path'], 'directory' => false], $tree['files'])) as $node) {
            $this->rejectLinks($root, $node['path']);
            $target = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $node['path']);
            $this->assertNoCaseConflict($target);
            if (!file_exists($target)) continue;
            $real = realpath($target);
            if (!$node['directory'] || !is_dir($target) || $real === false || !$this->isInside($root, $real)) throw new InvalidArgumentException('同名文件或目录已存在，请通过编辑器修改: ' . $node['path']);
        }
    }

    private function writeTree(string $root, array $tree): void
    {
        $createdDirectories = []; $written = [];
        try {
            foreach ($tree['directories'] as $directory) {
                $target = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $directory);
                if (is_dir($target)) continue;
                if (!mkdir($target, 0775)) throw new RuntimeException('上传目录创建失败: ' . $directory);
                $createdDirectories[] = $target;
            }
            foreach ($tree['files'] as $file) {
                $target = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $file['path']);
                $this->atomicWrite($target, $file['raw']); $written[] = $target;
            }
        } catch (Throwable $error) {
            foreach ($written as $target) @unlink($target);
            foreach (array_reverse($createdDirectories) as $directory) @rmdir($directory);
            throw $error;
        }
    }

    // Only used for staging trees created by this operation, never for caller-provided paths.
    private function removeOwnedTree(string $root): void
    {
        if (!is_dir($root)) return;
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $entry) {
            if ($entry->isDir() && !$entry->isLink()) @rmdir($entry->getPathname()); else @unlink($entry->getPathname());
        }
        @rmdir($root);
    }

    private function validateContent(string $raw): void
    {
        if (strlen($raw) > self::MAX_FILE_BYTES) throw new InvalidArgumentException('单文件不能超过 1 MiB');
        if (trim($raw) === '' || str_contains($raw, "\0") || preg_match('//u', $raw) !== 1) throw new InvalidArgumentException('提示词必须为非空 UTF-8 文本');
    }

    private function withWriteLock(callable $operation): mixed
    {
        $lock = fopen($this->root . '/.catalog.lock', 'c');
        if ($lock === false) throw new RuntimeException('技能目录不可写');
        try {
            if (!flock($lock, LOCK_EX)) throw new RuntimeException('无法锁定技能目录');
            return $operation();
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    private function atomicWrite(string $path, string $raw): void
    {
        $temporary = tempnam(dirname($path), '.skill-');
        if ($temporary === false) throw new RuntimeException('无法创建临时文件');
        try {
            if (file_put_contents($temporary, $raw, LOCK_EX) === false || !rename($temporary, $path)) throw new RuntimeException('技能文件写入失败');
        } finally { if (is_file($temporary)) @unlink($temporary); }
    }

    public function read(string $name, bool $includeBody = true): array
    {
        $name = self::canonical($name);
        $path = $this->filePath($name, 'SKILL.md');
        $raw = @file_get_contents($path);
        if (!is_string($raw)) {
            throw new RuntimeException("技能文件不存在: {$name}");
        }
        $parsed = self::parse($raw);
        if ($parsed['name'] !== $name) {
            throw new RuntimeException("技能名称与目录不一致: {$name}");
        }
        if ($includeBody) {
            $parsed['resources'] = $this->resources($name);
        } else {
            unset($parsed['body'], $parsed['raw']);
        }
        return $parsed + ['path' => $path];
    }

    public function update(string $name, string $raw): array
    {
        return $this->updateFile($name, 'SKILL.md', $raw);
    }

    public function updateInfo(string $name, string $displayName, string $description, string $body): array
    {
        $this->requireCustom($name);
        if (trim($description) === '' || preg_match('/[\r\n]/', $description)) throw new InvalidArgumentException('用途说明不能为空或包含换行');
        return $this->withWriteLock(function () use ($name, $displayName, $description, $body): array {
            $skill = $this->read($name);
            preg_match('/\A---\n(.*?)\n---\n?(.*)\z/s', $skill['raw'], $matches);
            $fields = self::parseFrontmatter($matches[1]);
            $metadata = json_decode($fields['metadata'] ?? '{}', true, 32, JSON_THROW_ON_ERROR);
            $metadata['display_name'] = trim($displayName) ?: $name;
            $replacements = [
                'description' => json_encode(trim($description), JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
                'metadata' => json_encode((object)$metadata, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            ];
            $seen = []; $lines = [];
            foreach (explode("\n", $matches[1]) as $line) {
                if (preg_match('/^(description|metadata):/', $line, $field)) {
                    $key = $field[1];
                    if (!isset($seen[$key])) $lines[] = $key . ': ' . $replacements[$key];
                    $seen[$key] = true;
                } else $lines[] = $line;
            }
            foreach ($replacements as $key => $value) if (!isset($seen[$key])) $lines[] = $key . ': ' . $value;
            return $this->saveExistingFile($name, 'SKILL.md', "---\n" . implode("\n", $lines) . "\n---\n\n" . trim($body) . "\n");
        });
    }

    public function delete(string $name): void
    {
        $this->requireCustom($name);
        $this->withWriteLock(function () use ($name): void {
            $root = $this->skillRoot($name);
            $entries = [];
            $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($iterator as $entry) {
                $path = $entry->getPathname();
                $real = realpath($path);
                if ($entry->isLink() || $real === false || !$this->isInside($root, $real)) throw new InvalidArgumentException('技能目录包含符号链接或越界路径，无法删除');
                $entries[] = ['path' => $path, 'directory' => $entry->isDir()];
            }
            // Keep the manifest until resources have been removed, so a failed deletion never creates an invalid catalog entry.
            $manifest = $root . DIRECTORY_SEPARATOR . 'SKILL.md';
            foreach ($entries as $entry) {
                if ($entry['path'] === $manifest) continue;
                $ok = $entry['directory'] ? @rmdir($entry['path']) : @unlink($entry['path']);
                if (!$ok) throw new RuntimeException('技能删除未完成，请检查目录写入权限后重试');
            }
            if (is_file($manifest) && !@unlink($manifest)) throw new RuntimeException('技能主文件删除失败');
            if (!@rmdir($root)) throw new RuntimeException('技能目录删除失败');
        });
    }

    public function readFile(string $name, string $relativePath = 'SKILL.md'): array
    {
        $relativePath = $this->normalizeRelativePath($relativePath, false);
        $path = $this->filePath($name, $relativePath);
        $raw = @file_get_contents($path);
        if (!is_string($raw)) throw new RuntimeException("技能文件无法读取: {$relativePath}");
        return [
            'name' => $name,
            'path' => $relativePath,
            'raw' => str_replace(["\r\n", "\r"], "\n", $raw),
            'size' => strlen($raw),
        ];
    }

    public function browse(string $name, string $relativePath = ''): array
    {
        $relativePath = $this->normalizeRelativePath($relativePath, true);
        $directory = $this->directoryPath($name, $relativePath);
        $entries = [];
        foreach (new DirectoryIterator($directory) as $entry) {
            if ($entry->isDot() || $entry->isLink()) continue;
            if (!$entry->isDir() && strtolower($entry->getExtension()) !== 'md') continue;
            $child = ltrim($relativePath . '/' . $entry->getFilename(), '/');
            $entries[] = [
                'name' => $entry->getFilename(),
                'path' => str_replace('\\', '/', $child),
                'type' => $entry->isDir() ? 'directory' : 'file',
                'size' => $entry->isFile() ? $entry->getSize() : null,
            ];
        }
        usort($entries, static fn(array $left, array $right): int =>
            ($left['type'] === $right['type'])
                ? strcasecmp($left['name'], $right['name'])
                : ($left['type'] === 'directory' ? -1 : 1)
        );
        return ['name' => $name, 'path' => $relativePath, 'entries' => $entries];
    }

    public function updateFile(string $name, string $relativePath, string $raw): array
    {
        return $this->withWriteLock(fn(): array => $this->saveExistingFile($name, $relativePath, $raw));
    }

    private function saveExistingFile(string $name, string $relativePath, string $raw): array
    {
        $this->validateContent($raw);
        $name = self::canonical($name);
        $relativePath = $this->normalizeRelativePath($relativePath, false);
        if (strcasecmp($relativePath, 'SKILL.md') === 0) $relativePath = 'SKILL.md';
        $path = $this->filePath($name, $relativePath);
        if ($relativePath === 'SKILL.md') {
            if ($name === 'computer-use-automation' && is_file(dirname($path) . '/original.sha256')) {
                $hash = trim((string)file_get_contents(dirname($path) . '/original.sha256'));
                if (hash('sha256', $raw) !== $hash) {
                    throw new InvalidArgumentException('操作电脑技能原文保持不变；请编辑 references/moonya-runtime.md 补充兼容说明。');
                }
            }
            $parsed = self::parse($raw);
            if ($parsed['name'] !== $name) {
                throw new InvalidArgumentException('SKILL.md 的 name 不允许修改');
            }
        }
        $directory = dirname($path);
        if (!is_dir($directory) || !is_writable($directory)) {
            throw new RuntimeException("技能目录不可写: {$name}");
        }
        $temporary = tempnam($directory, '.skill-');
        if ($temporary === false) throw new RuntimeException('无法创建技能临时文件');
        try {
            $content = $name === 'computer-use-automation' && $relativePath === 'SKILL.md' ? $raw : rtrim($raw) . "\n";
            if (file_put_contents($temporary, $content, LOCK_EX) === false) {
                throw new RuntimeException('技能文件写入失败');
            }
            if (!@rename($temporary, $path)) throw new RuntimeException('技能文件原子替换失败');
        } finally {
            if (is_file($temporary)) @unlink($temporary);
        }
        return $relativePath === 'SKILL.md'
            ? $this->read($name)
            : $this->readFile($name, $relativePath);
    }

    public static function parse(string $raw): array
    {
        $normalized = str_replace(["\r\n", "\r"], "\n", $raw);
        if (!preg_match('/\A---\n(.*?)\n---\n?(.*)\z/s', $normalized, $matches)) {
            throw new InvalidArgumentException('SKILL.md 必须包含完整 YAML frontmatter');
        }
        $frontmatter = self::parseFrontmatter($matches[1]);
        $name = $frontmatter['name'] ?? '';
        $description = $frontmatter['description'] ?? '';
        if (!preg_match('/^[a-z0-9-]{1,63}$/', $name)) {
            throw new InvalidArgumentException('技能 name 格式无效');
        }
        if ($description === '') throw new InvalidArgumentException('技能 description 不能为空');
        $body = trim($matches[2]);
        if ($body === '') throw new InvalidArgumentException('技能正文不能为空');
        $metadata = [];
        if (isset($frontmatter['metadata'])) {
            $decoded = json_decode($frontmatter['metadata'], true);
            if (!is_array($decoded)) throw new InvalidArgumentException('技能 metadata 必须是 JSON 对象');
            $metadata = $decoded;
        }
        return [
            'name' => $name,
            'display_name' => trim((string)($metadata['display_name'] ?? $name)),
            'description' => $description,
            'enabled' => !array_key_exists('enabled', $metadata) || $metadata['enabled'] === true,
            'body' => $body,
            'raw' => $normalized,
        ];
    }

    private static function parseFrontmatter(string $block): array
    {
        $frontmatter = [];
        foreach (explode("\n", $block) as $line) {
            if (trim($line) === '' || str_starts_with(ltrim($line), '#')) continue;
            if (!preg_match('/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.+)$/', $line, $field)) throw new InvalidArgumentException('SKILL.md frontmatter 只允许简单键值字段');
            $value = trim($field[2]);
            if (str_starts_with($value, '"')) {
                try { $value = json_decode($value, true, 32, JSON_THROW_ON_ERROR); }
                catch (JsonException $error) { throw new InvalidArgumentException('SKILL.md 引号字段格式无效', 0, $error); }
                if (!is_string($value)) throw new InvalidArgumentException('SKILL.md 字段必须为文本');
            } else $value = trim($value, " \t'");
            $frontmatter[$field[1]] = $value;
        }
        return $frontmatter;
    }

    /** @return array<string,string> */
    private function resources(string $name): array
    {
        $root = $this->skillRoot($name);
        $resources = [];
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $entry) {
            if (!$entry->isFile() || $entry->isLink() || strtolower($entry->getExtension()) !== 'md') continue;
            $relative = str_replace('\\', '/', substr($entry->getPathname(), strlen($root) + 1));
            if ($relative === 'SKILL.md') continue;
            $real = realpath($entry->getPathname());
            if ($real === false || !$this->isInside($root, $real)) continue;
            $raw = @file_get_contents($real);
            if (is_string($raw)) $resources[$relative] = str_replace(["\r\n", "\r"], "\n", $raw);
        }
        ksort($resources, SORT_NATURAL | SORT_FLAG_CASE);
        return $resources;
    }

    private function filePath(string $name, string $relativePath): string
    {
        $root = $this->skillRoot($name);
        $candidate = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
        $this->rejectLinks($root, $relativePath);
        $real = realpath($candidate);
        if ($real === false || !is_file($real) || !$this->isInside($root, $real)) {
            throw new RuntimeException("技能文件不存在: {$relativePath}");
        }
        return $real;
    }

    private function directoryPath(string $name, string $relativePath): string
    {
        $root = $this->skillRoot($name);
        $this->rejectLinks($root, $relativePath);
        $candidate = $relativePath === ''
            ? $root
            : $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
        $real = realpath($candidate);
        if ($real === false || !is_dir($real) || !$this->isInside($root, $real, true)) {
            throw new RuntimeException('技能目录不存在或越界');
        }
        return $real;
    }

    private function rejectLinks(string $root, string $relativePath): void
    {
        $candidate = $root;
        foreach (explode('/', $relativePath) as $part) {
            if ($part === '') continue;
            $candidate .= DIRECTORY_SEPARATOR . $part;
            if (is_link($candidate)) throw new InvalidArgumentException('技能路径不能包含符号链接');
        }
    }

    private function skillRoot(string $name): string
    {
        $name = self::canonical($name);
        if (!preg_match('/^[a-z0-9-]{1,63}$/', $name)) {
            throw new InvalidArgumentException('未知或不允许的技能');
        }
        $root = realpath($this->root);
        if ($root === false) throw new RuntimeException('技能根目录不存在');
        $directory = realpath($root . DIRECTORY_SEPARATOR . $name);
        if ($directory === false || !is_dir($directory) || is_link($root . DIRECTORY_SEPARATOR . $name) || !$this->isInside($root, $directory)) {
            if (!file_exists($root . DIRECTORY_SEPARATOR . $name) && !is_link($root . DIRECTORY_SEPARATOR . $name)) throw new OutOfBoundsException('技能不存在');
            throw new InvalidArgumentException('技能路径越界或包含符号链接');
        }
        return $directory;
    }

    private function normalizeRelativePath(string $path, bool $allowEmpty): string
    {
        $path = str_replace('\\', '/', trim($path));
        if ($path === '') {
            if ($allowEmpty) return '';
            throw new InvalidArgumentException('技能文件 path 不能为空');
        }
        if (str_starts_with($path, '/') || preg_match('/^[a-zA-Z]:\//', $path)) {
            throw new InvalidArgumentException('技能文件 path 必须是相对路径');
        }
        $parts = explode('/', $path);
        foreach ($parts as $part) {
            if ($part === '' || $part === '.' || $part === '..' || preg_match('/[\x00-\x1f<>:"|?*]/', $part)
                || preg_match('/[. ]$/', $part) || preg_match('/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i', $part)) {
                throw new InvalidArgumentException('技能文件 path 无效');
            }
        }
        if (!$allowEmpty && strtolower(pathinfo($path, PATHINFO_EXTENSION)) !== 'md') {
            throw new InvalidArgumentException('只允许读取或保存 Markdown 文件');
        }
        return implode('/', $parts);
    }

    private function isInside(string $root, string $target, bool $allowRoot = false): bool
    {
        $root = rtrim(str_replace('\\', '/', $root), '/');
        $target = rtrim(str_replace('\\', '/', $target), '/');
        if (DIRECTORY_SEPARATOR === '\\') {
            $root = strtolower($root);
            $target = strtolower($target);
        }
        return ($allowRoot && $target === $root) || str_starts_with($target . '/', $root . '/');
    }
}
