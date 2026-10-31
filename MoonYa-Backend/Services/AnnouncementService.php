<?php
declare(strict_types=1);

final class AnnouncementService
{
    public function __construct(private PDO $db, private string $root) {}

    public function validate(array $input): array
    {
        $title = $input['title'] ?? null; $blocks = $input['blocks'] ?? null;
        if (!is_string($title) || trim($title) === '' || mb_strlen($title) > 200) throw new InvalidArgumentException('标题不能为空且最多200字');
        if (!is_array($blocks) || !array_is_list($blocks) || count($blocks) < 1 || count($blocks) > 100) throw new InvalidArgumentException('请添加1至100个图文块');
        $clean = [];
        foreach ($blocks as $block) {
            if (!is_array($block)) throw new InvalidArgumentException('图文块无效');
            if (($block['type'] ?? '') === 'text') {
                $text = $block['text'] ?? null;
                if (!is_string($text) || trim($text) === '' || strlen($text) > 60000) throw new InvalidArgumentException('文字块不能为空且最多60000字节');
                $clean[] = ['type'=>'text', 'text'=>$text];
            } elseif (($block['type'] ?? '') === 'image') {
                $path = $block['url'] ?? ''; $width = $block['width'] ?? 100; $align = $block['align'] ?? 'center';
                if (!is_string($path) || !preg_match('~^/uploads/new-images/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp|bmp)$~D', $path) || !is_file($this->root.$path) || !@getimagesize($this->root.$path)) throw new InvalidArgumentException('图片必须是后台上传的有效图片');
                if (!is_int($width) || $width < 10 || $width > 100 || !in_array($align, ['left','center','right'], true)) throw new InvalidArgumentException('图片宽度或对齐方式无效');
                $clean[] = ['type'=>'image', 'url'=>$path, 'width'=>$width, 'align'=>$align];
            } else throw new InvalidArgumentException('不支持的图文块类型');
        }
        if (strlen(json_encode($clean, JSON_THROW_ON_ERROR)) > 1048576) throw new InvalidArgumentException('公告内容过大');
        return [trim($title), json_encode($clean, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)];
    }

    public function get(int $id): array
    {
        $query = $this->db->prepare('SELECT * FROM announcements WHERE id=?'); $query->execute([$id]);
        $row = $query->fetch(PDO::FETCH_ASSOC);
        if (!$row) throw new InvalidArgumentException('公告不存在');
        return $row;
    }

    public function save(int $adminId, array $input): array
    {
        [$title, $blocks] = $this->validate($input); $id = (int)($input['id'] ?? 0);
        if ($id > 0) {
            $this->get($id);
            $query = $this->db->prepare('UPDATE announcements SET title=?,blocks=?,admin_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
            $query->execute([$title,$blocks,$adminId,$id]);
        } else {
            $query = $this->db->prepare('INSERT INTO announcements (title,blocks,admin_id) VALUES (?,?,?)'); $query->execute([$title,$blocks,$adminId]);
            $id = (int)$this->db->lastInsertId();
        }
        return $this->adminRow($this->get($id));
    }

    public function publish(int $id): array
    {
        $this->get($id);
        // Copy the current draft atomically: saving never changes the published snapshot.
        $query = $this->db->prepare("UPDATE announcements SET published_title=title,published_blocks=blocks,status='published',revision=revision+1,published_at=COALESCE(published_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?");
        $query->execute([$id]);
        return $this->adminRow($this->get($id));
    }

    public function withdraw(int $id): array
    {
        $this->get($id); $query = $this->db->prepare("UPDATE announcements SET status='withdrawn',updated_at=CURRENT_TIMESTAMP WHERE id=?"); $query->execute([$id]);
        return $this->adminRow($this->get($id));
    }

    public function delete(int $id): array
    {
        $row = $this->get($id); $query = $this->db->prepare('DELETE FROM announcements WHERE id=?'); $query->execute([$id]);
        // Uploaded images can be shared with other content; deleting a notice must not delete them.
        return ['id'=>$id,'title'=>$row['title']];
    }

    public function listing(): array
    {
        return array_map($this->adminRow(...), $this->db->query('SELECT * FROM announcements ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC));
    }

    public function feed(): array
    {
        return array_map(static fn(array $row): array => ['id'=>(int)$row['id'],'revision'=>(int)$row['revision'],'title'=>$row['published_title'],'blocks'=>json_decode($row['published_blocks'],true,512,JSON_THROW_ON_ERROR),'published_at'=>$row['published_at']], $this->db->query("SELECT id,revision,published_title,published_blocks,published_at FROM announcements WHERE status='published' ORDER BY published_at ASC,id ASC")->fetchAll(PDO::FETCH_ASSOC));
    }

    private function adminRow(array $row): array
    {
        $row['id'] = (int)$row['id']; $row['revision'] = (int)$row['revision'];
        $row['blocks'] = json_decode($row['blocks'],true,512,JSON_THROW_ON_ERROR);
        $row['published_blocks'] = $row['published_blocks'] === null ? null : json_decode($row['published_blocks'],true,512,JSON_THROW_ON_ERROR);
        return $row;
    }
}
