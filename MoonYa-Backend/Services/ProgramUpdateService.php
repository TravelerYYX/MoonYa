<?php
declare(strict_types=1);

final class ProgramUpdateService
{
    public function __construct(private PDO $db, private string $root, private int $maxBytes = 2147483648, private int $chunkBytes = 8388608)
    {
        if (!is_dir($root) && !mkdir($root, 0700, true) && !is_dir($root)) throw new RuntimeException('无法创建更新文件目录');
        if (!is_file($root . '/.htaccess')) file_put_contents($root . '/.htaccess', "Require all denied\nDeny from all\n");
    }

    public static function versionParts(string $version): array
    {
        if (!preg_match('/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/D', $version)) throw new InvalidArgumentException('版本号必须是三段数字，例如 1.0.1');
        $parts = array_map('intval', explode('.', $version));
        if (max($parts) > 65534) throw new InvalidArgumentException('版本号每一段不能超过 65534');
        return $parts;
    }

    /** Inclusive single byte range; null means send the entire file. */
    public static function byteRange(?string $range, ?string $ifRange, string $etag, int $size): ?array
    {
        if ($range === null || $range === '' || ($ifRange !== null && trim($ifRange) !== $etag)) return null;
        if (!preg_match('/^bytes=(\d*)-(\d*)$/D', trim($range), $m) || ($m[1] === '' && $m[2] === '')) throw new OutOfRangeException('无效的下载范围');
        if ($m[1] === '') {
            $suffix = (int)$m[2];
            if ($suffix <= 0) throw new OutOfRangeException('无效的下载范围');
            $start = max(0, $size - $suffix); $end = $size - 1;
        } else {
            $start = (int)$m[1]; $end = $m[2] === '' ? $size - 1 : min((int)$m[2], $size - 1);
        }
        if ($size <= 0 || $start >= $size || $end < $start) throw new OutOfRangeException('下载范围超出文件大小');
        return [$start, $end];
    }

    public static function validateExe(string $file, ?string $version = null): void
    {
        $stream = fopen($file, 'rb');
        if (!$stream) throw new RuntimeException('无法读取安装程序');
        try {
            $header = fread($stream, 64);
            if (strlen($header) !== 64 || substr($header, 0, 2) !== 'MZ') throw new InvalidArgumentException('文件不是有效的 EXE 安装程序');
            $offset = unpack('V', substr($header, 60, 4))[1];
            if ($offset < 64 || $offset > filesize($file) - 4 || fseek($stream, $offset) !== 0 || fread($stream, 4) !== "PE\0\0") throw new InvalidArgumentException('文件不是有效的 Windows EXE');
            $metadata = self::exeMetadata($stream, $offset, (int)filesize($file));
            if ($metadata['product'] !== 'FarSideSetup.UpdateProtocol/1') throw new InvalidArgumentException('此 EXE 不支持自动更新，请重新构建 FarSideSetup.exe');
            if ($version !== null && $metadata['version'] !== $version) throw new InvalidArgumentException(sprintf('安装程序版本与填写的发布版本不一致：安装程序文件版本 %s，填写 %s。校验以 EXE 的文件版本为准，属性框里的「产品版本」不参与校验，请重新构建安装程序', $metadata['version'], $version));
        } finally { fclose($stream); }
    }

