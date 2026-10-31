<?php
/**
 * 下载链接搜索 API
 * 通过自建 Python 搜索服务查找软件/文件的最佳下载链接，再由 DeepSeek 选取最优直链。
 * POST /api/download_search.php
 * Body: { "query": "腾讯视频 PC版 官方下载" }
 *
 * v4.11（2026-09-14）：原先走 Kimi（Moonshot）原生 `$web_search` builtin_function，
 * 已随“只保留 DeepSeek”收敛一并移除；此处改为项目自有的 Python 搜索服务
 * （deepseek_web_search.search_api_url）+ DeepSeek 选链，全链路不再依赖外部厂商搜索。
 */

header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/Services/CorsPolicy.php';
applyCorsPolicy();
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => '仅支持 POST 方法'], JSON_UNESCAPED_UNICODE);
    exit;
}

$config = require_once __DIR__ . '/../config.php';

$input = json_decode(file_get_contents('php://input'), true);
$query = trim($input['query'] ?? '');

if (empty($query)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => '缺少查询参数'], JSON_UNESCAPED_UNICODE);
    exit;
}

/** 响应收口：统一 success / best_url / suggested_filename 契约。 */
function respondDownloadSearch(string $query, array $urls, string $filename): void
{
    $urls = array_values(array_unique(array_filter(array_map('strval', $urls))));
    $bestUrl = $urls[0] ?? '';
    echo json_encode([
        'success' => $bestUrl !== '',
        'urls' => array_slice($urls, 0, 5),
        'best_url' => $bestUrl,
        'suggested_filename' => $filename,
        'search_query' => $query,
    ], JSON_UNESCAPED_UNICODE);
}

// ---------------------------------------------------------------------------
// 1) 调用自有 Python 搜索服务（联网搜索的唯一后端）
// ---------------------------------------------------------------------------
$searchApiUrl = rtrim(trim((string)($config['deepseek_web_search']['search_api_url'] ?? '')), '/');
if ($searchApiUrl === '' || !filter_var($searchApiUrl, FILTER_VALIDATE_URL)) {
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'error_code' => 'missing_config',
        'error' => 'Missing required configuration: deepseek_web_search.search_api_url',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$searchCh = curl_init($searchApiUrl . '/search');
curl_setopt_array($searchCh, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode(['action' => 'web_search', 'query' => $query . ' 官方下载链接'], JSON_UNESCAPED_UNICODE),
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_CONNECTTIMEOUT => (int)($config['deepseek_web_search']['search_api_connect_timeout'] ?? 10),
    CURLOPT_TIMEOUT => (int)($config['deepseek_web_search']['search_api_timeout'] ?? 30),
]);
$searchRaw = curl_exec($searchCh);
$searchCode = curl_getinfo($searchCh, CURLINFO_HTTP_CODE);
curl_close($searchCh);

$searchResults = [];
if (is_string($searchRaw) && $searchRaw !== '' && $searchCode === 200) {
    $decoded = json_decode($searchRaw, true);
    if (is_array($decoded) && is_array($decoded['results'] ?? null)) {
        $searchResults = array_slice($decoded['results'], 0, 10);
    }
}

if ($searchResults === []) {
    respondDownloadSearch($query, [], '');
    exit;
}

// ---------------------------------------------------------------------------
// 2) 从搜索结果中收集候选直链（含标题/摘要里裸写的 URL）
// ---------------------------------------------------------------------------
$downloadKeywords = ['.exe', '.zip', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.appx', 'download', 'setup', 'install', 'dl.', 'get.'];
$allUrls = [];
$catalog = [];
foreach ($searchResults as $item) {
    if (!is_array($item)) {
        continue;
    }
    $title = trim((string)($item['title'] ?? ''));
    $url = trim((string)($item['url'] ?? ''));
    $snippet = trim((string)($item['snippet'] ?? ''));
    if ($url !== '') {
        $allUrls[] = $url;
    }
    if (preg_match_all('#https?://[^\s\'"<>\)\]\}]+#i', $title . ' ' . $snippet, $m)) {
        foreach ($m[0] as $found) {
            $allUrls[] = rtrim($found, ',;.!?');
        }
    }
    $catalog[] = ['title' => $title, 'url' => $url, 'snippet' => $snippet];
}
$allUrls = array_values(array_unique(array_filter($allUrls)));

// 关键词命中优先，作为 DeepSeek 不可用时的兜底排序
$keywordUrls = [];
foreach ($allUrls as $u) {
    foreach ($downloadKeywords as $kw) {
        if (stripos($u, $kw) !== false) {
            $keywordUrls[] = $u;
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// 3) 交给 DeepSeek 从候选中挑出最佳直链（单次非流式，失败则回退关键词排序）
// ---------------------------------------------------------------------------
$model = trim((string)($config['search_models']['search'] ?? '')) ?: 'deepseek-flash';
$apiUrl = trim((string)($config['deepseek_api_url'] ?? ''));
$apiKey = trim((string)($config['deepseek_api_key'] ?? ''));

$bestUrl = '';
$suggestedFilename = '';

if ($apiUrl !== '' && $apiKey !== '') {
    $candidateLines = [];
    foreach ($catalog as $i => $item) {
        $candidateLines[] = ($i + 1) . '. 标题: ' . $item['title'] . "\n   URL: " . $item['url'] . "\n   摘要: " . mb_substr($item['snippet'], 0, 200);
    }

    $requestData = [
        'model' => $model,
        'messages' => [
            ['role' => 'system', 'content' => '你是一个下载链接挑选助手。用户想下载某个软件或文件，请从给定的搜索结果中挑出一个最可能是官方直接下载链接的 URL。只返回 JSON：{"url":"...","filename":"..."}。filename 是建议的保存文件名（含扩展名）；若无法判断则留空字符串。不要输出任何解释、Markdown 代码块或多余文字。'],
            ['role' => 'user', 'content' => "用户需求：" . $query . "\n\n搜索结果：\n" . implode("\n", $candidateLines)],
        ],
        'temperature' => 0.2,
        'max_tokens' => 300,
        'stream' => false,
    ];

    $ch = curl_init($apiUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($requestData, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $apiKey,
        ],
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 60,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if (is_string($response) && $response !== '' && $httpCode === 200) {
        $data = json_decode($response, true);
        $content = trim((string)($data['choices'][0]['message']['content'] ?? ''));
        // 容忍模型偶发包裹 ```json 代码块
        $content = preg_replace('/^```(?:json)?\s*|\s*```$/i', '', $content);
        $picked = json_decode($content, true);
        if (is_array($picked)) {
            $pickedUrl = trim((string)($picked['url'] ?? ''));
            if ($pickedUrl !== '' && preg_match('#^https?://#i', $pickedUrl)) {
                $bestUrl = $pickedUrl;
            }
            $suggestedFilename = trim((string)($picked['filename'] ?? ''));
        }
    }
}

// ---------------------------------------------------------------------------
// 4) 组装结果（DeepSeek 未给出可用直链时回退到关键词命中 / 原始结果）
// ---------------------------------------------------------------------------
$ordered = [];
if ($bestUrl !== '') {
    $ordered[] = $bestUrl;
}
$ordered = array_merge($ordered, $keywordUrls, $allUrls);

if ($suggestedFilename === '' && preg_match('/[^\/\\\\]+\.(exe|zip|msi|dmg|apk|pkg|deb|rpm|appx)/i', $bestUrl, $nameMatch)) {
    $suggestedFilename = $nameMatch[0];
}

respondDownloadSearch($query, $ordered, $suggestedFilename);
