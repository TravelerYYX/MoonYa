<?php
declare(strict_types=1);
function getallheaders(): array { return $GLOBALS['fixture_headers'] ?? []; }
require_once dirname(__DIR__) . '/Services/RequestHeaders.php';
function checkHeader(string $expected): void {
    if (moonyaAuthorizationHeader() !== $expected) throw new RuntimeException('Authorization extraction failed');
}
unset($_SERVER['HTTP_AUTHORIZATION'], $_SERVER['REDIRECT_HTTP_AUTHORIZATION']);
$GLOBALS['fixture_headers'] = ['aUtHoRiZaTiOn' => 'Bearer apache-fixture'];
checkHeader('Bearer apache-fixture');
$_SERVER['HTTP_AUTHORIZATION'] = '';
checkHeader('Bearer apache-fixture');
$_SERVER['REDIRECT_HTTP_AUTHORIZATION'] = 'Bearer redirected-fixture';
checkHeader('Bearer redirected-fixture');
$_SERVER['HTTP_AUTHORIZATION'] = 'Bearer server-fixture';
checkHeader('Bearer server-fixture');
echo "Authorization: Apache headers, empty server values and server precedence: PASS\n";
