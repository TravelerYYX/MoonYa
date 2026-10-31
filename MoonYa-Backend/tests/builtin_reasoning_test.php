<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/Services/ClientConfig.php';
require_once dirname(__DIR__).'/Services/BuiltinBilling.php';
function verify(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
function invalid(callable $action): void { try { $action(); } catch (InvalidArgumentException $e) { return; } throw new RuntimeException('invalid configuration accepted'); }
$caps = BuiltinModelService::capabilities(['context_window'=>8192,'max_output_tokens'=>1024,
    'supports_thinking'=>true,'reasoning'=>'openai','efforts'=>['ultra','medium','xhigh'],
    'default_effort'=>'medium','effort_labels'=>['medium'=>'日常','xhigh'=>'<b>认真</b>','ultra'=>'']]);
verify($caps['efforts'] === ['medium','xhigh','ultra'], 'stable strength order');
verify((array)$caps['effort_labels'] === ['medium'=>'日常','xhigh'=>'<b>认真</b>'], 'literal labels and empty fallback');
$config = moonyaClientConfig([], [['id'=>'fixture','label'=>'Fixture','capabilities'=>$caps]]);
verify($config['modelCapabilities']['fixture']['default_effort']==='medium', 'default published');
verify((array)$config['modelCapabilities']['fixture']['effort_labels'] === (array)$caps['effort_labels'], 'labels published');
invalid(fn()=>BuiltinModelService::capabilities([...$caps,'default_effort'=>'high']));
invalid(fn()=>BuiltinModelService::capabilities([...$caps,'default_effort'=>'']));
invalid(fn()=>BuiltinModelService::capabilities([...$caps,'effort_labels'=>['bad'=>'bad']]));
invalid(fn()=>BuiltinModelService::capabilities([...$caps,'effort_labels'=>['medium'=>str_repeat('字',65)]]));
invalid(fn()=>BuiltinModelService::capabilities([...$caps,'effort_labels'=>['medium'=>"两\n行"]]));
verify(BuiltinReasoning::defaults(['efforts'=>['low','high','ultra']])['default_effort']==='high', 'legacy high default');
verify(BuiltinReasoning::defaults(['efforts'=>['low','xhigh']])['default_effort']==='xhigh', 'legacy highest default');
foreach (['medium','xhigh','ultra'] as $level) foreach ([false,true] as $work) {
    $resolved=BuiltinReasoning::resolve(['reasoningProfileVersion'=>2,'reasoningProfile'=>$level,'reasoningEffort'=>$level],$caps,$work);
    $wire=BuiltinBilling::payload(['messages'=>[],'thinking'=>['type'=>'enabled'],'reasoning_effort'=>$resolved['effort']],['capabilities'=>$caps,'upstream_model'=>'fixture']);
    verify($wire['reasoning_effort']===$level, 'wire preserves '.$level);
}
invalid(fn()=>BuiltinReasoning::resolve(['reasoningProfileVersion'=>2,'reasoningEffort'=>'high'],$caps));
invalid(fn()=>BuiltinReasoning::resolve(['reasoningProfileVersion'=>2,'reasoningProfile'=>'high','reasoningEffort'=>'medium'],$caps));
invalid(fn()=>BuiltinReasoning::resolve(['reasoningProfileVersion'=>2,'reasoningEffort'=>'none'],$caps,true));
invalid(fn()=>BuiltinReasoning::resolve(['reasoningProfileVersion'=>2,'reasoningEffort'=>'none'],[...$caps,'reasoning'=>'always']));
verify(BuiltinReasoning::resolve(['reasoningProfile'=>'medium','reasoningEffort'=>'low'],$caps)['effort']==='low', 'legacy medium contract');
verify(BuiltinReasoning::resolve(['reasoningProfile'=>'ultra','reasoningEffort'=>'ultra'],$caps)['effort']==='max', 'legacy ultra contract');
$binary=BuiltinModelService::capabilities([...$caps,'efforts'=>[],'default_effort'=>'auto','effort_labels'=>[]]);
verify(BuiltinReasoning::resolve(['reasoningProfileVersion'=>2,'reasoningEffort'=>'auto'],$binary,true)['effort']==='auto', 'binary Work');
$wire=BuiltinBilling::payload(['messages'=>[],'thinking'=>['type'=>'enabled'],'reasoning_effort'=>'auto'],['capabilities'=>$binary,'upstream_model'=>'fixture']);
verify(!isset($wire['reasoning_effort']), 'binary omits strength');
verify(BuiltinReasoning::resolve(['reasoningProfileVersion'=>2,'reasoningEffort'=>'none'],[...$binary,'supports_thinking'=>false],true)['effort']==='none', 'nonreasoning Work');
echo "Builtin reasoning tests passed\n";