    /** Read bounded PE version resources without loading a potentially 2 GiB EXE into memory. */
    private static function exeMetadata($stream, int $pe, int $fileSize): array
    {
        $read = static function(int $offset, int $length) use ($stream, $fileSize): string {
            if ($offset < 0 || $length < 0 || $offset + $length > $fileSize || $length > 1048576 || fseek($stream, $offset) !== 0) throw new InvalidArgumentException('EXE 版本资源无效');
            $bytes = fread($stream, $length);
            if ($bytes === false || strlen($bytes) !== $length) throw new InvalidArgumentException('EXE 版本资源不完整');
            return $bytes;
        };
        $u16 = static fn(string $bytes, int $offset): int => unpack('v', substr($bytes, $offset, 2))[1];
        $u32 = static fn(string $bytes, int $offset): int => unpack('V', substr($bytes, $offset, 4))[1];
        $coff = $read($pe + 4, 20); $count = $u16($coff, 2); $optionalSize = $u16($coff, 16);
        if ($count < 1 || $count > 96 || $optionalSize < 120 || $optionalSize > 4096) throw new InvalidArgumentException('EXE 节表无效');
        $optional = $read($pe + 24, $optionalSize); $magic = $u16($optional, 0);
        $directories = $magic === 0x10b ? 96 : ($magic === 0x20b ? 112 : 0);
        if (!$directories || $optionalSize < $directories + 24) throw new InvalidArgumentException('EXE 资源目录无效');
        $resourceRva = $u32($optional, $directories + 16); $resourceSize = $u32($optional, $directories + 20);
        if (!$resourceRva || $resourceSize < 16) throw new InvalidArgumentException('安装程序缺少版本资源');
        $sections = $read($pe + 24 + $optionalSize, $count * 40);
        $map = static function(int $rva, int $length) use ($sections, $count, $u32): int {
            for ($index = 0; $index < $count; $index++) {
                $base = $index * 40; $address = $u32($sections, $base + 12); $rawSize = $u32($sections, $base + 16);
                if ($rva >= $address && $rva + $length <= $address + $rawSize) return $u32($sections, $base + 20) + $rva - $address;
            }
            throw new InvalidArgumentException('EXE 版本资源地址无效');
        };
        $resourceBase = $map($resourceRva, 16);
        $entry = static function(int $relative, ?int $id = null) use ($read, $resourceBase, $resourceSize, $u16, $u32): int {
            if ($relative < 0 || $relative + 16 > $resourceSize) throw new InvalidArgumentException('EXE 资源树无效');
            $directory = $read($resourceBase + $relative, 16); $count = $u16($directory, 12) + $u16($directory, 14);
            if ($count < 1 || $count > 4096 || $relative + 16 + $count * 8 > $resourceSize) throw new InvalidArgumentException('EXE 资源树无效');
            $entries = $read($resourceBase + $relative + 16, $count * 8);
            for ($index = 0; $index < $count; $index++) {
                if ($id === null || $u32($entries, $index * 8) === $id) return $u32($entries, $index * 8 + 4);
            }
            throw new InvalidArgumentException('安装程序缺少版本资源');
        };
        $directory = $entry(0, 16);
        if (($directory & 0x80000000) === 0) throw new InvalidArgumentException('EXE 版本资源树无效');
        $directory = $entry($directory & 0x7fffffff);
        if (($directory & 0x80000000) === 0) throw new InvalidArgumentException('EXE 版本资源树无效');
        $leaf = $entry($directory & 0x7fffffff);
        if (($leaf & 0x80000000) !== 0 || $leaf + 16 > $resourceSize) throw new InvalidArgumentException('EXE 版本资源树无效');
        $data = $read($resourceBase + $leaf, 16); $length = $u32($data, 4);
        if ($length < 92 || $length > 65536) throw new InvalidArgumentException('EXE 版本资源大小无效');
        $bytes = $read($map($u32($data, 0), $length), $length);
        $product = ''; $version = '';
        $visit = null;
        $visit = static function(int $start, int $limit, int $depth = 0) use (&$visit, &$product, &$version, $bytes, $u16, $u32): int {
            if ($depth > 8 || $start + 6 > $limit) throw new InvalidArgumentException('EXE 版本信息无效');
            $length = $u16($bytes, $start); $valueLength = $u16($bytes, $start + 2); $type = $u16($bytes, $start + 4); $end = $start + $length;
            if ($length < 8 || $end > $limit) throw new InvalidArgumentException('EXE 版本信息无效');
            $cursor = $start + 6; $key = '';
            while ($cursor + 2 <= $end) {
                $char = $u16($bytes, $cursor); $cursor += 2;
                if ($char === 0) break;
                $key .= $char < 128 ? chr($char) : '?';
            }
            $cursor = ($cursor + 3) & ~3; $valueBytes = $type === 1 ? $valueLength * 2 : $valueLength;
            if ($cursor + $valueBytes > $end) throw new InvalidArgumentException('EXE 版本值无效');
            if ($key === 'VS_VERSION_INFO') {
                if ($valueBytes < 52 || $u32($bytes, $cursor) !== 0xfeef04bd) throw new InvalidArgumentException('EXE 固定版本信息无效');
                $ms = $u32($bytes, $cursor + 8); $ls = $u32($bytes, $cursor + 12);
                $version = ($ms >> 16).'.'.($ms & 65535).'.'.($ls >> 16);
            } elseif ($key === 'ProductName') {
                for ($i = 0; $i + 2 <= $valueBytes; $i += 2) {
                    $char = $u16($bytes, $cursor + $i); if ($char === 0) break;
                    $product .= $char < 128 ? chr($char) : '?';
                }
            }
            $cursor = ($cursor + $valueBytes + 3) & ~3;
            while ($cursor + 6 <= $end) { $cursor = ($visit($cursor, $end, $depth + 1) + 3) & ~3; }
            return $end;
        };
        $visit(0, strlen($bytes));
        return ['product'=>$product, 'version'=>$version];
    }

