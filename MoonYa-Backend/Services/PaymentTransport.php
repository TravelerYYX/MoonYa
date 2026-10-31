<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/env_loader.php';
final class PaymentTransport {
    private static function localHttp(string $host): bool {
        if (!in_array(strtolower(trim((string)env('PAYMENT_ALLOW_LOCAL_HTTP','false'))),['true','1'],true)) return false;
        if (!in_array($host,['localhost','127.0.0.1','[::1]'],true) || !in_array($_SERVER['REMOTE_ADDR']??'',['127.0.0.1','::1','::ffff:127.0.0.1'],true)) return false;
        foreach (['HTTP_FORWARDED','HTTP_X_FORWARDED_FOR','HTTP_X_FORWARDED_HOST','HTTP_X_FORWARDED_PROTO'] as $header) if (isset($_SERVER[$header])) return false;
        return true;
    }
    public static function enforce(): void {
        header('Cache-Control: no-store');header('Pragma: no-cache');header('Referrer-Policy: no-referrer');header('X-Content-Type-Options: nosniff');
        header("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        $host=$_SERVER['HTTP_HOST']??'';
        if (!preg_match('/^([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::([0-9]{1,5}))?$/D',$host,$authority) || (isset($authority[2]) && ((int)$authority[2]<1 || (int)$authority[2]>65535))) {http_response_code(403);throw new InvalidArgumentException('请求来源无效');}
        $hostname=strtolower($authority[1]);
        $https=isset($_SERVER['HTTPS']) && in_array(strtolower((string)$_SERVER['HTTPS']),['on','1'],true);
        $proxies=array_filter(array_map('trim',explode(',',(string)env('PAYMENT_TRUSTED_PROXIES',''))));
        if (in_array($_SERVER['REMOTE_ADDR']??'',$proxies,true) && ($_SERVER['HTTP_X_FORWARDED_PROTO']??'')==='https') $https=true;
        if (!$https && !self::localHttp($hostname)) {http_response_code(403);throw new InvalidArgumentException('支付管理必须通过 HTTPS 访问；本机 HTTP 需要显式启用本地开发模式');}
        $scheme=$https?'https':'http';$port=isset($authority[2])?(int)$authority[2]:($https?443:80);
        $origin=$_SERVER['HTTP_ORIGIN']??'';
        if ($origin!=='') {
            if (!preg_match('/^(https?):\/\/([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::([0-9]{1,5}))?$/iD',$origin,$source) || strtolower($source[1])!==$scheme || strtolower($source[2])!==$hostname || (isset($source[3])?(int)$source[3]:($scheme==='https'?443:80))!==$port) {http_response_code(403);throw new InvalidArgumentException('支付管理禁止跨域访问');}
        }
        if (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && !in_array($_SERVER['HTTP_SEC_FETCH_SITE'],['same-origin','none'],true)) {http_response_code(403);throw new InvalidArgumentException('支付管理禁止跨域访问');}
    }
    public static function notification(string $raw): array {
        if ($raw==='' || strlen($raw)>65536) throw new InvalidArgumentException('通知大小无效');
        $params=[];
        foreach (explode('&',$raw) as $pair) {
            if ($pair==='' || !str_contains($pair,'=') || preg_match('/%(?![a-fA-F0-9]{2})/',$pair)) throw new InvalidArgumentException('通知格式无效');
            [$key,$value]=explode('=',$pair,2);$key=urldecode($key);$value=urldecode($value);
            if (!preg_match('/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/D',$key) || isset($params[$key]) || str_contains($value,"\0")) throw new InvalidArgumentException('通知参数重复或无效');
            $params[$key]=$value;
        }
        return $params;
    }
}
