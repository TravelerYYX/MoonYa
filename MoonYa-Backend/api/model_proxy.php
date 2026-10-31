<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/RuntimeRequestAuth.php';
require_once dirname(__DIR__) . '/Services/SseStreamOutput.php';
require_once dirname(__DIR__) . '/Services/BuiltinBilling.php';
try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }
    $config = require dirname(__DIR__) . '/config.php';
    $user = authenticateMoonYaRequest($config);
    session_write_close();
    $input = json_decode((string)file_get_contents('php://input'), true, 128, JSON_THROW_ON_ERROR);
    if (!is_array($input) || !is_string($input['model'] ?? null) || (!is_array($input['messages'] ?? null) && !is_array($input['input'] ?? null))) throw new InvalidArgumentException('内置模型请求无效');
    $model = BuiltinBilling::configure($config, $user, $input['model'], false);
    require_once dirname(__DIR__) . '/Services/DesktopImageInput.php';
    if (isset($input['messages'])) $input['messages'] = DesktopImageInput::messages($input['messages'], $config);
    set_time_limit(0);
    SseStreamOutput::prepare();
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-store'); header('X-Accel-Buffering: no');
    echo ": connected\n\n"; SseStreamOutput::flush();
    $buffer = ''; $nonstream = ''; $lastHeartbeat = time();
    $forward = static function(string $line): void {
        $line=trim($line);if(!str_starts_with($line,'data:'))return;
        $data=trim(substr($line,5));if($data==='[DONE]')return;
        $json=json_decode($data,true);if(!is_array($json))return;
        if(isset($json['error']))$json=['error'=>['message'=>'内置模型服务请求失败']];
        echo 'data: '.json_encode($json,JSON_UNESCAPED_UNICODE)."\n\n";SseStreamOutput::flush();
    };
    $curl = curl_init($model['endpoint']);
    curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_CONNECTTIMEOUT => 15, CURLOPT_TIMEOUT => 0,
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_NOPROGRESS => false,
        CURLOPT_PROGRESSFUNCTION => static function () use (&$lastHeartbeat): int {
            if (connection_aborted()) return 1;
            if (time() - $lastHeartbeat >= 10) { echo ": heartbeat\n\n"; SseStreamOutput::flush(); $lastHeartbeat = time(); }
            return 0;
        },
        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$buffer, &$nonstream, $forward): int {
            BuiltinBilling::chunk($handle, $chunk);
            if ((int)curl_getinfo($handle, CURLINFO_HTTP_CODE) >= 400) return strlen($chunk);
            if (!str_contains(strtolower((string)curl_getinfo($handle, CURLINFO_CONTENT_TYPE)), 'text/event-stream')) { $nonstream .= $chunk; return strlen($chunk); }
            $buffer .= $chunk;
            while (($pos = strpos($buffer, "\n")) !== false) {
                $line = trim(substr($buffer, 0, $pos)); $buffer = substr($buffer, $pos + 1);
                $forward($line);
            }
            return strlen($chunk);
        }]);
    // Nonstream suppliers are converted to an SSE frame while billing remains authoritative.
    $ok = BuiltinBilling::execute($curl, $input);
    if($buffer!=='')$forward($buffer);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE); curl_close($curl);
    if ($ok === false || $status < 200 || $status >= 400) echo 'data: '.json_encode(['error'=>['message'=>'内置模型服务请求失败']])."\n\n";
    elseif ($nonstream !== '') {
        $json=json_decode($nonstream,true);
        if (!is_array($json) || isset($json['error'])) $json=['error'=>['message'=>'模型返回内容无效']];
        if (($model['capabilities']['protocol'] ?? '') === 'openai-responses' && !isset($json['error'])) $json=['type'=>($json['status'] ?? '') === 'completed' ? 'response.completed' : 'response.incomplete','response'=>$json];
        if (isset($json['choices'][0]['message'])) { $json['choices'][0]['delta']=$json['choices'][0]['message']; unset($json['choices'][0]['message']); }
        echo 'data: '.json_encode($json,JSON_UNESCAPED_UNICODE)."\n\n";
    }
    echo "data: [DONE]\n\n"; SseStreamOutput::flush();
} catch (Throwable $error) {
    error_log('Builtin proxy: '.get_class($error).' at '.basename($error->getFile()).':'.$error->getLine());
    $exhausted=$error instanceof CreditsExhausted;
    $result=json_encode(['error'=>['code'=>$exhausted?'credits_exhausted':'builtin_model_error',
        'message'=>$exhausted||$error instanceof InvalidArgumentException?$error->getMessage():'内置模型服务暂不可用']],JSON_UNESCAPED_UNICODE);
    if (!headers_sent()) {
        http_response_code($exhausted?402:($error instanceof InvalidArgumentException?400:(http_response_code()===401?401:503)));
        header('Content-Type: application/json'); echo $result;
    } else { echo 'data: '.$result."\n\n"; SseStreamOutput::flush(); }
}
