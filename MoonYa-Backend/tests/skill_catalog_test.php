<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/Services/SkillCatalog.php';

function skillAssert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'moonya-skills-' . bin2hex(random_bytes(6));
foreach (SkillCatalog::ALLOWED as $name) mkdir($root . DIRECTORY_SEPARATOR . $name, 0777, true);
mkdir($root . '/browser-use-automation/references/xiaohongshu', 0777, true);
$browser = "---\nname: browser-use-automation\ndescription: browser test\nmetadata: {\"display_name\":\"操作浏览器\"}\n---\n\n# Browser\n\nUse it.\n";
$computer = "---\nname: computer-use-automation\ndescription: computer test\nmetadata: {\"display_name\":\"Computer Use\"}\n---\n\n# Computer\n\nUse it.\n";
file_put_contents($root . '/browser-use-automation/SKILL.md', $browser);
file_put_contents($root . '/computer-use-automation/SKILL.md', $computer);
mkdir($root . '/computer-use');
file_put_contents($root . '/computer-use/SKILL.md', "---\nname: computer-use\ndescription: legacy desktop skill\n---\n\nOLD BODY\n");
file_put_contents($root . '/browser-use-automation/references/action-verification.md', "# Verify\n\nObserve again.\n");
file_put_contents($root . '/browser-use-automation/references/xiaohongshu/README.md', "# Xiaohongshu\n\nRoute it.\n");

