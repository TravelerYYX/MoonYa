<?php
/** QQ avatars are derived at display time; uploaded avatar data remains available. */
function moonyaUserAvatar(array $user): string {
    $qq = trim((string)($user['username'] ?? ''));
    if (!preg_match('/^[1-9][0-9]{4,10}$/D', $qq)) {
        $email = trim((string)($user['email'] ?? ''));
        $qq = preg_match('/^([1-9][0-9]{4,10})@qq\.com$/iD', $email, $match) ? $match[1] : '';
    }
    return $qq !== '' ? 'https://q1.qlogo.cn/g?b=qq&nk=' . $qq . '&s=100' : '/image/user.png';
}
