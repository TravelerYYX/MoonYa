<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/RuntimeRequestAuth.php';
require_once dirname(__DIR__) . '/Services/SkillCatalog.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); throw new InvalidArgumentException('不支持的请求方法'); }
    $config = require dirname(__DIR__) . '/config.php';
    authenticateMoonYaRequest($config);
    $skills = (new SkillCatalog(dirname(__DIR__) . '/skills'))->runtimeSkills();
    foreach ($skills as &$skill) $skill['resources'] = (object)$skill['resources'];
    unset($skill);
    echo json_encode(['success' => true, 'data' => ['version' => 1, 'skills' => $skills]],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    $status = http_response_code();
    if ($status < 400) { $status = 503; http_response_code($status); }
    echo json_encode(['success' => false, 'error' => $status === 401 ? '请重新登录后使用技能' : '技能目录暂不可用'], JSON_UNESCAPED_UNICODE);
}
