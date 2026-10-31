<?php
declare(strict_types=1);

/** Wire adapters for database models; credentials and billing stay server-side. */
final class BuiltinProtocol {
    public static function endpoint(string $endpoint, string $protocol): string {
        $suffix = $protocol === 'openai-responses' ? '/responses' : '/chat/completions';
        $endpoint = rtrim($endpoint, '/');
        if (preg_match('~/(chat/completions|responses)$~', $endpoint)) return preg_replace('~/(chat/completions|responses)$~', $suffix, $endpoint);
        return $protocol === 'openai-responses' || str_ends_with($endpoint, '/v1') ? $endpoint . $suffix : $endpoint;
    }
    public static function responses(array $input, array $caps): array {
        $effort = $input['reasoning']['effort'] ?? $input['reasoning_effort'] ?? $caps['default_effort'] ?? 'auto';
        if (($input['thinking']['type'] ?? '') === 'disabled') $effort = 'none';
        if ($effort === 'auto') $effort = $caps['default_effort'] !== 'auto' ? $caps['default_effort'] : 'high';
        if ($effort === 'none' && (!empty($caps['reasoning_required']) || ($caps['allow_thinking_off'] ?? true) === false)) throw new InvalidArgumentException('所选模型不允许关闭思考');
        if ($effort !== 'none' && !empty($caps['efforts']) && !in_array($effort, $caps['efforts'], true)) $effort = $caps['default_effort'];
        if (!isset($input['input'])) {
            $items = [];
            foreach ($input['messages'] ?? [] as $message) {
                if (($message['role'] ?? '') === 'tool') { $items[] = ['type'=>'function_call_output','call_id'=>$message['tool_call_id'],'output'=>$message['content'] ?? '']; continue; }
                if (!empty($message['content'])) {
                    $content = $message['content'];
                    if (is_array($content)) $content = array_map(static function(array $part) use ($message): array {
                        if (($part['type'] ?? '') === 'text') return ['type'=>$message['role'] === 'assistant' ? 'output_text' : 'input_text','text'=>$part['text'] ?? ''];
                        if (($part['type'] ?? '') === 'image_url') return ['type'=>'input_image','image_url'=>$part['image_url']['url'],'detail'=>$part['image_url']['detail'] ?? 'auto'];
                        throw new InvalidArgumentException('Responses 不支持此文件输入');
                    }, $content);
                    $items[] = ['role'=>$message['role'],'content'=>$content];
                }
                foreach ($message['tool_calls'] ?? [] as $call) $items[] = ['type'=>'function_call','call_id'=>$call['id'],'name'=>$call['function']['name'],'arguments'=>$call['function']['arguments'] ?? '{}'];
            }
            $input['input'] = $items;
        }
        if (!empty($input['tools'])) $input['tools'] = array_map(static fn(array $tool): array => isset($tool['function']) ? ['type'=>'function', ...$tool['function'],'strict'=>false] : $tool, $input['tools']);
        $input['max_output_tokens'] = $input['max_completion_tokens'] ?? $input['max_tokens'] ?? $input['max_output_tokens'] ?? $caps['max_output_tokens'];
        unset($input['messages'], $input['thinking'], $input['reasoning_effort'], $input['max_tokens'], $input['max_completion_tokens'], $input['stream_options']);
        if (!empty($caps['supports_thinking']) && $effort !== 'none') unset($input['temperature'], $input['top_p']);
        $input['store'] = false; $input['include'] = ['reasoning.encrypted_content'];
        if (!empty($caps['supports_thinking'])) $input['reasoning'] = ['effort'=>$effort, ...($effort !== 'none' ? ['summary'=>'auto'] : [])];
        else unset($input['reasoning']);
        if (isset($input['response_format'])) { $input['text']['format'] = $input['response_format']; unset($input['response_format']); }
        return $input;
    }
    public static function text(mixed $value): string {
        if (is_string($value)) return $value;
        if (!is_array($value)) return '';
        if (array_is_list($value)) return implode('', array_map([self::class,'text'], $value));
        if (is_string($value['text'] ?? null)) return $value['text'];
        if (is_string($value['text']['value'] ?? null)) return $value['text']['value'];
        if (is_string($value['thinking'] ?? null)) return $value['thinking'];
        return isset($value['summary']) ? self::text($value['summary']) : '';
    }
    public static function message(array $message): array {
        $content = $message['content'] ?? ''; $reasoning = '';
        if (is_array($content)) {
            $text = '';
            foreach ($content as $part) {
                if (is_array($part) && (!empty($part['thought']) || in_array($part['type'] ?? '', ['thinking','reasoning','reasoning_text','summary_text'], true))) $reasoning .= self::text($part);
                else $text .= self::text($part);
            }
            $content = $text;
        }
        $message['content'] = self::text($content);
        $message['reasoning_content'] = self::text($message['reasoning_content'] ?? null) ?: (self::text($message['reasoning'] ?? null) ?: $reasoning);
        unset($message['reasoning']);
        return $message;
    }
    public static function usage(?array $usage): ?array {
        if (!$usage || !array_key_exists('input_tokens', $usage)) return $usage;
        return ['prompt_tokens'=>$usage['input_tokens'],'completion_tokens'=>$usage['output_tokens'] ?? null,
            'prompt_tokens_details'=>$usage['input_tokens_details'] ?? [],'completion_tokens_details'=>$usage['output_tokens_details'] ?? []];
    }
    public static function completion(array $data, string $protocol): array {
        if (isset($data['error'])) return $data;
        if ($protocol !== 'openai-responses') {
            if (isset($data['choices'][0]['message'])) $data['choices'][0]['message'] = self::message($data['choices'][0]['message']);
            return $data;
        }
        if (!in_array($data['status'] ?? '', ['completed','incomplete'], true) || !isset($data['output'])) return ['error'=>['message'=>'Responses 返回内容无效或未完成']];
        if ($data['status'] === 'incomplete' && ($data['incomplete_details']['reason'] ?? '') !== 'max_output_tokens') return ['error'=>['message'=>'Responses 响应不完整']];
        $message = ['role'=>'assistant','content'=>'','reasoning_content'=>'','tool_calls'=>[]];
        foreach ($data['output'] as $item) {
            if (($item['type'] ?? '') === 'reasoning') $message['reasoning_content'] .= self::text($item['summary'] ?? []);
            if (($item['type'] ?? '') === 'message') foreach ($item['content'] ?? [] as $part) $message['content'] .= self::text($part) ?: ($part['refusal'] ?? '');
            if (($item['type'] ?? '') === 'function_call') $message['tool_calls'][] = ['id'=>$item['call_id'],'type'=>'function','function'=>['name'=>$item['name'],'arguments'=>$item['arguments']]];
        }
        return ['choices'=>[['message'=>$message,'finish_reason'=>$data['status'] === 'incomplete' ? 'length' : ($message['tool_calls'] ? 'tool_calls' : 'stop')]],'usage'=>self::usage($data['usage'] ?? null)];
    }
}

