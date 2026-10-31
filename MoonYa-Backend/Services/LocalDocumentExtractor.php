<?php
declare(strict_types=1);

/**
 * 本地文档文本提取。
 *
 * 项目统一为 DeepSeek 后不再有远端 file-extract 能力，改为在本机解析：
 * - PDF：优先调用 pdftotext，缺失时回退到纯 PHP 文本流解析；
 * - OOXML（docx/pptx/xlsx）与 ODF：用 ZipArchive 解包后剥离 XML 标签；
 * - 其余（txt/md/csv/json/xml/代码等）：按 UTF-8 纯文本直读。
 *
 * 提取失败返回 null，调用方据此降级（例如仅保留文件路径）。
 */
final class LocalDocumentExtractor
{
    /** 单个压缩包内最多读取的成员数，避免异常文档拖垮请求。 */
    private const MAX_ZIP_ENTRIES = 500;
    /** 单个 XML 成员的读取上限（字节）。 */
    private const MAX_XML_BYTES = 32 * 1024 * 1024;

    public static function extract(string $path, string $extension, int $maxChars = 0): ?string
    {
        if ($path === '' || !is_file($path) || !is_readable($path)) {
            return null;
        }
        $ext = strtolower(trim($extension));
        $text = match ($ext) {
            'pdf' => self::fromPdf($path),
            'docx' => self::fromZipXml($path, ['word/document.xml'], 'paragraph'),
            'pptx' => self::fromZipXml($path, null, 'slide'),
            'xlsx' => self::fromZipXml($path, ['xl/sharedStrings.xml'], 'text'),
            'odt', 'odp', 'ods' => self::fromZipXml($path, ['content.xml'], 'text'),
            default => self::fromPlainText($path),
        };
        if (!is_string($text)) {
            return null;
        }
        $text = trim($text);
        if ($text === '') {
            return null;
        }
        if ($maxChars > 0 && mb_strlen($text) > $maxChars) {
            $text = mb_substr($text, 0, $maxChars);
        }
        return $text;
    }

    private static function fromPlainText(string $path): ?string
    {
        $raw = @file_get_contents($path);
        if (!is_string($raw) || $raw === '' || strpos($raw, "\0") !== false) {
            return null;
        }
        if (!mb_check_encoding($raw, 'UTF-8')) {
            $converted = @mb_convert_encoding($raw, 'UTF-8', 'GB18030');
            if (!is_string($converted) || !mb_check_encoding($converted, 'UTF-8')) {
                return null;
            }
            $raw = $converted;
        }
        return $raw;
    }

    private static function fromPdf(string $path): ?string
    {
        $text = self::pdfViaPoppler($path);
        if ($text !== null) {
            return $text;
        }
        return self::pdfViaPhp($path);
    }

    private static function pdfViaPoppler(string $path): ?string
    {
        if (PHP_OS_FAMILY === 'Windows') {
            // Windows 下 pdftotext 常不在 PATH，交给纯 PHP 回退，避免 exec 报错噪声。
            $probe = @shell_exec('where pdftotext 2>NUL');
            if (!is_string($probe) || trim($probe) === '') {
                return null;
            }
        } elseif (!self::commandExists('pdftotext')) {
            return null;
        }
        $output = [];
        $status = 1;
        @exec('pdftotext -layout -enc UTF-8 ' . escapeshellarg($path) . ' - 2>/dev/null', $output, $status);
        if ($status !== 0 || $output === []) {
            return null;
        }
        $text = implode("\n", $output);
        return mb_strlen(trim($text)) > 10 ? $text : null;
    }

    private static function commandExists(string $command): bool
    {
        $output = [];
        $status = 1;
        @exec('command -v ' . escapeshellarg($command) . ' 2>/dev/null', $output, $status);
        return $status === 0 && $output !== [];
    }

