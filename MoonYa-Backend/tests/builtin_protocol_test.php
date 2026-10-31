<?php
declare(strict_types=1);
require_once __DIR__.'/../Services/BuiltinBilling.php';
function check(bool $pass): void { if (!$pass) throw new RuntimeException('Protocol assertion failed at '.json_encode(debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS,1))); }
$base=['context_window'=>8192,'max_output_tokens'=>4096,'supports_tools'=>true,'supports_images'=>true,'supports_thinking'=>true,'efforts'=>['low','medium','high'],'default_effort'=>'medium'];
$gpt=BuiltinModelService::capabilities([...$base,'protocol'=>'openai-responses','reasoning'=>'openai','reasoning_required'=>true]);
$payload=BuiltinBilling::payload(['messages'=>[['role'=>'user','content'=>'Hi']],'thinking'=>['type'=>'enabled'],'temperature'=>0.8,'stream'=>true,'max_tokens'=>2000],['upstream_model'=>'gpt-6.1-sol','capabilities'=>$gpt]);
check($payload['reasoning']===['effort'=>'medium','summary'=>'auto'] && $payload['max_output_tokens']===2000);
check(!isset($payload['temperature'],$payload['messages'],$payload['stream_options']) && $payload['store']===false);
check(BuiltinProtocol::endpoint('https://wawapii.com/v1/chat/completions/','openai-responses')==='https://wawapii.com/v1/responses');
$gemini=BuiltinModelService::capabilities([...$base,'reasoning'=>'gemini']);
$payload=BuiltinBilling::payload(['messages'=>[],'reasoning_effort'=>'high'],['upstream_model'=>'gemini-3.8-flash','capabilities'=>$gemini]);
check($payload['extra_body']['google']['thinking_config']===['thinking_level'=>'high','include_thoughts'=>true] && !isset($payload['reasoning_effort']));
foreach ([$gpt,$gemini] as $caps) { try { BuiltinBilling::payload(['thinking'=>['type'=>'disabled']],['upstream_model'=>'test','capabilities'=>$caps]); throw new LogicException('Disabled reasoning accepted'); } catch (InvalidArgumentException $expected) {} }
$message=BuiltinProtocol::message(['content'=>[['type'=>'text','text'=>'think','thought'=>true],['type'=>'text','text'=>['value'=>'answer']],['unknown'=>'ignored']],'reasoning_content'=>'think']);
check($message['reasoning_content']==='think' && $message['content']==='answer');
$output=[['type'=>'reasoning','summary'=>[['type'=>'summary_text','text'=>'think']]],['type'=>'message','content'=>[['type'=>'output_text','text'=>'answer']]]];
$response=['status'=>'completed','output'=>$output,'usage'=>['input_tokens'=>15,'output_tokens'=>7,'input_tokens_details'=>['cached_tokens'=>4]]];
$events=[['type'=>'response.reasoning_summary_text.delta','output_index'=>0,'summary_index'=>0,'delta'=>'thi'],['type'=>'response.reasoning_summary_text.delta','output_index'=>0,'summary_index'=>0,'delta'=>'nk'],['type'=>'response.output_item.done','output_index'=>0,'item'=>$output[0]],['type'=>'response.output_text.delta','output_index'=>1,'content_index'=>0,'delta'=>'answer'],['type'=>'response.completed','response'=>$response]];
$wire=implode('',array_map(fn($event)=>'data: '.json_encode($event)."\r\n\r\n",$events));
$adapter=new BuiltinProtocolStream('openai-responses'); $converted='';
foreach (str_split($wire,13) as $chunk) $converted.=$adapter->push($chunk);
$converted.=$adapter->push('',true); $thought='';$answer='';$usage=null;
foreach (explode("\n",$converted) as $line) if (str_starts_with($line,'data:')) { $event=json_decode(substr($line,5),true);$thought.=$event['choices'][0]['delta']['reasoning_content']??'';$answer.=$event['choices'][0]['delta']['content']??'';$usage=$event['usage']??$usage; }
check($thought==='think' && $answer==='answer' && $usage['prompt_tokens']===15 && !$adapter->failed);
foreach ([[],[['type'=>'response.failed','response'=>['error'=>['message'=>'private']]]]] as $events) {
    $adapter=new BuiltinProtocolStream('openai-responses');$wire='';foreach($events as $event)$wire.='data: '.json_encode($event)."\n\n";
    $converted=$adapter->push($wire."data: [DONE]\n\n",true);check($adapter->failed && str_contains($converted,'error') && !str_contains($converted,'private'));
}
check(BuiltinProtocol::completion($response,'openai-responses')['choices'][0]['message']['reasoning_content']==='think');
echo "Builtin protocol tests passed\n";
