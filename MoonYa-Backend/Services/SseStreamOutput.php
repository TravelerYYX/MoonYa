<?php
declare(strict_types=1);

final class SseStreamOutput
{
    public static function prepare(): void
    {
        ini_set('output_buffering', 'off');
        ini_set('zlib.output_compression', 'Off');
        while (ob_get_level() > 0) {
            ob_end_flush();
        }
    }

    public static function flush(): void
    {
        if (ob_get_level() > 0) {
            ob_flush();
        }
        flush();
    }
}