    public function begin(int $adminId, array $input): array
    {
        $version = trim((string)($input['version'] ?? '')); self::versionParts($version);
        $notes = trim((string)($input['notes'] ?? ''));
        $name = basename(str_replace('\\', '/', (string)($input['file_name'] ?? '')));
        $size = filter_var($input['file_size'] ?? null, FILTER_VALIDATE_INT);
        if ($notes === '' || strlen($notes) > 60000) throw new InvalidArgumentException('请填写更新内容（最多 60000 字节）');
        if (strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== 'exe' || strlen($name) > 255) throw new InvalidArgumentException('只能上传 EXE 安装程序');
        if ($size === false || $size < 64 || $size > $this->maxBytes) throw new InvalidArgumentException('安装程序大小超出限制');
        $query = $this->db->prepare('SELECT id FROM program_updates WHERE version = ?'); $query->execute([$version]);
        if ($query->fetch()) throw new InvalidArgumentException('该版本号已存在，请使用新的版本号');
        $id = bin2hex(random_bytes(16));
        $force = $input['force_update'] ?? false;
        if (!is_bool($force)) throw new InvalidArgumentException('强制更新开关无效');
        $this->save($id, ['admin_id'=>$adminId, 'version'=>$version, 'notes'=>$notes, 'force_update'=>$force, 'file_name'=>$name, 'file_size'=>$size, 'created'=>time()]);
        if (!touch($this->path($id, '.part'))) throw new RuntimeException('无法创建上传文件');
        return ['upload_id'=>$id, 'chunk_bytes'=>$this->chunkBytes, 'max_bytes'=>$this->maxBytes];
    }

    public function chunk(int $adminId, string $id, int $offset, string $bytes): array
    {
        return $this->locked($adminId, $id, function(array $meta) use ($id, $offset, $bytes) {
            if (isset($meta['release_id'])) throw new InvalidArgumentException('上传已经完成，不能修改安装文件');
            $length = strlen($bytes); $file = $this->path($id, '.part'); clearstatcache(true, $file); $current = filesize($file);
            if ($length === 0 || $length > $this->chunkBytes || $offset < 0 || $offset + $length > $meta['file_size']) throw new InvalidArgumentException('上传分块大小或位置无效');
            $stream = fopen($file, 'c+b');
            if (!$stream) throw new RuntimeException('无法写入上传文件');
            try {
                // Retrying a completed chunk is safe, including a lost HTTP response.
                $overlap = min($length, max(0, $current - $offset));
                if ($overlap > 0) {
                    fseek($stream, $offset);
                    if (fread($stream, $overlap) !== substr($bytes, 0, $overlap)) throw new InvalidArgumentException('重复分块内容不一致');
                    if ($overlap === $length) return ['uploaded_bytes'=>$current];
                }
                if ($offset > $current) throw new InvalidArgumentException('上传位置不一致，请重新上传');
                fseek($stream, $current); $written = $overlap;
                try {
                    while ($written < $length) {
                        $count = fwrite($stream, substr($bytes, $written));
                        if ($count === false || $count === 0) throw new RuntimeException('磁盘空间不足或写入失败');
                        $written += $count;
                    }
                    fflush($stream);
                } catch (Throwable $error) { ftruncate($stream, $current); throw $error; }
            } finally { fclose($stream); }
            return ['uploaded_bytes'=>$offset + $length];
        });
    }