    /** 纯 PHP 尽力提取：文本流对象 + 十六进制字符串。 */
    private static function pdfViaPhp(string $path): ?string
    {
        $content = @file_get_contents($path);
        if (!is_string($content) || $content === '') {
            return null;
        }
        $text = '';

        if (preg_match_all('/\(((?:\\\\.|[^()\\\\])*)\)\s*Tj/s', $content, $matches)) {
            $text .= implode("\n", array_map([self::class, 'unescapePdfString'], $matches[1]));
        }
        if (preg_match_all('/\[([^\]]*)\]\s*TJ/s', $content, $matches)) {
            foreach ($matches[1] as $chunk) {
                if (preg_match_all('/\(((?:\\\\.|[^()\\\\])*)\)/s', $chunk, $parts)) {
                    $text .= implode('', array_map([self::class, 'unescapePdfString'], $parts[1])) . "\n";
                }
            }
        }
        if (preg_match_all('/<([0-9A-Fa-f]{4,})>\s*Tj/s', $content, $matches)) {
            foreach ($matches[1] as $hex) {
                $decoded = @hex2bin(strlen($hex) % 2 === 0 ? $hex : '0' . $hex);
                if (!is_string($decoded)) {
                    continue;
                }
                $utf16 = @mb_convert_encoding($decoded, 'UTF-8', 'UTF-16BE');
                $text .= is_string($utf16) ? $utf16 : '';
            }
        }

        $text = trim((string)preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', $text));
        return mb_strlen($text) > 10 ? $text : null;
    }

    private static function unescapePdfString(string $value): string
    {
        $value = str_replace(['\\(', '\\)', '\\\\'], ['(', ')', '\\'], $value);
        return preg_replace_callback('/\\\\([0-7]{1,3})/', static function (array $match): string {
            return chr((int)octdec($match[1]));
        }, $value) ?? $value;
    }

    /**
     * 解包 OOXML/ODF 并剥离 XML 标签。
     *
     * @param list<string>|null $members 指定成员；null 表示按 $kind 通配匹配
     */
    private static function fromZipXml(string $path, ?array $members, string $kind): ?string
    {
        if (!class_exists('ZipArchive')) {
            return null;
        }
        $zip = new ZipArchive();
        if ($zip->open($path) !== true) {
            return null;
        }

        try {
            $targets = [];
            if (is_array($members)) {
                foreach ($members as $member) {
                    if ($zip->locateName($member) !== false) {
                        $targets[] = $member;
                    }
                }
            } else {
                $prefix = match ($kind) {
                    'slide' => 'ppt/slides/slide',
                    default => '',
                };
                if ($prefix === '') {
                    $zip->close();
                    return null;
                }
                $count = min($zip->numFiles, self::MAX_ZIP_ENTRIES);
                for ($i = 0; $i < $count; $i++) {
                    $name = (string)$zip->getNameIndex($i);
                    if (str_starts_with($name, $prefix) && str_ends_with($name, '.xml')) {
                        $targets[] = $name;
                    }
                }
                sort($targets, SORT_NATURAL);
            }

            $chunks = [];
            foreach ($targets as $target) {
                $stat = $zip->statName($target);
                if (is_array($stat) && (int)($stat['size'] ?? 0) > self::MAX_XML_BYTES) {
                    continue;
                }
                $xml = $zip->getFromName($target);
                if (!is_string($xml) || $xml === '') {
                    continue;
                }
                $chunks[] = self::xmlToText($xml, $kind);
            }
        } finally {
            $zip->close();
        }

        $text = trim(implode("\n\n", array_filter($chunks, static fn(string $c): bool => trim($c) !== '')));
        return $text === '' ? null : $text;
    }

    private static function xmlToText(string $xml, string $kind): string
    {
        // 段落/文本节点先转换为换行，避免整篇粘成一行。
        $xml = preg_replace('#</(?:w:p|a:p|text:p|text:h|br|w:br)>#', "\n", $xml) ?? $xml;
        $xml = preg_replace('#<(?:w:tab|text:tab)\s*/>#', "\t", $xml) ?? $xml;
        $plain = strip_tags($xml);
        $plain = html_entity_decode($plain, ENT_QUOTES | ENT_XML1, 'UTF-8');
        $plain = str_replace(["\r\n", "\r"], "\n", $plain);
        $plain = preg_replace('/[ \t]+\n/', "\n", $plain) ?? $plain;
        $plain = preg_replace('/\n{3,}/', "\n\n", $plain) ?? $plain;
        return trim($plain);
    }
}