/** Convert upstream events to the legacy PHP Chat contract, including final snapshots. */
final class BuiltinProtocolStream {
    public bool $failed = false;
    private string $buffer = '';
    private array $texts = [];
    private bool $ended = false;
    public function __construct(private string $protocol) {}
    private static function frame(array $event): string { return 'data: '.json_encode($event,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n\n"; }
    private function text(string $key, string $channel, mixed $value, bool $append = false): string {
        if (!is_string($value)) return '';
        $old = $this->texts[$key] ?? ''; $full = $append ? $old.$value : $value;
        if (!str_starts_with($full,$old)) throw new RuntimeException('模型流的最终文本与已收到内容不一致');
        $this->texts[$key] = $full; $delta = substr($full,strlen($old));
        return $delta === '' ? '' : self::frame(['choices'=>[['delta'=>[$channel=>$delta]]]]);
    }
    private function item(int $index, array $item): string {
        $out = '';
        if (($item['type'] ?? '') === 'reasoning') foreach ($item['summary'] ?? [] as $i=>$part) $out .= $this->text("$index:summary:$i",'reasoning_content',$part['text'] ?? null);
        if (($item['type'] ?? '') === 'message') foreach ($item['content'] ?? [] as $i=>$part) $out .= $this->text("$index:content:$i",'content',$part['text'] ?? $part['refusal'] ?? null);
        return $out;
    }
    private function consume(array $event): string {
        if ($this->protocol !== 'openai-responses') {
            if (isset($event['choices'][0]['delta'])) $event['choices'][0]['delta'] = BuiltinProtocol::message($event['choices'][0]['delta']);
            if (!empty($event['choices'][0]['finish_reason'])) $this->ended = true;
            return self::frame($event);
        }
        $type = $event['type'] ?? ''; $index = $event['output_index'] ?? 0; $part = $event['summary_index'] ?? $event['content_index'] ?? 0;
        if (isset($event['error']) || $type === 'response.failed' || $type === 'error') { $this->failed = true; $this->ended = true; return self::frame(['error'=>['message'=>'内置模型服务请求失败']]); }
        if (in_array($type,['response.output_item.added','response.output_item.done'],true)) return $this->item($index,$event['item']);
        if (in_array($type,['response.reasoning_summary_text.delta','response.reasoning_summary_text.done'],true)) return $this->text("$index:summary:$part",'reasoning_content',$event['delta'] ?? $event['text'] ?? null,str_ends_with($type,'.delta'));
        if (in_array($type,['response.reasoning_summary_part.added','response.reasoning_summary_part.done'],true)) return $this->text("$index:summary:$part",'reasoning_content',$event['part']['text'] ?? null);
        if (in_array($type,['response.output_text.delta','response.output_text.done','response.refusal.delta','response.refusal.done'],true)) return $this->text("$index:content:$part",'content',$event['delta'] ?? $event['text'] ?? $event['refusal'] ?? null,str_ends_with($type,'.delta'));
        if (in_array($type,['response.content_part.added','response.content_part.done'],true)) return $this->text("$index:content:$part",'content',$event['part']['text'] ?? $event['part']['refusal'] ?? null);
        if (in_array($type,['response.completed','response.incomplete'],true)) {
            $response = $event['response']; $completion = BuiltinProtocol::completion($response,$this->protocol); $this->ended = true;
            if (isset($completion['error'])) { $this->failed = true; return self::frame($completion); }
            $out = ''; foreach ($response['output'] as $i=>$item) $out .= $this->item($i,$item);
            // PHP Chat does not execute tools. Work consumes the raw Responses stream instead.
            return $out.self::frame(['choices'=>[['delta'=>[],'finish_reason'=>$completion['choices'][0]['finish_reason']]],'usage'=>$completion['usage']]);
        }
        return '';
    }
    public function push(string $chunk, bool $finish = false): string {
        $this->buffer .= $chunk; $this->buffer = str_replace("\r\n","\n",$this->buffer); $out = '';
        if ($finish && trim($this->buffer) !== '') $this->buffer .= "\n\n";
        while (($pos = strpos($this->buffer,"\n\n")) !== false) {
            $frame = substr($this->buffer,0,$pos); $this->buffer = substr($this->buffer,$pos+2); $data = [];
            foreach (explode("\n",$frame) as $line) if (str_starts_with($line,'data:')) $data[] = ltrim(substr($line,5));
            $text = implode("\n",$data);
            if ($text === '[DONE]') { if ($this->protocol !== 'openai-responses') $this->ended = true; continue; }
            if ($text === '') continue;
            try {
                $event = json_decode($text,true,128,JSON_THROW_ON_ERROR);
                if (!is_array($event)) throw new RuntimeException('Invalid upstream event');
                $out .= $this->consume($event);
            } catch (Throwable $error) {
                $this->failed = true; $this->ended = true;
                $out .= self::frame(['error'=>['message'=>'模型流格式无效或文本不一致']]);
                $this->buffer = ''; break;
            }
        }
        if ($finish) {
            if (!$this->ended) $this->failed = true;
            $out .= $this->ended ? "data: [DONE]\n\n" : self::frame(['error'=>['message'=>'模型流提前结束，响应不完整']]);
        }
        return $out;
    }
}
