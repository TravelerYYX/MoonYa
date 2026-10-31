<?php
declare(strict_types=1);
require_once __DIR__ . '/BuiltinModelService.php';

/** Used by PHP Chat and the desktop model proxy, independent of presentation statistics. */
final class BuiltinBilling {
    private static ?MembershipService $credits = null;
    private static ?BuiltinModelService $models = null;
    private static int $user = 0;
    private static string $selected = '';
    private static array $streams = [];
    private static array $callbacks = [];
    public static ?array $latest = null;
    private static bool $stopOnExhaustion = true;
    public static function configure(array $config, int $user, string $selected, bool $stopOnExhaustion = true): array {
        $db=MembershipService::connect($config); self::$credits=new MembershipService($db); self::$models=new BuiltinModelService($db,$config);
        self::$user=$user; self::$selected=$selected; self::$latest=null;
        self::$stopOnExhaustion=$stopOnExhaustion;
        $model=self::$models->resolve($selected); self::guard(); return $model;
    }
    public static function guard(): void {
        if (self::$credits && MembershipService::units(self::$credits->summary(self::$user)['balance'])<=0) throw new CreditsExhausted();
    }
    public static function payload(array $input, array $model): array {
        $caps=$model['capabilities']; $input['model']=$model['upstream_model'];
        if (!empty($input['stream'])) $input['stream_options']=['include_usage'=>true];
        $limit=(int)$caps['max_output_tokens'];
        foreach (['max_tokens','max_completion_tokens','max_output_tokens'] as $field) if (isset($input[$field])) {
            if (!is_int($input[$field]) || $input[$field]<1) throw new InvalidArgumentException('输出 Token 上限无效');
            $limit=min($limit,$input[$field]); unset($input[$field]);
        }
        $input[$caps['reasoning']==='openai'?'max_completion_tokens':'max_tokens']=$limit;
        if (!$caps['supports_images']) foreach ($input['messages']??[] as $message) foreach (is_array($message['content']??null)?$message['content']:[] as $part)
            if (in_array($part['type']??'', ['image_url','file'],true)) throw new InvalidArgumentException('所选模型不支持图片');
        if (!$caps['supports_images']) foreach ($input['input']??[] as $item) foreach (is_array($item['content']??null)?$item['content']:[] as $part)
            if (in_array($part['type']??'', ['input_image','input_file'],true)) throw new InvalidArgumentException('所选模型不支持图片');
        if (!$caps['supports_tools'] && !empty($input['tools'])) throw new InvalidArgumentException('所选模型不支持工具调用');
        if (!($caps['supports_tool_choice']??true)) unset($input['tool_choice']);
        $thinking=$input['thinking']['type']??'enabled';
        if (($caps['protocol'] ?? '') === 'openai-responses') return BuiltinProtocol::responses($input, $caps);
        if (!$caps['supports_thinking'] || $caps['reasoning']==='') { unset($input['thinking'],$input['reasoning_effort']); }
        elseif ($caps['reasoning']==='openai') {
            unset($input['thinking']); if ($thinking==='disabled') $input['reasoning_effort']='none';
        } elseif ($caps['reasoning']==='always') { unset($input['thinking'],$input['reasoning_effort']); }
        elseif ($caps['reasoning']==='gemini') {
            $effort = $input['reasoning_effort'] ?? $input['extra_body']['google']['thinking_config']['thinking_level'] ?? $caps['default_effort'] ?? 'medium';
            if (($input['extra_body']['google']['thinking_config']['thinking_budget'] ?? null) === 0) $thinking = 'disabled';
            if ($thinking === 'disabled' || $effort === 'none') {
                if (!empty($caps['reasoning_required']) || ($caps['allow_thinking_off'] ?? true) === false) throw new InvalidArgumentException('所选模型不允许关闭思考');
                $google = ['thinking_budget'=>0,'include_thoughts'=>false];
            } else {
                if ($effort === 'auto' || !in_array($effort,$caps['efforts'],true)) $effort = $caps['default_effort'];
                $google = ['thinking_level'=>$effort,'include_thoughts'=>true];
            }
            $input['extra_body']['google']['thinking_config'] = $google;
            unset($input['thinking'],$input['reasoning_effort']);
        }
        if($caps['supports_thinking']&&$thinking!=='disabled')unset($input['temperature'],$input['top_p']);
        if (isset($input['reasoning_effort']) && $input['reasoning_effort']!=='none') {
            $levels=$caps['efforts'];
            if (!$levels) unset($input['reasoning_effort']);
            elseif (!in_array($input['reasoning_effort'],$levels,true)) $input['reasoning_effort']=BuiltinReasoning::defaults($caps)['default_effort'];
        }
        return $input;
    }
    public static function writeCallback($curl, callable $callback): void {
        $key = spl_object_id($curl); self::$callbacks[$key] = $callback;
        curl_setopt($curl, CURLOPT_WRITEFUNCTION, static function($handle, string $chunk) use ($key, $callback): int {
            $length = strlen($chunk); self::chunk($handle,$chunk);
            $state = self::$streams[$key] ?? [];
            if (!isset($state['presenter']) || (int)curl_getinfo($handle,CURLINFO_HTTP_CODE) >= 400) $callback($handle,$chunk);
            elseif (str_contains(strtolower((string)curl_getinfo($handle,CURLINFO_CONTENT_TYPE)),'text/event-stream')) {
                $decoded = $state['presenter']->push($chunk);
                if ($decoded !== '') $callback($handle,$decoded);
            }
            return $length;
        });
    }
    public static function execute($curl, array $request, bool $deferStop = false) {
        if (!self::$credits) throw new RuntimeException('模型计费未初始化');
        $requested=(string)($request['model']??self::$selected);
        // A selected catalog id may differ from the supplier's wire model id.
        $selected=self::$models->resolve(self::$selected);
        $model=($requested===self::$selected || $requested===$selected['upstream_model'])?$selected:self::$models->resolve($requested);
        $payload=self::payload($request,$model);
        try { $id=self::$credits->beginCall(self::$user,$model); }
        catch (CreditsExhausted $error) { if (self::$stopOnExhaustion) self::stop(); throw $error; }
        $key=spl_object_id($curl);
        $protocol = $model['capabilities']['protocol'] ?? 'openai-completions';
        self::$streams[$key]=['buffer'=>'','usage'=>null,'body'=>'','failed'=>false];
        if (isset(self::$callbacks[$key]) && !empty($request['stream'])) self::$streams[$key]['presenter'] = new BuiltinProtocolStream($protocol);
        curl_setopt_array($curl,[CURLOPT_URL=>BuiltinProtocol::endpoint($model['endpoint'],$protocol),CURLOPT_POSTFIELDS=>json_encode($payload,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),
            CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$model['api_key'],'Content-Type: application/json'],
            CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2]);
        $result=false;
        try { $result=curl_exec($curl); }
        finally {
            self::chunk($curl,"\n\n");
            $body=json_decode(self::$streams[$key]['body'],true);
            if (is_array($body['usage']??null)) self::$streams[$key]['usage']=$body['usage'];
            $usage=self::$streams[$key]['usage'];
            if (isset(self::$streams[$key]['presenter']) && (int)curl_getinfo($curl,CURLINFO_HTTP_CODE) < 400) {
                if (is_array($body)) {
                    $completion = BuiltinProtocol::completion($body,$protocol);
                    if (isset($completion['choices'][0]['message'])) { $completion['choices'][0]['delta']=$completion['choices'][0]['message']; unset($completion['choices'][0]['message']); }
                    $tail = 'data: '.json_encode($completion,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n\ndata: [DONE]\n\n";
                } else $tail = self::$streams[$key]['presenter']->push('',true);
                if ($tail !== '') self::$callbacks[$key]($curl,$tail);
            }
            $failed = self::$streams[$key]['failed'] || (self::$streams[$key]['presenter']->failed ?? false) || isset($completion['error']) || isset($body['error']) || ($body['status'] ?? '') === 'failed';
            unset(self::$streams[$key],self::$callbacks[$key]);
            if (is_string($result) && empty($payload['stream'])) { $json=json_decode($result,true); $usage=is_array($json['usage']??null)?$json['usage']:$usage; }
            $status=(int)curl_getinfo($curl,CURLINFO_HTTP_CODE);
            self::$latest=self::$credits->settle($id,BuiltinProtocol::usage($usage),$failed||$result===false||$status<200||$status>=300?'failed':'completed');
            self::emit(['type'=>'credits_update','data'=>self::$latest]);
        }
        if(!$deferStop)self::finishCall();
        if (is_string($result) && empty($payload['stream']) && isset($request['messages'])) {
            $json = json_decode($result,true);
            if (is_array($json) && $status >= 200 && $status < 300) $result = json_encode(BuiltinProtocol::completion($json,$protocol),JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
        }
        return $result;
    }
    public static function finishCall(): void {
        if(self::$stopOnExhaustion&&self::$latest&&self::$latest['exhausted'])self::stop();
    }
    public static function stop(): never {
        self::emit(['type'=>'credits_exhausted','content'=>CreditsExhausted::MESSAGE,'error_code'=>'credits_exhausted']);
        self::emit(['type'=>'done','status'=>'quota_stopped']);
        exit;
    }
    public static function chunk($curl, string $chunk): void {
        $key=spl_object_id($curl); if (!isset(self::$streams[$key])) return;
        if (!str_contains(strtolower((string)curl_getinfo($curl,CURLINFO_CONTENT_TYPE)),'text/event-stream')) self::$streams[$key]['body'].=$chunk;
        self::$streams[$key]['buffer'].=$chunk;
        while (($pos=strpos(self::$streams[$key]['buffer'],"\n"))!==false) {
            $line=trim(substr(self::$streams[$key]['buffer'],0,$pos));self::$streams[$key]['buffer']=substr(self::$streams[$key]['buffer'],$pos+1);
            if (!str_starts_with($line,'data:')) continue;
            $json=json_decode(trim(substr($line,5)),true);
            if (isset($json['error']) || ($json['type'] ?? '') === 'response.failed') self::$streams[$key]['failed'] = true;
            if (is_array($json['response']['usage'] ?? null)) self::$streams[$key]['usage'] = $json['response']['usage'];
            if (is_array($json['usage']??null)) self::$streams[$key]['usage']=array_replace(self::$streams[$key]['usage']??[],$json['usage']);
        }
    }
    public static function emit(array $event): void {
        echo 'data: '.json_encode($event,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n\n";
        if (function_exists('streamFlush')) streamFlush();
    }
}