    public function complete(int $adminId, string $id): array
    {
        return $this->locked($adminId, $id, function(array $meta) use ($adminId, $id) {
            if (isset($meta['release_id'])) return $this->get((int)$meta['release_id']);
            $part = $this->path($id, '.part'); clearstatcache(true, $part);
            if (!is_file($part) || filesize($part) !== $meta['file_size']) throw new InvalidArgumentException('安装程序尚未上传完成');
            self::validateExe($part, $meta['version']); $hash = hash_file('sha256', $part); $parts = self::versionParts($meta['version']);
            $destination = $this->path($id, '.exe');
            $this->db->beginTransaction();
            try {
                $query = $this->db->prepare('INSERT INTO program_updates (version,major_version,minor_version,patch_version,notes,file_name,file_key,file_size,sha256,admin_id,force_update) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
                $query->execute([$meta['version'], ...$parts, $meta['notes'], $meta['file_name'], $id, $meta['file_size'], $hash, $adminId, (int)($meta['force_update'] ?? false)]);
                $releaseId = (int)$this->db->lastInsertId();
                if (!rename($part, $destination)) throw new RuntimeException('无法保存安装程序');
                $this->db->commit();
            } catch (Throwable $error) {
                if ($this->db->inTransaction()) $this->db->rollBack();
                if (is_file($destination)) rename($destination, $part);
                throw $error;
            }
            $meta['release_id'] = $releaseId; $this->save($id, $meta);
            return $this->get($releaseId);
        });
    }

    public function publish(int $id): array
    {
        $row = $this->get($id);
        $file = $this->path($row['file_key'], '.exe');
        if (!is_file($file) || filesize($file) !== (int)$row['file_size'] || hash_file('sha256', $file) !== $row['sha256']) throw new InvalidArgumentException('安装文件校验失败，不能发布');
        $query = $this->db->prepare("UPDATE program_updates SET status='published', published_at=COALESCE(published_at,CURRENT_TIMESTAMP) WHERE id=?"); $query->execute([$id]);
        return $this->get($id);
    }

    /** 删除一条版本（含草稿与已发布），同时清理磁盘上的安装包与上传元数据。 */
    public function delete(int $id): array
    {
        $row = $this->get($id); $key = (string)$row['file_key'];
        // 先删除数据库行（文件系统没有事务）：即使随后文件删除失败，应用状态仍然一致（最坏是磁盘残留孤立文件）。
        $this->db->beginTransaction();
        try {
            $query = $this->db->prepare('DELETE FROM program_updates WHERE id=? AND file_key=?'); $query->execute([$id, $key]);
            if ($query->rowCount() === 0) throw new InvalidArgumentException('版本不存在');
            $this->db->commit();
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
        // 文件删除不阻塞删除操作：失败仅记录日志，供后续运维清理。
        $failed = [];
        foreach (['.exe', '.json', '.lock', '.part'] as $suffix) {
            $file = $this->path($key, $suffix);
            if (is_file($file) && !@unlink($file)) $failed[] = $suffix;
        }
        if ($failed) error_log('Program updates: 无法删除版本 '.$row['version'].' 的文件 '.implode(',', $failed));
        return ['id'=>(int)$row['id'], 'version'=>(string)$row['version'], 'file_name'=>(string)$row['file_name'], 'status'=>(string)$row['status'], 'files_failed'=>$failed];
    }

    /** 批量删除，部分成功不中断整批，返回成功与失败清单。 */
    public function deleteMany(array $ids): array
    {
        $deleted = []; $failed = [];
        foreach ($ids as $id) {
            try { $deleted[] = $this->delete((int)$id); }
            catch (InvalidArgumentException $error) { $failed[] = ['id'=>(int)$id, 'error'=>$error->getMessage()]; }
        }
        return ['deleted'=>$deleted, 'failed'=>$failed];
    }

    public function get(int $id): array
    {
        $query = $this->db->prepare('SELECT * FROM program_updates WHERE id=?'); $query->execute([$id]);
        $row = $query->fetch(PDO::FETCH_ASSOC);
        if (!$row) throw new InvalidArgumentException('版本不存在');
        return $row;
    }

    public function latest(): ?array
    {
        return $this->db->query("SELECT * FROM program_updates WHERE status='published' ORDER BY major_version DESC,minor_version DESC,patch_version DESC LIMIT 1")->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    public function setForce(int $id, bool $force): array
    {
        $this->get($id);
        $query = $this->db->prepare('UPDATE program_updates SET force_update=? WHERE id=?');
        $query->execute([(int)$force, $id]);
        return $this->get($id);
    }

    public function minimumRequiredVersion(): ?string
    {
        $value = $this->db->query("SELECT version FROM program_updates WHERE status='published' AND force_update=1 ORDER BY major_version DESC,minor_version DESC,patch_version DESC LIMIT 1")->fetchColumn();
        return $value === false ? null : (string)$value;
    }

    public function listing(): array
    {
        return $this->db->query('SELECT * FROM program_updates ORDER BY major_version DESC,minor_version DESC,patch_version DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
    }

    public function publicRow(?array $row): ?array
    {
        if ($row === null) return null;
        return ['id'=>(int)$row['id'], 'version'=>$row['version'], 'notes'=>$row['notes'], 'force_update'=>(bool)($row['force_update'] ?? false), 'minimum_required_version'=>$this->minimumRequiredVersion(), 'file_name'=>$row['file_name'], 'size'=>(int)$row['file_size'], 'sha256'=>$row['sha256'], 'status'=>$row['status'], 'published_at'=>$row['published_at'], 'download_url'=>'admin/api/updates.php?action=download&id='.$row['id']];
    }

    public function download(array $row, string $method): void
    {
        $file = $this->path($row['file_key'], '.exe');
        if ($row['status'] !== 'published' || !is_file($file)) { http_response_code(404); return; }
        $size = (int)$row['file_size']; $etag = '"'.$row['sha256'].'"';
        header('Accept-Ranges: bytes'); header('ETag: '.$etag); header('Cache-Control: private, no-transform');
        header('Content-Type: application/octet-stream'); header('Content-Disposition: attachment; filename="FarSideSetup-'.$row['version'].'.exe"');
        try { $range = self::byteRange($_SERVER['HTTP_RANGE'] ?? null, $_SERVER['HTTP_IF_RANGE'] ?? null, $etag, $size); }
        catch (OutOfRangeException) { http_response_code(416); header('Content-Range: bytes */'.$size); header('Content-Length: 0'); return; }
        [$start, $end] = $range ?? [0, $size - 1];
        if ($range !== null) { http_response_code(206); header("Content-Range: bytes $start-$end/$size"); }
        header('Content-Length: '.($end - $start + 1));
        if ($method === 'HEAD') return;
        ini_set('zlib.output_compression', '0'); set_time_limit(0);
        while (ob_get_level() > 0) ob_end_clean();
        $stream = fopen($file, 'rb');
        if (!$stream) throw new RuntimeException('无法读取安装程序');
        try {
            fseek($stream, $start); $remaining = $end - $start + 1;
            while ($remaining > 0 && !connection_aborted()) {
                $bytes = fread($stream, min(1048576, $remaining));
                if ($bytes === false || $bytes === '') break;
                echo $bytes; $remaining -= strlen($bytes); flush();
            }
        } finally { fclose($stream); }
    }

    private function path(string $id, string $suffix): string
    {
        if (!preg_match('/^[a-f0-9]{32}$/D', $id)) throw new InvalidArgumentException('无效的上传标识');
        return $this->root.'/'.$id.$suffix;
    }
    private function save(string $id, array $meta): void
    {
        $file = $this->path($id, '.json');
        if (file_put_contents($file.'.tmp', json_encode($meta, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)) === false || !rename($file.'.tmp', $file)) throw new RuntimeException('无法保存上传状态');
    }
    private function locked(int $adminId, string $id, callable $callback): array
    {
        $lock = fopen($this->path($id, '.lock'), 'c');
        if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('无法锁定上传');
        try {
            $file = $this->path($id, '.json');
            $meta = is_file($file) ? json_decode((string)file_get_contents($file), true, 512, JSON_THROW_ON_ERROR) : null;
            if (!$meta || $meta['admin_id'] !== $adminId) throw new InvalidArgumentException('上传不存在或不属于当前管理员');
            return $callback($meta);
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }
}
