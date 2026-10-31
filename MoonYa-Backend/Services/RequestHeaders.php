<?php
declare(strict_types=1);

/** Apache mod_php may expose Authorization only through getallheaders(). */
function moonyaAuthorizationHeader(): string
{
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
        $value = trim((string)($_SERVER[$key] ?? ''));
        if ($value !== '') return $value;
    }
    if (function_exists('getallheaders')) {
        foreach ((getallheaders() ?: []) as $name => $value) {
            if (strcasecmp((string)$name, 'Authorization') === 0) return trim((string)$value);
        }
    }
    return '';
}
