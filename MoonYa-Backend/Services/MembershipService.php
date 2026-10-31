<?php
declare(strict_types=1);
require_once __DIR__ . '/MembershipPurchases.php';

final class CreditsExhausted extends RuntimeException {
    public const MESSAGE = '你已达到使用上限。升级套餐以继续，或在积分重置后再试。';
    public function __construct() { parent::__construct(self::MESSAGE); }
}

/** Authoritative server ledger. No client supplied balance or token count is accepted. */
final class MembershipService {
    use MembershipPurchases;
    public const SCALE = 1000000;
    private PDO $db;
    private Closure $clock;
    public function __construct(PDO $db, ?Closure $clock = null) {
        $this->db = $db;
        $this->clock = $clock ?? static fn() => new DateTimeImmutable('now', new DateTimeZone('Asia/Shanghai'));
    }
    public static function connect(array $config): PDO {
        return new PDO("mysql:host={$config['db_host']};dbname={$config['db_name']};charset=utf8mb4", $config['db_user'], $config['db_pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false]);
    }
    public static function units($value, bool $signed = false): int {
        $text = (string)$value;
        if (!preg_match($signed ? '/^-?\d{1,9}(?:\.\d{1,6})?$/' : '/^\d{1,9}(?:\.\d{1,6})?$/', $text))
            throw new InvalidArgumentException('积分／倍率必须是最多 6 位小数的有效数字');
        $negative = str_starts_with($text, '-'); $parts = explode('.', ltrim($text, '-'));
        $units = (int)$parts[0] * self::SCALE + (int)str_pad($parts[1] ?? '', 6, '0');
        return $negative ? -$units : $units;
    }
    public static function points(int $units): string {
        return ($units < 0 ? '-' : '') . intdiv(abs($units), self::SCALE) . '.' . str_pad((string)(abs($units) % self::SCALE), 6, '0', STR_PAD_LEFT);
    }
    public static function month(DateTimeImmutable $anchor, int $offset): DateTimeImmutable {
        $first = $anchor->modify('first day of this month')->modify("+$offset months");
        $day = min((int)$anchor->format('d'), (int)$first->format('t'));
        return $first->setDate((int)$first->format('Y'), (int)$first->format('m'), $day);
    }
    private function query(string $sql, array $args = []): PDOStatement {
        $statement = $this->db->prepare($sql); $statement->execute($args); return $statement;
    }
    private function date(string $value): DateTimeImmutable { return new DateTimeImmutable($value, new DateTimeZone('Asia/Shanghai')); }
    private function now(): DateTimeImmutable { return ($this->clock)()->setTimezone(new DateTimeZone('Asia/Shanghai')); }
    private function tx(Closure $action) {
        $this->db->beginTransaction();
        try { $result = $action(); $this->db->commit(); return $result; }
        catch (Throwable $error) { if ($this->db->inTransaction()) $this->db->rollBack(); throw $error; }
    }
    public function plans(bool $admin = false): array {
        return array_map([$this, 'publicPlan'], $this->query('SELECT * FROM membership_plans ' . ($admin ? '' : 'WHERE enabled=1 AND archived=0 ') . 'ORDER BY sort_order,id')->fetchAll());
    }
    public function publicPlan(array $row): array {
        return ['id' => (int)$row['id'], 'code' => $row['code'], 'name' => $row['name'], 'price_cents' => (int)$row['price_cents'],
            'monthly_credits' => self::points((int)$row['monthly_units']), 'description' => $row['description'],
            'tier_rank' => isset($row['tier_rank']) ? (int)$row['tier_rank'] : null,
            'features' => json_decode($row['features_json'], true, 32, JSON_THROW_ON_ERROR), 'is_free' => (bool)$row['is_free'],
            'enabled' => (bool)$row['enabled'], 'archived' => (bool)$row['archived'], 'sort_order' => (int)$row['sort_order']];
    }
    private function free(): array {
        $plan = $this->query('SELECT * FROM membership_plans WHERE is_free=1 AND archived=0 LIMIT 1')->fetch();
        if (!$plan) throw new RuntimeException('会员制度尚未初始化，请运行迁移脚本');
        return $plan;
    }
    /** Lock the user first, making first registration and all period rotations serializable. */
    private function account(int $user, bool $settlement = false): array {
        $identity = $this->query('SELECT id,status FROM users WHERE id=? FOR UPDATE', [$user])->fetch();
        if (!$identity || (!$settlement && $identity['status'] !== 'active')) throw new InvalidArgumentException('用户不可用');
        $account = $this->query('SELECT * FROM membership_accounts WHERE user_id=? FOR UPDATE', [$user])->fetch();
        $now = $this->now();
        if (!$account) {
            $free = $this->free();
            $this->query('INSERT INTO membership_accounts (user_id,plan_id,subscription_json,anchor_at) VALUES (?,?,?,?)',
                [$user, $free['id'], json_encode($this->publicPlan($free), JSON_UNESCAPED_UNICODE), $now->format('Y-m-d H:i:s')]);
            $account = $this->query('SELECT * FROM membership_accounts WHERE user_id=?', [$user])->fetch();
        }
        if ($this->paymentSchemaReady()) $this->rotatePurchases($account, $now);
        $plan = json_decode($account['subscription_json'], true, 32, JSON_THROW_ON_ERROR);
        if ($this->paymentSchemaReady() && !isset($plan['tier_rank'])) {
            $rank=$this->query('SELECT tier_rank FROM membership_plans WHERE id=?',[$account['plan_id']])->fetchColumn();
            if ($rank!==false && $rank!==null) {
                $plan['tier_rank']=(int)$rank;$account['subscription_json']=json_encode($plan,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
                $this->query('UPDATE membership_accounts SET subscription_json=? WHERE user_id=?',[$account['subscription_json'],$user]);
            }
        }
        if ($account['expires_at'] && $this->date($account['expires_at']) <= $now) {
            $free = $this->free(); $plan = $this->publicPlan($free);
            $account['plan_id'] = $free['id']; $account['anchor_at'] = $account['expires_at'];
            $account['expires_at'] = null; $account['current_period_id'] = null;
            $this->query('UPDATE membership_accounts SET plan_id=?,subscription_json=?,anchor_at=?,expires_at=NULL,current_period_id=NULL,revision=revision+1 WHERE user_id=?',
                [$free['id'], json_encode($plan, JSON_UNESCAPED_UNICODE), $account['anchor_at'], $user]);
        }
        $period = $account['current_period_id'] ? $this->query('SELECT * FROM credit_periods WHERE id=? FOR UPDATE', [$account['current_period_id']])->fetch() : false;
        if (!$period || $this->date($period['ends_at']) <= $now) {
            // Free allowance is editable and applied on the next monthly reset.
            if ($plan['is_free']) $plan = $this->publicPlan($this->free());
            $anchor = $this->date($account['anchor_at']);
            $offset = max(0, ((int)$now->format('Y') - (int)$anchor->format('Y')) * 12 + (int)$now->format('m') - (int)$anchor->format('m'));
            if (self::month($anchor, $offset) > $now) $offset--;
            $start = self::month($anchor, $offset); $end = self::month($anchor, $offset + 1);
            if ($account['expires_at'] && $this->date($account['expires_at']) < $end) $end = $this->date($account['expires_at']);
            $amount = self::units($plan['monthly_credits']);
            $this->query('INSERT INTO credit_periods (user_id,starts_at,ends_at,allowance_units,balance_units) VALUES (?,?,?,?,?)',
                [$user, $start->format('Y-m-d H:i:s'), $end->format('Y-m-d H:i:s'), $amount, $amount]);
            $periodId = (int)$this->db->lastInsertId();
            $this->query('UPDATE membership_accounts SET current_period_id=?,subscription_json=?,revision=revision+1 WHERE user_id=?', [$periodId, json_encode($plan, JSON_UNESCAPED_UNICODE), $user]);
            $period = $this->query('SELECT * FROM credit_periods WHERE id=?', [$periodId])->fetch();
            $details=['plan_id' => (int)$account['plan_id']];
            if ($this->paymentSchemaReady()) {
                $purchase=$this->query("SELECT order_no FROM membership_purchases WHERE user_id=? AND status='active' LIMIT 1",[$user])->fetch();
                if ($purchase) $details['order_no']=$purchase['order_no'];
            }
            $this->ledger($user, $periodId, 'monthly_reset', $amount, $amount, $details);
        }
        return ['user_id' => $user, 'plan' => $plan, 'balance' => self::points((int)$period['balance_units']),
            'period_allowance' => self::points((int)$period['allowance_units']),
            'period_id' => (int)$period['id'], 'period_start' => $period['starts_at'], 'resets_at' => $period['ends_at'],
            'expires_at' => $account['expires_at'],
            'queued_purchases' => $this->paymentSchemaReady() ? $this->purchaseQueue($user) : []];
    }
    public function summary(int $user): array { return $this->tx(fn() => $this->account($user)); }
    /** Migration initializes disabled accounts too; runtime access still requires active status. */
    public function initializeUser(int $user): array { return $this->tx(fn() => $this->account($user,true)); }
    private function ledger(int $user, int $period, string $kind, int $delta, int $balance, array $details, ?string $call = null): void {
        $this->query('INSERT INTO credit_ledger (user_id,period_id,call_id,kind,delta_units,balance_units,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
            [$user, $period, $call, $kind, $delta, $balance, json_encode($details, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), $this->now()->format('Y-m-d H:i:s')]);
    }
    public function beginCall(int $user, array $model): string {
        return $this->tx(function () use ($user, $model) {
            $account = $this->account($user);
            if (self::units($account['balance']) <= 0) throw new CreditsExhausted();
            $id = bin2hex(random_bytes(16));
            $id = substr($id, 0, 8) . '-' . substr($id, 8, 4) . '-' . substr($id, 12, 4) . '-' . substr($id, 16, 4) . '-' . substr($id, 20);
            $this->query('INSERT INTO credit_calls (id,user_id,period_id,model_id,multiplier_units,created_at) VALUES (?,?,?,?,?,?)',
                [$id, $user, $account['period_id'], $model['id'], $model['multiplier_units'], $this->now()->format('Y-m-d H:i:s')]);
            return $id;
        });
    }
    public static function tokenCounts(?array $usage): ?array {
        if (!$usage) return null;
        $input = $usage['prompt_tokens'] ?? $usage['total_input'] ?? null;
        $output = $usage['completion_tokens'] ?? $usage['output'] ?? null;
        if (!is_int($input) || !is_int($output) || $input < 0 || $output < 0 || $input > 2000000000 || $output > 2000000000) return null;
        return [$input, $output];
    }
    public function settle(string $id, ?array $usage, string $outcome = 'completed'): array {
        return $this->tx(function () use ($id, $usage, $outcome) {
            // Every path takes locks in user -> account -> period -> call order.
            $identity = $this->query('SELECT user_id FROM credit_calls WHERE id=?', [$id])->fetch();
            if (!$identity) throw new InvalidArgumentException('调用记录不存在');
            $user = (int)$identity['user_id']; $account = $this->account($user, true);
            $call = $this->query('SELECT * FROM credit_calls WHERE id=?', [$id])->fetch();
            $period = $this->query('SELECT * FROM credit_periods WHERE id=? FOR UPDATE', [$call['period_id']])->fetch();
            $transferPath = [];
            if ($this->paymentSchemaReady()) {
                while ($edge = $this->query('SELECT * FROM credit_transfers WHERE source_period_id=? FOR UPDATE', [$period['id']])->fetch()) {
                    $transferPath[] = $edge;
                    $period = $this->query('SELECT * FROM credit_periods WHERE id=? FOR UPDATE', [$edge['target_period_id']])->fetch();
                }
            }
            $call = $this->query('SELECT * FROM credit_calls WHERE id=? FOR UPDATE', [$id])->fetch();
            if ($call['settled_at'] === null) {
                $counts = self::tokenCounts($usage);
                $cost = $counts ? intdiv(($counts[0] + $counts[1]) * (int)$call['multiplier_units'] + 999, 1000) : 0;
                $charged = min($cost, (int)$period['balance_units']);
                foreach ($transferPath as $edge) $charged = min($charged, (int)$edge['remaining_units']);
                foreach ($transferPath as $edge) $this->query('UPDATE credit_transfers SET remaining_units=remaining_units-? WHERE source_period_id=?', [$charged,$edge['source_period_id']]);
                $balance = (int)$period['balance_units'] - $charged;
                $this->query('UPDATE credit_periods SET balance_units=? WHERE id=?', [$balance, $period['id']]);
                $this->query('UPDATE credit_calls SET input_tokens=?,output_tokens=?,cost_units=?,charged_units=?,status=?,settled_at=? WHERE id=?',
                    [$counts[0] ?? null, $counts[1] ?? null, $cost, $charged, $counts ? $outcome : 'usage_missing', $this->now()->format('Y-m-d H:i:s'), $id]);
                $this->ledger($user, (int)$period['id'], $counts ? 'model_usage' : 'usage_missing', -$charged, $balance,
                    ['model_id' => $call['model_id'], 'multiplier' => self::points((int)$call['multiplier_units']),
                    'input_tokens' => $counts[0] ?? null, 'output_tokens' => $counts[1] ?? null,
                    'actual_cost' => self::points($cost), 'waived' => self::points($cost - $charged), 'outcome' => $outcome,
                    'original_period_id' => (int)$call['period_id']], $id);
                if ($account['period_id'] === (int)$period['id']) $account['balance'] = self::points($balance);
            }
            return ['call_id' => $id, 'account' => $account, 'exhausted' => self::units($account['balance']) <= 0];
        });
    }
    public function grant(int $user, int $planId, ?string $expires, int $admin): array {
        return $this->tx(function () use ($user, $planId, $expires, $admin) {
            $this->account($user);
            $plan = $this->query('SELECT * FROM membership_plans WHERE id=? AND enabled=1 AND archived=0 FOR UPDATE', [$planId])->fetch();
            if (!$plan) throw new InvalidArgumentException('套餐不存在或已停用');
            $now = $this->now(); $end = null;
            if (!$plan['is_free']) {
                if($expires) {
                    if(!preg_match('/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/D',$expires))throw new InvalidArgumentException('请填写有效的北京时间到期日期');
                    $text=str_replace('T',' ',$expires);if(strlen($text)===16)$text.=':00';
                    $end=DateTimeImmutable::createFromFormat('!Y-m-d H:i:s',$text,new DateTimeZone('Asia/Shanghai'));
                    if(!$end||$end->format('Y-m-d H:i:s')!==$text)throw new InvalidArgumentException('到期日期无效');
                } else $end=self::month($now,1);
                if ($end <= $now) throw new InvalidArgumentException('到期时间必须晚于当前时间');
            }
            $snapshot = $this->publicPlan($plan);
            $this->query('UPDATE membership_accounts SET plan_id=?,subscription_json=?,anchor_at=?,expires_at=?,current_period_id=NULL,revision=revision+1 WHERE user_id=?',
                [$planId, json_encode($snapshot, JSON_UNESCAPED_UNICODE), $now->format('Y-m-d H:i:s'), $end?->format('Y-m-d H:i:s'), $user]);
            if ($this->paymentSchemaReady()) {
                $this->query("UPDATE membership_purchases SET status='replaced' WHERE user_id=? AND status='active'", [$user]);
                $this->reschedulePurchases($user, $now, $end ?? self::month($now,1));
            }
            $account = $this->account($user);
            $this->ledger($user, $account['period_id'], 'membership_grant', 0, self::units($account['balance']), ['admin_id' => $admin, 'plan_id' => $planId, 'expires_at' => $account['expires_at']]);
            return $account;
        });
    }
    public function adjust(int $user, $delta, string $reason, int $admin): array {
        if (!is_string($delta) && !is_int($delta) && !is_float($delta)) throw new InvalidArgumentException('积分调整值必须是有效数字');
        $units = self::units($delta, true);
        if ($units === 0) throw new InvalidArgumentException('积分调整值不能为零');
        $reason = trim($reason);
        if ($reason === '' || mb_strlen($reason) > 500) throw new InvalidArgumentException('请填写 1–500 字的调整原因');
        return $this->tx(function () use ($user, $units, $reason, $admin) {
            $account = $this->account($user); $balance = self::units($account['balance']) + $units;
            if ($balance < 0 || $balance > self::units('999999999')) throw new InvalidArgumentException('调整后的积分超出允许范围');
            $this->query('UPDATE credit_periods SET balance_units=? WHERE id=?', [$balance, $account['period_id']]);
            $this->ledger($user, $account['period_id'], 'admin_adjustment', $units, $balance, ['admin_id' => $admin, 'reason' => $reason]);
            $account['balance'] = self::points($balance); return $account;
        });
    }
    public function history(int $user, int $page = 1): array {
        $offset = (max(1, $page) - 1) * 20;
        $rows = $this->query("SELECT * FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT 20 OFFSET $offset", [$user])->fetchAll();
        return ['page' => max(1, $page), 'total' => (int)$this->query('SELECT COUNT(*) FROM credit_ledger WHERE user_id=?', [$user])->fetchColumn(),
            'items' => array_map(static fn($r) => ['id' => $r['id'], 'kind' => $r['kind'], 'delta' => self::points((int)$r['delta_units']),
                'balance' => self::points((int)$r['balance_units']), 'created_at' => $r['created_at'], 'details' => json_decode($r['details_json'], true)], $rows)];
    }
    public function savePlan(array $input): array {
        $code = trim((string)($input['code'] ?? '')); $name = trim((string)($input['name'] ?? ''));
        if (!preg_match('/^[a-z][a-z0-9_-]{0,63}$/', $code) || $name === '' || mb_strlen($name) > 100) throw new InvalidArgumentException('套餐标识或名称无效');
        $price = filter_var($input['price_cents'] ?? null, FILTER_VALIDATE_INT);
        $amount = self::units($input['monthly_credits'] ?? ''); $features = $input['features'] ?? [];
        if ($price === false || $price < 0 || $price > 1000000000 || $amount <= 0) throw new InvalidArgumentException('套餐价格或积分无效');
        if (!is_array($features) || !array_is_list($features) || count($features) > 20) throw new InvalidArgumentException('套餐介绍分组无效');
        foreach ($features as $group) {
            if (!is_array($group) || !is_string($group['title'] ?? null) || mb_strlen($group['title']) > 100 || !is_array($group['items'] ?? null) || !array_is_list($group['items']) || count($group['items']) > 50) throw new InvalidArgumentException('套餐介绍格式无效');
            foreach ($group['items'] as $item) if (!is_string($item) || mb_strlen($item) > 500) throw new InvalidArgumentException('介绍条目最多 500 字');
        }
        $description = trim((string)($input['description'] ?? ''));
        if (mb_strlen($description) > 500) throw new InvalidArgumentException('简介最多 500 字');
        return $this->tx(function () use ($input, $code, $name, $price, $amount, $features, $description) {
            $id = (int)($input['id'] ?? 0); $old = $id ? $this->query('SELECT * FROM membership_plans WHERE id=? FOR UPDATE', [$id])->fetch() : null;
            if ($id && !$old) throw new InvalidArgumentException('套餐不存在');
            if ($old && $old['archived']) throw new InvalidArgumentException('已删除的套餐不能编辑');
            $enabled = ($input['enabled'] ?? true) ? 1 : 0;
            if ($old && $old['is_free'] && ($code !== 'free' || $price !== 0 || !$enabled)) throw new InvalidArgumentException('免费版必须保留且价格为 0');
            if (!$old && $code === 'free') throw new InvalidArgumentException('免费版已存在');
            $rank = null;
            if ($this->paymentSchemaReady()) {
                $rank = filter_var($input['tier_rank'] ?? ($old['tier_rank'] ?? null), FILTER_VALIDATE_INT);
                if ($rank === false || $rank < 0 || $rank > 1000000 || (($old['is_free'] ?? false) ? $rank !== 0 : $rank === 0))
                    throw new InvalidArgumentException('请设置有效的独立套餐等级（付费套餐必须大于 0）');
            }
            $args = [$code, $name, $price, $amount, $description, json_encode($features, JSON_UNESCAPED_UNICODE), $enabled, (int)($input['sort_order'] ?? 0)];
            if ($old) $this->query('UPDATE membership_plans SET code=?,name=?,price_cents=?,monthly_units=?,description=?,features_json=?,enabled=?,sort_order=? WHERE id=?', [...$args, $id]);
            else { $this->query('INSERT INTO membership_plans (code,name,price_cents,monthly_units,description,features_json,enabled,sort_order) VALUES (?,?,?,?,?,?,?,?)', $args); $id = (int)$this->db->lastInsertId(); }
            if ($this->paymentSchemaReady()) $this->query('UPDATE membership_plans SET tier_rank=? WHERE id=?', [$rank,$id]);
            return $this->publicPlan($this->query('SELECT * FROM membership_plans WHERE id=?', [$id])->fetch());
        });
    }
    public function deletePlan(int $id): void {
        $this->tx(function () use ($id) {
            $row = $this->query('SELECT * FROM membership_plans WHERE id=? FOR UPDATE', [$id])->fetch();
            if (!$row || $row['is_free']) throw new InvalidArgumentException('免费版不能删除／套餐不存在');
            // Archive even unused plans so past grants and audit logs remain explainable.
            $this->query('UPDATE membership_plans SET enabled=0,archived=1 WHERE id=?', [$id]);
        });
    }
}
