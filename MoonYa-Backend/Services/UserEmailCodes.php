<?php
declare(strict_types=1);
require_once __DIR__ . '/AppDataPaths.php';
require_once __DIR__ . '/PaymentEmailMailer.php';

/** Shared server-side limits and single-use challenges, independent of cookies. */
final class UserEmailCodes {
    public function __construct(private ?string $directory = null, private ?Closure $deliver = null, private ?Closure $clock = null) {}
    private function now(): int { return $this->clock ? ($this->clock)() : time(); }
    private function locked(Closure $operation): mixed {
        $directory = $this->directory ?? AppDataPaths::directory('temp', 'user-email-codes');
        $file = fopen($directory . '/state.json', 'c+');
        if (!$file || !flock($file, LOCK_EX)) throw new RuntimeException('验证码服务暂不可用');
        try {
            $raw = stream_get_contents($file);
            $state = $raw === '' ? ['limits'=>[], 'challenges'=>[]] : json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
            foreach ($state['challenges'] as $id=>$row) if ($row['expires'] <= $this->now()) unset($state['challenges'][$id]);
            foreach ($state['limits'] as $id=>$row) if ($row['start'] + 3600 <= $this->now()) unset($state['limits'][$id]);
            try { return $operation($state); }
            finally {
                $json = json_encode($state, JSON_THROW_ON_ERROR);
                rewind($file);
                if (!ftruncate($file, 0) || fwrite($file, $json) !== strlen($json) || !fflush($file)) throw new RuntimeException('验证码状态保存失败');
            }
        } finally { flock($file, LOCK_UN); fclose($file); }
    }
    public static function qq(string $qq): string {
        $qq = trim($qq);
        if (!preg_match('/^[1-9][0-9]{4,10}$/D', $qq)) throw new InvalidArgumentException('请输入有效的 5-11 位 QQ 号');
        return $qq;
    }
    public function send(string $qq, string $purpose, string $ip): array {
        $qq = self::qq($qq);
        if (!in_array($purpose, ['register', 'login'], true)) throw new InvalidArgumentException('验证码用途无效');
        $id = bin2hex(random_bytes(24));
        $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $this->locked(function (&$state) use ($qq, $purpose, $ip, $id, $code) {
            foreach (['qq:'.$qq=>10, 'ip:'.$ip=>30] as $scope=>$maximum) {
                $key = hash('sha256', $scope);
                $limit = $state['limits'][$key] ?? ['start'=>$this->now(), 'count'=>0, 'next'=>0];
                if ($limit['next'] > $this->now() || $limit['count'] >= $maximum) throw new InvalidArgumentException('验证码发送过于频繁，请稍后重试');
            }
            foreach (['qq:'.$qq, 'ip:'.$ip] as $scope) {
                $key = hash('sha256', $scope);
                $limit = $state['limits'][$key] ?? ['start'=>$this->now(), 'count'=>0];
                $state['limits'][$key] = $limit + ['next'=>0];
                $state['limits'][$key]['next'] = $this->now() + 60;
                $state['limits'][$key]['count']++;
            }
            // Resending invalidates all previous codes for this QQ and purpose.
            foreach ($state['challenges'] as $key=>$row) if ($row['qq'] === $qq && $row['purpose'] === $purpose) unset($state['challenges'][$key]);
            $state['challenges'][$id] = ['qq'=>$qq, 'purpose'=>$purpose, 'hash'=>hash('sha256', $id.':'.$code), 'expires'=>$this->now()+300, 'attempts'=>0, 'sent'=>false];
        });
        try {
            if ($this->deliver) ($this->deliver)($qq.'@qq.com', $code, $purpose);
            else (new PaymentEmailMailer())->send($qq.'@qq.com', $code, 'user_'.$purpose);
            $this->locked(function (&$state) use ($id) {
                if (!isset($state['challenges'][$id])) throw new RuntimeException('验证码已失效，请重新发送');
                $state['challenges'][$id]['sent'] = true;
            });
        } catch (Throwable $error) {
            $this->locked(function (&$state) use ($id) { unset($state['challenges'][$id]); });
            throw new RuntimeException('验证码邮件发送失败，请稍后重试或联系管理员检查 SMTP 配置');
        }
        return ['challenge_id'=>$id, 'retry_after'=>60, 'expires_in'=>300];
    }
    public function verify(string $qq, string $purpose, string $id, string $code): void {
        $qq = self::qq($qq);
        $this->locked(function (&$state) use ($qq, $purpose, $id, $code) {
            $row = $state['challenges'][$id] ?? null;
            if (!$row || !$row['sent'] || $row['qq'] !== $qq || $row['purpose'] !== $purpose) throw new InvalidArgumentException('验证码无效或已过期，请重新发送');
            $state['challenges'][$id]['attempts']++;
            $valid = preg_match('/^[0-9]{6}$/D', $code) && hash_equals($row['hash'], hash('sha256', $id.':'.$code));
            if ($valid || $state['challenges'][$id]['attempts'] >= 5) unset($state['challenges'][$id]);
            if (!$valid) throw new InvalidArgumentException('验证码错误，请重试');
        });
    }
}
