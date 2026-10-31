<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/vendor/autoload.php';
require_once dirname(__DIR__).'/env_loader.php';

interface PaymentVerificationMailer {
    public function configured(): bool;
    public function send(string $email,string $code,string $operation): void;
}
final class PaymentMailUnavailable extends RuntimeException {}

final class PaymentEmailMailer implements PaymentVerificationMailer {
    private function settings(): array {
        $host=trim((string)env('SMTP_HOST',''));$user=trim((string)env('SMTP_USER',''));$password=(string)env('SMTP_PASS','');
        $port=filter_var(env('SMTP_PORT','587'),FILTER_VALIDATE_INT,['options'=>['min_range'=>1,'max_range'=>65535]]);
        $from=trim((string)env('SMTP_FROM',''))?:$user;$encryption=strtolower(trim((string)env('SMTP_ENCRYPTION','')))?:($port===465?'smtps':'tls');
        if(!preg_match('/^[a-zA-Z0-9.-]+$/D',$host) || $user==='' || preg_match('/[\r\n]/',$user) || $password==='' || !$port || !filter_var($from,FILTER_VALIDATE_EMAIL) || !in_array($encryption,['tls','smtps','ssl'],true))throw new PaymentMailUnavailable('邮件发送尚未配置完整，请设置 SMTP 发信服务');
        return compact('host','user','password','port','from','encryption');
    }
    public function configured(): bool {try{$this->settings();return true;}catch(PaymentMailUnavailable $error){return false;}}
    private function client(): \PHPMailer\PHPMailer\PHPMailer {
        $settings=$this->settings();$mail=new \PHPMailer\PHPMailer\PHPMailer(true);$mail->isSMTP();$mail->CharSet='UTF-8';$mail->SMTPDebug=0;
        $mail->Host=$settings['host'];$mail->Port=$settings['port'];$mail->SMTPAuth=true;$mail->Username=$settings['user'];$mail->Password=$settings['password'];
        $mail->SMTPSecure=$settings['encryption']==='tls'?\PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS:\PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS;
        $mail->SMTPOptions=['ssl'=>['verify_peer'=>true,'verify_peer_name'=>true,'allow_self_signed'=>false]];$mail->Timeout=10;$mail->Timelimit=15;
        $ca=trim((string)env('SMTP_CA_FILE',''));if($ca!==''){
            if(!is_file($ca)||!is_readable($ca))throw new PaymentMailUnavailable('SMTP 信任证书文件不可用');
            $mail->SMTPOptions['ssl']['cafile']=$ca;
        }
        $mail->setFrom($settings['from'],'MoonYa');return $mail;
    }
    /** Connectivity/authentication check for server operators; this sends no message. */
    public function checkConnection(): void {
        $mail=$this->client();
        try{if(!$mail->smtpConnect())throw new RuntimeException('SMTP connection failed');}
        catch(Throwable $error){throw new PaymentMailUnavailable('SMTP 连接或授权验证失败');}
        finally{$mail->smtpClose();}
    }
    public function send(string $email,string $code,string $operation): void {
        try{
            $mail=$this->client();$mail->addAddress($email);$mail->Subject='MoonYa 支付管理邮箱验证码';
            $label=['save'=>'保存支付配置','import'=>'导入旧支付配置','settle'=>'查单并结清订单'][$operation]??'确认支付管理操作';
            $mail->Body="你正在进行：".$label."。\n\n邮箱验证码：".$code."\n\n验证码 2 分钟有效，只能用于本次操作。请在支付管理页面输入，不要向他人提供验证码。若非本人操作，请检查管理员账号安全。";
            if (in_array($operation, ['user_register','user_login'], true)) {
                $mail->Subject = 'MoonYa 账号验证码';
                $label = $operation === 'user_register' ? '注册 MoonYa 账号' : '登录 MoonYa 账号';
                $mail->Body = "你正在".$label."。\n\n验证码：".$code."\n\n验证码 5 分钟有效，请勿向他人提供。若非本人操作，请忽略此邮件。";
            }
            if(!$mail->send())throw new RuntimeException('SMTP delivery failed');
        }catch(Throwable $error){throw new PaymentMailUnavailable('验证码邮件发送失败，请检查 SMTP 配置后重试');}
    }
}
