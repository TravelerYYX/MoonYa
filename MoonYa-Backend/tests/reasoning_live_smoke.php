<?php
declare(strict_types=1);
// Opt-in supplier smoke test. Reads saved credentials internally; never writes configuration.
if (($argv[1] ?? '') !== '--live') { fwrite(STDERR,"Usage: php tests/reasoning_live_smoke.php --live [model-id] [stream|json]\n"); exit(2); }
require_once __DIR__.'/../Services/BuiltinBilling.php';
$config = require __DIR__.'/../config.php';
$models = new BuiltinModelService(MembershipService::connect($config),$config);
$ids = isset($argv[2]) ? [$argv[2]] : ['gpt-6.1-sol','gemini-3.8-flash'];
foreach ($ids as $id) {
    $model = $models->resolve($id); $caps = $model['capabilities'];
    if ($id === 'gpt-6.1-sol') $caps = [...$caps,'protocol'=>'openai-responses','reasoning'=>'openai','efforts'=>['low','medium','high','xhigh','max'],'default_effort'=>'medium','reasoning_required'=>true,'allow_thinking_off'=>false];
    elseif ($id === 'gemini-3.8-flash') $caps = [...$caps,'protocol'=>'openai-completions','reasoning'=>'gemini','efforts'=>['low','medium','high'],'default_effort'=>'medium','reasoning_required'=>true,'allow_thinking_off'=>false];
    $caps['supports_thinking'] = true; $model['capabilities'] = $caps;
    $stream = ($argv[3] ?? 'json') === 'stream';
    $payload = BuiltinBilling::payload(['stream'=>$stream,'messages'=>[['role'=>'user','content'=>'有A、B、C三人，分别是总说真话的诚实者、总说假话的说谎者，以及可真可假的随机者。A说：B是说谎者。B说：C是诚实者。C说：A是随机者。列出所有满足约束的身份排列，逐项验证，最后简要说明结果。']],'max_tokens'=>4096,'reasoning_effort'=>'medium'],$model);
    $endpoint = BuiltinProtocol::endpoint($model['endpoint'],$caps['protocol']);
    $curl = curl_init($endpoint);
    curl_setopt_array($curl,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode($payload,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),CURLOPT_HTTPHEADER=>['Content-Type: application/json','Authorization: Bearer '.$model['api_key']],CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>55,CURLOPT_CONNECTTIMEOUT=>10,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2]);
    $raw = curl_exec($curl); $status = (int)curl_getinfo($curl,CURLINFO_HTTP_CODE); $error = curl_error($curl); curl_close($curl);
    $report = ['model'=>$id,'endpoint'=>$endpoint,'stream'=>$stream,'http_status'=>$status];
    if ($raw === false || $status < 200 || $status >= 300) {
        $json = json_decode((string)$raw,true); $message = $json['error']['message'] ?? $json['message'] ?? $error ?: 'non-JSON upstream error';
        $report['error'] = substr(str_replace($model['api_key'],'[redacted]',(string)$message),0,700);
    } else {
        if ($stream) {
            $adapter = new BuiltinProtocolStream($caps['protocol']); $converted = $adapter->push((string)$raw,true); $thought=''; $answer=''; $usage=null; $types=[];
            foreach (explode("\n",(string)$raw) as $line) if (str_starts_with($line,'data:')) { $event=json_decode(trim(substr($line,5)),true); if (isset($event['type'])) $types[$event['type']]=true; }
            foreach (explode("\n",$converted) as $line) if (str_starts_with($line,'data:')) { $event=json_decode(trim(substr($line,5)),true); $thought.=$event['choices'][0]['delta']['reasoning_content']??''; $answer.=$event['choices'][0]['delta']['content']??''; $usage=$event['usage']??$usage; if(isset($event['error']))$report['error']=$event['error']['message']; }
            $report += ['reasoning_chars'=>mb_strlen($thought),'answer_chars'=>mb_strlen($answer),'usage'=>$usage,'event_types'=>array_keys($types),'failed'=>$adapter->failed];
        } else {
            $json = json_decode((string)$raw,true); $completion = is_array($json) ? BuiltinProtocol::completion($json,$caps['protocol']) : [];
            $report += ['reasoning_chars'=>mb_strlen($completion['choices'][0]['message']['reasoning_content']??''),'answer_chars'=>mb_strlen($completion['choices'][0]['message']['content']??''),'usage'=>$completion['usage']??null,'response_keys'=>is_array($json)?array_keys($json):[], 'returned_reasoning'=>$json['reasoning']??null,'output_item_types'=>array_column($json['output']??[],'type'),'message_keys'=>array_keys($json['choices'][0]['message']??[])];
            if (isset($completion['error'])) $report['error']=substr(str_replace($model['api_key'],'[redacted]',(string)($completion['error']['message']??'upstream error')),0,700);
        }
    }
    echo json_encode($report,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n";
}
