<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/SkillCatalog.php';
$root = dirname(__DIR__) . '/skills';
$catalog = new SkillCatalog($root);
$skill = $catalog->read('computer-use-automation');
$alias = $catalog->read('computer-use');
if ($skill !== $alias) throw new RuntimeException('Legacy alias must disclose the actual original skill.');
$original = $root . '/computer-use-automation/SKILL.md';
$hash = trim((string)file_get_contents($root . '/computer-use-automation/original.sha256'));
if (hash_file('sha256', $original) !== $hash) throw new RuntimeException('Original skill bytes changed.');
try { $catalog->update('computer-use', "changed"); throw new RuntimeException('Original skill must not be editable.'); }
catch (InvalidArgumentException $error) { if (!str_contains($error->getMessage(), '原文保持不变')) throw $error; }
if (!str_contains($skill['body'], 'import seed_computer_use as cu') || !str_contains($skill['resources']['references/moonya-runtime.md'] ?? '', 'desktopControl')) throw new RuntimeException('Original prompt or compatibility reference missing.');
echo "desktop_skill_test: OK\n";
