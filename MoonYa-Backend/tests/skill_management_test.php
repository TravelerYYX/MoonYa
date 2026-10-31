<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/SkillCatalog.php';

function managementAssert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function managementReject(callable $operation, string $class): void
{
    try { $operation(); } catch (Throwable $error) {
        managementAssert($error instanceof $class, '错误类型不符: ' . $error->getMessage());
        return;
    }
    throw new RuntimeException('非法操作未拒绝');
}

$root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'moonya-skill-management-' . bin2hex(random_bytes(6));
mkdir($root);
$catalog = new SkillCatalog($root);
try {
    $catalog->create('writing-helper', '原名称', '原说明', '# 原提示词');
    $raw = "---\nname: writing-helper\ndescription: 原说明\ncompatibility: runtime-v1\nmetadata: {\"display_name\":\"原名称\",\"enabled\":false,\"custom\":\"保留\"}\n---\n\n# 原提示词\n";
    $catalog->update('writing-helper', $raw);
    $catalog->createDirectory('writing-helper', 'references');
    $catalog->upload('writing-helper', 'references', [['name' => 'guide.md', 'raw' => '# 原资料']]);
    $updated = $catalog->updateInfo('writing-helper', '新名称', '含 "引号" 的新说明', '# 新提示词');
    managementAssert($updated['name'] === 'writing-helper' && $updated['display_name'] === '新名称' && $updated['body'] === '# 新提示词', '技能信息未正确更新');
    managementAssert($updated['description'] === '含 "引号" 的新说明' && $updated['enabled'] === false, '说明或启用状态被破坏');
    managementAssert(str_contains($updated['raw'], 'compatibility: runtime-v1') && str_contains($updated['raw'], '"custom":"保留"'), '其他 frontmatter 或 metadata 丢失');
    managementAssert($updated['resources']['references/guide.md'] === '# 原资料', '编辑信息改变了子文件');
    managementAssert($catalog->updateInfo('writing-helper', '', '说明', '# 提示词')['display_name'] === 'writing-helper', '空显示名称未回退');
    $before = $catalog->read('writing-helper')['raw'];
    foreach ([['说明', ''], ["换行\n说明", '正文']] as [$description, $body]) {
        managementReject(fn() => $catalog->updateInfo('writing-helper', '', $description, $body), InvalidArgumentException::class);
        managementAssert($catalog->read('writing-helper')['raw'] === $before, '无效信息改变了原文件');
    }
    foreach (array_merge(SkillCatalog::ALLOWED, ['computer-use']) as $name) {
        managementReject(fn() => $catalog->updateInfo($name, 'x', 'x', 'x'), DomainException::class);
        managementReject(fn() => $catalog->delete($name), DomainException::class);
    }
    managementReject(fn() => $catalog->delete('../writing-helper'), InvalidArgumentException::class);
    managementReject(fn() => $catalog->delete('missing-helper'), OutOfBoundsException::class);

    $uploaded = $catalog->uploadTree('writing-helper', '', ['资料/深层/空目录', '资料/只有图片'], [
        ['path' => '资料/深层/guide.md', 'raw' => '# 新资料'],
        ['path' => '资料/深层/EXTRA.MD', 'raw' => '# 大写扩展名'],
        ['path' => '资料/只有图片/image.png', 'raw' => 'ignored'],
        ['path' => '资料/script.py', 'raw' => 'ignored'],
    ]);
    managementAssert($uploaded['uploaded_count'] === 2 && count($uploaded['skipped']) === 2, '有效文件或跳过统计错误');
    managementAssert(is_dir($root . '/writing-helper/资料/深层/空目录'), '空目录未保留');
    managementAssert(!file_exists($root . '/writing-helper/资料/只有图片/image.png'), '不支持文件被保存');
    managementAssert($catalog->read('writing-helper')['resources']['资料/深层/guide.md'] === '# 新资料', '嵌套资源未加载');
    $nested = $catalog->uploadTree('writing-helper', '资料/深层', ['追加'], [['path' => '追加/new.md', 'raw' => '# 新增']]);
    managementAssert($nested['directory']['path'] === '资料/深层' && is_file($root . '/writing-helper/资料/深层/追加/new.md'), '当前子目录上传路径错误');
    managementReject(fn() => $catalog->uploadTree('writing-helper', '', ['不会留下'], [
        ['path' => '不会留下/new.md', 'raw' => 'new'], ['path' => 'references/guide.md', 'raw' => 'overwrite'],
    ]), InvalidArgumentException::class);
    managementAssert(!file_exists($root . '/writing-helper/不会留下'), '冲突留下了部分目录');
    foreach ([
        fn() => $catalog->uploadTree('writing-helper', '', ['../outside'], []),
        fn() => $catalog->uploadTree('writing-helper', '', [], [['path' => '../outside.png', 'raw' => 'bad']]),
        fn() => $catalog->uploadTree('writing-helper', '', ['NUL'], []),
        fn() => $catalog->uploadTree('writing-helper', '', [], [['path' => 'a.md', 'raw' => 'a'], ['path' => 'A.MD', 'raw' => 'b']]),
        fn() => $catalog->uploadTree('writing-helper', '', ['same.md/child'], [['path' => 'same.md', 'raw' => 'x']]),
        fn() => $catalog->uploadTree('writing-helper', '', [], [['path' => 'huge.md', 'raw' => str_repeat('x', SkillCatalog::MAX_FILE_BYTES + 1)]]),
        fn() => $catalog->uploadTree('writing-helper', '', [], array_map(fn($i) => ['path' => "large-{$i}.md", 'raw' => str_repeat('x', SkillCatalog::MAX_FILE_BYTES)], range(1, 11))),
    ] as $invalid) managementReject($invalid, InvalidArgumentException::class);

    $manifest = "---\nname: imported-helper\ndescription: Imported\nmetadata: {\"display_name\":\"导入助手\"}\n---\n\nRead references/deep/guide.md\n";
    $import = $catalog->importTrees(['任意文件夹/空目录', '任意文件夹/references/deep'], [
        ['path' => '任意文件夹/SKILL.md', 'raw' => $manifest], ['path' => '任意文件夹/references/deep/guide.md', 'raw' => '# Imported resource'],
        ['path' => '任意文件夹/image.jpg', 'raw' => 'ignored'],
    ]);
    managementAssert($import['skills'][0]['name'] === 'imported-helper' && $import['uploaded_count'] === 2 && count($import['skipped']) === 1, '完整技能导入错误');
    managementAssert(is_dir($root . '/imported-helper/空目录') && $catalog->read('imported-helper')['resources']['references/deep/guide.md'] === '# Imported resource', '导入技能目录结构错误');
    managementReject(fn() => $catalog->importTrees([], [['path' => 'duplicate/SKILL.md', 'raw' => $manifest]]), InvalidArgumentException::class);
    managementReject(fn() => $catalog->importTrees(['missing'], [['path' => 'missing/guide.md', 'raw' => '# missing']]), InvalidArgumentException::class);
    managementReject(fn() => $catalog->importTrees([], [['path' => 'invalid/SKILL.md', 'raw' => '# missing frontmatter']]), InvalidArgumentException::class);
    managementReject(fn() => $catalog->importTrees([], [['path' => 'builtin/SKILL.md', 'raw' => str_replace('imported-helper', 'computer-use', $manifest)]]), InvalidArgumentException::class);
    managementReject(fn() => $catalog->importTrees(['new-folder', 'missing-folder'], [
        ['path' => 'new-folder/SKILL.md', 'raw' => str_replace('imported-helper', 'new-helper', $manifest)],
        ['path' => 'missing-folder/guide.md', 'raw' => '# missing'],
    ]), InvalidArgumentException::class);
    managementAssert(!is_dir($root . '/new-helper'), '多技能导入失败留下部分技能');

    file_put_contents($root . '/imported-helper/extra.bin', 'binary');
    $catalog->delete('imported-helper');
    managementAssert(!file_exists($root . '/imported-helper') && count($catalog->list()) === 1, '整技能目录未删除');
    $catalog->delete('writing-helper');
    managementAssert($catalog->runtimeSkills() === [], '删除后执行目录仍返回技能');
} finally {
    $cleanup = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($cleanup as $entry) { if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
    rmdir($root);
}
echo "skill_management_test: OK\n";