try {
    $catalog = new SkillCatalog($root);
    skillAssert($catalog->read('computer-use')['name'] === 'computer-use-automation', '旧技能名称未映射到原文技能');
    $items = $catalog->list(true);
    skillAssert(array_column($items, 'name') === SkillCatalog::ALLOWED, '旧名称目录导致技能重复列出');
    skillAssert(array_column($catalog->runtimeSkills(), 'name') === SkillCatalog::ALLOWED, '执行目录未按兼容名称去重');
    skillAssert($items[1]['body'] === trim(explode("---\n", $computer, 3)[2]), '旧目录覆盖了新版技能正文');
    skillAssert($items[0]['display_name'] === '操作浏览器', '展示元数据解析失败');
    skillAssert(isset($items[0]['resources']['references/xiaohongshu/README.md']), '技能 references 未随目录加载');
    $rootEntries = $catalog->browse('browser-use-automation')['entries'];
    skillAssert($rootEntries[0]['name'] === 'references' && $rootEntries[0]['type'] === 'directory', '技能根目录浏览失败');
    $reference = $catalog->readFile('browser-use-automation', 'references/action-verification.md');
    skillAssert(str_contains($reference['raw'], 'Observe again.'), '技能 reference 读取失败');
    $catalog->updateFile('browser-use-automation', 'references/action-verification.md', "# Verify\n\nFresh observation.\n");
    skillAssert(str_contains($catalog->readFile('browser-use-automation', 'references/action-verification.md')['raw'], 'Fresh'), '技能 reference 原子更新失败');
    $updated = str_replace('Use it.', 'Observe, act, verify.', $browser);
    skillAssert(str_contains($catalog->update('browser-use-automation', $updated)['body'], 'Observe'), '技能原子更新失败');
    $created = $catalog->create('writing-helper', '写作技能', '包含 "引号" 的写作提示词', '# 主提示词');
    skillAssert($created['display_name'] === '写作技能' && $created['description'] === '包含 "引号" 的写作提示词', '技能创建或引号解析失败');
    skillAssert(count($catalog->list()) === 3, '新增技能未动态发现');
    $catalog->createDirectory('writing-helper', '提示词');
    $catalog->createDirectory('writing-helper', '提示词/详细');
    $catalog->upload('writing-helper', '提示词/详细', [['name' => 'guide.md', 'raw' => '# 独特提示词'], ['name' => 'EXTRA.MD', 'raw' => '# 第二个提示词']]);
    skillAssert($catalog->read('writing-helper')['resources']['提示词/详细/guide.md'] === '# 独特提示词', '上传资源未加载');
    skillAssert(!isset($catalog->runtimeSkills()[2]['path']) && !isset($catalog->runtimeSkills()[2]['raw']), '运行时泄漏服务器路径或源码');
    $catalog->updateFile('writing-helper', '提示词/详细/guide.md', '# 最新版本');
    skillAssert(str_contains($catalog->read('writing-helper')['resources']['提示词/详细/guide.md'], '最新版本'), '上传文件编辑失败');
    foreach ([
        fn() => $catalog->create('writing-helper', '', 'test', 'body'),
        fn() => $catalog->create('computer-use', '', 'test', 'body'),
        fn() => $catalog->create('realtime-voice-chat', '', 'test', 'body'),
        fn() => $catalog->create('bad-name', '', "multi\nline", 'body'),
        fn() => $catalog->create('empty-body', '', 'test', ''),
        fn() => $catalog->createDirectory('writing-helper', '../escape'),
        fn() => $catalog->createDirectory('writing-helper', 'NUL'),
        fn() => $catalog->upload('writing-helper', '', [['name' => 'partial.md', 'raw' => 'valid'], ['name' => 'invalid.txt', 'raw' => 'invalid']]),
        fn() => $catalog->upload('writing-helper', '', [['name' => 'partial.md', 'raw' => 'valid'], ['name' => 'SKILL.md', 'raw' => 'existing']]),
        fn() => $catalog->upload('writing-helper', '', [['name' => '../escape.md', 'raw' => 'bad']]),
        fn() => $catalog->upload('writing-helper', '', [['name' => 'large.md', 'raw' => str_repeat('x', SkillCatalog::MAX_FILE_BYTES + 1)]]),
        fn() => $catalog->upload('writing-helper', '', array_map(fn($i) => ['name' => "large-{$i}.md", 'raw' => str_repeat('x', SkillCatalog::MAX_FILE_BYTES)], range(1, 11))),
        fn() => $catalog->upload('writing-helper', '', [['name' => 'null.md', 'raw' => "bad\0text"]]),
        fn() => $catalog->upload('writing-helper', '', [['name' => 'invalid.md', 'raw' => "\xff"]]),
        fn() => $catalog->upload('writing-helper', '', [['name' => 'a.md', 'raw' => 'one'], ['name' => 'A.md', 'raw' => 'two']]),
    ] as $invalid) {
        try { $invalid(); throw new RuntimeException('非法新增输入未拒绝'); }
        catch (InvalidArgumentException $error) {}
    }
    skillAssert(!is_file($root . '/writing-helper/partial.md'), '批量校验失败留下了部分文件');
    file_put_contents($root . '/computer-use-automation/original.sha256', hash('sha256', $computer));
    try { $catalog->update('computer-use', str_replace('Use it.', 'Changed.', $computer)); throw new RuntimeException('电脑技能保护失效'); }
    catch (InvalidArgumentException $error) {}
    try { $catalog->updateFile('computer-use', 'skill.md', str_replace('Use it.', 'Changed.', $computer)); throw new RuntimeException('大小写绕过电脑技能保护'); }
    catch (InvalidArgumentException $error) {}
    skillAssert(file_get_contents($root . '/computer-use-automation/SKILL.md') === $computer, '电脑技能原文被改变');
    foreach ([
        fn() => $catalog->read('../computer-use'),
        fn() => $catalog->read('third-skill'),
        fn() => $catalog->update('computer-use', "---\nname: wrong\ndescription: bad\n---\nbody"),
        fn() => SkillCatalog::parse("name: missing-frontmatter\n"),
        fn() => $catalog->readFile('browser-use-automation', '../computer-use/SKILL.md'),
        fn() => $catalog->readFile('browser-use-automation', 'references/not-markdown.txt'),
        fn() => $catalog->browse('browser-use-automation', 'references/../computer-use'),
    ] as $invalid) {
        try { $invalid(); throw new RuntimeException('非法技能输入未被拒绝'); }
        catch (InvalidArgumentException|RuntimeException $error) {
            skillAssert($error->getMessage() !== '非法技能输入未被拒绝', $error->getMessage());
        }
    }
} finally {
    $cleanup = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($cleanup as $entry) { if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
    rmdir($root);
}

echo "skill_catalog_test: OK\n";
