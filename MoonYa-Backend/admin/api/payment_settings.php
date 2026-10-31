<?php
declare(strict_types=1);
ini_set('display_errors','0');
require_once dirname(__DIR__,2).'/Services/PaymentTransport.php';
require_once dirname(__DIR__,2).'/Services/PaymentPasswordSecurity.php';
require_once dirname(__DIR__,2).'/Services/PaymentOrderDeletion.php';
require_once dirname(__DIR__,2).'/Services/PaymentService.php';
require_once dirname(__DIR__,2).'/Services/RequestHeaders.php';
require_once dirname(__DIR__).'/Auth.php';require_once dirname(__DIR__).'/Logger.php';
header('Content-Type: application/json; charset=utf-8');
try {
    PaymentTransport::enforce();
    if (!in_array($_SERVER['REQUEST_METHOD'],['GET','POST'],true)) {http_response_code(405);throw new InvalidArgumentException('请求方法无效');}
    $authorization=moonyaAuthorizationHeader();
    if (!preg_match('/^Bearer ([^\s]+)$/D',$authorization,$match)) {http_response_code(401);throw new InvalidArgumentException('请先登录管理后台');}
    $config=require dirname(__DIR__).'/config.php';$db=MembershipService::connect($config);
    $auth=new Auth($db,$config,new Logger($config,$db));$admin=$auth->authenticate($match[1]);
    if (!$admin) {http_response_code(401);throw new InvalidArgumentException('登录已失效');}
    if ($admin['role']!=='super_admin') {http_response_code(403);throw new InvalidArgumentException('仅超级管理员可管理支付配置');}
    $store=new PaymentConfiguration($db);$security=new PaymentPasswordSecurity($db,$store);$id=(int)$admin['id'];
    $action=$_GET['action']??'state';
    $data=$store->locked(function()use($db,$store,$security,$id,$action){
        if ($_SERVER['REQUEST_METHOD']==='GET') {
            if ($action!=='state') throw new InvalidArgumentException('操作无效');
            return ['configuration'=>$store->publicState(),'verification'=>$security->status($id)];
        }
        if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE']??''),'application/json') || (int)($_SERVER['CONTENT_LENGTH']??0)>393216) throw new InvalidArgumentException('请求格式或大小无效');
        $stream=fopen('php://input','rb');$raw=stream_get_contents($stream,393217);fclose($stream);
        if (strlen($raw)>393216) throw new InvalidArgumentException('请求过大');
        $input=json_decode($raw,true,32,JSON_THROW_ON_ERROR);unset($raw);
        if (!is_array($input) || array_is_list($input)) throw new InvalidArgumentException('请求格式无效');
        if ($action==='save_password') {
            if(array_diff(array_keys($input),['password','configuration']) || !is_string($input['password']??null) || !is_array($input['configuration']??null))throw new InvalidArgumentException('密码保存请求无效');
            $security->verifyPassword($id,$input['password']);unset($input['password']);
            $next=$store->candidate($input['configuration']);$store->save($next,$input['configuration']['revision'],$id);
            return ['message'=>'支付配置已加密保存','configuration'=>$store->publicState()];
        }
        if ($action==='challenge') {
            $type=$input['operation']??'';if($type==='save')throw new InvalidArgumentException('保存配置请使用密码确认接口');$operation=['type'=>$type];$summary=['operation'=>$type];
            if ($type==='import') {
                if (array_diff(array_keys($input),['operation'])) throw new InvalidArgumentException('导入请求无效');
                $operation['configuration']=$store->legacy();$summary+=array_diff_key($operation['configuration'],array_flip(PaymentMaterials::FIELDS));
            } elseif (in_array($type,['settle','force_delete'],true)) {
                if (array_diff(array_keys($input),['operation','order_numbers']) || !is_array($input['order_numbers']??null) || !array_is_list($input['order_numbers']) || count($input['order_numbers'])<1 || count($input['order_numbers'])>20) throw new InvalidArgumentException('关单请求无效');
                $operation['order_numbers']=array_values(array_unique($input['order_numbers']));
                foreach($operation['order_numbers'] as $number)if(!is_string($number)||!preg_match('/^MY[a-zA-Z0-9]{14,38}$/D',$number))throw new InvalidArgumentException('订单号无效');
                $summary['order_numbers']=$operation['order_numbers'];
                if($type==='force_delete')(new PaymentOrderDeletion($db,$store))->preview($operation['order_numbers']);
            } else throw new InvalidArgumentException('操作无效');
            return $security->prepare($id,$operation)+['summary'=>$summary];
        }
        if ($action==='confirm') {
            if (array_diff(array_keys($input),['challenge_id','password']) || !is_string($input['challenge_id']??null) || !preg_match('/^[a-f0-9]{64}$/D',$input['challenge_id']) || !is_string($input['password']??null)) throw new InvalidArgumentException('密码确认请求无效');
            $authorized=$security->authorize($id,$input['challenge_id'],$input['password']);
            if ($authorized['type']==='force_delete') {
                $results=(new PaymentOrderDeletion($db,$store))->delete($authorized['order_numbers'],$id);
                return ['results'=>$results,'message'=>'已强制删除 '.count($results).' 笔未结清订单'];
            }
            if ($authorized['type']==='import') {
                $db->beginTransaction();
                try {$store->save($authorized['configuration'],$authorized['revision'],$id,$authorized['type']==='import');$db->commit();}
                catch(Throwable $error){$db->rollBack();throw $error;}
                return ['message'=>'支付配置已加密保存','configuration'=>$store->publicState()];
            }
            if ($authorized['type']==='settle') {
                $payment=new PaymentService(new MembershipService($db),AlipayGateway::fromDatabase($db));$results=[];
                // Reuse this connection's lock; nested GET_LOCK calls are counted by MySQL.
                foreach($authorized['order_numbers'] as $number){
                    try {$result=$payment->settle($number);$store->audit($id,'payment_order_settle',['order_no'=>$number,'status'=>$result['status']]);$results[]=['order_no'=>$number,'status'=>$result['status']];}
                    catch(Throwable $error){$store->audit($id,'payment_order_settle_failed',['order_no'=>$number]);$results[]=['order_no'=>$number,'error'=>'结果未确认，订单仍需查单结清'];}
                }
                http_response_code(200);return ['results'=>$results];
            }
            throw new InvalidArgumentException('操作无效');
        }
        throw new InvalidArgumentException('操作无效');
    });
    echo json_encode(['success'=>true,'data'=>$data],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
} catch(Throwable $error) {
    if(http_response_code()<400)http_response_code($error instanceof InvalidArgumentException?400:503);
    echo json_encode(['success'=>false,'error'=>paymentAdminError($error)],JSON_UNESCAPED_UNICODE);
    // 客户端保持粗粒度，服务端日志保留可定位信息；这些异常信息均为固定文案，不含密钥或凭据。
    error_log('Payment admin failed: '.get_class($error).': '.paymentAdminError($error));
}

function paymentAdminError(Throwable $error): string {
    if($error instanceof InvalidArgumentException || $error instanceof PaymentStorageUnavailable)return $error->getMessage();
    if($error instanceof PDOException){$code=(int)($error->errorInfo[1]??0);
        if($code===1146 || $code===1054)return '支付数据库结构缺失，请执行支付数据库升级';
        if(in_array($code,[1044,1045,1142,1143],true))return '数据库账号权限不足，请检查支付数据读写权限';
        return '支付数据库访问失败，请检查数据库连接及服务状态';}
    if($error instanceof RuntimeException && in_array($error->getMessage(),['支付加密数据无效','支付配置完整性验证失败','支付配置结构无效'],true))return '支付配置密文损坏或与键环不匹配，请恢复数据库备份';
    return '支付操作失败，请查看服务器日志并检查服务运行环境';
}
