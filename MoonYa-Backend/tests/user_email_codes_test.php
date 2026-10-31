<?php
require_once dirname(__DIR__) . '/Services/UserEmailCodes.php';
require_once dirname(__DIR__) . '/Services/UserAvatar.php';
$directory = sys_get_temp_dir() . '/moonya-user-codes-' . bin2hex(random_bytes(8));
mkdir($directory, 0700);
$now = 1000; $mail = [];
$service = new UserEmailCodes($directory, function ($email, $code, $purpose) use (&$mail) { $mail[] = compact('email','code','purpose'); }, function () use (&$now) { return $now; });
function check(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
function rejects(Closure $operation): void { try { $operation(); } catch (InvalidArgumentException $error) { return; } throw new RuntimeException('Expected rejection'); }
try {
    rejects(fn()=>$service->send('abc', 'register', 'one'));
    $challenge = $service->send('123456789', 'register', 'one');
    check($mail[0]['email'] === '123456789@qq.com', 'QQ mailbox');
    check(!str_contains(file_get_contents($directory.'/state.json'), '"'.$mail[0]['code'].'"'), 'Code stored as hash');
    rejects(fn()=>$service->send('123456789', 'login', 'two'));
    rejects(fn()=>$service->verify('123456789', 'login', $challenge['challenge_id'], $mail[0]['code']));
    rejects(fn()=>$service->verify('123456788', 'register', $challenge['challenge_id'], $mail[0]['code']));
    $service->verify('123456789', 'register', $challenge['challenge_id'], $mail[0]['code']);
    rejects(fn()=>$service->verify('123456789', 'register', $challenge['challenge_id'], $mail[0]['code']));
    $now += 61;
    $challenge = $service->send('123456789', 'login', 'one');
    $correct = $mail[1]['code'];
    $wrong = $correct === '000000' ? '111111' : '000000';
    for ($i=0;$i<5;$i++) rejects(fn()=>$service->verify('123456789', 'login', $challenge['challenge_id'], $wrong));
    rejects(fn()=>$service->verify('123456789', 'login', $challenge['challenge_id'], $correct));
    $now += 61;
    $old = $service->send('123456789', 'login', 'one'); $oldCode = end($mail)['code'];
    $now += 61;
    $new = $service->send('123456789', 'login', 'one');
    rejects(fn()=>$service->verify('123456789', 'login', $old['challenge_id'], $oldCode));
    $code = end($mail)['code']; $now += 300;
    rejects(fn()=>$service->verify('123456789', 'login', $new['challenge_id'], $code));
    // Recreating the service cannot bypass limits by changing the PHP session.
    $service2 = new UserEmailCodes($directory, function(){}, function () use (&$now) { return $now; });
    for ($i=0;$i<6;$i++) { $now += 61; $service2->send('123456789', 'login', 'one'); }
    $now += 61;
    rejects(fn()=>$service2->send('123456789', 'login', 'different'));
    $now += 3600;
    $service2->send('123456789', 'login', 'one');
    check(moonyaUserAvatar(['username'=>'123456789']) === 'https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100', 'QQ avatar');
    check(moonyaUserAvatar(['username'=>'old','email'=>'123456789@qq.com']) === moonyaUserAvatar(['username'=>'123456789']), 'Legacy QQ mailbox avatar');
    check(moonyaUserAvatar(['username'=>'old','avatar'=>'uploads/old.png']) === '/image/user.png', 'No uploaded avatar override');
    echo "User email codes and avatars passed\n";
} finally { if (is_file($directory.'/state.json')) unlink($directory.'/state.json'); rmdir($directory); }
