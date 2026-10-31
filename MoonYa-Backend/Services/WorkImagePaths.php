<?php
declare(strict_types=1);

/** Read-only image references from the user's raw Work message, never attached content. */
final class WorkImagePaths
{
    /** @return list<string> */
    public static function extract(string $message): array
    {
        // Windows copy/paste may surround paths with directional formatting marks.
        $message = preg_replace('/[\x{200E}\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]/u', '', $message) ?? $message;
        // A drive root or UNC share is required. Chinese prose may immediately follow
        // the extension; ASCII suffixes and another path component cannot.
        // Recognize common unsupported image extensions too, so the existing
        // actual-content validator can report errors rather than silently ignore them.
        $pattern = '~(?<![A-Za-z0-9_:/\\\\])(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\/\r\n"\'<>|:*?]+[\\\\/])[^\r\n"\'`<>|:*?\x00-\x1F]*?\.(?:jpe?g|png|gif|webp|bmp|tiff?|ico|svg|avif|heic|heif)(?![A-Za-z0-9_.\\\\/])~iu';
        preg_match_all($pattern, $message, $matches);
        $paths = [];
        $seen = [];
        foreach ($matches[0] as $path) {
            $key = self::identity($path);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $paths[] = $path;
        }
        return $paths;
    }

    public static function identity(string $path): string
    {
        return mb_strtolower(str_replace('\\', '/', realpath($path) ?: $path), 'UTF-8');
    }

    /** Merge with picker-selected images while preserving their explicit ordering. */
    public static function appendSources(array $sources, string $message, int $nextOrder): array
    {
        $seen = [];
        $unique = [];
        foreach ($sources as $source) {
            $key = self::identity((string)$source['path']);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $unique[] = $source;
        }
        foreach (self::extract($message) as $path) {
            $key = self::identity($path);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $unique[] = ['path' => $path, 'name' => basename(str_replace('\\', '/', $path)), '_order' => $nextOrder++];
        }
        return $unique;
    }
}
