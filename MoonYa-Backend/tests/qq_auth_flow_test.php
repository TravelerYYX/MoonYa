<?php
require_once dirname(__DIR__).'/Services/UserEmailCodes.php';
require_once dirname(__DIR__).'/Services/UserAvatar.php';
class AuthResponse extends RuntimeException { public function __construct(public bool $success, public array $data, public int $status=200) {} }
function sendSuccess($data): never { throw new AuthResponse(true, $data); }
function sendError($status, $message): never { throw new AuthResponse(false, ['error'=>$message], $status); }
class MembershipService { public function __construct($db) {} public function summary($id) { return []; } }
class AuthTestPDO extends PDO {
    public function prepare(string $query, array $options=[]): PDOStatement|false { return parent::prepare(str_replace('NOW()', 'CURRENT_TIMESTAMP', $query), $options); }
}
function result(Closure $operation): AuthResponse { try { $operation(); } catch (AuthResponse $response) { return $response; } throw new RuntimeException('No auth response'); }
function expect(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
$source = file_get_contents(dirname(__DIR__).'/user_auth.php');
$start = strpos($source, 'function handleRegister(');
$end = strpos($source, 'function handleCheckSession(');
eval(substr($source, $start, $end-$start));
$profile=file_get_contents(dirname(__DIR__).'/user_profile.php');
$start=strpos($profile,'function handleUpdatePassword(');
$end=strpos($profile,'function handleUploadAvatar(');
eval(substr($profile,$start,$end-$start));
$directory = sys_get_temp_dir().'/moonya-qq-flow-'.bin2hex(random_bytes(6));
mkdir($directory,0700);
$_ENV['MOONYA_DATA_ROOT']=$directory;
AppDataPaths::configurePhp(); session_start();
$pdo = new AuthTestPDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
$pdo->exec('CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, real_name TEXT, password TEXT, avatar TEXT, status TEXT, created_at TEXT, updated_at TEXT, api_token TEXT, token_created_at TEXT)');
$codes = [];
$service = new UserEmailCodes(null, function($email,$code,$purpose) use (&$codes) { $codes[$email.':'.$purpose]=$code; });
function challenge(UserEmailCodes $service, array &$codes, string $qq, string $purpose): array {
    $row=$service->send($qq,$purpose,$qq);
    return ['qq'=>$qq,'challenge_id'=>$row['challenge_id'],'code'=>$codes[$qq.'@qq.com:'.$purpose]];
}
try {
    $input=challenge($service,$codes,'123456789','register');
    $response=result(fn()=>handleRegister($pdo,$input));
    expect($response->success && $response->data['user']['username']==='123456789', 'QQ registration');
    $user=$pdo->query('SELECT * FROM users')->fetch();
    expect($user['email']==='123456789@qq.com' && $user['password']===null, 'Verified mailbox, no initial password');
    expect((int)$_SESSION['user_id']===(int)$user['id'] && strlen($response->data['token'])===64, 'Registration authenticates');
    expect($response->data['user']['avatar']===moonyaUserAvatar($user), 'Registration avatar');
    $response=result(fn()=>handleLogin($pdo,['account'=>'123456789','password'=>'not-set']));
    expect(!$response->success, 'Unset password cannot log in');
    // Account-management password storage makes the existing password login work.
    // The profile endpoint reads JSON from php://input; test the same handler using supplied input.
    $setter=substr($profile,strpos($profile,'function handleSetPassword('),strpos($profile,'function handleCheckPasswordStatus(')-strpos($profile,'function handleSetPassword('));
    $setter=str_replace('function handleSetPassword($pdo)', 'function testSetPassword($pdo, $input)', $setter);
    $setter=str_replace("    \$input = json_decode(file_get_contents('php://input'), true);", '', $setter);
    eval($setter);
    $saved=result(fn()=>testSetPassword($pdo,['password'=>'valid-password']));
    expect($saved->success, 'Password saved by profile endpoint');
    $response=result(fn()=>handleLogin($pdo,['account'=>'123456789','password'=>'valid-password']));
    expect($response->success, 'Password login after setup');
    // A different QQ has no account and cannot be registered via a login challenge.
    $input=challenge($service,$codes,'223456789','login');
    $response=result(fn()=>handleCodeLogin($pdo,$input));
    expect(!$response->success && $response->status===404, 'Unregistered QQ must register');
    $input=challenge($service,$codes,'323456789','register');
    result(fn()=>handleRegister($pdo,$input));
    // Switch purpose after the cooldown using a fresh QQ challenge state.
    $stateFile=AppDataPaths::path('temp','user-email-codes','state.json');
    $state=json_decode(file_get_contents($stateFile),true); $state['limits']=[]; file_put_contents($stateFile,json_encode($state));
    $input=challenge($service,$codes,'323456789','login');
    $response=result(fn()=>handleCodeLogin($pdo,$input));
    expect($response->success && $response->data['user']['email']==='323456789@qq.com', 'QQ code login');
    $pdo->exec("UPDATE users SET status='banned' WHERE username='123456789'");
    $response=result(fn()=>handleLogin($pdo,['account'=>'123456789','password'=>'valid-password']));
    expect(!$response->success && $response->status===403, 'Banned password login');
    $input=challenge($service,$codes,'123456789','login');
    $response=result(fn()=>handleCodeLogin($pdo,$input));
    expect(!$response->success && $response->status===403, 'Banned code login');
    session_destroy();
    echo "QQ registration, code/password login and account status passed\n";
} finally {
    if (session_status()===PHP_SESSION_ACTIVE) session_destroy();
    $iterator=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
    foreach($iterator as $entry) { if($entry->isDir()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
    rmdir($directory);
}
