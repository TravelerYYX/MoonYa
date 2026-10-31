<?php
declare(strict_types=1);

/**
 * 退役 PHP 入口的统一应答。
 *
 * index / harness_api / model_api / statistics / context_usage / office/index
 * 这些入口的桌面端实现已迁入 MoonYa-Frontend + MoonYa-Harness，线上只剩这个桩。
 *
 * $alwaysRedirect 区分两类入口：
 *   - 纯页面入口（index.php、office/index.php）传 true —— 谁打开都该去新站点，
 *     不依赖 Accept：这类文件没有任何调用方，桌面客户端也不加载它
 *     （见 DesktopFrontendService 的 RemoteRoutes，不含 index.php）。
 *   - 接口入口（harness_api / model_api / statistics / context_usage）保持 false ——
 *     只有「浏览器导航」才跳转。它们仍会被 fetch/XHR 调用，无脑 302 会让调用方
 *     跟着跳到首页、把整页 HTML 当 JSON 解析，报错更难定位。
 *
 * 主机名比对是必须的：新站点若复用同一份代码，同域跳自己会形成无限重定向，
 * 此时退化为原来的 410 JSON。
 */
function moonyaLegacyEntryRespond(bool $alwaysRedirect = false): void
{
    $target = 'https://moonya.yueyaxuan.cn/';
    $targetHost = strtolower((string)parse_url($target, PHP_URL_HOST));
    $currentHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    $currentHost = (string)preg_replace('/:\d+$/', '', $currentHost);
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $accept = strtolower((string)($_SERVER['HTTP_ACCEPT'] ?? ''));

    $isBrowserNavigation = in_array($method, ['GET', 'HEAD'], true)
        && ($alwaysRedirect || str_contains($accept, 'text/html'))
        && $currentHost !== ''
        && $currentHost !== $targetHost;

    if ($isBrowserNavigation) {
        if (!headers_sent()) {
            header('Location: ' . $target, true, 302);
            header('Cache-Control: no-store');
            header('Content-Type: text/html; charset=utf-8');
        }
        if ($method === 'HEAD') {
            exit;
        }
        $safeTarget = htmlspecialchars($target, ENT_QUOTES, 'UTF-8');
        echo '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
            . '<meta http-equiv="refresh" content="0;url=' . $safeTarget . '">'
            . '<title>MoonYa</title></head><body><p>正在前往 <a href="' . $safeTarget . '">'
            . $safeTarget . '</a></p></body></html>';
        exit;
    }

    if (!headers_sent()) {
        http_response_code(410);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(['success' => false, 'error' => '此入口已迁入 MoonYa 桌面客户端，请使用客户端。'], JSON_UNESCAPED_UNICODE);
    exit;
}
